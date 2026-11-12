import { IntegrationError } from '../errors.mjs';
import { basicAuth, requestJson } from '../http.mjs';
import { assessLicense } from '../license.mjs';

const BASE = 'https://www.kaggle.com/api/v1';
const REF = /^[a-z0-9][a-z0-9-]{1,60}\/[a-z0-9][a-z0-9-]{1,100}$/i;
export const isKaggleRef = (v) => typeof v === 'string' && REF.test(v);

const licenseName = (d) => d.licenseName ?? d.licenses?.[0]?.name ?? d.license?.name ?? null;

/** Kaggle dataset discovery. Authenticated with KAGGLE_USERNAME + KAGGLE_KEY, server-side only; nothing is downloaded here. */
export function createKaggleService({ secrets, fetchImpl, sleep, log }) {
  const need = () => {
    if (!secrets.isConfigured('kaggle')) throw new IntegrationError('not_configured', 'Kaggle is not configured. Set KAGGLE_USERNAME and KAGGLE_KEY in backend/.env.', { provider: 'Kaggle' });
  };
  const auth = () => ({ Authorization: basicAuth(secrets.get('KAGGLE_USERNAME'), secrets.get('KAGGLE_KEY')) });
  const call = (path, opts = {}) => {
    need();
    return requestJson({ provider: 'Kaggle', url: `${BASE}${path}`, headers: auth(), fetchImpl, sleep, log, secretValues: secrets.values(), timeoutMs: 15000, ...opts });
  };

  const summary = (d) => {
    const lic = licenseName(d);
    const ref = d.ref ?? (d.ownerRef && d.datasetSlug ? `${d.ownerRef}/${d.datasetSlug}` : null);
    return {
      ref,
      title: d.title ?? ref,
      subtitle: d.subtitle ?? null,
      sizeBytes: Number.isFinite(d.totalBytes) ? d.totalBytes : null,
      license: lic,
      licenseAssessment: assessLicense(lic),
      downloads: d.downloadCount ?? null,
      votes: d.voteCount ?? null,
      lastUpdated: d.lastUpdated ?? null,
      tags: (d.tags ?? []).map((t) => (typeof t === 'string' ? t : t?.name)).filter(Boolean).slice(0, 20),
      url: d.url ?? (ref ? `https://www.kaggle.com/datasets/${ref}` : null),
    };
  };

  return {
    async search({ q, page = 1 }) {
      const query = String(q ?? '').trim().slice(0, 120);
      if (!query) throw new IntegrationError('bad_request', 'Enter something to search for.', { provider: 'Kaggle' });
      const p = Math.min(Math.max(Number(page) || 1, 1), 50);
      const { data } = await call(`/datasets/list?search=${encodeURIComponent(query)}&page=${p}&sortBy=hottest`);
      if (!Array.isArray(data)) throw new IntegrationError('bad_response', 'Kaggle returned an unexpected search result.', { provider: 'Kaggle' });
      return { query, page: p, results: data.map(summary).filter((r) => r.ref) };
    },

    async get(ref) {
      if (!isKaggleRef(ref)) throw new IntegrationError('bad_request', 'That is not a valid Kaggle dataset reference (owner/name).', { provider: 'Kaggle' });
      const [meta, files] = await Promise.all([
        call(`/datasets/view/${ref}`),
        call(`/datasets/list/${ref}`).then((r) => r.data).catch(() => null), // the file list is helpful, not essential
      ]);
      const d = meta.data ?? {};
      const list = (files?.datasetFiles ?? files?.files ?? []).map((f) => ({ name: f.name, sizeBytes: Number.isFinite(f.totalBytes) ? f.totalBytes : null })).filter((f) => f.name);
      const base = summary({ ...d, ref });
      return {
        ...base,
        description: typeof d.description === 'string' ? d.description.slice(0, 4000) : null,
        files: list,
        downloadNotes: ['Downloads the whole dataset as one ZIP. Only JSON, JSONL, CSV and documentation files are kept; other file types cause the import to be rejected.', 'Some datasets require accepting terms on kaggle.com first.'],
      };
    },

    downloadRequest(ref) {
      need();
      if (!isKaggleRef(ref)) throw new IntegrationError('bad_request', 'Invalid dataset reference.', { provider: 'Kaggle' });
      return { url: `${BASE}/datasets/download/${ref}`, headers: auth(), allowedHosts: ['www.kaggle.com', 'kaggle.com'] };
    },

    async health() {
      await call('/datasets/list?pageSize=1', { retries: 0, timeoutMs: 8000 });
      return { detail: 'Credentials accepted.' };
    },
  };
}
