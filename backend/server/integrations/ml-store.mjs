import fs from 'node:fs/promises';
import path from 'node:path';
import { IntegrationError } from './errors.mjs';
import { backendRoot as defaultRoot, parseJsonOutput, runPython } from './python.mjs';

const EXPERIMENT_ID = /^exp_[A-Za-z0-9_]{1,80}$/;
export const isExperimentId = (v) => typeof v === 'string' && EXPERIMENT_ID.test(v);

/** Joins `rel` under `base` and refuses anything that would leave it (including via symlinks, checked by the caller's realpath use). */
export function resolveInside(base, rel) {
  const root = path.resolve(base);
  const full = path.resolve(root, rel);
  if (full !== root && !full.startsWith(root + path.sep)) throw new IntegrationError('bad_request', 'That path is outside the allowed folder.');
  return full;
}

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return undefined;
    throw new IntegrationError('bad_response', `A local file is not readable JSON (${path.basename(file)}).`);
  }
}

/**
 * Read-only view of the existing ML workspace (ml/experiments, datasets/manifests). It never writes there: training and
 * registration stay owned by the Python pipeline and scripts.
 */
export function createMlStore({ backendRoot = defaultRoot, python } = {}) {
  const experimentsDir = path.join(backendRoot, 'ml', 'experiments');
  const datasetsDir = path.join(backendRoot, 'datasets');

  const summarise = (r) => ({
    experimentId: r.experiment_id,
    status: r.status,
    task: r.task ?? null,
    modelName: r.model_name ?? null,
    modelVersion: r.model_version ?? null,
    datasetVersion: r.dataset_version ?? null,
    datasetFingerprint: r.dataset_fingerprint ?? null,
    startedAt: r.started_at ?? null,
    completedAt: r.completed_at ?? null,
    trainRecords: r.train_records ?? null,
    validationRecords: r.validation_records ?? null,
    testRecords: r.test_records ?? null,
    validationMetrics: r.validation_metrics ?? null,
    testMetrics: r.test_metrics ?? null,
    hyperparameters: r.hyperparameters ?? {},
    productionReady: r.production_ready === true,
    error: r.error ?? null,
    tracking: r.tracking?.wandb ? { wandb: r.tracking.wandb } : null,
  });

  async function listExperiments() {
    let names;
    try {
      names = await fs.readdir(experimentsDir);
    } catch {
      return [];
    }
    const out = [];
    for (const n of names.filter((f) => f.endsWith('.json') && isExperimentId(f.slice(0, -5)))) {
      const rec = await readJson(path.join(experimentsDir, n)).catch(() => undefined);
      if (rec?.experiment_id) out.push(summarise(rec));
    }
    return out.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
  }

  async function getExperiment(id) {
    if (!isExperimentId(id)) throw new IntegrationError('bad_request', 'Invalid experiment id.');
    const rec = await readJson(path.join(experimentsDir, `${id}.json`));
    if (!rec) throw new IntegrationError('not_found', 'No such local experiment.', { provider: 'GhostGrid' });
    return { summary: summarise(rec), record: rec };
  }

  async function listDatasets() {
    const manifest = (await readJson(path.join(datasetsDir, 'manifests', 'datasets.json'))) ?? { datasets: [] };
    const out = [];
    for (const d of manifest.datasets ?? []) {
      let meta = null;
      try {
        meta = await readJson(resolveInside(backendRoot, d.metadata_file));
      } catch {
        /* metadata missing or outside the workspace: listed without details */
      }
      out.push({ name: d.name, version: d.version, sha256: d.sha256, metadata: meta });
    }
    return out;
  }

  async function findDataset(name, version) {
    const hit = (await listDatasets()).find((d) => d.name === name && (!version || d.version === version));
    if (!hit?.metadata?.file) throw new IntegrationError('not_found', 'No such registered dataset.', { provider: 'GhostGrid' });
    return hit;
  }

  /** Statistics computed by the Python profiler on the real file. Only files under datasets/ can be profiled. */
  async function profileFile(relFile) {
    const candidate = resolveInside(backendRoot, relFile);
    let full;
    try {
      full = await fs.realpath(candidate); // resolves symlinks so a link cannot point the profiler outside datasets/
    } catch {
      throw new IntegrationError('not_found', 'The dataset file is missing on disk.', { provider: 'GhostGrid' });
    }
    const dsRoot = await fs.realpath(datasetsDir).catch(() => datasetsDir);
    if (!full.startsWith(dsRoot + path.sep)) throw new IntegrationError('bad_request', 'Only files inside the datasets folder can be profiled.');
    let res;
    try {
      res = await runPython('profile_dataset.py', [full], { python });
    } catch (err) {
      throw new IntegrationError('unavailable', err.message, { provider: 'Python' });
    }
    const data = parseJsonOutput(res.stdout);
    if (!data || data.error) throw new IntegrationError('bad_response', `The dataset could not be profiled${data?.error ? `: ${String(data.error).slice(0, 160)}` : '.'}`, { provider: 'Python' });
    return data;
  }

  async function readExampleConfig() {
    return (await readJson(path.join(backendRoot, 'ml', 'configs', 'example.json'))) ?? null;
  }

  return { listExperiments, getExperiment, listDatasets, findDataset, profileFile, readExampleConfig, datasetsDir, backendRoot };
}
