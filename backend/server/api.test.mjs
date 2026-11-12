import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from './app.mjs';
import { bootstrap } from './bootstrap.mjs';
import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS, openDatabase, SCHEMA_VERSION } from './db.mjs';
import { SAMPLES } from './samples.mjs';
import * as V from './validate.mjs';

let dir;
let handles;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghostgrid-'));
  handles = [];
});
afterEach(async () => {
  for (const h of handles) {
    await new Promise((r) => h.server.close(r));
    try {
      h.db.close();
    } catch {
      /* already closed */
    }
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Starts a real HTTP server on a database file in the temp folder. */
async function start({ file = path.join(dir, 'test.db'), seed = false, legacy, staticDir } = {}) {
  const db = openDatabase(file);
  bootstrap(db, { seedSamples: seed, legacyFile: legacy });
  const app = createApp({ db, staticDir });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const handle = { db, server, base, file };
  handles.push(handle);
  const call = (method, url, body) =>
    fetch(base + url, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { ...handle, call };
}

const asset = (id, over = {}) => ({ id, name: id.toUpperCase(), kind: 'power', criticality: 'high', notes: '', ...over });
const dep = (dependentId, providerId, over = {}) => ({
  id: `d-${dependentId}-${providerId}`,
  dependentId,
  providerId,
  mode: 'required',
  status: 'confirmed',
  relation: 'power',
  notes: '',
  ...over,
});
const scenario = (over = {}) => ({
  id: 'sc-1',
  name: 'Test scenario',
  description: '',
  sector: 'Energy',
  assets: [asset('a'), asset('b', { kind: 'service' }), asset('c')],
  dependencies: [dep('b', 'a'), dep('c', 'b', { status: 'inferred' })],
  runs: [{ id: 'r1', name: 'A fails', failedIds: ['a'], createdAt: '2026-01-01T00:00:00.000Z' }],
  strategies: [{ id: 'm1', name: 'Backup', dependentId: 'b', providerId: 'a', backupId: 'c', notes: '' }],
  assumptions: [
    { id: 'as1', text: 'General assumption', targetType: 'scenario', targetId: null, confidence: 'high' },
    { id: 'as2', text: 'About a link', targetType: 'link', targetId: 'd-b-a', confidence: 'low' },
  ],
  ...over,
});

describe('database', () => {
  it('creates the schema and records the version', () => {
    const db = openDatabase(':memory:');
    expect(db.prepare('PRAGMA user_version').get().user_version).toBe(SCHEMA_VERSION);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
    for (const t of ['scenarios', 'nodes', 'links', 'assumptions', 'mitigations', 'simulation_runs', 'run_failed_nodes', 'reports']) expect(tables).toContain(t);
    expect(db.prepare('PRAGMA foreign_keys').get().foreign_keys).toBe(1);
    db.close();
  });

  it('enforces rules in the database itself, not only in the API', () => {
    const db = openDatabase(':memory:');
    const now = new Date().toISOString();
    db.prepare("INSERT INTO scenarios VALUES ('s','S','','x',NULL,?,?)").run(now, now);
    db.prepare("INSERT INTO nodes VALUES ('s','a','A','power','high','',NULL,NULL,0)").run();
    const bad = (sql, ...p) => expect(() => db.prepare(sql).run(...p)).toThrow();
    bad("INSERT INTO nodes VALUES ('s','z','Z','banana','high','',NULL,NULL,1)"); // bad kind
    bad("INSERT INTO links VALUES ('s','l','a','a','required','confirmed','power','',0)"); // self link
    bad("INSERT INTO links VALUES ('s','l','a','ghost','required','confirmed','power','',0)"); // missing node
    db.prepare("INSERT INTO nodes VALUES ('s','b','B','power','high','',NULL,NULL,1)").run();
    bad("INSERT INTO links VALUES ('s','l','a','b','required','maybe','power','',0)"); // bad status
    db.close();
  });

  it('refuses a database created by a newer version', () => {
    const file = path.join(dir, 'future.db');
    const db = openDatabase(file);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    db.close();
    expect(() => openDatabase(file)).toThrow(/newer/);
  });
});

describe('Part 3 data model', () => {
  it('upgrades a v1 database in place and keeps its mitigations', () => {
    const file = path.join(dir, 'v1.db');
    const old = new DatabaseSync(file);
    old.exec('PRAGMA foreign_keys = ON;');
    old.exec(MIGRATIONS[0].sql);
    old.exec('PRAGMA user_version = 1');
    const now = new Date().toISOString();
    old.prepare("INSERT INTO scenarios VALUES ('s','S','','x',NULL,?,?)").run(now, now);
    for (const [i, id] of ['a', 'b', 'c'].entries()) old.prepare("INSERT INTO nodes VALUES ('s',?,?,'power','high','',NULL,NULL,?)").run(id, id.toUpperCase(), i);
    old.prepare("INSERT INTO mitigations VALUES ('s','m1','Old backup','b','a','c','kept',0)").run();
    old.close();

    const db = openDatabase(file);
    expect(db.prepare('PRAGMA user_version').get().user_version).toBe(SCHEMA_VERSION);
    expect(db.prepare('SELECT * FROM mitigations').get()).toMatchObject({ id: 'm1', kind: 'backup', backup_id: 'c', notes: 'kept', cost_level: null, effort_level: null });
    db.close();
  });

  it('stores link failures in runs, decouple options and estimates, and defaults older payloads', async () => {
    const { call } = await start();
    const doc = scenario({
      runs: [
        { id: 'r1', name: 'A fails', failedIds: ['a'], createdAt: '2026-01-01T00:00:00.000Z' }, // no failedLinkIds: defaults to []
        { id: 'r2', name: 'Link b to a fails', failedIds: [], failedLinkIds: ['d-b-a'], createdAt: '2026-01-01T00:00:00.000Z' },
      ],
      strategies: [
        { id: 'm1', name: 'Backup', dependentId: 'b', providerId: 'a', backupId: 'c' }, // older shape
        { id: 'm2', name: 'Decouple', kind: 'decouple', dependentId: 'b', providerId: 'a', costLevel: 'high', effortLevel: 'low' },
      ],
    });
    const res = await call('POST', '/api/scenarios', doc);
    expect(res.status).toBe(201);
    const body = (await res.json()).scenario;
    expect(body.runs.map((r) => [r.failedIds, r.failedLinkIds])).toEqual([[['a'], []], [[], ['d-b-a']]]);
    expect(body.strategies[0]).toMatchObject({ kind: 'backup', backupId: 'c', costLevel: null, effortLevel: null });
    expect(body.strategies[1]).toMatchObject({ kind: 'decouple', backupId: '', costLevel: 'high', effortLevel: 'low' });
  });

  it('rejects invalid kinds, estimates and empty runs with a clear message', async () => {
    const { call } = await start();
    const bad = async (over, pattern) => {
      const res = await call('POST', '/api/scenarios', scenario(over));
      expect(res.status).toBe(400);
      expect(JSON.stringify(await res.json())).toMatch(pattern);
    };
    await bad({ strategies: [{ id: 'm', name: 'x', kind: 'teleport', dependentId: 'b', providerId: 'a' }] }, /kind/);
    await bad({ strategies: [{ id: 'm', name: 'x', kind: 'backup', dependentId: 'b', providerId: 'a' }] }, /backup/);
    await bad({ strategies: [{ id: 'm', name: 'x', dependentId: 'b', providerId: 'a', backupId: 'c', costLevel: 'huge' }] }, /costLevel/);
    await bad({ runs: [{ id: 'r', name: 'empty', failedIds: [], failedLinkIds: ['nope'] }] }, /at least one/);
  });

  it('drops a run link failure when the link is removed by an update', async () => {
    const { call } = await start();
    const doc = scenario({ runs: [{ id: 'r2', name: 'Link fails', failedIds: ['a'], failedLinkIds: ['d-b-a'], createdAt: '2026-01-01T00:00:00.000Z' }] });
    await call('POST', '/api/scenarios', doc);
    const updated = { ...doc, dependencies: doc.dependencies.filter((d) => d.id !== 'd-b-a'), assumptions: [], strategies: [], runs: [{ ...doc.runs[0], failedLinkIds: [] }] };
    const res = await call('PUT', `/api/scenarios/${doc.id}`, updated);
    expect(res.status).toBe(200);
    expect((await res.json()).scenario.runs[0]).toMatchObject({ failedIds: ['a'], failedLinkIds: [] });
  });
});

describe('scenario API', () => {
  it('reports health with an empty store', async () => {
    const { call } = await start();
    expect(await (await call('GET', '/api/health')).json()).toEqual({ ok: true, schemaVersion: SCHEMA_VERSION, scenarios: 0 });
  });

  it('creates, reads, lists, updates and deletes a scenario with every entity type', async () => {
    const { call } = await start();
    const created = await call('POST', '/api/scenarios', scenario());
    expect(created.status).toBe(201);
    const body = (await created.json()).scenario;
    expect(body.assets).toHaveLength(3);
    expect(body.dependencies.find((d) => d.id === 'd-c-b')).toMatchObject({ status: 'inferred', relation: 'power' });
    expect(body.runs[0].failedIds).toEqual(['a']);
    expect(body.strategies[0].backupId).toBe('c');
    expect(body.assumptions.map((a) => a.targetType)).toEqual(['scenario', 'link']);
    expect(body.isSample).toBe(false);

    expect((await call('POST', '/api/scenarios', scenario())).status).toBe(409);
    expect((await (await call('GET', '/api/scenarios')).json()).scenarios).toHaveLength(1);
    expect((await call('GET', '/api/scenarios/sc-1')).status).toBe(200);
    expect((await call('GET', '/api/scenarios/missing')).status).toBe(404);

    const updated = scenario({ name: 'Renamed', assets: [...scenario().assets.map((a) => (a.id === 'a' ? { ...a, x: 120.46, y: 80 } : a)), asset('d')] });
    const put = await (await call('PUT', '/api/scenarios/sc-1', updated)).json();
    expect(put.scenario.name).toBe('Renamed');
    expect(put.scenario.assets).toHaveLength(4);
    expect(put.scenario.assets[0]).toMatchObject({ x: 120.5, y: 80 });

    expect((await call('DELETE', '/api/scenarios/sc-1')).status).toBe(204);
    expect((await call('DELETE', '/api/scenarios/sc-1')).status).toBe(404);
  });

  it('survives a restart: data written before the database is closed is there after reopening', async () => {
    const first = await start();
    await first.call('POST', '/api/scenarios', scenario());
    await first.call('PUT', '/api/scenarios/sc-1', scenario({ description: 'edited before restart' }));
    await new Promise((r) => first.server.close(r));
    first.db.close();
    handles.length = 0;

    const second = await start({ file: first.file });
    const s = (await (await second.call('GET', '/api/scenarios/sc-1')).json()).scenario;
    expect(s.description).toBe('edited before restart');
    expect(s.dependencies).toHaveLength(2);
    expect(s.assumptions).toHaveLength(2);
  });

  it('rejects invalid scenarios with specific messages and leaves stored data untouched', async () => {
    const { call } = await start();
    await call('POST', '/api/scenarios', scenario());
    const cases = [
      [scenario({ dependencies: [dep('a', 'ghost')] }), /unknown asset/],
      [scenario({ dependencies: [dep('a', 'a')] }), /itself/],
      [scenario({ dependencies: [dep('b', 'a', { status: 'maybe' })] }), /status/],
      [scenario({ dependencies: [dep('b', 'a', { relation: 'telepathy' })] }), /relation/],
      [scenario({ dependencies: [dep('b', 'a'), { ...dep('b', 'a'), id: 'other' }] }), /duplicates/],
      [scenario({ assets: [asset('a'), asset('b', { name: 'A' })] , dependencies: [], runs: [], strategies: [], assumptions: []}), /Duplicate asset name/],
      [scenario({ assumptions: [{ id: 'x', text: 'hi', targetType: 'node', targetId: 'ghost' }] }), /unknown asset/],
      [scenario({ assumptions: [{ id: 'x', text: '   ', targetType: 'scenario' }] }), /needs text/],
      [scenario({ assets: [asset('a', { kind: 'banana' })], dependencies: [], runs: [], strategies: [], assumptions: [] }), /kind/],
    ];
    for (const [body, pattern] of cases) {
      const res = await call('PUT', '/api/scenarios/sc-1', body);
      expect(res.status).toBe(400);
      expect(JSON.stringify(await res.json())).toMatch(pattern);
    }
    // The failed writes must not have changed anything.
    const s = (await (await call('GET', '/api/scenarios/sc-1')).json()).scenario;
    expect(s.assets).toHaveLength(3);
    expect(s.dependencies).toHaveLength(2);
  });

  it('rejects malformed requests cleanly', async () => {
    const { call, base } = await start();
    const raw = await fetch(`${base}/api/scenarios`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{oops' });
    expect(raw.status).toBe(400);
    expect((await raw.json()).error).toMatch(/JSON/);
    expect((await call('POST', '/api/scenarios', [])).status).toBe(400);
    await call('POST', '/api/scenarios', scenario());
    expect((await call('PUT', '/api/scenarios/sc-1', scenario({ id: 'other' }))).status).toBe(400);
    expect((await call('PUT', '/api/scenarios/nope', scenario({ id: 'nope' }))).status).toBe(404);
    const missing = await call('GET', '/api/nope');
    expect(missing.status).toBe(404);
    expect((await missing.json()).error).toBeTruthy();
  });

  it('keeps scenario names unique, ignoring case', async () => {
    const { call } = await start();
    await call('POST', '/api/scenarios', scenario());
    const res = await call('POST', '/api/scenarios', scenario({ id: 'sc-2', name: 'TEST SCENARIO' }));
    expect(res.status).toBe(409);
    await call('POST', '/api/scenarios', scenario({ id: 'sc-3', name: 'Other' }));
    expect((await call('PUT', '/api/scenarios/sc-3', scenario({ id: 'sc-3', name: 'test scenario' }))).status).toBe(409);
  });

  it('removing a node through an update cascades to links, runs, strategies in the database', async () => {
    const { call, db } = await start();
    await call('POST', '/api/scenarios', scenario());
    const next = scenario({
      assets: [asset('b'), asset('c')],
      dependencies: [dep('c', 'b', { status: 'inferred' })],
      runs: [],
      strategies: [],
      assumptions: [],
    });
    expect((await call('PUT', '/api/scenarios/sc-1', next)).status).toBe(200);
    expect(db.prepare('SELECT COUNT(*) n FROM links').get().n).toBe(1);
    expect(db.prepare('SELECT COUNT(*) n FROM run_failed_nodes').get().n).toBe(0);
    expect(db.prepare('SELECT COUNT(*) n FROM mitigations').get().n).toBe(0);
  });

  it('duplicates a scenario in the database with a unique name and no sample flag', async () => {
    const { call } = await start();
    await call('POST', '/api/scenarios', scenario());
    const one = (await (await call('POST', '/api/scenarios/sc-1/duplicate', {})).json()).scenario;
    const two = (await (await call('POST', '/api/scenarios/sc-1/duplicate', {})).json()).scenario;
    expect(one.name).toBe('Test scenario (copy)');
    expect(two.name).toBe('Test scenario (copy 2)');
    expect(one.id).not.toBe('sc-1');
    expect(one.dependencies).toHaveLength(2);
    expect(one.assumptions).toHaveLength(2);
    expect(one.isSample).toBe(false);
    expect((await call('POST', '/api/scenarios/sc-1/duplicate', { name: 'Test scenario' })).status).toBe(409);
    expect((await call('POST', '/api/scenarios/sc-1/duplicate', { name: '  ' })).status).toBe(400);
    expect((await call('POST', '/api/scenarios/missing/duplicate', {})).status).toBe(404);
    // Editing the copy leaves the original alone.
    await call('PUT', `/api/scenarios/${one.id}`, { ...one, assets: one.assets.slice(0, 1), dependencies: [], runs: [], strategies: [], assumptions: [] });
    expect((await (await call('GET', '/api/scenarios/sc-1')).json()).scenario.assets).toHaveLength(3);
  });
});

describe('saved reports', () => {
  const content = [
    { t: 'h', level: 1, text: 'Report' },
    { t: 'p', text: 'Hello' },
    { t: 'ul', items: ['one'] },
    { t: 'table', head: ['A', 'B'], rows: [['1', '2']] },
  ];

  it('saves, lists, reads and deletes reports, and removes them with the scenario', async () => {
    const { call, db } = await start();
    await call('POST', '/api/scenarios', scenario());
    const saved = await call('POST', '/api/scenarios/sc-1/reports', { title: 'First', options: { shared: true }, content });
    expect(saved.status).toBe(201);
    const { report } = await saved.json();
    expect((await (await call('GET', '/api/scenarios/sc-1/reports')).json()).reports).toHaveLength(1);
    const full = (await (await call('GET', `/api/scenarios/sc-1/reports/${report.id}`)).json()).report;
    expect(full.content).toEqual(content);
    expect(full.options).toEqual({ shared: true });

    // A report survives edits to the scenario because it is a snapshot.
    await call('PUT', '/api/scenarios/sc-1', scenario({ name: 'Renamed' }));
    expect((await (await call('GET', '/api/scenarios/sc-1/reports')).json()).reports).toHaveLength(1);

    expect((await call('DELETE', `/api/scenarios/sc-1/reports/${report.id}`)).status).toBe(204);
    expect((await call('DELETE', `/api/scenarios/sc-1/reports/${report.id}`)).status).toBe(404);
    await call('POST', '/api/scenarios/sc-1/reports', { title: 'Second', content });
    await call('DELETE', '/api/scenarios/sc-1');
    expect(db.prepare('SELECT COUNT(*) n FROM reports').get().n).toBe(0);
  });

  it('validates reports and requires an existing scenario', async () => {
    const { call } = await start();
    await call('POST', '/api/scenarios', scenario());
    expect((await call('POST', '/api/scenarios/sc-1/reports', { title: '', content })).status).toBe(400);
    expect((await call('POST', '/api/scenarios/sc-1/reports', { title: 'x', content: [] })).status).toBe(400);
    expect((await call('POST', '/api/scenarios/sc-1/reports', { title: 'x', content: [{ t: 'script' }] })).status).toBe(400);
    expect((await call('POST', '/api/scenarios/missing/reports', { title: 'x', content })).status).toBe(404);
    expect((await call('GET', '/api/scenarios/missing/reports')).status).toBe(404);
  });
});

describe('simulated samples', () => {
  it('are valid, labelled as simulated, and contain a mix of link statuses', () => {
    expect(SAMPLES.length).toBeGreaterThanOrEqual(3);
    for (const { doc } of SAMPLES) {
      expect(doc.name.toLowerCase()).toContain('simulated');
      expect(doc.assumptions.some((a) => a.targetType === 'scenario' && /SIMULATED DATA/.test(a.text))).toBe(true);
      expect(new Set(doc.dependencies.map((d) => d.status))).toEqual(new Set(['confirmed', 'inferred', 'unknown']));
      expect(doc.runs.length).toBeGreaterThan(0);
      expect(doc.strategies.length).toBeGreaterThan(0);
    }
  });

  it('are seeded once, can be restored, and are not re-seeded after the user deletes them', async () => {
    const file = path.join(dir, 'seed.db');
    const a = await start({ file, seed: true });
    const list = (await (await a.call('GET', '/api/scenarios')).json()).scenarios;
    expect(list).toHaveLength(SAMPLES.length);
    expect(list.every((s) => s.isSample)).toBe(true);

    await a.call('DELETE', '/api/scenarios');
    await new Promise((r) => a.server.close(r));
    a.db.close();
    handles.length = 0;

    const b = await start({ file, seed: true });
    expect((await (await b.call('GET', '/api/scenarios')).json()).scenarios).toHaveLength(0); // not re-seeded
    const restored = (await (await b.call('POST', '/api/samples/restore')).json()).added;
    expect(restored).toHaveLength(SAMPLES.length);
    expect((await (await b.call('POST', '/api/samples/restore')).json()).added).toHaveLength(0); // idempotent
  });

  it('seeding can be disabled', async () => {
    const { call } = await start({ seed: false });
    expect((await (await call('GET', '/api/scenarios')).json()).scenarios).toHaveLength(0);
  });
});

describe('legacy JSON import (Part 1 data)', () => {
  it('imports a Part 1 db.json once, defaulting the new link fields', async () => {
    const legacy = path.join(dir, 'db.json');
    fs.writeFileSync(
      legacy,
      JSON.stringify({
        scenarios: [
          {
            id: 'old-1',
            name: 'Old scenario',
            description: 'from part 1',
            sector: 'Energy',
            isSample: true,
            createdAt: '2026-02-01T00:00:00.000Z',
            updatedAt: '2026-02-02T00:00:00.000Z',
            assets: [asset('a'), asset('b')].map(({ x, y, ...rest }) => rest),
            dependencies: [{ id: 'd1', dependentId: 'b', providerId: 'a', mode: 'required' }],
            runs: [],
            strategies: [],
          },
          { id: 'broken', name: 'Broken', assets: 'nope' },
        ],
      }),
    );
    const a = await start({ legacy, seed: true });
    const list = (await (await a.call('GET', '/api/scenarios')).json()).scenarios;
    const old = list.find((s) => s.id === 'old-1');
    expect(old).toBeTruthy();
    expect(old.dependencies[0]).toMatchObject({ status: 'confirmed', relation: 'other' });
    expect(old.createdAt).toBe('2026-02-01T00:00:00.000Z');
    expect(old.sampleKey).toBe('metro-corridor');
    expect(list.find((s) => s.id === 'broken')).toBeUndefined();
    // The imported sample occupies the metro key, so seeding adds only the other samples.
    expect(list.filter((s) => s.isSample)).toHaveLength(SAMPLES.length);
    expect(fs.existsSync(legacy)).toBe(true);
  });
});

describe('validation constants', () => {
  it('stay in sync with the web app model', async () => {
    const types = fs.readFileSync(path.join(process.cwd(), 'engine/types.ts'), 'utf8');
    const listIn = (name) => [...types.match(new RegExp(`${name} = \\[([^\\]]+)\\]`))[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(listIn('ASSET_KINDS')).toEqual(V.ASSET_KINDS);
    expect(listIn('CRITICALITIES')).toEqual(V.CRITICALITIES);
    expect(listIn('LINK_STATUSES')).toEqual(V.LINK_STATUSES);
    expect(listIn('RELATIONS')).toEqual(V.RELATIONS);
    expect(listIn('CONFIDENCES')).toEqual(V.CONFIDENCES);
    expect(listIn('MITIGATION_KINDS')).toEqual(V.MITIGATION_KINDS);
    expect(listIn('ESTIMATE_LEVELS')).toEqual(V.ESTIMATE_LEVELS);
  });
});

describe('response headers and caching', () => {
  it('sends hardening headers and never caches API answers', async () => {
    const { call } = await start();
    const res = await call('GET', '/api/health');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-powered-by')).toBeNull();
  });

  it('caches fingerprinted assets for good but makes the HTML shell revalidate', async () => {
    const staticDir = path.join(dir, 'dist');
    fs.mkdirSync(path.join(staticDir, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(staticDir, 'index.html'), '<!doctype html><title>x</title>');
    fs.writeFileSync(path.join(staticDir, 'assets', 'app-abc123.js'), 'console.log(1)');
    fs.writeFileSync(path.join(staticDir, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    const { base } = await start({ staticDir });

    const asset = await fetch(`${base}/assets/app-abc123.js`);
    expect(asset.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    const icon = await fetch(`${base}/favicon.svg`);
    expect(icon.headers.get('cache-control')).toBe('no-cache');
    const page = await fetch(`${base}/app/dashboard`); // client-side route falls back to the shell
    expect(page.status).toBe(200);
    expect(page.headers.get('cache-control')).toBe('no-cache');
    const missingApi = await fetch(`${base}/api/nope`);
    expect(missingApi.status).toBe(404);
  });
});
