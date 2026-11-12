import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS, SCHEMA_VERSION, openDatabase } from '../db.mjs';
import { createScenario } from '../repo.mjs';
import { SAMPLES } from '../samples.mjs';
import { createImportManager } from './dataset-import.mjs';
import { createIntegrations } from './index.mjs';
import { createSecrets } from './config.mjs';
import { createMlStore } from './ml-store.mjs';
import { ROUTES } from './routes.mjs';
import { createWandbService } from './wandb/wandb.service.mjs';
import { KEYS, fakeFetch, geminiReply, goodAnswer, json, memDb, noSleep, quiet, tmpDir, writeExperiment } from './testkit.mjs';

const codeOf = async (p) => (await p.then(() => null, (e) => e)) ?? { code: 'NO_ERROR' };
const bytesResponse = (buf, { status = 200, length = true } = {}) => new Response(buf, { status, headers: length ? { 'content-length': String(buf.length) } : {} });
const GOOD_JSONL = Buffer.from('{"record_id":"a","graph_id":"g1","features":{"x":1},"target":"u"}\n{"record_id":"b","graph_id":"g2","features":{"x":2},"target":"d"}\n');
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const makeZip = (file, entries) => execFileSync('python3', ['-c', 'import sys,json,zipfile\nz=zipfile.ZipFile(sys.argv[1],"w")\nfor k,v in json.loads(sys.argv[2]).items(): z.writestr(k,v)\nz.close()', file, JSON.stringify(entries)]);
const hfPlan = (over = {}) => ({ source: 'huggingface', sourceId: 'org/ds', revision: 'a'.repeat(40), sourceUrl: 'https://huggingface.co/datasets/org/ds', license: 'mit', licenseStatus: 'permissive', expectedBytes: GOOD_JSONL.length, downloads: [{ name: 'train.jsonl', kind: 'file', request: { url: 'https://huggingface.co/datasets/org/ds/resolve/x/train.jsonl', headers: {}, allowedHosts: ['huggingface.co'] }, origin: 'train.jsonl' }], ...over });

describe('dataset import manager', () => {
  let db, root;
  beforeEach(() => { db = memDb(); root = tmpDir(); });
  afterEach(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const mgr = (handler, opts = {}) => createImportManager({ db, backendRoot: root, fetchImpl: fakeFetch(handler), log: quiet, ...opts });
  const finish = async (m, row) => { await m.whenDone(row.id); return m.get(row.id); };

  it('downloads, hashes, validates, records provenance and writes only inside datasets/external', async () => {
    const m = mgr(() => bytesResponse(GOOD_JSONL));
    const row = await finish(m, await m.start(hfPlan()));
    expect(row.status).toBe('downloaded');
    expect(row.files[0].sha256).toBe(sha(GOOD_JSONL));
    expect(row.validation.ok).toBe(true);
    expect(row.localPath.startsWith('datasets/external/huggingface/')).toBe(true);
    const dir = path.join(root, path.dirname(row.localPath));
    const prov = JSON.parse(fs.readFileSync(path.join(dir, 'provenance.json'), 'utf8'));
    expect(prov.sourceUrl).toBe('https://huggingface.co/datasets/org/ds');
    expect(prov.license).toBe('mit');
  });

  it('keeps files that do not match GhostGrid’s record format but marks them as not valid for training', async () => {
    const m = mgr(() => bytesResponse(Buffer.from('a,b\n1,2\n')));
    const row = await finish(m, await m.start(hfPlan({ downloads: [{ name: 'raw.csv', kind: 'file', request: { url: 'https://huggingface.co/x', headers: {}, allowedHosts: ['huggingface.co'] } }] })));
    expect(row.status).toBe('downloaded');
    expect(row.validation.ok).toBe(false);
    expect((await codeOf(m.register(row.id, { file: 'raw.csv', name: 'Raw', version: '1.0.0', acknowledgeLicense: true }))).code).toBe('unsupported');
  });

  it('refuses before downloading when the declared size is over the limit', async () => {
    const m = mgr(() => { throw new Error('must not be called'); }, { limits: { maxBytes: 100 } });
    expect((await codeOf(m.start(hfPlan({ expectedBytes: 5000 })))).code).toBe('too_large');
    expect(db.prepare('SELECT COUNT(*) AS n FROM external_datasets').get().n).toBe(0);
  });

  it('stops a download that exceeds the limit without a Content-Length and leaves nothing behind', async () => {
    const m = mgr(() => bytesResponse(Buffer.alloc(5000, 97), { length: false }), { limits: { maxBytes: 1000 } });
    const row = await finish(m, await m.start(hfPlan({ expectedBytes: null })));
    expect(row.status).toBe('failed');
    expect(row.error).toContain('size limit');
    expect(fs.existsSync(path.join(root, 'datasets/external/huggingface', fs.readdirSync(path.join(root, 'datasets/external/huggingface'))[0] ?? 'none'))).toBe(false);
  });

  it('never overwrites: a second import of the same revision is a conflict, even if the first is in progress', async () => {
    const m = mgr(() => bytesResponse(GOOD_JSONL));
    const first = await m.start(hfPlan());
    expect((await codeOf(m.start(hfPlan()))).code).toBe('conflict');
    await m.whenDone(first.id);
    expect((await codeOf(m.start(hfPlan()))).code).toBe('conflict');
    const stray = path.join(root, 'datasets/external/huggingface/other-ds-bbbbbbbbbbbb');
    fs.mkdirSync(stray, { recursive: true });
    fs.writeFileSync(path.join(stray, 'precious.csv'), 'keep');
    expect((await codeOf(m.start(hfPlan({ sourceId: 'other/ds', revision: 'b'.repeat(40) })))).code).toBe('conflict');
    expect(fs.readFileSync(path.join(stray, 'precious.csv'), 'utf8')).toBe('keep');
  });

  it('reports refused access (gated, no terms accepted) as a failure with an actionable message, and allows a retry', async () => {
    let allow = false;
    const m = mgr(() => (allow ? bytesResponse(GOOD_JSONL) : new Response('gated', { status: 403 })));
    const row = await finish(m, await m.start(hfPlan()));
    expect(row.status).toBe('failed');
    expect(row.error).toContain('terms');
    allow = true;
    expect((await finish(m, await m.start(hfPlan()))).status).toBe('downloaded');
  });

  it('rejects download URLs on hosts that are not allowed, and non-HTTPS URLs', async () => {
    const m = mgr(() => bytesResponse(GOOD_JSONL));
    for (const url of ['https://evil.example/x.csv', 'http://huggingface.co/x.csv']) {
      const row = await finish(m, await m.start(hfPlan({ sourceId: `o/${crypto.randomUUID().slice(0, 6)}`, downloads: [{ name: 'a.csv', kind: 'file', request: { url, headers: {}, allowedHosts: ['huggingface.co'] } }] })));
      expect(row.status).toBe('failed');
    }
  });

  it('extracts a safe ZIP, flattening paths, and records hashes of the extracted files', async () => {
    const zip = path.join(root, 'src.zip');
    makeZip(zip, { 'data/train.jsonl': GOOD_JSONL.toString(), 'README.md': 'hello' });
    const buf = fs.readFileSync(zip);
    const m = mgr(() => bytesResponse(buf));
    const row = await finish(m, await m.start(hfPlan({ source: 'kaggle', sourceId: 'o/z', revision: 'r1', downloads: [{ name: 'dataset.zip', kind: 'zip', request: { url: 'https://www.kaggle.com/api/v1/datasets/download/o/z', headers: {}, allowedHosts: ['www.kaggle.com'] } }] })));
    expect(row.status).toBe('downloaded');
    expect(row.files.map((f) => f.name).sort()).toEqual(['README.md', 'data__train.jsonl']);
    expect(row.validation.ok).toBe(true);
    expect(fs.existsSync(path.join(root, path.dirname(row.localPath), '.download.zip'))).toBe(false);
  });

  it('rejects a malicious ZIP (path traversal, scripts) and removes everything it created', async () => {
    for (const entries of [{ '../../evil.csv': 'x' }, { 'run.sh': 'rm -rf /' }]) {
      const zip = path.join(root, 'bad.zip');
      makeZip(zip, entries);
      const buf = fs.readFileSync(zip);
      const m = mgr(() => bytesResponse(buf));
      const id = `o/${crypto.randomUUID().slice(0, 6)}`;
      const row = await finish(m, await m.start(hfPlan({ source: 'kaggle', sourceId: id, revision: 'r', downloads: [{ name: 'dataset.zip', kind: 'zip', request: { url: 'https://www.kaggle.com/x', headers: {}, allowedHosts: ['www.kaggle.com'] } }] })));
      expect(row.status).toBe('failed');
      expect(row.error).toContain('rejected');
      expect(fs.existsSync(path.join(root, 'evil.csv'))).toBe(false);
      expect(fs.existsSync(path.join(root, '..', 'evil.csv'))).toBe(false);
      expect(fs.readdirSync(path.join(root, 'datasets/external/kaggle')).some((n) => n.startsWith(id.split('/')[1]))).toBe(false);
    }
  });

  it('can be cancelled while downloading, and interrupted imports are marked failed on restart', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const m = mgr(async (url, init) => { await gate; if (init.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' }); return bytesResponse(GOOD_JSONL); });
    const row = await m.start(hfPlan());
    m.cancel(row.id);
    release();
    expect((await finish(m, row)).status).toBe('cancelled');
    db.prepare("INSERT INTO external_datasets (id, source, source_id, revision, source_url, status, local_path, created_at, updated_at) VALUES ('x','kaggle','a/b','','u','downloading','p','t','t')").run();
    expect(m.recoverInterrupted()).toBe(1);
    expect(m.get('x').status).toBe('failed');
  });

  it('registers through register_dataset.py with provenance in --source, enforcing the licence gate', async () => {
    const calls = [];
    const fakePy = async (script, args) => { calls.push({ script, args }); return script === 'register_dataset.py' ? { code: 0, stdout: 'ok', stderr: '' } : (await import('./python.mjs')).runPython(script, args); };
    const m = mgr(() => bytesResponse(GOOD_JSONL), { runPythonImpl: fakePy });
    const row = await finish(m, await m.start(hfPlan({ license: 'cc-by-nc-4.0', licenseStatus: 'restricted' })));
    expect((await codeOf(m.register(row.id, { file: 'train.jsonl', name: 'Ext', version: '1.0.0' }))).code).toBe('forbidden');
    expect((await codeOf(m.register(row.id, { file: 'train.jsonl', name: '../bad', version: '1.0.0', acknowledgeLicense: true }))).code).toBe('bad_request');
    const done = await m.register(row.id, { file: 'train.jsonl', name: 'Ext', version: '1.0.0', acknowledgeLicense: true });
    expect(done.status).toBe('registered');
    const args = calls.find((c) => c.script === 'register_dataset.py').args;
    expect(args[0]).toBe(`${row.localPath}/train.jsonl`);
    expect(args[args.indexOf('--source') + 1]).toContain('https://huggingface.co/datasets/org/ds');
    expect(args[args.indexOf('--license') + 1]).toBe('cc-by-nc-4.0');
    expect((await codeOf(m.register(row.id, { file: 'train.jsonl', name: 'Ext', version: '1.0.1', acknowledgeLicense: true }))).code).toBe('conflict');
  });

  it('only failed or cancelled imports can be removed; downloaded data is never deleted automatically', async () => {
    const m = mgr(() => bytesResponse(GOOD_JSONL));
    const row = await finish(m, await m.start(hfPlan()));
    expect((await codeOf(m.remove(row.id))).code).toBe('conflict');
  });
});

describe('Weights & Biases service', () => {
  let db, root;
  beforeEach(() => { db = memDb(); root = tmpDir(); writeExperiment(root, 'exp_a1'); writeExperiment(root, 'exp_b2', { dataset_fingerprint: 'fp2', validation_metrics: { task: 'classification', accuracy: 0.95, macro_f1: 0.9 } }); });
  afterEach(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const svc = ({ py, env = KEYS, handler = () => json({ data: { viewer: { username: 'me' } } }) } = {}) => {
    const calls = [];
    const f = fakeFetch(handler);
    const w = createWandbService({ db, secrets: createSecrets(env), mlStore: createMlStore({ backendRoot: root }), fetchImpl: f, sleep: noSleep, log: quiet, runPythonImpl: async (script, args, opts) => { calls.push({ script, args, opts }); return py ? py(args, opts) : { code: 0, stdout: JSON.stringify({ run_id: 'gg-x', run_url: 'https://wandb.ai/me/p/runs/gg-x', entity: 'me', project: 'ghostgrid', uploaded_checkpoint: false }), stderr: '' }; } });
    return { w, calls, f };
  };

  it('health requires a real viewer in the GraphQL answer', async () => {
    expect((await svc().w.health()).detail).toContain('me');
    expect((await codeOf(svc({ handler: () => json({ data: { viewer: null } }) }).w.health())).code).toBe('invalid_credentials');
    const none = svc({ env: {} });
    expect((await codeOf(none.w.health())).code).toBe('not_configured');
    expect(none.f.calls).toHaveLength(0);
  });

  it('syncs once, links experiment to run, passes the key only via the child environment, and refuses duplicates', async () => {
    const { w, calls } = svc();
    const link = await w.sync({ experimentId: 'exp_a1' });
    expect(link).toMatchObject({ status: 'synced', runId: 'gg-x', experimentId: 'exp_a1' });
    expect(calls[0].args.join(' ')).not.toContain(KEYS.WANDB_API_KEY);
    expect(calls[0].opts.extraEnv.WANDB_API_KEY).toBe(KEYS.WANDB_API_KEY);
    expect((await codeOf(w.sync({ experimentId: 'exp_a1' }))).code).toBe('conflict');
    expect(calls).toHaveLength(1);
    const listed = (await w.experiments()).find((e) => e.experimentId === 'exp_a1');
    expect(listed.wandb.syncStatus).toBe('synced');
    expect((await w.experiments()).find((e) => e.experimentId === 'exp_b2').wandb.syncStatus).toBe('not_synced');
  });

  it('blocks two simultaneous syncs of the same experiment', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const { w } = svc({ py: async () => { await gate; return { code: 0, stdout: JSON.stringify({ run_id: 'gg-y' }), stderr: '' }; } });
    const first = w.sync({ experimentId: 'exp_a1' });
    // Wait until the first call has really claimed the experiment (it awaits file I/O before claiming, so without this
    // the two calls can resolve in either order and the "loser" would be the first one).
    for (let i = 0; i < 200 && w.linkFor('exp_a1')?.status !== 'pending'; i++) await new Promise((r) => setTimeout(r, 5));
    expect(w.linkFor('exp_a1')?.status).toBe('pending');
    expect((await codeOf(w.sync({ experimentId: 'exp_a1' }))).code).toBe('conflict');
    release();
    expect((await first).status).toBe('synced');
  });

  it('uploads a checkpoint only with the option AND explicit consent', async () => {
    const { w, calls } = svc();
    expect((await codeOf(w.sync({ experimentId: 'exp_a1', uploadCheckpoint: true }))).code).toBe('forbidden');
    expect(calls).toHaveLength(0);
    await w.sync({ experimentId: 'exp_a1', uploadCheckpoint: true, consentToUpload: true });
    expect(calls[0].args).toContain('--upload-checkpoint');
    const { w: w2, calls: c2 } = svc();
    await w2.sync({ experimentId: 'exp_b2' });
    expect(c2[0].args).not.toContain('--upload-checkpoint');
  });

  it('records failures (missing package, W&B duplicate) and lets the user retry', async () => {
    let code = 4;
    const { w } = svc({ py: () => (code === 0 ? { code: 0, stdout: JSON.stringify({ run_id: 'gg-z' }), stderr: '' } : { code, stdout: JSON.stringify({ error: 'x', error_code: 'e' }), stderr: '' }) });
    expect((await codeOf(w.sync({ experimentId: 'exp_a1' }))).code).toBe('unsupported');
    expect(w.linkFor('exp_a1').status).toBe('failed');
    code = 3;
    expect((await codeOf(w.sync({ experimentId: 'exp_a1' }))).code).toBe('conflict');
    code = 0;
    expect((await w.sync({ experimentId: 'exp_a1' })).status).toBe('synced');
  });

  it('works with W&B absent: not configured means no sync, but local experiments still list', async () => {
    const { w, calls } = svc({ env: {} });
    expect((await codeOf(w.sync({ experimentId: 'exp_a1' }))).code).toBe('not_configured');
    expect(calls).toHaveLength(0);
    expect((await w.experiments())).toHaveLength(2);
  });

  it('rejects bad ids and incomplete experiments', async () => {
    writeExperiment(root, 'exp_run1', { status: 'running' });
    const { w } = svc();
    expect((await codeOf(w.sync({ experimentId: '../../etc/passwd' }))).code).toBe('bad_request');
    expect((await codeOf(w.sync({ experimentId: 'exp_run1' }))).code).toBe('bad_request');
    expect((await codeOf(w.sync({ experimentId: 'exp_a1', project: 'bad name!' }))).code).toBe('bad_request');
  });

  it('compares real recorded metrics and warns when datasets differ', async () => {
    const { w } = svc();
    const c = await w.compare(['exp_a1', 'exp_b2']);
    expect(c.comparable).toBe(false);
    expect(c.warnings.join(' ')).toContain('different dataset');
    expect(c.experiments[1].metrics['validation.accuracy']).toBe(0.95);
    writeExperiment(root, 'exp_c3', { validation_metrics: { task: 'classification', accuracy: 0.99, macro_f1: 0.5 } });
    const same = await w.compare(['exp_a1', 'exp_c3']);
    expect(same.comparable).toBe(true);
    expect(same.bestByMetric['validation.accuracy']).toBe('exp_c3');
    expect(same.bestByMetric['validation.macro_f1']).toBe('exp_a1');
    expect((await codeOf(w.compare(['exp_a1']))).code).toBe('bad_request');
  });
});

describe('API handlers on a real database and the real engine', () => {
  let db, root, integ, gemini, prompts;
  beforeEach(() => {
    db = memDb();
    root = tmpDir();
    prompts = [];
    gemini = (body) => geminiReply(body);
    integ = createIntegrations({
      db, env: KEYS, backendRoot: root, log: quiet, sleep: noSleep,
      fetchImpl: fakeFetch((url, init) => {
        if (url.includes('generativelanguage')) { if (init.body) prompts.push(JSON.parse(init.body).contents[0].parts[0].text); return gemini(goodAnswer({ findings: [{ title: 'Real', detail: 'd', severity: 'important', evidence: ['totals.failed'], assetIds: ['northgate', 'ghost-asset'] }] })); }
        return json({});
      }),
    });
  });
  afterEach(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const scenario = () => createScenario(db, SAMPLES[0].doc, { sampleKey: null });
  const H = () => integ.handlers;

  it('explains a simulation the server recomputes itself, labels it as AI output, and strips invented assets', async () => {
    const s = scenario();
    const out = await H().aiAnalyze({ body: { task: 'simulation_explanation', params: { scenarioId: s.id, failedAssetIds: ['northgate'] } } });
    expect(out.aiGenerated).toBe(true);
    expect(out.kind).toBe('ai_interpretation');
    expect(out.notice).toContain('not a simulation');
    expect(out.provider).toBe('gemini');
    expect(out.content.findings[0].assetIds).toEqual(['northgate']);
    expect(out.content.caveats.join(' ')).toContain('did not match your data');
    expect(prompts[0]).toContain('"totals":{"failed":11,"cascaded":10');
    expect(out.grounding.items.join(' ')).toContain('11 assets failed');
  });

  it('refuses failures that are not part of the scenario and unknown tasks', async () => {
    const s = scenario();
    expect((await codeOf(H().aiAnalyze({ body: { task: 'simulation_explanation', params: { scenarioId: s.id, failedAssetIds: ['made-up'] } } }))).code).toBe('bad_request');
    expect((await codeOf(H().aiAnalyze({ body: { task: 'write_poetry' } }))).code).toBe('bad_request');
    expect((await codeOf(H().aiAnalyze({ body: { task: 'infrastructure_analysis', params: { scenarioId: 'nope' } } }))).code).toBe('not_found');
    expect(prompts).toHaveLength(0);
  });

  it('infrastructure analysis sends the real graph and metrics from the Python extractor', async () => {
    const s = scenario();
    const out = await H().aiAnalyze({ body: { task: 'infrastructure_analysis', params: { scenarioId: s.id, mode: 'recommendations' } } });
    expect(out.grounding.items.join(' ')).toContain('13 assets');
    expect(prompts[0]).toContain('single_point_of_failure_count');
  });

  it('explains only recorded experiment results and notes when no test evaluation exists', async () => {
    writeExperiment(root, 'exp_e1');
    const out = await H().aiAnalyze({ body: { task: 'model_evaluation', params: { experimentId: 'exp_e1' } } });
    expect(out.grounding.notes.join(' ')).toContain('No held-out test');
    expect(prompts[0]).toContain('"accuracy":0.9');
    expect((await codeOf(H().aiAnalyze({ body: { task: 'model_evaluation', params: { experimentId: 'exp_missing' } } }))).code).toBe('not_found');
  });

  it('turns AI off cleanly: nothing else is affected and no request is made', async () => {
    H().setEnabled({ params: { id: 'gemini' }, body: { enabled: false } });
    H().setEnabled({ params: { id: 'groq' }, body: { enabled: false } });
    const s = scenario();
    expect((await codeOf(H().aiAnalyze({ body: { task: 'infrastructure_analysis', params: { scenarioId: s.id } } }))).code).toBe('not_configured');
    expect(prompts).toHaveLength(0);
    expect(H().mlDatasets).toBeTruthy();
    expect((await H().mlExperiments()).experiments).toEqual([]);
  });

  it('persists the provider preference and rate-limits its own AI endpoint', async () => {
    expect(H().aiSetPreferences({ body: { provider: 'groq', fallback: false } }).preferences).toEqual({ provider: 'groq', fallback: false });
    expect((await codeOf(H().aiAnalyze({ body: { task: 'experiment_summary' } }))).code).toBe('bad_request'); // nothing to summarise yet
    expect(() => H().aiSetPreferences({ body: { provider: 'skynet' } })).toThrow();
  });

  it('downloads need confirmation, non-permissive licences need acknowledgement, and gated repos need a token', async () => {
    expect((await codeOf(H().hfImport({ body: { id: 'org/ds', files: ['a.csv'] } }))).code).toBe('bad_request');
    expect((await codeOf(H().kaggleImport({ body: { ref: 'bad ref', confirmDownload: true } }))).code).toBe('bad_request');
    const noToken = createIntegrations({ db, env: {}, backendRoot: root, log: quiet, sleep: noSleep, fetchImpl: fakeFetch(() => json({ id: 'org/ds', sha: 'a'.repeat(40), gated: 'manual', tags: ['license:mit'], siblings: [{ rfilename: 'a.csv', size: 3 }] })) });
    const e = await codeOf(noToken.handlers.hfImport({ body: { id: 'org/ds', files: ['a.csv'], confirmDownload: true } }));
    expect(e.code).toBe('forbidden');
    const restricted = createIntegrations({ db, env: {}, backendRoot: root, log: quiet, sleep: noSleep, fetchImpl: fakeFetch(() => json({ id: 'org/nc', sha: 'a'.repeat(40), tags: ['license:cc-by-nc-4.0'], siblings: [{ rfilename: 'a.csv', size: 3 }] })) });
    expect((await codeOf(restricted.handlers.hfImport({ body: { id: 'org/nc', files: ['a.csv'], confirmDownload: true } }))).code).toBe('forbidden');
    expect((await codeOf(restricted.handlers.hfImport({ body: { id: 'org/nc', files: ['data.parquet'], confirmDownload: true, acknowledgeLicense: true } }))).code).toBe('bad_request');
  });

  it('associates an external model with a local experiment, once', async () => {
    const modelHandler = () => json({ id: 'org/model', sha: 'c'.repeat(40), tags: ['license:apache-2.0'] });
    const i2 = createIntegrations({ db, env: {}, backendRoot: root, log: quiet, sleep: noSleep, fetchImpl: fakeFetch(modelHandler) });
    writeExperiment(root, 'exp_m1');
    const r = await i2.handlers.modelRefsCreate({ body: { repoId: 'org/model', experimentId: 'exp_m1', note: 'baseline' } });
    expect(r.reference).toMatchObject({ repoId: 'org/model', experimentId: 'exp_m1', license: 'apache-2.0' });
    expect((await codeOf(i2.handlers.modelRefsCreate({ body: { repoId: 'org/model', experimentId: 'exp_m1' } }))).code).toBe('conflict');
    expect((await codeOf(i2.handlers.modelRefsCreate({ body: { repoId: 'org/model', experimentId: 'exp_nope' } }))).code).toBe('not_found');
    expect(i2.handlers.modelRefsList().references).toHaveLength(1);
  });

  it('never returns a credential in any response', async () => {
    const s = scenario();
    await H().checkHealth({ body: { force: true } });
    const outputs = [H().list(), await H().checkHealth({ body: {} }), H().aiStatus(), await H().aiAnalyze({ body: { task: 'infrastructure_analysis', params: { scenarioId: s.id } } })];
    const text = JSON.stringify(outputs);
    for (const v of Object.values(KEYS)) expect(text).not.toContain(v);
    expect(text).not.toContain('SECRET');
  });
});

describe('routes and database', () => {
  it('every route maps to an existing handler, and none is declared twice', () => {
    const integ = createIntegrations({ db: memDb(), env: {}, log: quiet });
    const seen = new Set();
    for (const [method, p, name] of ROUTES) {
      expect(typeof integ.handlers[name]).toBe('function');
      expect(seen.has(`${method} ${p}`)).toBe(false);
      seen.add(`${method} ${p}`);
    }
  });

  it('upgrades a v3 database in place without touching existing data', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'old.db');
    const old = new DatabaseSync(file);
    old.exec('PRAGMA foreign_keys = ON');
    for (const m of MIGRATIONS.filter((x) => x.version <= 3)) old.exec(m.sql);
    old.exec('PRAGMA user_version = 3');
    old.prepare("INSERT INTO scenarios (id, name, sector, created_at, updated_at) VALUES ('s1', 'Kept', 'Mixed / regional', 't', 't')").run();
    old.close();
    const db = openDatabase(file);
    expect(db.prepare('PRAGMA user_version').get().user_version).toBe(SCHEMA_VERSION);
    expect(db.prepare('SELECT name FROM scenarios WHERE id = ?').get('s1').name).toBe('Kept');
    expect(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name IN ('external_datasets','wandb_syncs','model_references','integration_settings','integration_health')").get().n).toBe(5);
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('the application starts with no keys at all', async () => {
    const db = memDb();
    const integ = createIntegrations({ db, env: {}, log: quiet });
    const list = integ.handlers.list();
    expect(list.integrations.every((i) => i.configured === false)).toBe(true);
    expect(list.integrations.find((i) => i.id === 'gemini').state).toBe('not_configured');
    const checked = await integ.handlers.checkHealth({ body: {} }).catch((e) => e);
    expect(checked.integrations).toBeTruthy();
  });
});

describe('Express adapter (exercised with a fake router, since Express is not installed in the test sandbox)', () => {
  const fakeRouter = () => {
    const table = {};
    const router = new Proxy({}, { get: (_, method) => (path, fn) => { table[`${String(method).toUpperCase()} ${path}`] = fn; } });
    return { router, table };
  };
  const fakeRes = () => {
    const r = { code: 200, headers: {}, body: undefined };
    r.status = (c) => { r.code = c; return r; };
    r.json = (b) => { r.body = b; return r; };
    r.setHeader = (k, v) => { r.headers[k] = v; };
    return r;
  };
  it('registers every route, returns success statuses, and maps integration errors to JSON without leaking details', async () => {
    const { mountRoutes } = await import('./routes.mjs');
    const { IntegrationError } = await import('./errors.mjs');
    const { router, table } = fakeRouter();
    const handlers = Object.fromEntries(ROUTES.map(([, , name]) => [name, async () => ({ ok: name })]));
    handlers.aiAnalyze = async () => { throw new IntegrationError('rate_limited', 'Slow down.', { provider: 'Gemini', retryAfterSec: 12.2 }); };
    mountRoutes(router, handlers);
    expect(Object.keys(table)).toHaveLength(ROUTES.length);
    const ok = fakeRes();
    await table['POST /huggingface/imports']({ params: {}, query: {}, body: {} }, ok, () => {});
    expect(ok.code).toBe(202);
    const limited = fakeRes();
    await table['POST /ai/analyze']({ params: {}, query: {}, body: {} }, limited, () => {});
    expect(limited.code).toBe(429);
    expect(limited.headers['Retry-After']).toBe('13');
    expect(limited.body).toEqual({ error: 'Slow down.', code: 'rate_limited', provider: 'Gemini', retryAfterSec: 12.2 });
  });
  it('passes unexpected errors to the app error handler instead of answering with internals', async () => {
    const { mountRoutes } = await import('./routes.mjs');
    const { router, table } = fakeRouter();
    mountRoutes(router, Object.fromEntries(ROUTES.map(([, , n]) => [n, async () => { throw new Error('boom with secret'); }])), { log: () => {} });
    let passed;
    const res = fakeRes();
    await table['GET /']({ params: {}, query: {}, body: {} }, res, (e) => { passed = e; });
    expect(passed.message).toContain('boom');
    expect(res.body).toBeUndefined();
  });
});
