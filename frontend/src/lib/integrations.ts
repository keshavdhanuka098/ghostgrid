import { ApiError, pick, request } from './api';

/** Everything here talks only to GhostGrid's own /api/integrations. No provider URL or key ever reaches the browser. */

export type IntegrationState = 'connected' | 'not_configured' | 'disabled' | 'rate_limited' | 'connection_failed' | 'pending';

export interface IntegrationInfo {
  id: string;
  label: string;
  category: 'ai' | 'datasets' | 'tracking' | 'maps';
  description: string;
  features: string[];
  envVars: Array<{ name: string; set: boolean }>;
  configured: boolean;
  enabled: boolean;
  toggleable: boolean;
  state: IntegrationState;
  stateLabel: string;
  detail: string | null;
  errorCode: string | null;
  publicAccess: boolean;
  worksAnonymously: boolean;
  lastCheckedAt: string | null;
  lastOkAt: string | null;
  lastErrorCode: string | null;
}

export interface AiStatus {
  preferences: { provider: 'auto' | 'gemini' | 'groq'; fallback: boolean };
  providers: Array<{ id: string; label: string; model: string; configured: boolean; enabled: boolean }>;
}

export interface AiFinding { title: string; detail: string; severity: 'info' | 'notable' | 'important'; evidence: string[]; assetIds: string[] }
export interface AiRecommendation { title: string; rationale: string; effort: 'low' | 'medium' | 'high' | null; basedOn: string[] }
export interface AiResult {
  aiGenerated: true;
  kind: 'ai_interpretation';
  notice: string;
  task: string;
  provider: string;
  providerLabel: string;
  model: string;
  fallbackFrom?: Array<{ provider: string; reason: string }>;
  cached: boolean;
  generatedAt: string;
  grounding: { source: string; items: string[]; notes: string[] };
  content: { summary: string; findings: AiFinding[]; recommendations: AiRecommendation[]; caveats: string[] };
}

export interface LicenseAssessment { id: string | null; status: 'permissive' | 'conditions' | 'restricted' | 'unknown'; requiresReview: boolean; summary: string }

export interface HfItem {
  kind: 'dataset' | 'model';
  id: string;
  author: string | null;
  description: string | null;
  license: string | null;
  licenseAssessment: LicenseAssessment;
  tags: string[];
  taskCategories: string[];
  sizeCategories: string[];
  downloads: number | null;
  likes: number | null;
  lastModified: string | null;
  gated: false | 'auto' | 'manual';
  private: boolean;
  url: string;
}
export interface HfFile { path: string; sizeBytes: number | null; importable: boolean }
export interface HfDetail extends HfItem { revision: string | null; sizeBytes: number | null; files: HfFile[]; importableBytes: number; importNotes: string[] }

export interface KaggleItem {
  ref: string;
  title: string;
  subtitle: string | null;
  sizeBytes: number | null;
  license: string | null;
  licenseAssessment: LicenseAssessment;
  downloads: number | null;
  votes: number | null;
  lastUpdated: string | null;
  tags: string[];
  url: string | null;
}
export interface KaggleDetail extends KaggleItem { description: string | null; files: Array<{ name: string; sizeBytes: number | null }>; downloadNotes: string[] }

export interface ImportRow {
  id: string;
  source: 'huggingface' | 'kaggle';
  sourceId: string;
  revision: string;
  sourceUrl: string;
  license: string | null;
  licenseStatus: LicenseAssessment['status'];
  status: 'downloading' | 'extracting' | 'validating' | 'downloaded' | 'registered' | 'failed' | 'cancelled';
  totalBytes: number | null;
  downloadedBytes: number;
  localPath: string;
  files: Array<{ name: string; bytes: number; sha256: string }>;
  validation: { ok: boolean; checked: Array<{ file: string; ok: boolean; records: number | null; errors: string[] }>; note?: string } | null;
  manifestName: string | null;
  manifestVersion: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WandbLink { status: 'pending' | 'synced' | 'failed'; runId?: string | null; runUrl?: string | null; project?: string | null; entity?: string | null; error?: string | null; syncedAt?: string | null }
export interface LocalExperiment {
  experimentId: string;
  status: string;
  task: string | null;
  modelName: string | null;
  modelVersion: string | null;
  datasetVersion: string | null;
  datasetFingerprint: string | null;
  startedAt: string | null;
  completedAt: string | null;
  validationMetrics: Record<string, unknown> | null;
  testMetrics: Record<string, unknown> | null;
  hyperparameters: Record<string, unknown>;
  wandb: { syncStatus: 'not_synced' | 'pending' | 'synced' | 'failed' } & Partial<WandbLink>;
}
export interface Comparison {
  comparable: boolean;
  warnings: string[];
  bestByMetric: Record<string, string>;
  experiments: Array<{ experimentId: string; modelName: string | null; datasetVersion: string | null; metrics: Record<string, number>; hyperparameters: Record<string, unknown> }>;
}
export interface ModelReference { id: string; repoId: string; revision: string; url: string; license: string | null; experimentId: string | null; note: string }
export interface LocalDataset { name: string; version: string; metadata: { record_count?: number; license?: string; source?: string } | null }

const base = '/api/integrations';
const q = (o: Record<string, string | number | undefined>) => '?' + Object.entries(o).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&');
const enc = encodeURIComponent;

export const integrationsApi = {
  list: async () => {
    const r = await request<{ integrations: IntegrationInfo[]; ai: AiStatus; importLimitBytes: number }>('GET', base);
    pick<IntegrationInfo[]>(r, 'integrations', 'array');
    pick<AiStatus>(r, 'ai');
    return { ...r, importLimitBytes: typeof r.importLimitBytes === 'number' ? r.importLimitBytes : 0 };
  },
  check: async (force = false) => {
    const r = await request<{ integrations: IntegrationInfo[] }>('POST', `${base}/health`, { force });
    pick<IntegrationInfo[]>(r, 'integrations', 'array');
    return r;
  },
  setEnabled: (id: string, enabled: boolean) => request<{ integration: IntegrationInfo }>('PATCH', `${base}/${enc(id)}`, { enabled }),
  setAiPreferences: (p: Partial<AiStatus['preferences']>) => request<AiStatus>('PUT', `${base}/ai/preferences`, p),
  analyze: (task: string, params: Record<string, unknown>, refresh = false) => request<AiResult>('POST', `${base}/ai/analyze`, { task, params, refresh }),

  hfSearch: (kind: 'datasets' | 'models', term: string) => request<{ results: HfItem[]; authenticated: boolean }>('GET', `${base}/huggingface/${kind}${q({ q: term })}`),
  hfDataset: (id: string) => request<{ dataset: HfDetail }>('GET', `${base}/huggingface/dataset${q({ id })}`),
  hfModel: (id: string) => request<{ model: HfDetail }>('GET', `${base}/huggingface/model${q({ id })}`),
  hfImport: (body: { id: string; files: string[]; confirmDownload: boolean; acknowledgeLicense: boolean }) => request<{ import: ImportRow }>('POST', `${base}/huggingface/imports`, body),
  kaggleSearch: (term: string) => request<{ results: KaggleItem[] }>('GET', `${base}/kaggle/datasets${q({ q: term })}`),
  kaggleDataset: (ref: string) => request<{ dataset: KaggleDetail }>('GET', `${base}/kaggle/dataset${q({ ref })}`),
  kaggleImport: (body: { ref: string; confirmDownload: boolean; acknowledgeLicense: boolean }) => request<{ import: ImportRow }>('POST', `${base}/kaggle/imports`, body),

  imports: async () => pick<ImportRow[]>(await request<unknown>('GET', `${base}/imports`), 'imports', 'array'),
  cancelImport: (id: string) => request<{ ok: true }>('POST', `${base}/imports/${enc(id)}/cancel`, {}),
  removeImport: (id: string) => request<{ ok: true }>('DELETE', `${base}/imports/${enc(id)}`),
  registerImport: (id: string, body: { file: string; name: string; version: string; description?: string; acknowledgeLicense: boolean }) => request<{ import: ImportRow }>('POST', `${base}/imports/${enc(id)}/register`, body),

  modelReferences: async () => pick<ModelReference[]>(await request<unknown>('GET', `${base}/model-references`), 'references', 'array'),
  addModelReference: (body: { repoId: string; experimentId?: string; note?: string }) => request<{ reference: ModelReference }>('POST', `${base}/model-references`, body),
  removeModelReference: (id: string) => request<{ ok: true }>('DELETE', `${base}/model-references/${enc(id)}`),

  localDatasets: async () => pick<LocalDataset[]>(await request<unknown>('GET', `${base}/ml/datasets`), 'datasets', 'array'),
  localExperiments: async () => {
    const r = await request<{ experiments: LocalExperiment[]; wandbDefaults: { project: string; entity?: string } }>('GET', `${base}/ml/experiments`);
    pick<LocalExperiment[]>(r, 'experiments', 'array');
    return r;
  },
  wandbSync: (body: { experimentId: string; project?: string; uploadCheckpoint?: boolean; consentToUpload?: boolean }) => request<{ link: WandbLink }>('POST', `${base}/wandb/sync`, body),
  compare: async (experimentIds: string[]) => {
    const r = await request<Comparison>('POST', `${base}/wandb/compare`, { experimentIds });
    pick<Comparison['experiments']>(r, 'experiments', 'array');
    return r;
  },
};

/** A short, human message for any failure, with the specific reason when GhostGrid reports one. */
export function integrationError(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  return err instanceof Error ? err.message : 'Something went wrong.';
}

export const formatBytes = (n: number | null | undefined): string => {
  if (n === null || n === undefined) return 'size unknown';
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${u[i]}`;
};
