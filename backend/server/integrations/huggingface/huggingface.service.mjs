import { IntegrationError } from '../errors.mjs';
import { requestJson } from '../http.mjs';
import { assessLicense } from '../license.mjs';

const BASE = 'https://huggingface.co';
const REPO_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}(\/[A-Za-z0-9][A-Za-z0-9._-]{0,95})?$/;
const REVISION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
export const IMPORTABLE_EXT = /\.(jsonl|ndjson|json|csv|zip)$/i;
export const isRepoId = (v) => typeof v === 'string' && REPO_ID.test(v) && !v.includes('..');
export const isRevision = (v) => typeof v === 'string' && REVISION.test(v);

const tagValue = (tags, prefix) => (tags ?? []).filter((t) => typeof t === 'string' && t.startsWith(prefix)).map((t) => t.slice(prefix.length));

/** Hugging Face search and metadata. Works anonymously for public repos; HF_TOKEN (server-side only) adds private/gated access and higher limits. */
export function createHuggingFaceService({ secrets, fetchImpl, sleep, log }) {
  const token = () => secrets.get('HF_TOKEN');
  const call = (path, opts = {}) =>
    requestJson({
      provider: 'Hugging Face',
      url: `${BASE}${path}`,
      headers: token() ? { Authorization: `Bearer ${token()}` } : {},
      fetchImpl,
      sleep,
      log,
      secretValues: secrets.values(),
      timeoutMs: 15000,
      ...opts,
    });

  const normalise = (r, kind) => {
    const license = tagValue(r.tags, 'license:')[0] ?? r.cardData?.license ?? null;
    return {
      kind,
      id: r.id ?? r.modelId,
      author: r.author ?? (r.id ?? '').split('/')[0] ?? null,
      description: typeof r.description === 'string' ? r.description.slice(0, 1200) : typeof r.cardData?.pretty_name === 'string' ? r.cardData.pretty_name : null,
      license: license ? String(Array.isArray(license) ? license[0] : license) : null,
      licenseAssessment: assessLicense(license),
      tags: (r.tags ?? []).filter((t) => typeof t === 'string' && !t.startsWith('license:')).slice(0, 25),
      taskCategories: tagValue(r.tags, 'task_categories:'),
      sizeCategories: tagValue(r.tags, 'size_categories:'),
      downloads: r.downloads ?? null,
      likes: r.likes ?? null,
      lastModified: r.lastModified ?? null,
      gated: r.gated === undefined ? false : r.gated, // false | 'auto' | 'manual'
      private: r.private === true,
      pipelineTag: r.pipeline_tag ?? null,
      library: r.library_name ?? null,
      url: `${BASE}/${kind === 'dataset' ? 'datasets/' : ''}${r.id ?? r.modelId}`,
    };
  };

  async function search(kind, { q, limit = 20 }) {
    const query = String(q ?? '').trim().slice(0, 120);
    if (!query) throw new IntegrationError('bad_request', 'Enter something to search for.', { provider: 'Hugging Face' });
    const n = Math.min(Math.max(Number(limit) || 20, 1), 30);
    const { data } = await call(`/api/${kind}s?search=${encodeURIComponent(query)}&limit=${n}&sort=downloads&direction=-1`);
    if (!Array.isArray(data)) throw new IntegrationError('bad_response', 'Hugging Face returned an unexpected search result.', { provider: 'Hugging Face' });
    return { query, results: data.map((r) => normalise(r, kind)), authenticated: Boolean(token()) };
  }

  async function detail(kind, id, revision) {
    if (!isRepoId(id)) throw new IntegrationError('bad_request', 'That is not a valid Hugging Face repository id.', { provider: 'Hugging Face' });
    if (revision !== undefined && !isRevision(revision)) throw new IntegrationError('bad_request', 'Invalid revision.', { provider: 'Hugging Face' });
    const rev = revision ? `/revision/${encodeURIComponent(revision)}` : '';
    let data;
    try {
      ({ data } = await call(`/api/${kind}s/${id}${rev}?blobs=true`));
    } catch (err) {
      // A gated or private repo answers 401/403 without a token (or without accepted terms). Say that, not "invalid key".
      if (err.code === 'invalid_credentials' && !token()) throw new IntegrationError('forbidden', 'This repository is private or gated. Set HF_TOKEN in backend/.env and accept its terms on huggingface.co.', { provider: 'Hugging Face' });
      if (err.code === 'forbidden') throw new IntegrationError('forbidden', 'Access to this repository is restricted. Accept its terms on huggingface.co with the account that owns HF_TOKEN.', { provider: 'Hugging Face' });
      throw err;
    }
    const base = normalise(data, kind);
    const files = (data.siblings ?? []).filter((f) => f && typeof f.rfilename === 'string').map((f) => ({ path: f.rfilename, sizeBytes: Number.isFinite(f.size) ? f.size : null, importable: IMPORTABLE_EXT.test(f.rfilename) }));
    const importableBytes = files.filter((f) => f.importable).reduce((n, f) => n + (f.sizeBytes ?? 0), 0);
    return {
      ...base,
      revision: data.sha ?? null,
      cardSummary: data.cardData ? { languages: data.cardData.language ?? null, taskIds: data.cardData.task_ids ?? null, prettyName: data.cardData.pretty_name ?? null, sourceDatasets: data.cardData.source_datasets ?? null } : null,
      sizeBytes: Number.isFinite(data.usedStorage) ? data.usedStorage : null,
      files,
      importableBytes,
      importNotes: kind === 'dataset' ? importNotes(base, files) : [],
    };
  }

  const importNotes = (base, files) => {
    const notes = [];
    if (!files.some((f) => f.importable)) notes.push('No JSON, JSONL, CSV or ZIP files in this repository. GhostGrid cannot import it (Parquet and script-based datasets are not supported).');
    if (base.gated) notes.push('Gated: requires HF_TOKEN and accepted terms on huggingface.co.');
    if (base.private) notes.push('Private repository.');
    notes.push('Imported files are stored as-is. They must still be mapped to GhostGrid’s record format (record_id, features, target) before training.');
    return notes;
  };

  return {
    searchDatasets: (p) => search('dataset', p),
    searchModels: (p) => search('model', p),
    getDataset: (id, rev) => detail('dataset', id, rev),
    getModel: (id, rev) => detail('model', id, rev),
    /** Download request for one file; the token is attached only here, to huggingface.co, never to redirected hosts. */
    fileRequest(id, revision, filePath) {
      if (!isRepoId(id) || !isRevision(revision)) throw new IntegrationError('bad_request', 'Invalid repository or revision.', { provider: 'Hugging Face' });
      if (filePath.split('/').some((p) => !p || p === '..' || p === '.')) throw new IntegrationError('bad_request', 'Invalid file path.', { provider: 'Hugging Face' });
      return { url: `${BASE}/datasets/${id}/resolve/${encodeURIComponent(revision)}/${filePath.split('/').map(encodeURIComponent).join('/')}`, headers: token() ? { Authorization: `Bearer ${token()}` } : {}, allowedHosts: ['huggingface.co'] };
    },
    async health() {
      if (!token()) {
        await call('/api/datasets?limit=1', { retries: 0, timeoutMs: 8000 });
        return { detail: 'Public search reachable (no token configured: private and gated repositories are unavailable).', anonymous: true };
      }
      const { data } = await call('/api/whoami-v2', { retries: 0, timeoutMs: 8000 });
      return { detail: `Token accepted${data?.name ? ` for account "${data.name}"` : ''}.` };
    },
  };
}
