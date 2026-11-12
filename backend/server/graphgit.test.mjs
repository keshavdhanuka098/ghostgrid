import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from './app.mjs';
import { bootstrap } from './bootstrap.mjs';
import { MIGRATIONS, openDatabase, SCHEMA_VERSION } from './db.mjs';
import { applyOps, canonicalGraph, diffGraphs, graphHash } from './graphgit/patch.mjs';
import { outcomeFor } from '../engine/graph.ts';
import { explainCascade } from '../engine/analysis.ts';
import { hydrateSimulation } from '../engine/graphGit.ts';

let dir;
let handles;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghostgrid-gg-'));
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

async function start({ file = path.join(dir, 'gg.db') } = {}) {
  const db = openDatabase(file);
  bootstrap(db, { seedSamples: false });
  const app = createApp({ db });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const handle = { db, server, base, file };
  handles.push(handle);
  const call = async (method, url, body) => {
    const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  return { ...handle, call };
}
async function stop(h) {
  await new Promise((r) => h.server.close(r));
  h.db.close();
  handles = handles.filter((x) => x !== h);
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
const scenarioDoc = (over = {}) => ({
  id: 'sc-1',
  name: 'Test scenario',
  description: '',
  sector: 'Energy',
  // a <- b <- c, and d relies on a with an alternate e
  assets: [asset('a'), asset('b', { kind: 'service' }), asset('c', { kind: 'service' }), asset('d', { kind: 'service' }), asset('e')],
  dependencies: [dep('b', 'a'), dep('c', 'b', { status: 'inferred' }), dep('d', 'a', { mode: 'alternate' }), dep('d', 'e', { mode: 'alternate' })],
  runs: [],
  strategies: [],
  assumptions: [],
  ...over,
});

async function withScenario(over) {
  const h = await start();
  const created = await h.call('POST', '/api/scenarios', scenarioDoc(over));
  expect(created.status).toBe(201);
  const list = await h.call('GET', '/api/scenarios/sc-1/branches');
  const main = list.body.branches.find((b) => b.isDefault);
  return { ...h, main };
}

const patch = (h, branchId, op, extra = {}) => h.call('POST', `/api/branches/${branchId}/patches`, { op, ...extra });
const commit = (h, branchId, message = 'Change', extra = {}) => h.call('POST', `/api/branches/${branchId}/commits`, { message, ...extra });
const branchOf = (h, name, extra = {}) => h.call('POST', '/api/scenarios/sc-1/branches', { name, ...extra });
const names = (graph) => graph.assets.map((a) => a.name).sort();

/* ------------------------------------------------------------------ patch engine */

describe('patch engine (pure)', () => {
  const g = () => ({ assets: scenarioDoc().assets, dependencies: scenarioDoc().dependencies });

  it('canonical form and hash ignore ordering but not content', () => {
    const a = g();
    const b = { assets: [...a.assets].reverse(), dependencies: [...a.dependencies].reverse() };
    expect(graphHash(a)).toBe(graphHash(b));
    expect(canonicalGraph(a).assets.map((x) => x.id)).toEqual(['a', 'b', 'c', 'd', 'e']);
    const c = g();
    c.assets[0].criticality = 'low';
    expect(graphHash(c)).not.toBe(graphHash(a));
    expect(graphHash(c, { layout: false })).not.toBe(graphHash(a, { layout: false }));
    const moved = g();
    moved.assets[0].x = 5;
    moved.assets[0].y = 6;
    expect(graphHash(moved)).not.toBe(graphHash(a));
    expect(graphHash(moved, { layout: false })).toBe(graphHash(a, { layout: false }));
  });

  it('does not mutate its input', () => {
    const before = JSON.stringify(g());
    const input = g();
    applyOps(input, [{ type: 'delete_node', nodeId: 'a' }]);
    expect(JSON.stringify(input)).toBe(before);
  });

  it('every operation has an inverse that restores the original graph exactly', () => {
    const ops = [
      { type: 'add_node', node: { name: 'Backup', kind: 'data', criticality: 'low' } },
      { type: 'delete_node', nodeId: 'a' },
      { type: 'modify_node', nodeId: 'b', changes: { name: 'B2', notes: 'hi' } },
      { type: 'set_criticality', nodeId: 'c', criticality: 'critical' },
      { type: 'move_node', nodeId: 'e', x: 10, y: 20 },
      { type: 'add_dependency', dependency: { dependentId: 'e', providerId: 'c', mode: 'required', status: 'unknown', relation: 'data' } },
      { type: 'remove_dependency', dependencyId: 'd-c-b' },
      { type: 'modify_dependency', dependencyId: 'd-b-a', changes: { status: 'unknown', relation: 'data', notes: 'x' } },
      { type: 'replace_provider', dependencyId: 'd-c-b', providerId: 'e' },
      { type: 'set_dependency_mode', dependencyId: 'd-b-a', mode: 'alternate' },
    ];
    for (const op of ops) {
      const { graph, results } = applyOps(g(), [op]);
      expect(graphHash(graph)).not.toBe(graphHash(g()));
      const back = applyOps(graph, results[0].inverse, { strict: true });
      expect(graphHash(back.graph), op.type).toBe(graphHash(g()));
    }
  });

  it('classifies behavioural, structural and layout changes', () => {
    const { results } = applyOps(g(), [
      { type: 'set_dependency_mode', dependencyId: 'd-b-a', mode: 'alternate' },
      { type: 'move_node', nodeId: 'a', x: 1, y: 2 },
      { type: 'set_criticality', nodeId: 'a', criticality: 'low' },
    ]);
    expect(results.map((r) => r.category)).toEqual(['behavioural', 'layout', 'structural']);
  });

  it('rejects behavioural parameters the simulation engine does not have', () => {
    for (const type of ['increase_latency', 'reduce_availability', 'modify_capacity', 'set_failure_threshold', 'set_circuit_breaker', 'set_recovery']) {
      expect(() => applyOps(g(), [{ type, nodeId: 'a', value: 1 }])).toThrow(/not supported/);
    }
    expect(() => applyOps(g(), [{ type: 'drop_table' }])).toThrow(/Unknown operation type/);
    expect(() => applyOps(g(), [{ nodeId: 'a' }])).toThrow(/type is required/);
  });

  it('rejects free-form mutation of fields that have their own operation', () => {
    expect(() => applyOps(g(), [{ type: 'modify_node', nodeId: 'a', changes: { criticality: 'low' } }])).toThrow(/set_criticality/);
    expect(() => applyOps(g(), [{ type: 'modify_node', nodeId: 'a', changes: { id: 'z' } }])).toThrow(/id cannot be changed/);
    expect(() => applyOps(g(), [{ type: 'modify_dependency', dependencyId: 'd-b-a', changes: { mode: 'alternate' } }])).toThrow(/set_dependency_mode/);
    expect(() => applyOps(g(), [{ type: 'modify_dependency', dependencyId: 'd-b-a', changes: { providerId: 'e' } }])).toThrow(/replace_provider/);
  });

  it('refuses stale operations when applied strictly', () => {
    expect(() => applyOps(g(), [{ type: 'set_criticality', nodeId: 'a', criticality: 'low', expect: { criticality: 'medium' } }], { strict: true })).toThrow(/changed since/);
    expect(() => applyOps(g(), [{ type: 'remove_dependency', dependencyId: 'nope' }], { strict: true })).toThrow(/does not exist/);
  });

  it('diff then apply reproduces the target graph', () => {
    const from = g();
    const to = g();
    to.assets = to.assets.filter((a) => a.id !== 'e').map((a) => (a.id === 'b' ? { ...a, name: 'Bee', criticality: 'critical', x: 3, y: 4 } : a));
    to.assets.push(asset('z', { name: 'Zed', kind: 'data' }));
    to.dependencies = to.dependencies.filter((d) => d.providerId !== 'e' && d.id !== 'd-c-b');
    to.dependencies.push(dep('z', 'a', { mode: 'alternate' }));
    to.dependencies.find((d) => d.id === 'd-b-a').status = 'unknown';
    to.dependencies.find((d) => d.id === 'd-d-a').mode = 'required';
    const { graph } = applyOps(from, diffGraphs(from, to), { strict: true });
    expect(graphHash(graph)).toBe(graphHash(to));
  });
});

/* ---------------------------------------------------------------------- branches */

describe('branches', () => {
  it('gives every new scenario a main branch with a baseline commit', async () => {
    const h = await start();
    expect((await h.call('POST', '/api/scenarios', scenarioDoc())).status).toBe(201);
    const { body } = await h.call('GET', '/api/scenarios/sc-1/branches');
    expect(body.branches).toHaveLength(1);
    const main = body.branches[0];
    expect(main).toMatchObject({ name: 'main', isDefault: true, parentBranchId: null, commitCount: 1, pendingPatchCount: 0, scenarioId: 'sc-1' });
    expect(main.baseCommitId).toBe(main.headCommitId);
    expect(main.headCommit).toMatchObject({ kind: 'baseline', message: 'Initial infrastructure baseline', nodeCount: 5, linkCount: 4, parentCommitId: null });
    expect(main.createdAt).toBeTruthy();
    expect(main.updatedAt).toBeTruthy();
    expect(main.ancestry.map((b) => b.name)).toEqual(['main']);
  });

  it('adds main to scenarios saved before Graph Git existed (upgrade from schema v2)', async () => {
    const file = path.join(dir, 'old.db');
    const old = new DatabaseSync(file);
    old.exec('PRAGMA foreign_keys = ON;');
    for (const m of MIGRATIONS.filter((x) => x.version <= 2)) old.exec(m.sql);
    old.exec('PRAGMA user_version = 2');
    old.prepare("INSERT INTO scenarios (id, name, description, sector, created_at, updated_at) VALUES ('legacy', 'Legacy', '', 'Energy', 't', 't')").run();
    old.prepare("INSERT INTO nodes (scenario_id, id, name, kind, criticality, notes, sort_order) VALUES ('legacy','n1','N1','power','high','',0)").run();
    old.close();
    const h = await start({ file });
    expect(h.db.prepare('PRAGMA user_version').get().user_version).toBe(SCHEMA_VERSION);
    const { body } = await h.call('GET', '/api/scenarios/legacy/branches');
    expect(body.branches[0]).toMatchObject({ name: 'main', commitCount: 1 });
    const state = await h.call('GET', `/api/branches/${body.branches[0].id}`);
    expect(state.body.working.assets.map((a) => a.id)).toEqual(['n1']);
  });

  it('creates, lists and describes a feature branch', async () => {
    const { call, main } = await withScenario();
    const created = await branchOf({ call }, 'fix/auth-microservice-timeout', { description: 'Auth timeout fix' });
    expect(created.status).toBe(201);
    const b = created.body.branch;
    expect(b).toMatchObject({
      name: 'fix/auth-microservice-timeout',
      description: 'Auth timeout fix',
      parentBranchId: main.id,
      parentBranchName: 'main',
      baseCommitId: main.headCommitId,
      headCommitId: main.headCommitId,
      isDefault: false,
      commitCount: 0,
    });
    expect(b.ancestry.map((x) => x.name)).toEqual(['main', 'fix/auth-microservice-timeout']);
    expect(created.body.working.assets).toHaveLength(5);
    const list = await call('GET', '/api/scenarios/sc-1/branches');
    expect(list.body.branches.map((x) => x.name)).toEqual(['main', 'fix/auth-microservice-timeout']);
  });

  it('validates names and refuses duplicates', async () => {
    const h = await withScenario();
    for (const name of ['', '   ', 'has space', '/lead', 'trail/', 'a//b', 'a..b', 'x'.repeat(81), 5, null, undefined]) {
      expect((await branchOf(h, name)).status, String(name)).toBe(400);
    }
    expect((await branchOf(h, 'test/one')).status).toBe(201);
    expect((await branchOf(h, 'TEST/ONE')).status).toBe(409);
    expect((await branchOf(h, 'main')).status).toBe(409);
    expect((await branchOf(h, 'ok', { description: 'x'.repeat(301) })).status).toBe(400);
    expect((await h.call('POST', '/api/scenarios/nope/branches', { name: 'x' })).status).toBe(404);
  });

  it('isolates branches: changes in one never touch main or another branch', async () => {
    const h = await withScenario();
    const f1 = (await branchOf(h, 'feature/one')).body.branch;
    const f2 = (await branchOf(h, 'feature/two')).body.branch;
    expect((await patch(h, f1.id, { type: 'delete_node', nodeId: 'a' })).status).toBe(201);
    expect((await commit(h, f1.id, 'Drop a')).status).toBe(201);
    expect((await patch(h, f2.id, { type: 'add_node', node: { name: 'Extra', kind: 'data', criticality: 'low' } })).status).toBe(201);

    const m = (await h.call('GET', `/api/branches/${h.main.id}`)).body;
    expect(names(m.working)).toEqual(['A', 'B', 'C', 'D', 'E']);
    expect(m.branch.headCommitId).toBe(h.main.headCommitId);
    expect(m.dirty).toBe(false);
    const s1 = (await h.call('GET', `/api/branches/${f1.id}`)).body;
    expect(names(s1.working)).toEqual(['B', 'C', 'D', 'E']);
    const s2 = (await h.call('GET', `/api/branches/${f2.id}`)).body;
    expect(names(s2.working)).toEqual(['A', 'B', 'C', 'D', 'E', 'Extra']);
    expect(s2.head.id).toBe(h.main.headCommitId);
    // The scenario's own saved graph is never changed by branch work.
    const live = (await h.call('GET', '/api/scenarios/sc-1')).body.scenario;
    expect(live.assets).toHaveLength(5);
    expect(live.dependencies).toHaveLength(4);
  });

  it('switching branches loads the right saved graph, including uncommitted work', async () => {
    const h = await withScenario();
    const f = (await branchOf(h, 'feature/x')).body.branch;
    await patch(h, f.id, { type: 'set_criticality', nodeId: 'a', criticality: 'low' });
    for (let i = 0; i < 3; i++) {
      const main = (await h.call('GET', `/api/branches/${h.main.id}`)).body;
      expect(main.working.assets.find((a) => a.id === 'a').criticality).toBe('high');
      const feat = (await h.call('GET', `/api/branches/${f.id}`)).body;
      expect(feat.working.assets.find((a) => a.id === 'a').criticality).toBe('low');
      expect(feat.dirty).toBe(true);
    }
  });

  it('creates a branch from a historical commit', async () => {
    const h = await withScenario();
    const f = (await branchOf(h, 'feature/history')).body.branch;
    await patch(h, f.id, { type: 'add_node', node: { name: 'N1', kind: 'data', criticality: 'low' } });
    const c1 = (await commit(h, f.id, 'Add N1')).body.commit;
    await patch(h, f.id, { type: 'add_node', node: { name: 'N2', kind: 'data', criticality: 'low' } });
    await commit(h, f.id, 'Add N2');
    const old = await branchOf(h, 'experiment/from-c1', { fromCommitId: c1.id });
    expect(old.status).toBe(201);
    expect(old.body.branch).toMatchObject({ baseCommitId: c1.id, headCommitId: c1.id, parentBranchId: f.id, parentBranchName: 'feature/history' });
    expect(names(old.body.working)).toEqual(['A', 'B', 'C', 'D', 'E', 'N1']);
    expect((await branchOf(h, 'x/bad', { fromCommitId: 'cm-missing' })).status).toBe(404);
    // from another branch's head
    const fromBranch = await branchOf(h, 'x/from-branch', { fromBranchId: f.id });
    expect(names(fromBranch.body.working)).toEqual(['A', 'B', 'C', 'D', 'E', 'N1', 'N2']);
  });

  it('rejects a commit or branch from another scenario', async () => {
    const h = await withScenario();
    await h.call('POST', '/api/scenarios', scenarioDoc({ id: 'sc-2', name: 'Other' }));
    const other = (await h.call('GET', '/api/scenarios/sc-2/branches')).body.branches[0];
    expect((await branchOf(h, 'x/cross', { fromCommitId: other.headCommitId })).status).toBe(400);
    expect((await branchOf(h, 'x/cross2', { fromBranchId: other.id })).status).toBe(400);
  });

  it('renames a branch and edits its description', async () => {
    const h = await withScenario();
    const f = (await branchOf(h, 'feature/old')).body.branch;
    await new Promise((r) => setTimeout(r, 5));
    const r = await h.call('PATCH', `/api/branches/${f.id}`, { name: 'feature/new', description: 'Renamed' });
    expect(r.status).toBe(200);
    expect(r.body.branch).toMatchObject({ name: 'feature/new', description: 'Renamed', id: f.id });
    expect(r.body.branch.updatedAt >= f.updatedAt).toBe(true);
    expect((await h.call('PATCH', `/api/branches/${f.id}`, { name: 'main' })).status).toBe(409);
    expect((await h.call('PATCH', `/api/branches/${f.id}`, { name: 'bad name' })).status).toBe(400);
    expect((await h.call('PATCH', `/api/branches/${f.id}`, {})).status).toBe(400);
    expect((await h.call('PATCH', `/api/branches/${f.id}`, { name: 'FEATURE/NEW' })).status).toBe(200); // case-only rename of itself
    expect((await h.call('PATCH', '/api/branches/none', { name: 'x' })).status).toBe(404);
  });

  it('deletes safely: never the default branch, never branches others depend on', async () => {
    const h = await withScenario();
    expect((await h.call('DELETE', `/api/branches/${h.main.id}`)).status).toBe(409);

    const parent = (await branchOf(h, 'feature/parent')).body.branch;
    await patch(h, parent.id, { type: 'add_node', node: { name: 'P1', kind: 'data', criticality: 'low' } });
    const pc = (await commit(h, parent.id, 'P1')).body.commit;
    const child = (await branchOf(h, 'feature/child', { fromCommitId: pc.id })).body.branch;

    const blocked = await h.call('DELETE', `/api/branches/${parent.id}`);
    expect(blocked.status).toBe(409);
    expect(blocked.body.details.join(' ')).toMatch(/feature\/child/);
    expect((await h.call('GET', `/api/branches/${parent.id}`)).status).toBe(200);

    // A branch that has built on top of the parent's commits also blocks it.
    await patch(h, child.id, { type: 'add_node', node: { name: 'C1', kind: 'data', criticality: 'low' } });
    await commit(h, child.id, 'C1');
    expect((await h.call('DELETE', `/api/branches/${parent.id}`)).status).toBe(409);

    // Leaf branch deletes cleanly and takes its own commits, patches and simulations with it.
    await h.call('POST', `/api/branches/${child.id}/simulations`, { failedIds: ['a'] });
    expect((await h.call('DELETE', `/api/branches/${child.id}`)).status).toBe(204);
    expect((await h.call('GET', `/api/branches/${child.id}`)).status).toBe(404);
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM branch_simulations').get().n).toBe(0);
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM graph_patches WHERE branch_id = ?').get(child.id).n).toBe(0);
    // Now the parent is free to go; main is untouched throughout.
    expect((await h.call('DELETE', `/api/branches/${parent.id}`)).status).toBe(204);
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM commits').get().n).toBe(1);
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM graph_snapshots').get().n).toBe(1); // orphaned snapshots are removed
    expect((await h.call('GET', `/api/branches/${h.main.id}`)).body.dirty).toBe(false);
    expect((await h.call('DELETE', '/api/branches/none')).status).toBe(404);
  });

  it('deleting a scenario removes its branches and history', async () => {
    const h = await withScenario();
    const f = (await branchOf(h, 'feature/a')).body.branch;
    await patch(h, f.id, { type: 'delete_node', nodeId: 'e' });
    await commit(h, f.id, 'x');
    expect((await h.call('DELETE', '/api/scenarios/sc-1')).status).toBe(204);
    for (const t of ['branches', 'commits', 'graph_snapshots', 'graph_patches', 'branch_simulations']) {
      expect(h.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n, t).toBe(0);
    }
  });

  it('flags scenario edits made outside Graph Git and syncs them to main as a visible commit', async () => {
    const h = await withScenario();
    const before = (await h.call('GET', `/api/branches/${h.main.id}`)).body;
    expect(before.scenarioDrift).toBe(false);
    const live = (await h.call('GET', '/api/scenarios/sc-1')).body.scenario;
    live.assets.push(asset('z', { name: 'Zed' }));
    expect((await h.call('PUT', '/api/scenarios/sc-1', live)).status).toBe(200);
    const after = (await h.call('GET', `/api/branches/${h.main.id}`)).body;
    // Main did not change silently.
    expect(after.head.id).toBe(before.head.id);
    expect(names(after.working)).toEqual(['A', 'B', 'C', 'D', 'E']);
    expect(after.scenarioDrift).toBe(true);
    const f = (await branchOf(h, 'feature/not-default')).body.branch;
    expect((await h.call('POST', `/api/branches/${f.id}/sync-from-scenario`, {})).status).toBe(400);
    const synced = await h.call('POST', `/api/branches/${h.main.id}/sync-from-scenario`, { author: 'Keshav' });
    expect(synced.status).toBe(201);
    expect(synced.body.commit).toMatchObject({ kind: 'sync', author: 'Keshav' });
    expect(synced.body.commit.summary.nodesAdded).toBe(1);
    expect(synced.body.state.scenarioDrift).toBe(false);
    expect((await h.call('POST', `/api/branches/${h.main.id}/sync-from-scenario`, {})).status).toBe(409); // already in sync
  });
});

/* ----------------------------------------------------------------------- patches */

describe('patches', () => {
  let h;
  let f;
  beforeEach(async () => {
    h = await withScenario();
    f = (await branchOf(h, 'feature/patches')).body.branch;
  });
  const state = async () => (await h.call('GET', `/api/branches/${f.id}`)).body;

  it('adds a node', async () => {
    const r = await patch(h, f.id, { type: 'add_node', node: { id: 'n-new', name: 'Backup DB', kind: 'data', criticality: 'critical', notes: 'replica' } });
    expect(r.status).toBe(201);
    expect(r.body.created[0]).toMatchObject({ type: 'add_node', category: 'structural', pending: true, commitId: null, branchId: f.id, baseCommitId: h.main.headCommitId });
    expect(r.body.created[0].description).toMatch(/Add asset "Backup DB"/);
    expect(r.body.working.assets.find((a) => a.id === 'n-new')).toMatchObject({ name: 'Backup DB', criticality: 'critical' });
    expect(r.body.dirty).toBe(true);
    // id is generated when omitted
    const g = await patch(h, f.id, { type: 'add_node', node: { name: 'Gen', kind: 'other', criticality: 'low' } });
    expect(g.body.created[0].op.node.id).toMatch(/^as-/);
  });

  it('deletes a node and its dependencies', async () => {
    const r = await patch(h, f.id, { type: 'delete_node', nodeId: 'b' });
    expect(r.status).toBe(201);
    expect(r.body.created[0].description).toMatch(/Delete asset "B" and 2 dependencies/);
    expect(r.body.working.assets.map((a) => a.id)).not.toContain('b');
    expect(r.body.working.dependencies.map((d) => d.id).sort()).toEqual(['d-d-a', 'd-d-e']);
  });

  it('modifies node properties and criticality', async () => {
    const r = await patch(h, f.id, { type: 'modify_node', nodeId: 'a', changes: { name: 'Grid feed', kind: 'network', notes: 'n' } });
    expect(r.body.working.assets.find((a) => a.id === 'a')).toMatchObject({ name: 'Grid feed', kind: 'network', notes: 'n' });
    const c = await patch(h, f.id, { type: 'set_criticality', nodeId: 'a', criticality: 'critical' });
    expect(c.body.working.assets.find((a) => a.id === 'a').criticality).toBe('critical');
    const m = await patch(h, f.id, { type: 'move_node', nodeId: 'a', x: 40.04, y: 80 });
    expect(m.body.created[0].category).toBe('layout');
    expect(m.body.working.assets.find((a) => a.id === 'a')).toMatchObject({ x: 40, y: 80 });
  });

  it('adds, removes and modifies dependencies, replaces providers and switches mode', async () => {
    const add = await patch(h, f.id, { type: 'add_dependency', dependency: { dependentId: 'e', providerId: 'c', mode: 'required', status: 'inferred', relation: 'data', notes: 'x' } });
    expect(add.status).toBe(201);
    const newDep = add.body.working.dependencies.find((d) => d.dependentId === 'e' && d.providerId === 'c');
    expect(newDep).toMatchObject({ mode: 'required', status: 'inferred', relation: 'data' });
    expect((await patch(h, f.id, { type: 'modify_dependency', dependencyId: newDep.id, changes: { status: 'confirmed', relation: 'power' } })).status).toBe(201);
    const mode = await patch(h, f.id, { type: 'set_dependency_mode', dependencyId: newDep.id, mode: 'alternate' });
    expect(mode.body.created[0].category).toBe('behavioural');
    expect((await patch(h, f.id, { type: 'replace_provider', dependencyId: 'd-c-b', providerId: 'a' })).status).toBe(201);
    expect((await patch(h, f.id, { type: 'remove_dependency', dependencyId: 'd-b-a' })).status).toBe(201);
    const s = await state();
    expect(s.working.dependencies.find((d) => d.id === 'd-c-b').providerId).toBe('a');
    expect(s.working.dependencies.find((d) => d.id === newDep.id)).toMatchObject({ mode: 'alternate', status: 'confirmed', relation: 'power' });
    expect(s.working.dependencies.some((d) => d.id === 'd-b-a')).toBe(false);
    expect(s.patches.map((p) => p.type)).toEqual(['add_dependency', 'modify_dependency', 'set_dependency_mode', 'replace_provider', 'remove_dependency']);
    expect(s.patches.map((p) => p.seq)).toEqual([1, 2, 3, 4, 5]);
  });

  it('rejects invalid patches without saving anything', async () => {
    const bad = [
      [{ type: 'delete_node', nodeId: 'ghost' }, /does not exist/],
      [{ type: 'delete_node' }, /nodeId is required/],
      [{ type: 'add_node', node: { name: '', kind: 'data', criticality: 'low' } }, /name is required/],
      [{ type: 'add_node', node: { name: 'A', kind: 'data', criticality: 'low' } }, /already exists/],
      [{ type: 'add_node', node: { name: 'x'.repeat(61), kind: 'data', criticality: 'low' } }, /60 characters/],
      [{ type: 'add_node', node: { name: 'Q', kind: 'toaster', criticality: 'low' } }, /kind must be/],
      [{ type: 'add_node', node: { name: 'Q', kind: 'data', criticality: 'extreme' } }, /criticality must be/],
      [{ type: 'add_node', node: { id: 'a', name: 'Q', kind: 'data', criticality: 'low' } }, /id "a" already exists/],
      [{ type: 'add_node', node: { name: 'Q', kind: 'data', criticality: 'low', x: 1 } }, /x and y/],
      [{ type: 'add_node' }, /node is required/],
      [{ type: 'modify_node', nodeId: 'a', changes: {} }, /at least one field/],
      [{ type: 'modify_node', nodeId: 'a', changes: { name: 'B' } }, /already exists/],
      [{ type: 'modify_node', nodeId: 'a', changes: { name: 'A' } }, /nothing to change/],
      [{ type: 'set_criticality', nodeId: 'a', criticality: 'high' }, /already high/],
      [{ type: 'set_criticality', nodeId: 'a', criticality: 'nope' }, /criticality must be/],
      [{ type: 'move_node', nodeId: 'a', x: 'left', y: 1 }, /x and y/],
      [{ type: 'add_dependency', dependency: { dependentId: 'a', providerId: 'a', mode: 'required', status: 'confirmed', relation: 'power' } }, /itself/],
      [{ type: 'add_dependency', dependency: { dependentId: 'b', providerId: 'a', mode: 'required', status: 'confirmed', relation: 'power' } }, /already relies/],
      [{ type: 'add_dependency', dependency: { dependentId: 'b', providerId: 'zzz', mode: 'required', status: 'confirmed', relation: 'power' } }, /does not exist/],
      [{ type: 'add_dependency', dependency: { dependentId: 'e', providerId: 'a', mode: 'sometimes', status: 'confirmed', relation: 'power' } }, /mode must be/],
      [{ type: 'add_dependency', dependency: { dependentId: 'e', providerId: 'a', mode: 'required', status: 'certain', relation: 'power' } }, /status must be/],
      [{ type: 'add_dependency', dependency: { dependentId: 'e', providerId: 'a', mode: 'required', status: 'confirmed', relation: 'vibes' } }, /relation must be/],
      [{ type: 'remove_dependency', dependencyId: 'nope' }, /does not exist/],
      [{ type: 'replace_provider', dependencyId: 'd-c-b', providerId: 'b' }, /already the provider/],
      [{ type: 'replace_provider', dependencyId: 'd-c-b', providerId: 'c' }, /itself/],
      [{ type: 'replace_provider', dependencyId: 'd-d-a', providerId: 'e' }, /already relies/],
      [{ type: 'set_dependency_mode', dependencyId: 'd-b-a', mode: 'required' }, /already required/],
      [{ type: 'increase_latency', nodeId: 'a', ms: 200 }, /not supported/],
      [{ type: 'set_circuit_breaker', nodeId: 'a' }, /not supported/],
      [{ type: 'explode' }, /Unknown operation/],
      ['just a string', /must be an object/],
    ];
    for (const [op, pattern] of bad) {
      const r = await patch(h, f.id, op);
      expect(r.status, JSON.stringify(op)).toBe(400);
      expect(r.body.error, JSON.stringify(op)).toMatch(pattern);
    }
    expect((await state()).patches).toHaveLength(0);
    expect((await state()).dirty).toBe(false);
  });

  it('applies a batch atomically: one bad operation saves none', async () => {
    const r = await h.call('POST', `/api/branches/${f.id}/patches`, {
      ops: [
        { type: 'set_criticality', nodeId: 'a', criticality: 'low' },
        { type: 'delete_node', nodeId: 'ghost' },
      ],
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/Operation 2/);
    expect((await state()).patches).toHaveLength(0);
    const ok = await h.call('POST', `/api/branches/${f.id}/patches`, {
      ops: [
        { type: 'add_node', node: { id: 'z', name: 'Z', kind: 'data', criticality: 'low' } },
        { type: 'add_dependency', dependency: { dependentId: 'z', providerId: 'a', mode: 'required', status: 'confirmed', relation: 'data' } },
      ],
    });
    expect(ok.status).toBe(201);
    expect(ok.body.created).toHaveLength(2);
  });

  it('validates the request itself', async () => {
    expect((await h.call('POST', `/api/branches/${f.id}/patches`, {})).status).toBe(400);
    expect((await h.call('POST', `/api/branches/${f.id}/patches`, { ops: [] })).status).toBe(400);
    expect((await h.call('POST', `/api/branches/${f.id}/patches`, { op: { type: 'move_node', nodeId: 'a', x: 1, y: 1 }, ops: [] })).status).toBe(400);
    expect((await h.call('POST', `/api/branches/${f.id}/patches`, { ops: Array(51).fill({ type: 'move_node', nodeId: 'a', x: 1, y: 1 }) })).status).toBe(400);
    expect((await h.call('POST', '/api/branches/none/patches', { op: { type: 'move_node', nodeId: 'a', x: 1, y: 1 } })).status).toBe(404);
    expect((await h.call('POST', `/api/branches/${f.id}/patches`, [1, 2])).status).toBe(400);
    const raw = await fetch(`${h.base}/api/branches/${f.id}/patches`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{nope' });
    expect(raw.status).toBe(400);
    expect((await h.call('GET', `/api/branches/${f.id}/patches?status=weird`)).status).toBe(400);
  });

  it('reverses a patch by appending its inverse, and keeps the original in the record', async () => {
    const first = (await patch(h, f.id, { type: 'delete_node', nodeId: 'b' })).body.created[0];
    const undone = await h.call('POST', `/api/branches/${f.id}/patches/${first.id}/revert`);
    expect(undone.status).toBe(201);
    expect(graphHash(undone.body.working)).toBe(graphHash((await h.call('GET', `/api/branches/${h.main.id}`)).body.working));
    const patches = undone.body.patches;
    expect(patches[0]).toMatchObject({ id: first.id, reverted: true });
    expect(patches.slice(1).every((p) => p.revertsPatchId === first.id)).toBe(true);
    expect((await h.call('POST', `/api/branches/${f.id}/patches/${first.id}/revert`)).status).toBe(409); // already undone
    expect((await h.call('POST', `/api/branches/${f.id}/patches/none/revert`)).status).toBe(404);
  });

  it('refuses to undo a patch that later changes depend on', async () => {
    const add = (await patch(h, f.id, { type: 'add_node', node: { id: 'n1', name: 'N1', kind: 'data', criticality: 'low' } })).body.created[0];
    await patch(h, f.id, { type: 'add_dependency', dependency: { dependentId: 'n1', providerId: 'a', mode: 'required', status: 'confirmed', relation: 'data' } });
    const r = await h.call('POST', `/api/branches/${f.id}/patches/${add.id}/revert`);
    expect(r.status).toBe(409);
    expect((await state()).patches).toHaveLength(2);
  });

  it('merges consecutive moves of one asset into a single patch', async () => {
    await patch(h, f.id, { type: 'move_node', nodeId: 'a', x: 1, y: 1 });
    await patch(h, f.id, { type: 'move_node', nodeId: 'a', x: 2, y: 2 });
    const third = await patch(h, f.id, { type: 'move_node', nodeId: 'a', x: 3, y: 3 });
    expect(third.body.created).toHaveLength(1);
    const s = await state();
    expect(s.patches).toHaveLength(1);
    expect(s.working.assets.find((a) => a.id === 'a')).toMatchObject({ x: 3, y: 3 });
    // undoing the single patch returns the asset to where it started (unpinned)
    const undone = await h.call('POST', `/api/branches/${f.id}/patches/${s.patches[0].id}/revert`);
    expect(undone.body.working.assets.find((a) => a.id === 'a')).toMatchObject({ x: null, y: null });
    await patch(h, f.id, { type: 'move_node', nodeId: 'b', x: 9, y: 9 });
    await patch(h, f.id, { type: 'move_node', nodeId: 'c', x: 9, y: 9 });
    expect((await state()).patches.filter((p) => !p.reverted && p.type === 'move_node' && !p.revertsPatchId)).toHaveLength(2);
  });

  it('discards uncommitted patches', async () => {
    await patch(h, f.id, { type: 'delete_node', nodeId: 'e' });
    const r = await h.call('DELETE', `/api/branches/${f.id}/patches`);
    expect(r.status).toBe(200);
    expect(r.body.dirty).toBe(false);
    expect(r.body.working.assets).toHaveLength(5);
  });

  it('lists patches by status', async () => {
    await patch(h, f.id, { type: 'set_criticality', nodeId: 'a', criticality: 'low' });
    await commit(h, f.id, 'one');
    await patch(h, f.id, { type: 'set_criticality', nodeId: 'b', criticality: 'low' });
    const status = async (s) => (await h.call('GET', `/api/branches/${f.id}/patches?status=${s}`)).body.patches.length;
    expect(await status('all')).toBe(2);
    expect(await status('pending')).toBe(1);
    expect(await status('committed')).toBe(1);
  });

  it('refuses edits that would exceed the pending-change limit', async () => {
    // 50 alternating criticality changes per request: each one is valid, and they add up.
    const toggles = () => Array.from({ length: 50 }, (_, j) => ({ type: 'set_criticality', nodeId: 'a', criticality: j % 2 === 0 ? 'low' : 'high' }));
    for (let i = 0; i < 10; i++) expect((await h.call('POST', `/api/branches/${f.id}/patches`, { ops: toggles() })).status, `batch ${i}`).toBe(201);
    const over = await h.call('POST', `/api/branches/${f.id}/patches`, { ops: toggles() });
    expect(over.status).toBe(409);
    expect(over.body.error).toMatch(/Too many uncommitted changes/);
    expect((await state()).patches).toHaveLength(500);
  });
});

/* ----------------------------------------------------------------------- commits */

describe('commits', () => {
  let h;
  let f;
  beforeEach(async () => {
    h = await withScenario();
    f = (await branchOf(h, 'feature/commits')).body.branch;
  });

  it('creates a commit from pending patches with a change summary', async () => {
    await patch(h, f.id, { type: 'add_node', node: { id: 'bk', name: 'Backup DB', kind: 'data', criticality: 'high' } });
    await patch(h, f.id, { type: 'add_dependency', dependency: { dependentId: 'bk', providerId: 'a', mode: 'required', status: 'confirmed', relation: 'data' } });
    await patch(h, f.id, { type: 'set_dependency_mode', dependencyId: 'd-b-a', mode: 'alternate' });
    await patch(h, f.id, { type: 'move_node', nodeId: 'e', x: 5, y: 5 });
    const r = await commit(h, f.id, 'Add backup database', { body: 'Second copy of data.', author: 'Keshav' });
    expect(r.status).toBe(201);
    const c = r.body.commit;
    expect(c).toMatchObject({ message: 'Add backup database', body: 'Second copy of data.', author: 'Keshav', kind: 'commit', branchId: f.id, branchName: 'feature/commits', parentCommitId: h.main.headCommitId, nodeCount: 6, linkCount: 5 });
    expect(c.summary).toMatchObject({ nodesAdded: 1, depsAdded: 1, depsModified: 1, behavioural: 1, moved: 1, nodesModified: 0 });
    expect(c.summary.lines.join('\n')).toMatch(/Add asset "Backup DB"/);
    expect(c.summary.lines.join('\n')).toMatch(/Moved 1 asset/);
    expect(r.body.state.dirty).toBe(false);
    expect(r.body.state.branch).toMatchObject({ headCommitId: c.id, baseCommitId: h.main.headCommitId, commitCount: 1 });
    // patches are recorded against the commit
    const detail = (await h.call('GET', `/api/commits/${c.id}`)).body;
    expect(detail.patches.map((p) => p.type)).toEqual(['add_node', 'add_dependency', 'set_dependency_mode', 'move_node']);
    expect(detail.patches.every((p) => p.commitId === c.id && !p.pending)).toBe(true);
    expect(detail.graph.assets).toHaveLength(6);
  });

  it('validates commit requests', async () => {
    expect((await commit(h, f.id, 'Nothing')).status).toBe(409);
    await patch(h, f.id, { type: 'set_criticality', nodeId: 'a', criticality: 'low' });
    for (const message of [undefined, '', '   ', 'x'.repeat(121), 'two\nlines', 12]) {
      expect((await h.call('POST', `/api/branches/${f.id}/commits`, { message })).status, String(message)).toBe(400);
    }
    expect((await h.call('POST', `/api/branches/${f.id}/commits`, { message: 'ok', author: 'x'.repeat(81) })).status).toBe(400);
    expect((await h.call('POST', `/api/branches/${f.id}/commits`, { message: 'ok', body: 'x'.repeat(2001) })).status).toBe(400);
    expect((await commit(h, 'none', 'x')).status).toBe(404);
    expect((await commit(h, f.id, 'ok')).status).toBe(201);
    expect((await commit(h, f.id, 'again')).status).toBe(409);
  });

  it('refuses a commit whose changes cancel out', async () => {
    await patch(h, f.id, { type: 'set_criticality', nodeId: 'a', criticality: 'low' });
    await patch(h, f.id, { type: 'set_criticality', nodeId: 'a', criticality: 'high' });
    const r = await commit(h, f.id, 'noop');
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/cancel/);
  });

  it('detects a stale view of the branch', async () => {
    await patch(h, f.id, { type: 'set_criticality', nodeId: 'a', criticality: 'low' });
    expect((await commit(h, f.id, 'stale', { expectedHeadCommitId: 'cm-old' })).status).toBe(409);
    expect((await patch(h, f.id, { type: 'set_criticality', nodeId: 'b', criticality: 'low' }, { expectedHeadCommitId: 'cm-old' })).status).toBe(409);
    expect((await commit(h, f.id, 'fresh', { expectedHeadCommitId: h.main.headCommitId })).status).toBe(201);
  });

  it('snapshots are immutable: later commits and edits never change older ones', async () => {
    await patch(h, f.id, { type: 'set_criticality', nodeId: 'a', criticality: 'low' });
    const c1 = (await commit(h, f.id, 'c1')).body.commit;
    const snap1 = (await h.call('GET', `/api/commits/${c1.id}`)).body;
    await patch(h, f.id, { type: 'delete_node', nodeId: 'a' });
    await commit(h, f.id, 'c2');
    const again = (await h.call('GET', `/api/commits/${c1.id}`)).body;
    expect(again.graph).toEqual(snap1.graph);
    expect(again.commit).toEqual(snap1.commit);
    expect(again.graph.assets.find((a) => a.id === 'a').criticality).toBe('low');
    // The baseline on main is untouched too.
    const base = (await h.call('GET', `/api/commits/${h.main.headCommitId}`)).body;
    expect(base.graph.assets.find((a) => a.id === 'a').criticality).toBe('high');
    // The database itself refuses to rewrite history.
    expect(() => h.db.prepare("UPDATE commits SET message = 'rewritten' WHERE id = ?").run(c1.id)).toThrow(/immutable/);
    expect(() => h.db.prepare("UPDATE graph_snapshots SET graph = '{}' WHERE id = ?").run(c1.snapshotId)).toThrow(/immutable/);
  });

  it('shares identical snapshots between commits', async () => {
    await patch(h, f.id, { type: 'set_criticality', nodeId: 'a', criticality: 'low' });
    const c1 = (await commit(h, f.id, 'c1')).body.commit;
    const g = (await branchOf(h, 'feature/twin', { fromCommitId: h.main.headCommitId })).body.branch;
    await patch(h, g.id, { type: 'set_criticality', nodeId: 'a', criticality: 'low' });
    const c2 = (await commit(h, g.id, 'twin')).body.commit;
    expect(c2.snapshotId).toBe(c1.snapshotId);
    expect(c2.id).not.toBe(c1.id);
  });

  it('lists history with ancestry, newest first, including shared history', async () => {
    await patch(h, f.id, { type: 'add_node', node: { name: 'N1', kind: 'data', criticality: 'low' } });
    const c1 = (await commit(h, f.id, 'First')).body.commit;
    await patch(h, f.id, { type: 'add_node', node: { name: 'N2', kind: 'data', criticality: 'low' } });
    const c2 = (await commit(h, f.id, 'Second')).body.commit;
    // main gets its own commit afterwards; it must not appear in the feature branch's history
    await patch(h, h.main.id, { type: 'set_criticality', nodeId: 'e', criticality: 'low' });
    const m1 = (await commit(h, h.main.id, 'Main only')).body.commit;

    const hist = (await h.call('GET', `/api/branches/${f.id}/commits`)).body;
    expect(hist.commits.map((c) => c.message)).toEqual(['Second', 'First', 'Initial infrastructure baseline']);
    expect(hist.total).toBe(3);
    expect(hist.commits[0].parentCommitId).toBe(c1.id);
    expect(hist.commits[1].parentCommitId).toBe(h.main.headCommitId);
    expect(hist.commits.map((c) => c.branchName)).toEqual(['feature/commits', 'feature/commits', 'main']);
    expect(hist.commits.map((c) => c.id)).not.toContain(m1.id);
    expect(c2.seq).toBeGreaterThan(c1.seq);
    const mainHist = (await h.call('GET', `/api/branches/${h.main.id}/commits`)).body;
    expect(mainHist.commits.map((c) => c.message)).toEqual(['Main only', 'Initial infrastructure baseline']);
    const paged = (await h.call('GET', `/api/branches/${f.id}/commits?limit=1&offset=1`)).body;
    expect(paged.commits.map((c) => c.message)).toEqual(['First']);
    expect(paged.total).toBe(3);
    expect((await h.call('GET', `/api/branches/${f.id}/commits?limit=abc`)).status).toBe(400);
    expect((await h.call('GET', '/api/commits/none')).status).toBe(404);
  });

  it('restores an earlier version as a NEW commit and rewrites nothing', async () => {
    await patch(h, f.id, { type: 'add_node', node: { id: 'n1', name: 'N1', kind: 'data', criticality: 'low' } });
    const c1 = (await commit(h, f.id, 'Add N1')).body.commit;
    await patch(h, f.id, { type: 'delete_node', nodeId: 'a' });
    await patch(h, f.id, { type: 'modify_node', nodeId: 'b', changes: { name: 'Renamed' } });
    const c2 = (await commit(h, f.id, 'Break things')).body.commit;
    const before = (await h.call('GET', `/api/branches/${f.id}/commits`)).body.commits;

    const r = await h.call('POST', `/api/commits/${c1.id}/restore`, { branchId: f.id, author: 'Keshav' });
    expect(r.status).toBe(201);
    const restored = r.body.commit;
    expect(restored).toMatchObject({ kind: 'restore', parentCommitId: c2.id, snapshotId: c1.snapshotId, snapshotHash: c1.snapshotHash });
    expect(restored.message).toMatch(/Restore commit #\d+: Add N1/);
    expect(restored.summary.nodesAdded).toBe(1); // "a" came back
    expect(r.body.state.branch.headCommitId).toBe(restored.id);
    expect(graphHash(r.body.state.working)).toBe(graphHash((await h.call('GET', `/api/commits/${c1.id}`)).body.graph));
    // history only grew
    const after = (await h.call('GET', `/api/branches/${f.id}/commits`)).body.commits;
    expect(after.slice(1)).toEqual(before);
    expect(after[0].id).toBe(restored.id);
    // the commit "Break things" is still there, unchanged
    expect((await h.call('GET', `/api/commits/${c2.id}`)).body.graph.assets.some((a) => a.id === 'a')).toBe(false);
    // patches recorded for the restore
    expect((await h.call('GET', `/api/commits/${restored.id}`)).body.patches.length).toBeGreaterThan(0);
    // restoring something identical to the head is refused
    expect((await h.call('POST', `/api/commits/${restored.id}/restore`, { branchId: f.id })).status).toBe(409);
  });

  it('restoring requires explicit consent to discard uncommitted work', async () => {
    await patch(h, f.id, { type: 'add_node', node: { name: 'N1', kind: 'data', criticality: 'low' } });
    const c1 = (await commit(h, f.id, 'c1')).body.commit;
    await patch(h, f.id, { type: 'delete_node', nodeId: 'e' });
    await commit(h, f.id, 'c2');
    await patch(h, f.id, { type: 'set_criticality', nodeId: 'a', criticality: 'low' });
    const refused = await h.call('POST', `/api/commits/${c1.id}/restore`, { branchId: f.id });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatch(/uncommitted/);
    expect((await h.call('GET', `/api/branches/${f.id}`)).body.dirty).toBe(true); // nothing was lost
    const ok = await h.call('POST', `/api/commits/${c1.id}/restore`, { branchId: f.id, discardPending: true });
    expect(ok.status).toBe(201);
    expect(ok.body.state.dirty).toBe(false);
  });

  it('can restore a commit from another branch onto this one, but not across scenarios', async () => {
    await patch(h, f.id, { type: 'add_node', node: { id: 'n1', name: 'N1', kind: 'data', criticality: 'low' } });
    const c1 = (await commit(h, f.id, 'c1')).body.commit;
    const r = await h.call('POST', `/api/commits/${c1.id}/restore`, { branchId: h.main.id });
    expect(r.status).toBe(201);
    expect(names(r.body.state.working)).toContain('N1');
    await h.call('POST', '/api/scenarios', scenarioDoc({ id: 'sc-2', name: 'Other' }));
    const other = (await h.call('GET', '/api/scenarios/sc-2/branches')).body.branches[0];
    expect((await h.call('POST', `/api/commits/${c1.id}/restore`, { branchId: other.id })).status).toBe(400);
  });

  it('reverts an earlier commit with a new commit, and refuses when later changes conflict', async () => {
    await patch(h, f.id, { type: 'set_criticality', nodeId: 'a', criticality: 'low' });
    const c1 = (await commit(h, f.id, 'Lower a')).body.commit;
    await patch(h, f.id, { type: 'add_node', node: { id: 'n1', name: 'N1', kind: 'data', criticality: 'low' } });
    const c2 = (await commit(h, f.id, 'Add N1')).body.commit;

    const r = await h.call('POST', `/api/commits/${c1.id}/revert`, { branchId: f.id });
    expect(r.status).toBe(201);
    expect(r.body.commit).toMatchObject({ kind: 'revert', message: 'Revert "Lower a"', parentCommitId: c2.id });
    const w = r.body.state.working;
    expect(w.assets.find((a) => a.id === 'a').criticality).toBe('high'); // undone
    expect(w.assets.some((a) => a.id === 'n1')).toBe(true); // later work kept

    // Conflict: someone changed the same thing since.
    await patch(h, f.id, { type: 'set_criticality', nodeId: 'a', criticality: 'critical' });
    await commit(h, f.id, 'Raise a');
    const again = await h.call('POST', `/api/commits/${c1.id}/revert`, { branchId: f.id });
    expect(again.status).toBe(409);
    expect(again.body.error).toMatch(/cannot be reverted cleanly/);
    expect((await h.call('POST', `/api/commits/${h.main.headCommitId}/revert`, { branchId: f.id })).status).toBe(409); // baseline
    // a commit outside this branch's history
    await patch(h, h.main.id, { type: 'set_criticality', nodeId: 'e', criticality: 'low' });
    const mc = (await commit(h, h.main.id, 'Main change')).body.commit;
    expect((await h.call('POST', `/api/commits/${mc.id}/revert`, { branchId: f.id })).status).toBe(400);
  });

  it('refuses to revert an addition that later work builds on', async () => {
    await patch(h, f.id, { type: 'add_node', node: { id: 'n1', name: 'N1', kind: 'data', criticality: 'low' } });
    const c1 = (await commit(h, f.id, 'Add N1')).body.commit;
    await patch(h, f.id, { type: 'add_dependency', dependency: { dependentId: 'n1', providerId: 'a', mode: 'required', status: 'confirmed', relation: 'data' } });
    await commit(h, f.id, 'Wire N1');
    const r = await h.call('POST', `/api/commits/${c1.id}/revert`, { branchId: f.id });
    expect(r.status).toBe(409);
  });

  it('compares commit metadata and content', async () => {
    await patch(h, f.id, { type: 'add_node', node: { name: 'N1', kind: 'data', criticality: 'low' } });
    const c1 = (await commit(h, f.id, 'c1')).body.commit;
    const cmp = await h.call('GET', `/api/commits/compare?from=${h.main.headCommitId}&to=${c1.id}`);
    expect(cmp.status).toBe(200);
    expect(cmp.body).toMatchObject({ relation: 'ancestor', sameContent: false });
    expect(cmp.body.summary.nodesAdded).toBe(1);
    expect(cmp.body.from.message).toBe('Initial infrastructure baseline');
    expect(cmp.body.to.message).toBe('c1');
    const back = (await h.call('GET', `/api/commits/compare?from=${c1.id}&to=${h.main.headCommitId}`)).body;
    expect(back.relation).toBe('descendant');
    expect(back.summary.nodesRemoved).toBe(1);
    expect((await h.call('GET', `/api/commits/compare?from=${c1.id}&to=${c1.id}`)).body).toMatchObject({ relation: 'same', sameContent: true });
    expect((await h.call('GET', '/api/commits/compare?from=x')).status).toBe(400);
    expect((await h.call('GET', `/api/commits/compare?from=${c1.id}&to=missing`)).status).toBe(404);
  });
});

/* --------------------------------------------------------------------- simulations */

describe('branch simulations', () => {
  let h;
  let f;
  beforeEach(async () => {
    h = await withScenario();
    f = (await branchOf(h, 'feature/sim')).body.branch;
  });
  const sim = (branchId, body) => h.call('POST', `/api/branches/${branchId}/simulations`, body);

  it('runs the existing engine on the branch head and records the exact commit', async () => {
    const r = await sim(h.main.id, { failedIds: ['a'], name: 'Grid outage' });
    expect(r.status).toBe(201);
    const s = r.body.simulation;
    expect(s).toMatchObject({ scenarioId: 'sc-1', branchId: h.main.id, commitId: h.main.headCommitId, name: 'Grid outage', failedIds: ['a'], failedLinkIds: [], isCurrent: true });
    expect(s.config).toMatchObject({ engineVersion: 1 });
    expect(s.createdAt).toBeTruthy();
    // Same numbers as the engine the UI uses.
    const graph = (await h.call('GET', `/api/commits/${h.main.headCommitId}`)).body.graph;
    const out = outcomeFor(graph.assets, graph.dependencies, { nodes: ['a'], links: [] });
    expect([...s.result.failed].sort()).toEqual([...out.sim.failed].sort());
    expect(s.result.rounds).toEqual(out.sim.rounds);
    expect(s.totals).toEqual({ failed: out.total, cascaded: out.cascaded, critical: out.critical, rounds: out.sim.rounds.length - 1 });
    expect(s.result.causeKind.b).toBe('required');
    expect(s.result.roundOf).toMatchObject({ a: 0, b: 1, c: 2 });
    // d has alternates a and e: only a is down, so d survives.
    expect(s.result.failed).not.toContain('d');
  });

  it('stored results rehydrate into the engine\'s own simulation object, so the existing explanations work on them', async () => {
    const s = (await sim(h.main.id, { failedIds: ['a'] })).body.simulation;
    const detail = (await h.call('GET', `/api/simulations/${s.id}`)).body.simulation;
    const hydrated = hydrateSimulation(detail.result, detail.graph);
    const direct = outcomeFor(detail.graph.assets, detail.graph.dependencies, { nodes: ['a'], links: [] }).sim;
    expect([...hydrated.failed].sort()).toEqual([...direct.failed].sort());
    expect(hydrated.rounds).toEqual(direct.rounds);
    expect([...hydrated.roundOf]).toEqual([...direct.roundOf]);
    expect([...hydrated.causeKind]).toEqual([...direct.causeKind]);
    expect([...hydrated.causes]).toEqual([...direct.causes]);
    expect([...hydrated.linkDownRound].sort()).toEqual([...direct.linkDownRound].sort());
    expect(explainCascade(hydrated)).toEqual(explainCascade(direct));
  });

  it('supports link failures', async () => {
    const r = await sim(h.main.id, { failedLinkIds: ['d-b-a'] });
    expect(r.status).toBe(201);
    expect([...r.body.simulation.result.failed].sort()).toEqual(['b', 'c']);
    expect(r.body.simulation.result.linkDownRound['d-b-a']).toBe(0);
  });

  it('runs independently per branch: the same failure gives different results', async () => {
    // On the feature branch, d no longer has a redundant alternate: make both d links required.
    await patch(h, f.id, { type: 'set_dependency_mode', dependencyId: 'd-d-a', mode: 'required' });
    await commit(h, f.id, 'Make d depend on a');
    const onMain = (await sim(h.main.id, { failedIds: ['a'] })).body.simulation;
    const onFeature = (await sim(f.id, { failedIds: ['a'] })).body.simulation;
    expect(onMain.result.failed).not.toContain('d');
    expect(onFeature.result.failed).toContain('d');
    expect(onMain.totals.failed).toBe(3);
    expect(onFeature.totals.failed).toBe(4);
    expect(onMain.commitId).toBe(h.main.headCommitId);
    expect(onFeature.commitId).not.toBe(onMain.commitId);
    const featureList = (await h.call('GET', `/api/branches/${f.id}/simulations`)).body.simulations;
    const mainList = (await h.call('GET', `/api/branches/${h.main.id}/simulations`)).body.simulations;
    expect(featureList.map((x) => x.id)).toEqual([onFeature.id]);
    expect(mainList.map((x) => x.id)).toEqual([onMain.id]);
  });

  it('is reproducible', async () => {
    const created = (await sim(h.main.id, { failedIds: ['a', 'e'] })).body.simulation;
    const second = (await sim(h.main.id, { failedIds: ['e', 'a'] })).body.simulation;
    expect([...second.result.failed].sort()).toEqual([...created.result.failed].sort());
    expect(second.result.rounds.map((r) => [...r].sort())).toEqual(created.result.rounds.map((r) => [...r].sort()));
    const read = (await h.call('GET', `/api/simulations/${created.id}`)).body.simulation;
    expect(read.reproducible).toBe(true);
    expect(read.result).toEqual(created.result);
    expect(read.graph.assets).toHaveLength(5);
  });

  it('keeps historical simulations tied to their original commit when the graph changes', async () => {
    const old = (await sim(f.id, { failedIds: ['a'] })).body.simulation;
    expect(old.isCurrent).toBe(true);
    await patch(h, f.id, { type: 'delete_node', nodeId: 'b' });
    const c = (await commit(h, f.id, 'Remove b')).body.commit;

    const list = (await h.call('GET', `/api/branches/${f.id}/simulations`)).body.simulations;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: old.id, commitId: h.main.headCommitId, isCurrent: false });
    const reread = (await h.call('GET', `/api/simulations/${old.id}`)).body.simulation;
    expect(reread.result).toEqual(old.result); // unchanged
    expect(reread.result.failed).toContain('b'); // describes the OLD graph
    expect(reread.graph.assets.some((a) => a.id === 'b')).toBe(true);
    expect(reread.reproducible).toBe(true);
    // A new run on the new commit differs and is recorded against the new commit.
    const fresh = (await sim(f.id, { failedIds: ['a'] })).body.simulation;
    expect(fresh.commitId).toBe(c.id);
    expect(fresh.result.failed).not.toContain('b');
    expect(fresh.isCurrent).toBe(true);
    // Filter by commit
    const byCommit = (await h.call('GET', `/api/branches/${f.id}/simulations?commitId=${h.main.headCommitId}`)).body.simulations;
    expect(byCommit.map((x) => x.id)).toEqual([old.id]);
  });

  it('can simulate an earlier commit in the branch history, never an unrelated one', async () => {
    await patch(h, f.id, { type: 'delete_node', nodeId: 'b' });
    await commit(h, f.id, 'Remove b');
    const atBaseline = await sim(f.id, { failedIds: ['a'], commitId: h.main.headCommitId });
    expect(atBaseline.status).toBe(201);
    expect(atBaseline.body.simulation.commitId).toBe(h.main.headCommitId);
    expect(atBaseline.body.simulation.result.failed).toContain('b');
    // A commit that exists on main only is not part of the feature branch's history.
    await patch(h, h.main.id, { type: 'set_criticality', nodeId: 'e', criticality: 'low' });
    const mc = (await commit(h, h.main.id, 'Main only')).body.commit;
    expect((await sim(f.id, { failedIds: ['a'], commitId: mc.id })).status).toBe(400);
    expect((await sim(f.id, { failedIds: ['a'], commitId: 'cm-nope' })).status).toBe(404);
  });

  it('simulates the committed graph, not uncommitted edits', async () => {
    await patch(h, f.id, { type: 'delete_node', nodeId: 'b' });
    const r = (await sim(f.id, { failedIds: ['a'] })).body.simulation;
    expect(r.commitId).toBe(h.main.headCommitId);
    expect(r.result.failed).toContain('b');
  });

  it('validates simulation requests', async () => {
    const bad = [
      [{}, /at least one/],
      [{ failedIds: [] }, /at least one/],
      [{ failedIds: 'a' }, /array of ids/],
      [{ failedIds: [1] }, /array of ids/],
      [{ failedIds: ['ghost'] }, /does not contain: ghost/],
      [{ failedLinkIds: ['ghost-link'] }, /does not contain/],
      [{ failedIds: ['a'], name: 'x'.repeat(81) }, /80 characters/],
      [{ failedIds: ['a'], name: 5 }, /name must be a string/],
    ];
    for (const [body, pattern] of bad) {
      const r = await sim(h.main.id, body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.body.error).toMatch(pattern);
    }
    expect((await sim('none', { failedIds: ['a'] })).status).toBe(404);
    expect((await h.call('GET', '/api/simulations/none')).status).toBe(404);
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM branch_simulations').get().n).toBe(0);
  });

  it('gives simulations a readable default name', async () => {
    const one = (await sim(h.main.id, { failedIds: ['a'] })).body.simulation;
    expect(one.name).toMatch(/^A outage @ #\d+$/);
    const many = (await sim(h.main.id, { failedIds: ['a', 'e'] })).body.simulation;
    expect(many.name).toMatch(/^2 failures @ #\d+$/);
  });
});

/* --------------------------------------------------------- database and API layer */

describe('database guarantees', () => {
  it('creates the Graph Git tables and indexes', async () => {
    const db = openDatabase(':memory:');
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
    for (const t of ['branches', 'commits', 'graph_snapshots', 'graph_patches', 'branch_simulations']) expect(tables).toContain(t);
    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map((r) => r.name);
    for (const i of ['idx_branches_name', 'idx_branches_default', 'idx_commits_branch', 'idx_commits_parent', 'idx_patches_pending', 'idx_sims_branch', 'idx_sims_commit']) expect(indexes).toContain(i);
    expect(SCHEMA_VERSION).toBe(4);
  });

  it('enforces foreign keys and constraints', async () => {
    const h = await withScenario();
    const sql = (q, ...a) => h.db.prepare(q).run(...a);
    // deferred cross references are checked when the transaction ends
    h.db.exec('BEGIN');
    sql("INSERT INTO commits (id, scenario_id, branch_id, parent_commit_id, snapshot_id, seq, kind, message, body, author, summary, created_at) SELECT 'cm-orphan', scenario_id, 'br-none', NULL, snapshot_id, 999, 'commit', 'x', '', NULL, '{}', 't' FROM commits LIMIT 1");
    expect(() => h.db.exec('COMMIT')).toThrow(/FOREIGN KEY/);
    h.db.exec('ROLLBACK');
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM commits WHERE id = 'cm-orphan'").get().n).toBe(0);
    // immediate foreign keys
    expect(() => sql("INSERT INTO graph_snapshots (id, scenario_id, hash, graph, node_count, link_count, created_at) VALUES ('s','nope','h','{}',0,0,'t')")).toThrow(/FOREIGN KEY/);
    expect(() => sql("INSERT INTO branch_simulations (id, scenario_id, branch_id, commit_id, name, failed_nodes, failed_links, config, result, total_failed, cascaded, critical, rounds, created_at) VALUES ('x','sc-1','br-none','cm-none','n','[]','[]','{}','{}',0,0,0,0,'t')")).toThrow();
    // CHECK constraints
    const f = (await branchOf(h, 'feature/x')).body.branch;
    expect(() => sql("UPDATE branches SET is_default = 1 WHERE id = ?", f.id)).toThrow(/UNIQUE/); // only one default per scenario
    expect(() => sql("INSERT INTO branches (id, scenario_id, name, base_commit_id, head_commit_id, created_at, updated_at) VALUES ('b2','sc-1','FEATURE/X','x','x','t','t')")).toThrow(/UNIQUE/); // names unique, case-insensitive
    expect(() => sql("INSERT INTO graph_patches (id, scenario_id, branch_id, base_commit_id, seq, op_type, category, payload, inverse, description, created_at) VALUES ('p','sc-1',?,?,1,'drop_table','structural','{}','[]','d','t')", f.id, h.main.headCommitId)).toThrow(/CHECK/);
  });

  it('rolls back a failed commit completely: no commit, no snapshot, patches still pending', async () => {
    const h = await withScenario();
    const f = (await branchOf(h, 'feature/tx')).body.branch;
    await patch(h, f.id, { type: 'set_criticality', nodeId: 'a', criticality: 'low' });
    const counts = () => ({
      commits: h.db.prepare('SELECT COUNT(*) AS n FROM commits').get().n,
      snaps: h.db.prepare('SELECT COUNT(*) AS n FROM graph_snapshots').get().n,
      pending: h.db.prepare('SELECT COUNT(*) AS n FROM graph_patches WHERE commit_id IS NULL').get().n,
    });
    const before = counts();
    // Sabotage the final step of the commit, after the commit row and snapshot have been written.
    h.db.exec("CREATE TRIGGER sabotage BEFORE UPDATE OF head_commit_id ON branches BEGIN SELECT RAISE(ABORT, 'simulated failure'); END;");
    const r = await commit(h, f.id, 'will fail');
    expect(r.status).toBe(500);
    expect(counts()).toEqual(before);
    const s = (await h.call('GET', `/api/branches/${f.id}`)).body;
    expect(s.branch.headCommitId).toBe(h.main.headCommitId);
    expect(s.dirty).toBe(true);
    h.db.exec('DROP TRIGGER sabotage');
    expect((await commit(h, f.id, 'now it works')).status).toBe(201);
  });

  it('rolls back a failed restore and a failed branch creation', async () => {
    const h = await withScenario();
    const f = (await branchOf(h, 'feature/tx2')).body.branch;
    await patch(h, f.id, { type: 'delete_node', nodeId: 'e' });
    const c1 = (await commit(h, f.id, 'c1')).body.commit;
    await patch(h, f.id, { type: 'delete_node', nodeId: 'd' });
    await commit(h, f.id, 'c2');
    const before = h.db.prepare('SELECT COUNT(*) AS n FROM commits').get().n;
    h.db.exec("CREATE TRIGGER sabotage BEFORE UPDATE OF head_commit_id ON branches BEGIN SELECT RAISE(ABORT, 'simulated failure'); END;");
    expect((await h.call('POST', `/api/commits/${c1.id}/restore`, { branchId: f.id })).status).toBe(500);
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM commits').get().n).toBe(before);
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM graph_patches WHERE commit_id IS NULL").get().n).toBe(0);
    h.db.exec('DROP TRIGGER sabotage');
    h.db.exec("CREATE TRIGGER sabotage2 BEFORE INSERT ON branches WHEN NEW.name = 'boom/branch' BEGIN SELECT RAISE(ABORT, 'simulated failure'); END;");
    const branchesBefore = h.db.prepare('SELECT COUNT(*) AS n FROM branches').get().n;
    expect((await branchOf(h, 'boom/branch')).status).toBe(500);
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM branches').get().n).toBe(branchesBefore);
  });

  it('handles bad requests and unknown routes consistently', async () => {
    const h = await withScenario();
    expect((await h.call('GET', '/api/branches/nope')).body).toMatchObject({ error: 'Branch not found.' });
    expect((await h.call('GET', '/api/scenarios/nope/branches')).status).toBe(404);
    expect((await h.call('POST', '/api/commits/nope/restore', {})).status).toBe(404);
    expect((await h.call('POST', '/api/commits/nope/revert', {})).status).toBe(404);
    expect((await h.call('GET', '/api/branches/nope/commits')).status).toBe(404);
    expect((await h.call('GET', '/api/branches/nope/simulations')).status).toBe(404);
    expect((await h.call('GET', '/api/graph-git/nothing')).status).toBe(404);
    expect((await h.call('POST', `/api/scenarios/sc-1/branches`, [])).status).toBe(400);
    const bad = await fetch(`${h.base}/api/scenarios/sc-1/branches`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{oops' });
    expect(bad.status).toBe(400);
  });
});

describe('persistence', () => {
  it('keeps branches, commits, patches and simulations after the application restarts', async () => {
    let h = await start();
    await h.call('POST', '/api/scenarios', scenarioDoc());
    const main = (await h.call('GET', '/api/scenarios/sc-1/branches')).body.branches[0];
    const f = (await branchOf(h, 'fix/auth-microservice-timeout', { description: 'Fix' })).body.branch;
    await patch(h, f.id, { type: 'add_node', node: { id: 'cache', name: 'Auth cache', kind: 'data', criticality: 'high' } });
    await patch(h, f.id, { type: 'add_dependency', dependency: { dependentId: 'b', providerId: 'cache', mode: 'alternate', status: 'inferred', relation: 'data' } });
    const c1 = (await commit(h, f.id, 'Add auth cache', { author: 'Keshav' })).body.commit;
    await patch(h, f.id, { type: 'set_criticality', nodeId: 'cache', criticality: 'critical' }); // left uncommitted on purpose
    const sim = (await h.call('POST', `/api/branches/${f.id}/simulations`, { failedIds: ['a'] })).body.simulation;
    const file = h.file;
    await stop(h);

    h = await start({ file });
    const branches = (await h.call('GET', '/api/scenarios/sc-1/branches')).body.branches;
    expect(branches.map((b) => b.name)).toEqual(['main', 'fix/auth-microservice-timeout']);
    const feat = (await h.call('GET', `/api/branches/${f.id}`)).body;
    expect(feat.branch).toMatchObject({ headCommitId: c1.id, description: 'Fix', commitCount: 1, pendingPatchCount: 1 });
    expect(feat.working.assets.find((a) => a.id === 'cache').criticality).toBe('critical'); // uncommitted work survived
    expect(feat.head.graph).toBeUndefined();
    const hist = (await h.call('GET', `/api/branches/${f.id}/commits`)).body.commits;
    expect(hist.map((c) => c.message)).toEqual(['Add auth cache', 'Initial infrastructure baseline']);
    expect(hist[0].author).toBe('Keshav');
    const reread = (await h.call('GET', `/api/simulations/${sim.id}`)).body.simulation;
    expect(reread).toMatchObject({ commitId: c1.id, reproducible: true });
    expect(reread.result).toEqual(sim.result);
    // main is exactly as it was
    const m = (await h.call('GET', `/api/branches/${main.id}`)).body;
    expect(m.branch.headCommitId).toBe(main.headCommitId);
    expect(m.working.assets).toHaveLength(5);
    expect(m.dirty).toBe(false);
    expect((await h.call('GET', '/api/health')).body.schemaVersion).toBe(SCHEMA_VERSION);
  });
});
