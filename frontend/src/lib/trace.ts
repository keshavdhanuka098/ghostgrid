// Dependency trace helpers for the Investigation page: the actual paths to and from an asset, and what two assets share.

import { weakestStatus } from './analysis';
import { traceAsset } from './graph';
import type { Asset, Dependency, LinkStatus } from './types';

export interface PathEntry {
  asset: Asset;
  hops: number;
  /** Links in reliance order: the first one's dependent is the relying asset, the last one's provider is the relied-on asset. */
  links: Dependency[];
  /** Weakest status along the path: a path is only as certain as its least certain link. */
  status: LinkStatus;
}

/** Asset ids along a path, from the relying asset to the relied-on asset. */
export const chainIds = (links: Dependency[]): string[] => (links.length ? [...links.map((l) => l.dependentId), links[links.length - 1].providerId] : []);

function bfs(assets: Asset[], deps: Dependency[], originId: string, dir: 'up' | 'down'): PathEntry[] {
  const byId = new Map(assets.map((a) => [a.id, a]));
  const adj = new Map<string, Dependency[]>();
  for (const d of deps) {
    if (!byId.has(d.dependentId) || !byId.has(d.providerId)) continue;
    const from = dir === 'up' ? d.dependentId : d.providerId;
    (adj.get(from) ?? adj.set(from, []).get(from)!).push(d);
  }
  const seen = new Map<string, Dependency[]>([[originId, []]]); // asset -> links from the origin, in traversal order
  const queue = [originId];
  for (let i = 0; i < queue.length; i++) {
    const cur = queue[i];
    for (const d of adj.get(cur) ?? []) {
      const next = dir === 'up' ? d.providerId : d.dependentId;
      if (seen.has(next)) continue;
      seen.set(next, [...seen.get(cur)!, d]);
      queue.push(next);
    }
  }
  const out: PathEntry[] = [];
  for (const [id, links] of seen) {
    if (id === originId) continue;
    out.push({ asset: byId.get(id)!, hops: links.length, links: dir === 'up' ? links : [...links].reverse(), status: weakestStatus(links) });
  }
  return out.sort((a, b) => a.hops - b.hops || a.asset.name.localeCompare(b.asset.name));
}

/** What the asset relies on, with the shortest path to each. */
export const upstreamPaths = (assets: Asset[], deps: Dependency[], id: string) => bfs(assets, deps, id, 'up');
/** What relies on the asset, with the shortest path from each. */
export const downstreamPaths = (assets: Asset[], deps: Dependency[], id: string) => bfs(assets, deps, id, 'down');

export interface SharedUpstream {
  asset: Asset;
  hopsA: number;
  hopsB: number;
  /** Weakest evidence across both paths. */
  status: LinkStatus;
}

/** Assets that both A and B rely on, directly or through other assets. */
export function sharedBetween(assets: Asset[], deps: Dependency[], aId: string, bId: string): SharedUpstream[] {
  if (aId === bId) return [];
  const a = new Map(upstreamPaths(assets, deps, aId).map((e) => [e.asset.id, e]));
  const out: SharedUpstream[] = [];
  for (const e of upstreamPaths(assets, deps, bId)) {
    const x = a.get(e.asset.id);
    if (x) out.push({ asset: e.asset, hopsA: x.hops, hopsB: e.hops, status: weakestStatus([...x.links, ...e.links]) });
  }
  return out.sort((p, q) => p.hopsA + p.hopsB - (q.hopsA + q.hopsB) || p.asset.name.localeCompare(q.asset.name));
}

export { traceAsset };
