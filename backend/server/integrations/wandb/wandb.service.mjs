import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { IntegrationError } from '../errors.mjs';
import { basicAuth, requestJson } from '../http.mjs';
import { parseJsonOutput, runPython } from '../python.mjs';

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const nowIso = () => new Date().toISOString();

const toLink = (r) => r && ({ experimentId: r.experiment_id, runId: r.run_id, runUrl: r.run_url, entity: r.entity, project: r.project, status: r.status, uploadedCheckpoint: r.uploaded_checkpoint === 1, error: r.error, createdAt: r.created_at, syncedAt: r.synced_at });

/**
 * Weights & Biases is strictly optional. Logging runs in the official Python SDK (ml/tracking), started by this service
 * on request; this module never blocks or alters local training. One GhostGrid experiment maps to at most one W&B run.
 */
export function createWandbService({ db, secrets, mlStore, fetchImpl, sleep, log, python, runPythonImpl = runPython }) {
  const baseUrl = () => {
    const u = secrets.env('WANDB_BASE_URL', 'https://api.wandb.ai');
    return /^https:\/\//.test(u) ? u.replace(/\/$/, '') : 'https://api.wandb.ai';
  };
  const defaults = () => ({ project: secrets.env('WANDB_PROJECT', 'ghostgrid'), entity: secrets.env('WANDB_ENTITY', '') || undefined });

  async function health() {
    if (!secrets.isConfigured('wandb')) throw new IntegrationError('not_configured', 'W&B is not configured. Set WANDB_API_KEY in backend/.env.', { provider: 'Weights & Biases' });
    const { data } = await requestJson({
      provider: 'Weights & Biases',
      url: `${baseUrl()}/graphql`,
      method: 'POST',
      headers: { Authorization: basicAuth('api', secrets.get('WANDB_API_KEY')) },
      body: { query: 'query GhostGridViewer { viewer { username entity } }' },
      fetchImpl, sleep, log, secretValues: secrets.values(), timeoutMs: 8000, retries: 0,
    });
    const viewer = data?.data?.viewer;
    if (!viewer) throw new IntegrationError('invalid_credentials', 'Weights & Biases did not accept the configured API key.', { provider: 'Weights & Biases' });
    return { detail: `Key accepted for ${viewer.username ?? 'your account'}.`, account: viewer.username ?? null };
  }

  const links = () => db.prepare('SELECT * FROM wandb_syncs ORDER BY created_at DESC').all().map(toLink);
  const linkFor = (id) => toLink(db.prepare('SELECT * FROM wandb_syncs WHERE experiment_id = ?').get(id));

  /** Local experiments plus where each one stands with W&B (from this database, or from the record when training synced it itself). */
  async function experiments() {
    const rows = new Map(links().map((l) => [l.experimentId, l]));
    return (await mlStore.listExperiments()).map((e) => {
      const db_ = rows.get(e.experimentId);
      const rec = e.tracking?.wandb;
      const link = db_ ?? (rec ? { experimentId: e.experimentId, runId: rec.run_id ?? null, runUrl: rec.run_url ?? null, project: rec.project ?? null, entity: rec.entity ?? null, status: rec.status === 'synced' ? 'synced' : 'failed', error: rec.error ?? null, syncedAt: rec.synced_at ?? null } : null);
      return { ...e, wandb: link ? { ...link, syncStatus: link.status } : { syncStatus: 'not_synced' } };
    });
  }

  async function sync({ experimentId, project, entity, uploadCheckpoint = false, consentToUpload = false, update = false }) {
    if (!secrets.isConfigured('wandb')) throw new IntegrationError('not_configured', 'W&B is not configured. Set WANDB_API_KEY in backend/.env.', { provider: 'Weights & Biases' });
    const d = defaults();
    const proj = project ?? d.project;
    const ent = entity ?? d.entity;
    if (!NAME.test(proj) || (ent !== undefined && !NAME.test(ent))) throw new IntegrationError('bad_request', 'Invalid W&B project or entity name.', { provider: 'GhostGrid' });
    const { summary } = await mlStore.getExperiment(experimentId);
    if (summary.status !== 'completed') throw new IntegrationError('bad_request', 'Only completed experiments can be synchronised.', { provider: 'GhostGrid' });
    // Uploading model files is opt-in twice over (the option and an explicit consent flag), because they may be sensitive.
    const upload = uploadCheckpoint === true && consentToUpload === true;
    if (uploadCheckpoint === true && !upload) throw new IntegrationError('forbidden', 'Uploading the model checkpoint needs your explicit consent.', { provider: 'GhostGrid' });

    const existing = linkFor(experimentId);
    const synced = existing?.status === 'synced' || summary.tracking?.wandb?.status === 'synced';
    if (synced && !update) throw new IntegrationError('conflict', 'This experiment is already linked to a W&B run. Nothing was logged twice.', { provider: 'GhostGrid' });
    if (!synced && update) throw new IntegrationError('conflict', 'There is no W&B run to update for this experiment.', { provider: 'GhostGrid' });
    if (existing?.status === 'pending') throw new IntegrationError('conflict', 'A synchronisation for this experiment is already running.', { provider: 'GhostGrid' });

    if (!update) {
      try {
        if (existing) db.prepare("UPDATE wandb_syncs SET status = 'pending', error = NULL, project = ?, entity = ? WHERE experiment_id = ?").run(proj, ent ?? null, experimentId);
        else db.prepare("INSERT INTO wandb_syncs (experiment_id, project, entity, status, created_at) VALUES (?, ?, ?, 'pending', ?)").run(experimentId, proj, ent ?? null, nowIso());
      } catch {
        throw new IntegrationError('conflict', 'A synchronisation for this experiment is already running.', { provider: 'GhostGrid' });
      }
    }
    const fail = (code, message) => {
      if (!update) db.prepare("UPDATE wandb_syncs SET status = 'failed', error = ? WHERE experiment_id = ?").run(message, experimentId);
      throw new IntegrationError(code, message, { provider: 'Weights & Biases' });
    };
    const wbDir = path.join(os.tmpdir(), 'ghostgrid-wandb');
    fs.mkdirSync(wbDir, { recursive: true });
    const args = [experimentId, '--project', proj, ...(ent ? ['--entity', ent] : []), ...(upload ? ['--upload-checkpoint'] : []), ...(update ? ['--update'] : [])];
    let res;
    try {
      res = await runPythonImpl('sync_wandb.py', args, {
        python, timeoutMs: 180000,
        extraEnv: { WANDB_API_KEY: secrets.get('WANDB_API_KEY'), WANDB_BASE_URL: baseUrl(), WANDB_DIR: wbDir, WANDB_CACHE_DIR: wbDir, WANDB_CONFIG_DIR: wbDir, WANDB_SILENT: 'true', WANDB_DISABLE_GIT: 'true', WANDB_DISABLE_CODE: 'true' },
      });
    } catch (err) {
      return fail('unavailable', err.message);
    }
    const out = parseJsonOutput(res.stdout);
    if (res.code === 0 && out?.run_id) {
      db.prepare("UPDATE wandb_syncs SET run_id = ?, run_url = ?, entity = ?, project = ?, status = 'synced', uploaded_checkpoint = MAX(uploaded_checkpoint, ?), error = NULL, synced_at = ? WHERE experiment_id = ?")
        .run(out.run_id, out.run_url ?? null, out.entity ?? ent ?? null, out.project ?? proj, out.uploaded_checkpoint ? 1 : 0, nowIso(), experimentId);
      return linkFor(experimentId);
    }
    if (res.code === 4) return fail('unsupported', 'The wandb Python package is not installed. Run: pip install wandb');
    if (res.code === 3) return fail('conflict', 'W&B already has a run for this experiment. Nothing was logged twice.');
    return fail('unavailable', `Synchronisation failed${out?.error ? `: ${String(out.error).slice(0, 160)}` : '.'}`);
  }

  /** Side-by-side comparison of recorded metrics. Runs are only called comparable when task and dataset fingerprint match. */
  async function compare(ids) {
    const list = [...new Set(ids)].slice(0, 6);
    if (list.length < 2) throw new IntegrationError('bad_request', 'Choose at least two experiments to compare.', { provider: 'GhostGrid' });
    const all = new Map((await experiments()).map((e) => [e.experimentId, e]));
    const picked = list.map((id) => {
      const e = all.get(id);
      if (!e) throw new IntegrationError('not_found', `Experiment ${id} was not found.`, { provider: 'GhostGrid' });
      return e;
    });
    const flat = (e) => ({ ...scalars('validation', e.validationMetrics), ...scalars('test', e.testMetrics) });
    const rows = picked.map((e) => ({ experimentId: e.experimentId, modelName: e.modelName, modelVersion: e.modelVersion, task: e.task, datasetVersion: e.datasetVersion, datasetFingerprint: e.datasetFingerprint, hyperparameters: e.hyperparameters, metrics: flat(e), wandb: e.wandb }));
    const warnings = [];
    if (new Set(rows.map((r) => r.task)).size > 1) warnings.push('The experiments solve different tasks, so their metrics are not comparable.');
    if (new Set(rows.map((r) => r.datasetFingerprint ?? 'unknown')).size > 1) warnings.push('The experiments used different dataset fingerprints. Differences may come from the data, not the model.');
    const comparable = warnings.length === 0;
    const best = {};
    if (comparable) for (const key of new Set(rows.flatMap((r) => Object.keys(r.metrics)))) {
      const lowerIsBetter = /mae|rmse|loss/.test(key);
      const have = rows.filter((r) => key in r.metrics);
      if (have.length > 1) best[key] = have.reduce((a, b) => ((lowerIsBetter ? b.metrics[key] < a.metrics[key] : b.metrics[key] > a.metrics[key]) ? b : a)).experimentId;
    }
    return { experiments: rows, comparable, warnings, bestByMetric: best };
  }

  return { health, sync, experiments, compare, links, linkFor, defaults };
}

function scalars(prefix, m) {
  const out = {};
  for (const [k, v] of Object.entries(m ?? {})) if (typeof v === 'number' && Number.isFinite(v)) out[`${prefix}.${k}`] = v;
  return out;
}
