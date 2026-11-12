import { CRIT_WEIGHT, type Asset, type AssetKind, type Dependency } from './types.ts';

/* ------------------------------------------------------------------ index */

export interface GraphIndex {
  byId: Map<string, Asset>;
  /** dependencies keyed by the dependent asset (what it relies on) */
  providers: Map<string, Dependency[]>;
  /** dependencies keyed by the provider asset (what relies on it) */
  dependents: Map<string, Dependency[]>;
}

export function buildIndex(assets: Asset[], deps: Dependency[]): GraphIndex {
  const byId = new Map(assets.map((a) => [a.id, a]));
  const providers = new Map<string, Dependency[]>();
  const dependents = new Map<string, Dependency[]>();
  for (const d of deps) {
    if (!byId.has(d.dependentId) || !byId.has(d.providerId)) continue;
    (providers.get(d.dependentId) ?? providers.set(d.dependentId, []).get(d.dependentId)!).push(d);
    (dependents.get(d.providerId) ?? dependents.set(d.providerId, []).get(d.providerId)!).push(d);
  }
  return { byId, providers, dependents };
}

/* ------------------------------------------------------------- simulation */

/** What fails at the start: assets, and/or individual dependency links (the provider stops serving that one dependent). */
export interface FailureSeed {
  nodes?: Iterable<string>;
  links?: Iterable<string>;
}

/** Why an asset failed. `seed`: it was failed directly. `required`: a required provider or link is down. `alternates`: every alternate is down. */
export type CauseKind = 'seed' | 'required' | 'alternates';

export interface Simulation {
  /** Every failed asset, including the initial ones. */
  failed: Set<string>;
  /**
   * rounds[0] = initial failures, rounds[n] = assets that failed because of round n-1.
   * When only links are failed, rounds[0] is empty: nothing is down yet, but the links are.
   */
  rounds: string[][];
  roundOf: Map<string, number>;
  /** For each failed asset, the failed providers that caused it (empty for initial failures and for broken links). */
  causes: Map<string, string[]>;
  /** For each cascaded asset, the dependency links that were down and caused it. Empty for initial failures. */
  causeLinks: Map<string, Dependency[]>;
  causeKind: Map<string, CauseKind>;
  /** Initial failures that exist in the model. */
  seedNodes: string[];
  seedLinks: string[];
  /** Round in which a link stopped working: 0 if it was failed directly, otherwise the round its provider failed. Absent while it still works. */
  linkDownRound: Map<string, number>;
}

/**
 * Propagates failures through the dependency graph.
 * - A link is down when it was failed directly or its provider has failed.
 * - A dependent fails when any of its required links is down.
 * - If it has alternate links, it also fails once all of them are down.
 * Cycles are fine: an asset fails at most once, so the process always terminates.
 * Everything is derived from the mapped dependencies. There is no randomness and no hidden state.
 */
export function simulateFailure(assets: Asset[], deps: Dependency[], seed: FailureSeed): Simulation {
  const idx = buildIndex(assets, deps);
  const linkById = new Map(deps.filter((d) => idx.byId.has(d.dependentId) && idx.byId.has(d.providerId)).map((d) => [d.id, d]));
  const failed = new Set<string>();
  const roundOf = new Map<string, number>();
  const causes = new Map<string, string[]>();
  const causeLinks = new Map<string, Dependency[]>();
  const causeKind = new Map<string, CauseKind>();
  const linkDownRound = new Map<string, number>();
  const rounds: string[][] = [];

  const seedNodes = [...new Set(seed.nodes ?? [])].filter((id) => idx.byId.has(id));
  const seedLinks = [...new Set(seed.links ?? [])].filter((id) => linkById.has(id));
  const seedLinkSet = new Set(seedLinks);
  for (const id of seedNodes) {
    failed.add(id);
    roundOf.set(id, 0);
    causes.set(id, []);
    causeLinks.set(id, []);
    causeKind.set(id, 'seed');
  }
  for (const id of seedLinks) linkDownRound.set(id, 0);
  if (seedNodes.length || seedLinks.length) rounds.push(seedNodes);

  const isDown = (d: Dependency) => seedLinkSet.has(d.id) || failed.has(d.providerId);

  for (;;) {
    const next: { id: string; kind: CauseKind; links: Dependency[] }[] = [];
    for (const asset of assets) {
      if (failed.has(asset.id)) continue;
      const provs = idx.providers.get(asset.id);
      if (!provs?.length) continue;
      const downRequired = provs.filter((p) => p.mode === 'required' && isDown(p));
      const alternates = provs.filter((p) => p.mode === 'alternate');
      if (downRequired.length) next.push({ id: asset.id, kind: 'required', links: downRequired });
      else if (alternates.length && alternates.every(isDown)) next.push({ id: asset.id, kind: 'alternates', links: alternates });
    }
    if (!next.length) break;
    const round = rounds.length;
    for (const n of next) {
      failed.add(n.id);
      roundOf.set(n.id, round);
      causeKind.set(n.id, n.kind);
      causeLinks.set(n.id, n.links);
      causes.set(n.id, n.links.filter((l) => failed.has(l.providerId) && !seedLinkSet.has(l.id)).map((l) => l.providerId));
    }
    // Links out of the newly failed assets are down from this round on.
    for (const n of next) for (const l of idx.dependents.get(n.id) ?? []) if (!linkDownRound.has(l.id)) linkDownRound.set(l.id, round);
    rounds.push(next.map((n) => n.id));
  }
  // Links out of the initial failures are down from round 0.
  for (const id of seedNodes) for (const l of idx.dependents.get(id) ?? []) if (!linkDownRound.has(l.id)) linkDownRound.set(l.id, 0);
  return { failed, rounds, roundOf, causes, causeLinks, causeKind, seedNodes, seedLinks, linkDownRound };
}

/** Failure of one or more assets. */
export function simulate(assets: Asset[], deps: Dependency[], failedIds: Iterable<string>): Simulation {
  return simulateFailure(assets, deps, { nodes: failedIds });
}

/** The chain of failures leading to `assetId`, root first. */
export function traceChain(sim: Simulation, assetId: string): string[] {
  const chain = [assetId];
  const seen = new Set(chain);
  let current = assetId;
  for (;;) {
    const causes = sim.causes.get(current);
    if (!causes?.length) break;
    const next = causes.find((c) => !seen.has(c)) ?? causes[0];
    if (seen.has(next)) break;
    chain.unshift(next);
    seen.add(next);
    current = next;
  }
  return chain;
}

/* --------------------------------------------------- shared dependencies */

export interface SharedDependency {
  asset: Asset;
  /** Assets that fail and list this asset as a direct provider. */
  direct: string[];
  /** Assets that fail but do NOT list this asset as a direct provider. */
  hidden: string[];
  reached: string[];
  criticalReached: string[];
  hiddenKinds: AssetKind[];
  /** Criticality-weighted size of the hidden exposure. */
  score: number;
  /** Failure reaches two or more assets through indirect paths only. */
  isHiddenShared: boolean;
}

/**
 * For every asset, finds what fails if it fails, and how much of that is only visible through indirect paths.
 * Results are based solely on the dependencies the user has mapped.
 */
export function findSharedDependencies(assets: Asset[], deps: Dependency[]): SharedDependency[] {
  const idx = buildIndex(assets, deps);
  const results: SharedDependency[] = [];
  for (const asset of assets) {
    const sim = simulate(assets, deps, [asset.id]);
    const reached = [...sim.failed].filter((id) => id !== asset.id);
    const directSet = new Set((idx.dependents.get(asset.id) ?? []).map((d) => d.dependentId));
    const direct = reached.filter((id) => directSet.has(id));
    const hidden = reached.filter((id) => !directSet.has(id));
    if (!hidden.length) continue;
    const hiddenAssets = hidden.map((id) => idx.byId.get(id)!);
    results.push({
      asset,
      direct,
      hidden,
      reached,
      criticalReached: reached.filter((id) => idx.byId.get(id)!.criticality === 'critical'),
      hiddenKinds: [...new Set(hiddenAssets.map((a) => a.kind))],
      score: hiddenAssets.reduce((sum, a) => sum + CRIT_WEIGHT[a.criticality], 0),
      isHiddenShared: hidden.length >= 2,
    });
  }
  return results.sort((a, b) => b.score - a.score || a.asset.name.localeCompare(b.asset.name));
}

/* ---------------------------------------------------------------- outcome */

export interface Outcome {
  failed: string[];
  total: number;
  critical: number;
  /** Failures beyond the initial ones. */
  cascaded: number;
  sim: Simulation;
}

export function outcomeFor(assets: Asset[], deps: Dependency[], failure: string[] | FailureSeed): Outcome {
  const sim = simulateFailure(assets, deps, Array.isArray(failure) ? { nodes: failure } : failure);
  const byId = new Map(assets.map((a) => [a.id, a]));
  const failed = [...sim.failed];
  return {
    failed,
    total: failed.length,
    critical: failed.filter((id) => byId.get(id)?.criticality === 'critical').length,
    cascaded: failed.length - (sim.rounds[0]?.length ?? 0),
    sim,
  };
}

/* ----------------------------------------------------------------- layout */

export const NODE_W = 176;
export const NODE_H = 48;
const COL_GAP = 72;
const ROW_GAP = 18;
const PAD = 24;

/** Depth of each asset: 0 for assets that rely on nothing, otherwise 1 + the deepest provider. */
export function computeLevels(assets: Asset[], deps: Dependency[]): Map<string, number> {
  const idx = buildIndex(assets, deps);
  const memo = new Map<string, number>();
  const visiting = new Set<string>();
  const level = (id: string): number => {
    const known = memo.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) return 0; // cycle: ignore the back edge
    visiting.add(id);
    let l = 0;
    for (const d of idx.providers.get(id) ?? []) l = Math.max(l, level(d.providerId) + 1);
    visiting.delete(id);
    memo.set(id, l);
    return l;
  };
  assets.forEach((a) => level(a.id));
  return memo;
}

export interface Point {
  x: number;
  y: number;
}

export interface Layout {
  /** Top-left corner of every node. Pinned positions (asset.x / asset.y) win over the automatic layout. */
  pos: Map<string, Point>;
  width: number;
  height: number;
  levels: Map<string, number>;
  /** Ids of assets whose position is pinned by the user. */
  pinned: Set<string>;
}

/** Providers sit on the left, dependents to the right. Assets with a saved position keep it. */
export function layoutGraph(assets: Asset[], deps: Dependency[]): Layout {
  const levels = computeLevels(assets, deps);
  const idx = buildIndex(assets, deps);
  const columns: Asset[][] = [];
  for (const a of assets) (columns[levels.get(a.id) ?? 0] ??= []).push(a);

  const order = new Map<string, number>();
  columns.forEach((col, ci) => {
    if (!col) return;
    if (ci === 0) col.sort((a, b) => a.name.localeCompare(b.name));
    else {
      const bary = (a: Asset) => {
        const provs = (idx.providers.get(a.id) ?? []).map((d) => order.get(d.providerId)).filter((v): v is number => v !== undefined);
        return provs.length ? provs.reduce((s, v) => s + v, 0) / provs.length : Number.MAX_SAFE_INTEGER;
      };
      col.sort((a, b) => bary(a) - bary(b) || a.name.localeCompare(b.name));
    }
    col.forEach((a, i) => order.set(a.id, i));
  });

  const cols = columns.filter(Boolean);
  const maxRows = Math.max(1, ...cols.map((c) => c.length));
  const innerH = maxRows * NODE_H + (maxRows - 1) * ROW_GAP;
  const pos = new Map<string, Point>();
  columns.forEach((col, ci) => {
    if (!col) return;
    const colH = col.length * NODE_H + (col.length - 1) * ROW_GAP;
    const top = PAD + (innerH - colH) / 2;
    col.forEach((a, i) => pos.set(a.id, { x: PAD + ci * (NODE_W + COL_GAP), y: top + i * (NODE_H + ROW_GAP) }));
  });

  const pinned = new Set<string>();
  for (const a of assets) {
    if (typeof a.x === 'number' && typeof a.y === 'number') {
      pos.set(a.id, { x: a.x, y: a.y });
      pinned.add(a.id);
    }
  }

  // Bounds cover every node, so pinned nodes dragged outside the automatic area are still reachable.
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pos.values()) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x + NODE_W);
    maxY = Math.max(maxY, p.y + NODE_H);
  }
  if (!pos.size) {
    minX = minY = 0;
    maxX = maxY = 0;
  }
  const shiftX = Math.min(0, minX - PAD);
  const shiftY = Math.min(0, minY - PAD);
  if (shiftX || shiftY) for (const p of pos.values()) ((p.x -= shiftX), (p.y -= shiftY));
  return {
    pos,
    levels,
    pinned,
    width: Math.max(PAD * 2 + NODE_W, maxX - shiftX + PAD),
    height: Math.max(PAD * 2 + NODE_H, maxY - shiftY + PAD),
  };
}

export interface EdgeGeometry {
  d: string;
  /** Midpoint of the curve, where the status marker sits. */
  mid: Point;
}

/**
 * Curve for a dependency, drawn from the provider to the dependent. In the layered layout this runs from the provider's
 * right edge to the dependent's left edge; when nodes have been moved so that is not possible, it connects the facing sides.
 */
export function edgeGeometry(from: Point, to: Point): EdgeGeometry {
  if (from.x + NODE_W + 24 <= to.x) {
    const x1 = from.x + NODE_W;
    const y1 = from.y + NODE_H / 2;
    const x2 = to.x;
    const y2 = to.y + NODE_H / 2;
    const dx = Math.max(40, Math.abs(x2 - x1) / 2);
    const c1x = x1 + dx;
    const c2x = x2 - dx;
    return {
      d: `M${x1} ${y1}C${c1x} ${y1} ${c2x} ${y2} ${x2} ${y2}`,
      mid: { x: (x1 + 3 * c1x + 3 * c2x + x2) / 8, y: (y1 + y2) / 2 },
    };
  }
  // Facing-sides fallback: vertical when the nodes overlap horizontally, otherwise right-to-left.
  const fc = { x: from.x + NODE_W / 2, y: from.y + NODE_H / 2 };
  const tc = { x: to.x + NODE_W / 2, y: to.y + NODE_H / 2 };
  const overlapX = Math.abs(fc.x - tc.x) < NODE_W;
  let a: Point;
  let b: Point;
  if (overlapX) {
    const down = tc.y >= fc.y;
    a = { x: fc.x, y: down ? from.y + NODE_H : from.y };
    b = { x: tc.x, y: down ? to.y : to.y + NODE_H };
    const dy = Math.max(30, Math.abs(b.y - a.y) / 2);
    const sign = down ? 1 : -1;
    return {
      d: `M${a.x} ${a.y}C${a.x} ${a.y + sign * dy} ${b.x} ${b.y - sign * dy} ${b.x} ${b.y}`,
      mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
    };
  }
  const right = tc.x >= fc.x;
  a = { x: right ? from.x + NODE_W : from.x, y: fc.y };
  b = { x: right ? to.x : to.x + NODE_W, y: tc.y };
  const dx = Math.max(40, Math.abs(b.x - a.x) / 2);
  const sign = right ? 1 : -1;
  return {
    d: `M${a.x} ${a.y}C${a.x + sign * dx} ${a.y} ${b.x - sign * dx} ${b.y} ${b.x} ${b.y}`,
    mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
  };
}

/* ---------------------------------------------------------------- tracing */

export type TraceMode = 'off' | 'up' | 'down' | 'both';

export interface Trace {
  origin: string;
  mode: TraceMode;
  /** What the origin relies on, directly or through other assets, with the number of hops. */
  upstream: Map<string, number>;
  /** What relies on the origin, directly or through other assets, with the number of hops. */
  downstream: Map<string, number>;
  /** Dependency ids along the traced paths. */
  links: Set<string>;
}

function walk(idx: GraphIndex, start: string, direction: 'up' | 'down', links: Set<string>): Map<string, number> {
  const depth = new Map<string, number>();
  const visited = new Set([start]);
  let frontier = [start];
  for (let hops = 1; frontier.length; hops++) {
    const next: string[] = [];
    for (const id of frontier) {
      // Upstream follows a dependent to its providers; downstream follows a provider to its dependents.
      const deps = direction === 'up' ? (idx.providers.get(id) ?? []) : (idx.dependents.get(id) ?? []);
      for (const d of deps) {
        links.add(d.id);
        const other = direction === 'up' ? d.providerId : d.dependentId;
        if (visited.has(other)) continue;
        visited.add(other);
        depth.set(other, hops);
        next.push(other);
      }
    }
    frontier = next;
  }
  return depth;
}

/** Everything upstream (relied on) and/or downstream (relying) of an asset. Safe on cycles. */
export function traceAsset(assets: Asset[], deps: Dependency[], origin: string, mode: Exclude<TraceMode, 'off'> = 'both'): Trace {
  const idx = buildIndex(assets, deps);
  const links = new Set<string>();
  const upstream = mode === 'up' || mode === 'both' ? walk(idx, origin, 'up', links) : new Map<string, number>();
  const downstream = mode === 'down' || mode === 'both' ? walk(idx, origin, 'down', links) : new Map<string, number>();
  return { origin, mode, upstream, downstream, links };
}
