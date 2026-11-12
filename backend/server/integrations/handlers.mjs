import crypto from 'node:crypto';
import { IntegrationError } from './errors.mjs';
import { INTEGRATION_IDS } from './config.mjs';
import { TASKS, TASK_IDS, SYSTEM_PROMPT } from './ai/tasks.mjs';
import { safeFileName } from './dataset-import.mjs';
import { isRepoId } from './huggingface/huggingface.service.mjs';
import { isKaggleRef } from './kaggle/kaggle.service.mjs';
import { isExperimentId } from './ml-store.mjs';

const bad = (m) => new IntegrationError('bad_request', m, { provider: 'GhostGrid' });
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const nowIso = () => new Date().toISOString();

/**
 * Framework-free request handlers: each takes { params, query, body } and returns JSON (or throws IntegrationError).
 * routes.mjs adapts them to Express; tests call them directly. Credentials never appear in any return value.
 */
export function createHandlers({ db, secrets, health, llm, hf, kaggle, wandb, imports, mlStore, getMeta, setMeta, readScenario, extractFeatures, runSimulation, aiRateLimit = { max: 30, windowMs: 60_000 }, now = () => Date.now() }) {
  const requireEnabled = (id) => {
    if (!health.isEnabled(id)) throw new IntegrationError('disabled', 'This integration is turned off in GhostGrid settings.', { provider: id });
  };
  const aiCalls = [];
  const throttleAi = () => {
    const t = now();
    while (aiCalls.length && t - aiCalls[0] > aiRateLimit.windowMs) aiCalls.shift();
    if (aiCalls.length >= aiRateLimit.max) throw new IntegrationError('rate_limited', 'Too many AI requests in a short time. Wait a moment and try again.', { provider: 'GhostGrid', retryAfterSec: 30 });
    aiCalls.push(t);
  };
  const checkLicenseGate = (assessment, ack) => {
    if (assessment.status !== 'permissive' && ack !== true) throw new IntegrationError('forbidden', `${assessment.summary} Confirm that you have reviewed the licence to continue.`, { provider: 'GhostGrid' });
  };
  const requireConfirm = (body) => {
    if (body?.confirmDownload !== true) throw bad('Downloads only start after you confirm them.');
  };

  const aiCtx = { readScenario: (id) => readScenario(id), extractFeatures, runSimulation, mlStore, getImport: (id) => imports.get(id) };

  return {
    /* ---- status and health ---- */
    list: () => ({ integrations: health.snapshot(), ai: llm.status(), importLimitBytes: imports.limits.maxBytes }),
    async checkHealth({ body }) {
      const ids = Array.isArray(body?.ids) ? body.ids.filter((i) => INTEGRATION_IDS.includes(i)) : undefined;
      return { integrations: await health.check({ ids, force: body?.force === true }) };
    },
    setEnabled({ params, body }) {
      if (!INTEGRATION_IDS.includes(params.id)) throw new IntegrationError('not_found', 'Unknown integration.');
      if (typeof body?.enabled !== 'boolean') throw bad('"enabled" must be true or false.');
      health.setEnabled(params.id, body.enabled);
      return { integration: health.snapshot().find((i) => i.id === params.id) };
    },

    /* ---- AI ---- */
    aiStatus: () => llm.status(),
    aiSetPreferences({ body }) {
      const provider = body?.provider;
      if (provider !== undefined) {
        if (!['auto', 'gemini', 'groq'].includes(provider)) throw bad('provider must be auto, gemini or groq.');
        setMeta(db, 'ai.provider', provider);
      }
      if (body?.fallback !== undefined) {
        if (typeof body.fallback !== 'boolean') throw bad('fallback must be true or false.');
        setMeta(db, 'ai.fallback', String(body.fallback));
      }
      llm.clearCache();
      return llm.status();
    },
    async aiAnalyze({ body }) {
      if (!TASK_IDS.includes(body?.task)) throw bad(`Unknown AI task. Choose one of: ${TASK_IDS.join(', ')}.`);
      if (body.params !== undefined && !isObj(body.params)) throw bad('params must be an object.');
      throttleAi();
      const built = await TASKS[body.task](body.params ?? {}, aiCtx);
      const out = await llm.complete({ task: body.task, system: SYSTEM_PROMPT, prompt: built.prompt, knownIds: built.knownIds, cacheKey: built.cacheKey, refresh: body.refresh === true });
      return {
        aiGenerated: true,
        kind: 'ai_interpretation',
        notice: 'AI-generated interpretation of GhostGrid data. It is not a simulation or model result and can be wrong; check it against the figures it cites.',
        task: body.task,
        provider: out.provider, providerLabel: out.providerLabel, model: out.model, fallbackFrom: out.fallbackFrom, cached: out.cached, generatedAt: out.generatedAt,
        grounding: built.grounding,
        content: out.content,
      };
    },

    /* ---- Hugging Face ---- */
    async hfSearchDatasets({ query }) { requireEnabled('huggingface'); return hf.searchDatasets({ q: query.q, limit: query.limit }); },
    async hfSearchModels({ query }) { requireEnabled('huggingface'); return hf.searchModels({ q: query.q, limit: query.limit }); },
    async hfDataset({ query }) { requireEnabled('huggingface'); return { dataset: await hf.getDataset(query.id, query.revision || undefined) }; },
    async hfModel({ query }) { requireEnabled('huggingface'); return { model: await hf.getModel(query.id, query.revision || undefined) }; },
    async hfImport({ body }) {
      requireEnabled('huggingface');
      requireConfirm(body);
      if (!isRepoId(body?.id)) throw bad('Invalid Hugging Face dataset id.');
      const requested = Array.isArray(body.files) ? [...new Set(body.files.filter((f) => typeof f === 'string'))] : [];
      if (!requested.length || requested.length > 20) throw bad('Choose between 1 and 20 files to import.');
      const detail = await hf.getDataset(body.id, body.revision || undefined);
      checkLicenseGate(detail.licenseAssessment, body.acknowledgeLicense);
      if (detail.gated && !secrets.isConfigured('huggingface')) throw new IntegrationError('forbidden', 'This dataset is gated. Set HF_TOKEN and accept its terms on huggingface.co first.', { provider: 'Hugging Face' });
      const byPath = new Map(detail.files.map((f) => [f.path, f]));
      const chosen = requested.map((p) => {
        const f = byPath.get(p);
        if (!f?.importable) throw bad(`"${p}" is not an importable file in this repository (JSON, JSONL, CSV or ZIP only).`);
        return f;
      });
      const zips = chosen.filter((f) => /\.zip$/i.test(f.path));
      if (zips.length && chosen.length > 1) throw bad('Import a ZIP archive on its own, without other files.');
      const names = chosen.map((f) => safeFileName(f.path));
      if (new Set(names.map((n) => n.toLowerCase())).size !== names.length) throw bad('Two chosen files would end up with the same name.');
      const revision = detail.revision ?? 'main';
      const known = chosen.every((f) => f.sizeBytes !== null);
      const row = await imports.start({
        source: 'huggingface', sourceId: body.id, revision, sourceUrl: detail.url, license: detail.license, licenseStatus: detail.licenseAssessment.status,
        expectedBytes: known ? chosen.reduce((n, f) => n + f.sizeBytes, 0) : null,
        downloads: chosen.map((f, i) => ({ name: names[i], kind: /\.zip$/i.test(f.path) ? 'zip' : 'file', request: hf.fileRequest(body.id, revision, f.path), origin: f.path })),
      });
      return { import: row };
    },

    /* ---- Kaggle ---- */
    async kaggleSearch({ query }) { requireEnabled('kaggle'); return kaggle.search({ q: query.q, page: query.page }); },
    async kaggleDataset({ query }) { requireEnabled('kaggle'); return { dataset: await kaggle.get(query.ref) }; },
    async kaggleImport({ body }) {
      requireEnabled('kaggle');
      requireConfirm(body);
      if (!isKaggleRef(body?.ref)) throw bad('Invalid Kaggle dataset reference (owner/name).');
      const detail = await kaggle.get(body.ref);
      checkLicenseGate(detail.licenseAssessment, body.acknowledgeLicense);
      const row = await imports.start({
        source: 'kaggle', sourceId: body.ref, revision: String(detail.lastUpdated ?? 'latest'), sourceUrl: detail.url, license: detail.license, licenseStatus: detail.licenseAssessment.status,
        expectedBytes: detail.sizeBytes,
        downloads: [{ name: 'dataset.zip', kind: 'zip', request: kaggle.downloadRequest(body.ref), origin: body.ref }],
      });
      return { import: row };
    },

    /* ---- imports (shared) ---- */
    importsList: () => ({ imports: imports.list() }),
    importGet({ params }) {
      const row = imports.get(params.id);
      if (!row) throw new IntegrationError('not_found', 'Import not found.', { provider: 'GhostGrid' });
      return { import: row };
    },
    importCancel({ params }) { imports.cancel(params.id); return { ok: true }; },
    async importRemove({ params }) { await imports.remove(params.id); return { ok: true }; },
    async importRegister({ params, body }) { return { import: await imports.register(params.id, { file: body?.file, name: body?.name, version: body?.version, description: body?.description, acknowledgeLicense: body?.acknowledgeLicense }) }; },

    /* ---- model references (Hugging Face) ---- */
    modelRefsList: () => ({ references: db.prepare('SELECT * FROM model_references ORDER BY created_at DESC').all().map(refRow) }),
    async modelRefsCreate({ body }) {
      requireEnabled('huggingface');
      if (!isRepoId(body?.repoId)) throw bad('Invalid Hugging Face model id.');
      const experimentId = body.experimentId ?? '';
      if (experimentId) {
        if (!isExperimentId(experimentId)) throw bad('Invalid experiment id.');
        await mlStore.getExperiment(experimentId);
      }
      const m = await hf.getModel(body.repoId, body.revision || undefined); // verifies the repo really exists and is visible to us
      const id = `mref-${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
      try {
        db.prepare('INSERT INTO model_references (id, provider, repo_id, revision, url, license, experiment_id, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(id, 'huggingface', m.id, m.revision ?? '', m.url, m.license, experimentId, String(body.note ?? '').slice(0, 300), nowIso());
      } catch {
        throw new IntegrationError('conflict', 'That model is already associated with this experiment.', { provider: 'GhostGrid' });
      }
      return { reference: refRow(db.prepare('SELECT * FROM model_references WHERE id = ?').get(id)), licenseAssessment: m.licenseAssessment, gated: m.gated };
    },
    modelRefsDelete({ params }) {
      const r = db.prepare('DELETE FROM model_references WHERE id = ?').run(params.id);
      if (!r.changes) throw new IntegrationError('not_found', 'Reference not found.', { provider: 'GhostGrid' });
      return { ok: true };
    },

    /* ---- local ML data (read-only) and W&B ---- */
    mlDatasets: async () => ({ datasets: await mlStore.listDatasets() }),
    mlExperiments: async () => ({ experiments: await wandb.experiments(), wandbDefaults: wandb.defaults() }),
    async wandbSync({ body }) { requireEnabled('wandb'); return { link: await wandb.sync({ experimentId: body?.experimentId, project: body?.project || undefined, entity: body?.entity || undefined, uploadCheckpoint: body?.uploadCheckpoint === true, consentToUpload: body?.consentToUpload === true, update: body?.update === true }) }; },
    async wandbCompare({ body }) {
      if (!Array.isArray(body?.experimentIds) || !body.experimentIds.every(isExperimentId)) throw bad('Provide experimentIds as a list of experiment ids.');
      return wandb.compare(body.experimentIds);
    },
  };
}

const refRow = (r) => ({ id: r.id, provider: r.provider, repoId: r.repo_id, revision: r.revision, url: r.url, license: r.license, experimentId: r.experiment_id || null, note: r.note, createdAt: r.created_at });
