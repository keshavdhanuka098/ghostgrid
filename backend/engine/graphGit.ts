// Graph Git types and small pure helpers shared by the UI. The server owns all versioning rules; the browser only
// shows what it returns, sends structured patch operations, and re-hydrates stored simulation results so the
// existing explanation code (analysis.ts) can describe them.

import type { Simulation } from './graph';
import type { Asset, AssetKind, Criticality, Dependency, DependencyMode, LinkStatus, Relation } from './types';

export interface GraphDoc {
  assets: Asset[];
  dependencies: Dependency[];
}

/* ---------------------------------------------------------------- patches */

export type PatchCategory = 'structural' | 'behavioural' | 'layout';

export type NewAsset = { id?: string; name: string; kind: AssetKind; criticality: Criticality; notes?: string; x?: number | null; y?: number | null };
export type NewDependency = {
  id?: string;
  dependentId: string;
  providerId: string;
  mode: DependencyMode;
  status: LinkStatus;
  relation: Relation;
  notes?: string;
};

/** The closed set of operations the server accepts. There is no free-form edit. */
export type PatchOp =
  | { type: 'add_node'; node: NewAsset }
  | { type: 'delete_node'; nodeId: string }
  | { type: 'modify_node'; nodeId: string; changes: Partial<Pick<Asset, 'name' | 'kind' | 'notes'>> }
  | { type: 'set_criticality'; nodeId: string; criticality: Criticality }
  | { type: 'move_node'; nodeId: string; x: number | null; y: number | null }
  | { type: 'add_dependency'; dependency: NewDependency }
  | { type: 'remove_dependency'; dependencyId: string }
  | { type: 'modify_dependency'; dependencyId: string; changes: Partial<Pick<Dependency, 'status' | 'relation' | 'notes'>> }
  | { type: 'replace_provider'; dependencyId: string; providerId: string }
  | { type: 'set_dependency_mode'; dependencyId: string; mode: DependencyMode };

export type PatchType = PatchOp['type'];

export const PATCH_CATEGORY_LABEL: Record<PatchCategory, string> = {
  structural: 'Structure',
  behavioural: 'Behaviour',
  layout: 'Layout',
};

export interface Patch {
  id: string;
  branchId: string;
  commitId: string | null;
  baseCommitId: string;
  seq: number;
  type: PatchType;
  category: PatchCategory;
  op: PatchOp;
  inverse: PatchOp[];
  description: string;
  revertsPatchId: string | null;
  reverted: boolean;
  pending: boolean;
  createdAt: string;
}

/* ---------------------------------------------------------------- commits */

export type CommitKind = 'baseline' | 'commit' | 'restore' | 'revert' | 'sync';

export const COMMIT_KIND_LABEL: Record<CommitKind, string> = {
  baseline: 'Baseline',
  commit: 'Commit',
  restore: 'Restore',
  revert: 'Revert',
  sync: 'Sync',
};

export interface ChangeSummary {
  nodesAdded: number;
  nodesRemoved: number;
  nodesModified: number;
  depsAdded: number;
  depsRemoved: number;
  depsModified: number;
  behavioural: number;
  moved: number;
  lines: string[];
}

export interface Commit {
  id: string;
  scenarioId: string;
  branchId: string;
  branchName: string | null;
  parentCommitId: string | null;
  snapshotId: string;
  snapshotHash: string;
  seq: number;
  kind: CommitKind;
  message: string;
  body: string;
  author: string | null;
  summary: ChangeSummary;
  nodeCount: number;
  linkCount: number;
  createdAt: string;
}

/** "#007" style label, ordered across the whole scenario. */
export const commitLabel = (c: Pick<Commit, 'seq'>) => `#${String(c.seq).padStart(3, '0')}`;
export const shortId = (id: string) => id.slice(-6);

/** One-line change summary for a commit row, e.g. "+1 asset, −2 dependencies, 1 behaviour change". */
export function summaryText(s: ChangeSummary): string {
  const plural = (n: number, w: string, p = `${w}s`) => `${n} ${n === 1 ? w : p}`;
  const parts: string[] = [];
  if (s.nodesAdded) parts.push(`+${plural(s.nodesAdded, 'asset')}`);
  if (s.nodesRemoved) parts.push(`−${plural(s.nodesRemoved, 'asset')}`);
  if (s.nodesModified) parts.push(`${plural(s.nodesModified, 'asset')} edited`);
  if (s.depsAdded) parts.push(`+${plural(s.depsAdded, 'dependency', 'dependencies')}`);
  if (s.depsRemoved) parts.push(`−${plural(s.depsRemoved, 'dependency', 'dependencies')}`);
  if (s.depsModified) parts.push(`${plural(s.depsModified, 'dependency', 'dependencies')} edited`);
  if (s.behavioural) parts.push(`${plural(s.behavioural, 'behaviour change')}`);
  if (s.moved) parts.push(`${plural(s.moved, 'asset')} moved`);
  return parts.join(', ') || 'No changes';
}

/* --------------------------------------------------------------- branches */

export interface BranchInfo {
  id: string;
  scenarioId: string;
  name: string;
  description: string;
  parentBranchId: string | null;
  parentBranchName: string | null;
  ancestry: { id: string; name: string }[];
  baseCommitId: string;
  baseCommitSeq: number;
  headCommitId: string;
  isDefault: boolean;
  commitCount: number;
  pendingPatchCount: number;
  simulationCount: number;
  headCommit: Commit;
  createdAt: string;
  updatedAt: string;
}

export interface BranchState {
  branch: BranchInfo;
  head: Commit;
  /** Head snapshot with the uncommitted patches applied. */
  working: GraphDoc;
  /** Uncommitted patches, oldest first. */
  patches: Patch[];
  dirty: boolean;
  /** Default branch only: the scenario was edited elsewhere since main's latest commit. */
  scenarioDrift?: boolean;
}

export interface CommitDetail {
  commit: Commit;
  graph: GraphDoc;
  patches: Patch[];
}

export interface CommitComparison {
  from: Commit;
  to: Commit;
  relation: 'same' | 'ancestor' | 'descendant' | 'diverged';
  sameContent: boolean;
  summary: ChangeSummary;
}

/** Branches arranged so that each branch follows its parent, with its depth in the tree. */
export function branchTree(branches: BranchInfo[]): { branch: BranchInfo; depth: number }[] {
  const children = new Map<string | null, BranchInfo[]>();
  const ids = new Set(branches.map((b) => b.id));
  for (const b of branches) {
    const key = b.parentBranchId && ids.has(b.parentBranchId) ? b.parentBranchId : null;
    (children.get(key) ?? children.set(key, []).get(key)!).push(b);
  }
  const out: { branch: BranchInfo; depth: number }[] = [];
  const visit = (parent: string | null, depth: number) => {
    const list = (children.get(parent) ?? []).sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.createdAt.localeCompare(b.createdAt));
    for (const b of list) {
      out.push({ branch: b, depth });
      visit(b.id, depth + 1);
    }
  };
  visit(null, 0);
  return out;
}

/* ------------------------------------------------------------ simulations */

/** Stored result of a branch simulation, exactly as the server computed it. */
export interface StoredResult {
  seedNodes: string[];
  seedLinks: string[];
  failed: string[];
  rounds: string[][];
  roundOf: Record<string, number>;
  causes: Record<string, string[]>;
  causeKind: Record<string, 'seed' | 'required' | 'alternates'>;
  causeLinkIds: Record<string, string[]>;
  linkDownRound: Record<string, number>;
  totals: { failed: number; cascaded: number; critical: number; rounds: number };
}

export interface BranchSimulation {
  id: string;
  scenarioId: string;
  branchId: string;
  commitId: string;
  commit: { id: string; seq: number; message: string; branchId: string; createdAt: string };
  /** True while the branch head is still the commit this simulation ran on. */
  isCurrent: boolean;
  name: string;
  failedIds: string[];
  failedLinkIds: string[];
  config: { engineVersion: number; model: string; linkFailures: boolean };
  totals: StoredResult['totals'];
  createdAt: string;
}

export interface BranchSimulationDetail extends BranchSimulation {
  result: StoredResult;
  /** The exact graph this simulation ran on. */
  graph: GraphDoc;
  /** Recomputing it now gives the identical result. */
  reproducible: boolean;
}

/** Rebuilds the engine's Simulation object from a stored result, so analysis.ts can explain it unchanged. */
export function hydrateSimulation(result: StoredResult, graph: GraphDoc): Simulation {
  const dep = new Map(graph.dependencies.map((d) => [d.id, d]));
  return {
    failed: new Set(result.failed),
    rounds: result.rounds,
    roundOf: new Map(Object.entries(result.roundOf)),
    causes: new Map(Object.entries(result.causes)),
    causeLinks: new Map(Object.entries(result.causeLinkIds).map(([id, ids]) => [id, ids.map((l) => dep.get(l)).filter((d): d is Dependency => !!d)])),
    causeKind: new Map(Object.entries(result.causeKind)),
    seedNodes: result.seedNodes,
    seedLinks: result.seedLinks,
    linkDownRound: new Map(Object.entries(result.linkDownRound)),
  };
}

/** Whether two graphs hold the same assets and dependencies (positions ignored). Used to tell if the working graph equals a commit. */
export function sameGraphContent(a: GraphDoc, b: GraphDoc): boolean {
  if (a.assets.length !== b.assets.length || a.dependencies.length !== b.dependencies.length) return false;
  const bAssets = new Map(b.assets.map((x) => [x.id, x]));
  for (const x of a.assets) {
    const y = bAssets.get(x.id);
    if (!y || y.name !== x.name || y.kind !== x.kind || y.criticality !== x.criticality || (y.notes ?? '') !== (x.notes ?? '')) return false;
  }
  const bDeps = new Map(b.dependencies.map((x) => [x.id, x]));
  for (const x of a.dependencies) {
    const y = bDeps.get(x.id);
    if (!y || y.dependentId !== x.dependentId || y.providerId !== x.providerId || y.mode !== x.mode || y.status !== x.status || y.relation !== x.relation || (y.notes ?? '') !== (x.notes ?? '')) return false;
  }
  return true;
}
