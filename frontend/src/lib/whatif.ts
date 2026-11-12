// Hypothetical ("what-if") changes to assets and dependency links. They are applied on top of a scenario to produce a
// separate asset/dependency set for analysis. The saved scenario is never modified by anything in this file.

import { findSharedDependencies, outcomeFor, type FailureSeed, type Outcome, type SharedDependency } from './graph';
import { investigate, type Finding, type Hypothesis, type Investigation, normaliseHypothesis } from './analysis';
import { CRIT_LABEL, type Asset, type AssetKind, type Criticality, type Dependency, type DependencyMode, type Scenario } from './types';

export const WHATIF_PREFIX = 'wi-';
export const isHypothetical = (id: string) => id.startsWith(WHATIF_PREFIX);

export interface AssetChange {
  /** false: the asset does not exist in the hypothetical model. */
  exists?: false;
  criticality?: Criticality;
}

export interface WhatIfChanges {
  /** Edits to existing dependency links, by link id. */
  links: Record<string, Hypothesis>;
  /** Edits to existing assets, by asset id. */
  assets: Record<string, AssetChange>;
  addedAssets: Asset[];
  addedLinks: Dependency[];
}

export const emptyChanges = (): WhatIfChanges => ({ links: {}, assets: {}, addedAssets: [], addedLinks: [] });

export function normaliseAssetChange(a: Asset, c: AssetChange): AssetChange | null {
  if (c.exists === false) return { exists: false };
  if (c.criticality && c.criticality !== a.criticality) return { criticality: c.criticality };
  return null;
}

/** Drops changes that no longer apply (deleted assets/links, no-ops, links to missing assets). */
export function cleanChanges(base: { assets: Asset[]; dependencies: Dependency[] }, ch: WhatIfChanges): WhatIfChanges {
  const out = emptyChanges();
  for (const d of base.dependencies) {
    const h = ch.links[d.id] && normaliseHypothesis(d, ch.links[d.id]);
    if (h) out.links[d.id] = h;
  }
  for (const a of base.assets) {
    const c = ch.assets[a.id] && normaliseAssetChange(a, ch.assets[a.id]);
    if (c) out.assets[a.id] = c;
  }
  out.addedAssets = ch.addedAssets.filter((a) => isHypothetical(a.id));
  const known = new Set([...base.assets.map((a) => a.id), ...out.addedAssets.map((a) => a.id)]);
  out.addedLinks = ch.addedLinks.filter((d) => isHypothetical(d.id) && known.has(d.dependentId) && known.has(d.providerId));
  return out;
}

export const countChanges = (ch: WhatIfChanges) =>
  Object.keys(ch.links).length + Object.keys(ch.assets).length + ch.addedAssets.length + ch.addedLinks.length;

/** The assets and dependencies as they would be if every change were true. */
export function applyChanges(assets: Asset[], deps: Dependency[], ch: WhatIfChanges): { assets: Asset[]; deps: Dependency[] } {
  const outAssets: Asset[] = [];
  for (const a of assets) {
    const c = ch.assets[a.id];
    if (c?.exists === false) continue;
    outAssets.push(c?.criticality ? { ...a, criticality: c.criticality } : a);
  }
  outAssets.push(...ch.addedAssets);
  const ids = new Set(outAssets.map((a) => a.id));
  const outDeps: Dependency[] = [];
  for (const d of deps) {
    const h = ch.links[d.id];
    if (h?.exists === false) continue;
    outDeps.push(h?.mode ? { ...d, mode: h.mode } : d);
  }
  outDeps.push(...ch.addedLinks);
  return { assets: outAssets, deps: outDeps.filter((d) => ids.has(d.dependentId) && ids.has(d.providerId)) };
}

/* ------------------------------------------------------------ description */

export interface ChangeItem {
  key: string;
  kind: 'asset-remove' | 'asset-criticality' | 'asset-add' | 'link-remove' | 'link-mode' | 'link-add';
  text: string;
  /** The change contradicts something marked confirmed. */
  contradictsConfirmed: boolean;
  /** A single-change set, used to test what this change does on its own. */
  only: WhatIfChanges;
}

export function describeChanges(s: Pick<Scenario, 'assets' | 'dependencies'>, ch: WhatIfChanges): ChangeItem[] {
  const all = [...s.assets, ...ch.addedAssets];
  const name = (id: string) => all.find((a) => a.id === id)?.name ?? 'Unknown';
  const link = (d: Dependency) => `${name(d.dependentId)} → ${name(d.providerId)}`;
  const items: ChangeItem[] = [];
  for (const a of s.assets) {
    const c = ch.assets[a.id];
    if (!c) continue;
    items.push({
      key: `a:${a.id}`,
      kind: c.exists === false ? 'asset-remove' : 'asset-criticality',
      text: c.exists === false ? `${a.name} does not exist (removed along with its dependencies)` : `${a.name} is ${CRIT_LABEL[c.criticality!]} criticality instead of ${CRIT_LABEL[a.criticality]}`,
      contradictsConfirmed: false,
      only: { ...emptyChanges(), assets: { [a.id]: c } },
    });
  }
  for (const a of ch.addedAssets)
    items.push({ key: `na:${a.id}`, kind: 'asset-add', text: `New asset ${a.name} (${a.kind}, ${CRIT_LABEL[a.criticality]})`, contradictsConfirmed: false, only: { ...emptyChanges(), addedAssets: [a] } });
  for (const d of s.dependencies) {
    const h = ch.links[d.id];
    if (!h) continue;
    items.push({
      key: `l:${d.id}`,
      kind: h.exists === false ? 'link-remove' : 'link-mode',
      text: h.exists === false ? `${link(d)} does not exist` : `${link(d)} is ${h.mode} instead of ${d.mode}`,
      contradictsConfirmed: d.status === 'confirmed',
      only: { ...emptyChanges(), links: { [d.id]: h } },
    });
  }
  for (const d of ch.addedLinks)
    items.push({ key: `nl:${d.id}`, kind: 'link-add', text: `New ${d.mode} dependency ${link(d)}`, contradictsConfirmed: false, only: { ...emptyChanges(), addedLinks: [d] } });
  return items;
}

/** Link ids the graph should mark as under a what-if assumption. */
export const changedLinkIds = (ch: WhatIfChanges) => new Set([...Object.keys(ch.links), ...ch.addedLinks.map((d) => d.id)]);
export const changedAssetIds = (ch: WhatIfChanges) => new Set([...Object.keys(ch.assets), ...ch.addedAssets.map((a) => a.id)]);

/* ------------------------------------------------------------ comparisons */

export interface SetDiff {
  added: string[];
  removed: string[];
}
export const diffSets = (before: Set<string>, after: Set<string>): SetDiff => ({
  added: [...after].filter((k) => !before.has(k)),
  removed: [...before].filter((k) => !after.has(k)),
});

type Base = { assets: Asset[]; dependencies: Dependency[] };
const hypo = (b: Base, ch: WhatIfChanges) => applyChanges(b.assets, b.dependencies, ch);

export interface SimulationComparison {
  before: Outcome;
  after: Outcome;
  newlyDown: string[];
  noLongerDown: string[];
  /** Still down in both, but in a different round. */
  roundChanged: string[];
}

export function compareSimulation(base: Base, ch: WhatIfChanges, seed: FailureSeed): SimulationComparison {
  const h = hypo(base, ch);
  const before = outcomeFor(base.assets, base.dependencies, seed);
  const after = outcomeFor(h.assets, h.deps, seed);
  const d = diffSets(before.sim.failed, after.sim.failed);
  const roundChanged = [...after.sim.failed].filter((id) => before.sim.failed.has(id) && before.sim.roundOf.get(id) !== after.sim.roundOf.get(id));
  return { before, after, newlyDown: d.added, noLongerDown: d.removed, roundChanged };
}

export interface FindingsComparison {
  before: Investigation | null;
  after: Investigation | null;
  added: Finding[];
  removed: Finding[];
  /** Same finding, but its evidence, redundancy or support changed. */
  changed: { before: Finding; after: Finding }[];
}

export function compareFindings(base: Base, ch: WhatIfChanges, targetId: string): FindingsComparison {
  const h = hypo(base, ch);
  const before = investigate(base.assets, base.dependencies, targetId);
  const after = investigate(h.assets, h.deps, targetId);
  const b = new Map((before?.findings ?? []).map((f) => [f.id, f]));
  const a = new Map((after?.findings ?? []).map((f) => [f.id, f]));
  return {
    before,
    after,
    added: [...a.values()].filter((f) => !b.has(f.id)),
    removed: [...b.values()].filter((f) => !a.has(f.id)),
    changed: [...a.values()].filter((f) => b.has(f.id) && b.get(f.id)!.signature !== f.signature).map((f) => ({ before: b.get(f.id)!, after: f })),
  };
}

export interface SharedComparison {
  before: SharedDependency[];
  after: SharedDependency[];
  added: SharedDependency[];
  removed: SharedDependency[];
}

export function compareShared(base: Base, ch: WhatIfChanges): SharedComparison {
  const h = hypo(base, ch);
  const before = findSharedDependencies(base.assets, base.dependencies).filter((x) => x.isHiddenShared);
  const after = findSharedDependencies(h.assets, h.deps).filter((x) => x.isHiddenShared);
  const b = new Set(before.map((x) => x.asset.id));
  const a = new Set(after.map((x) => x.asset.id));
  return { before, after, added: after.filter((x) => !b.has(x.asset.id)), removed: before.filter((x) => !a.has(x.asset.id)) };
}

/**
 * Explains each difference between the original and hypothetical result by applying every change on its own.
 * `evaluate` turns an asset/dependency set into the set of keys that hold in it (failed assets, finding ids...).
 */
export function attribute(
  base: Base,
  ch: WhatIfChanges,
  items: ChangeItem[],
  evaluate: (assets: Asset[], deps: Dependency[]) => Set<string>,
): Map<string, { direction: 'added' | 'removed'; causes: string[] }> {
  const before = evaluate(base.assets, base.dependencies);
  const h = hypo(base, ch);
  const after = evaluate(h.assets, h.deps);
  const singles = items.map((it) => {
    const x = hypo(base, it.only);
    return { it, keys: evaluate(x.assets, x.deps) };
  });
  const out = new Map<string, { direction: 'added' | 'removed'; causes: string[] }>();
  for (const key of new Set([...before, ...after])) {
    if (before.has(key) === after.has(key)) continue;
    const direction = after.has(key) ? 'added' : 'removed';
    out.set(key, { direction, causes: singles.filter((s) => s.keys.has(key) === after.has(key)).map((s) => s.it.text) });
  }
  return out;
}

export const NEW_ASSET_KIND: AssetKind = 'service';
export const NEW_LINK_MODE: DependencyMode = 'alternate';
