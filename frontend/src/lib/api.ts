import type { Block } from './report';
import type {
  BranchInfo,
  BranchSimulation,
  BranchSimulationDetail,
  BranchState,
  Commit,
  CommitComparison,
  CommitDetail,
  Patch,
  PatchOp,
} from './graphGit';
import type { ReportSummary, Scenario } from './types';

export class ApiError extends Error {
  status: number;
  details: string[];
  constructor(message: string, status = 0, details: string[] = []) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError('Cannot reach the GhostGrid server. Make sure it is running (npm run dev) and try again.');
  }
  if (res.status === 204) return undefined as T;
  let data: unknown = null;
  let parsed = true;
  try {
    data = await res.json();
  } catch {
    parsed = false; // not JSON (an HTML error page, an empty body, ...)
  }
  if (!res.ok) {
    const d = (data !== null && typeof data === 'object' ? data : {}) as { error?: string; details?: string[] };
    throw new ApiError(typeof d.error === 'string' ? d.error : `The server responded with ${res.status}.`, res.status, Array.isArray(d.details) ? d.details : []);
  }
  // A "successful" reply that is not JSON means something other than the GhostGrid API answered (for example a static
  // host that serves index.html for /api). Fail with a readable message instead of handing the UI `null`.
  if (!parsed) throw new ApiError('The server sent a reply GhostGrid could not read. Check that the API is running and reachable.', res.status);
  return data as T;
}

/** Reads a required field from an API reply, failing with a readable error (not a render crash) when the shape is wrong. */
export function pick<T>(data: unknown, key: string, kind: 'array' | 'object' = 'object'): T {
  const v = data !== null && typeof data === 'object' ? (data as Record<string, unknown>)[key] : undefined;
  const ok = kind === 'array' ? Array.isArray(v) : v !== null && typeof v === 'object';
  if (!ok) throw new ApiError('The server sent a reply GhostGrid could not read. Check that the API is running and reachable.');
  return v as T;
}

const enc = encodeURIComponent;

export interface SavedReport extends ReportSummary {
  options: Record<string, unknown>;
  content: Block[];
}

export interface AssetFeatures {
  id: string;
  name: string;
  kind: string;
  criticality: string;
  features: Record<string, number | boolean>;
}
export interface GraphFeatures {
  schema: string;
  graph: Record<string, number>;
  assets: AssetFeatures[];
}

export const api = {
  health: () => request<{ ok: boolean; schemaVersion: number; scenarios: number }>('GET', '/api/health'),
  list: async () => pick<Scenario[]>(await request<unknown>('GET', '/api/scenarios'), 'scenarios', 'array'),
  create: async (s: Scenario) => pick<Scenario>(await request<unknown>('POST', '/api/scenarios', s), 'scenario', 'object'),
  update: async (s: Scenario) => pick<Scenario>(await request<unknown>('PUT', `/api/scenarios/${enc(s.id)}`, s), 'scenario', 'object'),
  duplicate: async (id: string, name?: string) =>
    pick<Scenario>(await request<unknown>('POST', `/api/scenarios/${enc(id)}/duplicate`, name ? { name } : {}), 'scenario', 'object'),
  remove: (id: string) => request<void>('DELETE', `/api/scenarios/${enc(id)}`),
  removeAll: () => request<void>('DELETE', '/api/scenarios'),
  restoreSamples: async () => pick<Scenario[]>(await request<unknown>('POST', '/api/samples/restore'), 'added', 'array'),

  extractFeatures: async (scenarioId: string) => {
    const r = await request<GraphFeatures>('POST', `/api/scenarios/${enc(scenarioId)}/features`, {});
    pick<AssetFeatures[]>(r, 'assets', 'array');
    pick<Record<string, number>>(r, 'graph');
    return r;
  },
  listReports: async (scenarioId: string) => pick<ReportSummary[]>(await request<unknown>('GET', `/api/scenarios/${enc(scenarioId)}/reports`), 'reports', 'array'),
  getReport: async (scenarioId: string, id: string) => pick<SavedReport>(await request<unknown>('GET', `/api/scenarios/${enc(scenarioId)}/reports/${enc(id)}`), 'report', 'object'),
  saveReport: async (scenarioId: string, body: { title: string; options: Record<string, unknown>; content: Block[] }) =>
    pick<SavedReport>(await request<unknown>('POST', `/api/scenarios/${enc(scenarioId)}/reports`, body), 'report', 'object'),
  removeReport: (scenarioId: string, id: string) => request<void>('DELETE', `/api/scenarios/${enc(scenarioId)}/reports/${enc(id)}`),

  // ---- Graph Git ----
  listBranches: async (scenarioId: string) => pick<BranchInfo[]>(await request<unknown>('GET', `/api/scenarios/${enc(scenarioId)}/branches`), 'branches', 'array'),
  createBranch: (scenarioId: string, body: { name: string; description?: string; fromCommitId?: string; fromBranchId?: string }) =>
    request<BranchState>('POST', `/api/scenarios/${enc(scenarioId)}/branches`, body),
  getBranch: (branchId: string) => request<BranchState>('GET', `/api/branches/${enc(branchId)}`),
  updateBranch: (branchId: string, body: { name?: string; description?: string }) => request<BranchState>('PATCH', `/api/branches/${enc(branchId)}`, body),
  deleteBranch: (branchId: string) => request<void>('DELETE', `/api/branches/${enc(branchId)}`),
  syncBranchFromScenario: (branchId: string, body: { discardPending?: boolean; author?: string }) =>
    request<{ commit: Commit; state: BranchState }>('POST', `/api/branches/${enc(branchId)}/sync-from-scenario`, body),

  listCommits: async (branchId: string, limit = 200) => {
    const r = await request<{ commits: Commit[]; total: number }>('GET', `/api/branches/${enc(branchId)}/commits?limit=${limit}`);
    pick<Commit[]>(r, 'commits', 'array');
    return r;
  },
  commitBranch: (branchId: string, body: { message: string; body?: string; author?: string; expectedHeadCommitId?: string }) =>
    request<{ commit: Commit; state: BranchState }>('POST', `/api/branches/${enc(branchId)}/commits`, body),
  getCommit: (commitId: string) => request<CommitDetail>('GET', `/api/commits/${enc(commitId)}`),
  restoreCommit: (commitId: string, body: { branchId: string; discardPending?: boolean; author?: string; expectedHeadCommitId?: string }) =>
    request<{ commit: Commit; state: BranchState }>('POST', `/api/commits/${enc(commitId)}/restore`, body),
  revertCommit: (commitId: string, body: { branchId: string; discardPending?: boolean; author?: string; expectedHeadCommitId?: string }) =>
    request<{ commit: Commit; state: BranchState }>('POST', `/api/commits/${enc(commitId)}/revert`, body),
  compareCommits: (from: string, to: string) => request<CommitComparison>('GET', `/api/commits/compare?from=${enc(from)}&to=${enc(to)}`),

  addPatches: (branchId: string, ops: PatchOp[], expectedHeadCommitId?: string) =>
    request<BranchState & { created: Patch[] }>('POST', `/api/branches/${enc(branchId)}/patches`, { ops, expectedHeadCommitId }),
  revertPatch: (branchId: string, patchId: string) => request<BranchState>('POST', `/api/branches/${enc(branchId)}/patches/${enc(patchId)}/revert`),
  discardPatches: (branchId: string) => request<BranchState>('DELETE', `/api/branches/${enc(branchId)}/patches`),

  listBranchSimulations: async (branchId: string) => pick<BranchSimulation[]>(await request<unknown>('GET', `/api/branches/${enc(branchId)}/simulations`), 'simulations', 'array'),
  runBranchSimulation: async (branchId: string, body: { failedIds: string[]; failedLinkIds: string[]; commitId?: string; name?: string }) =>
    pick<BranchSimulationDetail>(await request<unknown>('POST', `/api/branches/${enc(branchId)}/simulations`, body), 'simulation', 'object'),
  getBranchSimulation: async (simulationId: string) => pick<BranchSimulationDetail>(await request<unknown>('GET', `/api/simulations/${enc(simulationId)}`), 'simulation', 'object'),
};
