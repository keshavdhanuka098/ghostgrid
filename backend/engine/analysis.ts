// Evidence-aware analysis built on the failure model in graph.ts: dependency-chain investigation, what-if assumptions,
// and explanations of cascades. Every result here is derived from the mapped dependencies. Nothing is estimated or random,
// and no probability or accuracy figures are produced, because the model has no data that could support them.

import {
  buildIndex,
  simulateFailure,
  type FailureSeed,
  type GraphIndex,
  type Simulation,
} from './graph';
import {
  CRIT_WEIGHT,
  RELATION_LABEL,
  STATUS_LABEL,
  type Asset,
  type Dependency,
  type DependencyMode,
  type LinkStatus,
} from './types';

/* ----------------------------------------------------------- evidence tiers */

/** The weakest evidence a result needs. confirmed < inferred < unknown in strength of support, in that order. */
export type Tier = 'confirmed' | 'inferred' | 'unknown';
const TIERS: Tier[] = ['confirmed', 'inferred', 'unknown'];
const keepFor: Record<Tier, (d: Dependency) => boolean> = {
  confirmed: (d) => d.status === 'confirmed',
  inferred: (d) => d.status !== 'unknown',
  unknown: () => true,
};

export const TIER_LABEL: Record<Tier, string> = {
  confirmed: 'Confirmed links only',
  inferred: 'Needs inferred links',
  unknown: 'Needs unknown links',
};

export const isUnconfirmed = (d: Dependency) => d.status !== 'confirmed';

/** Weakest status in a list of links (unknown < inferred < confirmed). Empty list counts as confirmed. */
export function weakestStatus(links: Dependency[]): LinkStatus {
  if (links.some((l) => l.status === 'unknown')) return 'unknown';
  if (links.some((l) => l.status === 'inferred')) return 'inferred';
  return 'confirmed';
}

export interface EvidenceResult {
  /** For every asset that fails when all mapped links are live: the weakest evidence tier in which it still fails. */
  tiers: Map<string, Tier>;
  /** Assets that fail when only stronger evidence is used but survive when every mapped link is live (an unconfirmed backup protects them). */
  unstable: Set<string>;
}

/**
 * Runs the same failure three times: with confirmed links only, with confirmed + inferred, and with everything.
 * An asset's tier is the first of those in which it fails. Because removing an alternate link can make a failure more likely,
 * `unstable` reports the assets whose outcome flips the "wrong" way, i.e. that rely on an unconfirmed backup actually existing.
 */
export function evidenceTiers(assets: Asset[], deps: Dependency[], seed: FailureSeed): EvidenceResult {
  const nodes = [...(seed.nodes ?? [])];
  const links = [...(seed.links ?? [])];
  const sims = TIERS.map((t) => simulateFailure(assets, deps.filter(keepFor[t]), { nodes, links }));
  const all = sims[2];
  const tiers = new Map<string, Tier>();
  for (const id of all.failed) {
    const t = TIERS.find((_, i) => sims[i].failed.has(id));
    if (t) tiers.set(id, t);
  }
  const unstable = new Set<string>();
  for (const sim of sims.slice(0, 2)) for (const id of sim.failed) if (!all.failed.has(id)) unstable.add(id);
  return { tiers, unstable };
}

/* -------------------------------------------------------------- explanation */

export interface StepReason {
  dep: Dependency;
  /** provider-failed: the provider is down. link-failed: this link was failed directly. */
  reason: 'provider-failed' | 'link-failed';
  /** Round in which the link went down. */
  downRound: number;
}

export interface Step {
  assetId: string;
  round: number;
  kind: 'seed' | 'required' | 'alternates';
  reasons: StepReason[];
  /** Weakest status among the links that caused the failure. */
  evidence: LinkStatus;
}

/** One entry per failed asset, ordered by round, saying which dependency links caused it. */
export function explainCascade(sim: Simulation): Step[] {
  const steps: Step[] = [];
  const seedLinks = new Set(sim.seedLinks);
  for (const [assetId, round] of sim.roundOf) {
    const links = sim.causeLinks.get(assetId) ?? [];
    steps.push({
      assetId,
      round,
      kind: sim.causeKind.get(assetId) ?? 'seed',
      reasons: links.map((dep) => ({
        dep,
        reason: seedLinks.has(dep.id) ? 'link-failed' : 'provider-failed',
        downRound: sim.linkDownRound.get(dep.id) ?? 0,
      })),
      evidence: weakestStatus(links),
    });
  }
  return steps.sort((a, b) => a.round - b.round);
}

export function describeStep(step: Step, nameOf: (id: string) => string): string {
  if (step.kind === 'seed') return 'Failed directly. This is the failure you selected.';
  const one = (r: StepReason) => {
    const who = nameOf(r.dep.providerId);
    const how = `${r.dep.status}, ${RELATION_LABEL[r.dep.relation].toLowerCase()}`;
    return r.reason === 'link-failed'
      ? `its link to ${who} was failed directly (${how})`
      : `${who} failed in round ${r.downRound} (${how})`;
  };
  if (step.kind === 'required')
    return `It requires ${step.reasons.length > 1 ? 'several providers that are down' : 'a provider that is down'}: ${step.reasons.map(one).join('; ')}.`;
  return `Every alternate provider is down, so no backup remains: ${step.reasons.map(one).join('; ')}.`;
}

/** All assets and links that contributed to an asset's failure, including the asset itself. */
export function ancestry(sim: Simulation, id: string): { nodes: Set<string>; links: Set<string> } {
  const nodes = new Set<string>();
  const links = new Set<string>();
  const stack = [id];
  while (stack.length) {
    const cur = stack.pop()!;
    if (nodes.has(cur)) continue;
    nodes.add(cur);
    for (const l of sim.causeLinks.get(cur) ?? []) {
      links.add(l.id);
      if (sim.failed.has(l.providerId)) stack.push(l.providerId);
    }
  }
  return { nodes, links };
}

export interface ChainStep {
  assetId: string;
  /** The dependency link that carried the failure into this asset from the previous one in the chain. Null for the root cause. */
  via: Dependency | null;
}

/** One causal chain ending at `id`, root cause first, with the link that carried each step. */
export function chainSteps(sim: Simulation, id: string): ChainStep[] {
  const ids: string[] = [id];
  const carriers: Dependency[] = []; // carriers[i] carried the failure from ids[i + 1] into ids[i]
  const seen = new Set(ids);
  let cur = id;
  for (;;) {
    const pick: Dependency | undefined = (sim.causeLinks.get(cur) ?? [])
      .filter((l) => sim.failed.has(l.providerId) && !seen.has(l.providerId))
      .sort((x, y) => (sim.roundOf.get(x.providerId) ?? 0) - (sim.roundOf.get(y.providerId) ?? 0))[0];
    if (!pick) break;
    carriers.push(pick);
    ids.push(pick.providerId);
    seen.add(pick.providerId);
    cur = pick.providerId;
  }
  ids.reverse();
  carriers.reverse();
  return ids.map((assetId, i) => ({ assetId, via: i === 0 ? null : carriers[i - 1] }));
}

/* ------------------------------------------------------------ investigation */

export type FindingKind = 'spof' | 'conditional' | 'shared';

export const FINDING_LABEL: Record<FindingKind, string> = {
  spof: 'Single point of failure',
  conditional: 'Possible single point of failure',
  shared: 'Shared dependency',
};

export interface Finding {
  id: string;
  kind: FindingKind;
  /** The upstream asset the finding is about. */
  asset: Asset;
  /** The investigated asset lists it as a direct provider. */
  direct: boolean;
  /** Steps from the investigated asset to it. */
  hops: number;
  /** The investigated asset has alternates, and this one failure takes all of them (or their own providers) down. */
  defeatsRedundancy: boolean;
  /** Direct providers of the investigated asset that reach this asset (or are it). */
  convergesVia: Asset[];
  /** Assets that fail together with it but are not part of the investigated asset's own chain. */
  alsoFails: Asset[];
  /** Weakest evidence needed for the investigated asset to fail. Null when it does not fail. */
  evidence: Tier | null;
  /** The chain of links by which failure reaches the investigated asset (first cause chain), or the dependency path for non-failing findings. */
  support: Dependency[];
  /** Every link that contributed to the failure. */
  supportIds: string[];
  /** Inferred or unknown links among the contributing links: what the finding rests on without verification. */
  unconfirmed: Dependency[];
  /** For possible single points of failure: unconfirmed links whose absence would make the finding real. */
  dependsOnAbsent: Dependency[];
  /** Criticality-weighted size of the failure caused by this asset alone. */
  score: number;
  /** Text lines explaining why this was flagged. */
  why: string[];
  /** A string that changes when anything the reader would notice about this finding changes. */
  signature: string;
}

export interface Gap {
  kind: 'unconfirmed-link' | 'chain-ends' | 'nothing-mapped';
  text: string;
  link?: Dependency;
  asset?: Asset;
}

export interface UpstreamEntry {
  asset: Asset;
  hops: number;
  /** Link from the nearer asset to this one on a shortest path. */
  via: Dependency;
  /** Weakest status along that path. */
  pathStatus: LinkStatus;
}

export interface Investigation {
  target: Asset;
  upstream: UpstreamEntry[];
  /** Every link in the upstream chain (also alternates that never carried a failure). */
  linkIds: Set<string>;
  findings: Finding[];
  gaps: Gap[];
  /** Assets that rely on the target, directly or not. */
  downstreamCount: number;
}

function pathLinks(entries: Map<string, UpstreamEntry>, id: string): Dependency[] {
  const links: Dependency[] = [];
  let cur = entries.get(id);
  while (cur) {
    links.push(cur.via);
    cur = entries.get(cur.via.dependentId);
  }
  return links; // from the asset toward the investigated target
}

function upstreamMap(idx: GraphIndex, start: string) {
  const entries = new Map<string, UpstreamEntry>();
  const linkIds = new Set<string>();
  const seen = new Set([start]);
  let frontier = [start];
  for (let hops = 1; frontier.length; hops++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const d of idx.providers.get(id) ?? []) {
        linkIds.add(d.id);
        if (seen.has(d.providerId)) continue;
        seen.add(d.providerId);
        entries.set(d.providerId, { asset: idx.byId.get(d.providerId)!, hops, via: d, pathStatus: 'confirmed' });
        next.push(d.providerId);
      }
    }
    frontier = next;
  }
  for (const [id, e] of entries) e.pathStatus = weakestStatus(pathLinks(entries, id));
  return { entries, linkIds };
}

const KIND_RANK: Record<FindingKind, number> = { spof: 0, conditional: 1, shared: 2 };

/**
 * Traces everything the target relies on and flags:
 *  - single points of failure: one upstream asset whose failure alone takes the target down;
 *  - possible single points of failure: the same, but only if unconfirmed backup links turn out not to exist;
 *  - shared dependencies: one upstream asset reached through two or more of the target's providers, which weakens redundancy.
 */
export function investigate(assets: Asset[], deps: Dependency[], targetId: string): Investigation | null {
  const idx = buildIndex(assets, deps);
  const target = idx.byId.get(targetId);
  if (!target) return null;
  const { entries, linkIds } = upstreamMap(idx, targetId);
  const directProviders = (idx.providers.get(targetId) ?? []).map((d) => d.providerId);
  const hasAlternates = (idx.providers.get(targetId) ?? []).some((d) => d.mode === 'alternate');

  // For each direct provider, everything at or above it.
  const reachFrom = new Map<string, Set<string>>();
  for (const p of directProviders) {
    const set = new Set<string>([p]);
    for (const id of upstreamMap(idx, p).entries.keys()) set.add(id);
    reachFrom.set(p, set);
  }
  const upstreamIds = new Set(entries.keys());
  const unconfirmedInChain = [...linkIds].map((id) => deps.find((d) => d.id === id)!).filter(isUnconfirmed);

  const findings: Finding[] = [];
  for (const [uid, entry] of entries) {
    const U = entry.asset;
    const sim = simulateFailure(assets, deps, { nodes: [uid] });
    const fails = sim.failed.has(targetId);
    const ev = evidenceTiers(assets, deps, { nodes: [uid] });
    const convergesVia = directProviders.filter((p) => reachFrom.get(p)!.has(uid)).map((p) => idx.byId.get(p)!);

    let kind: FindingKind | null = null;
    if (fails) kind = 'spof';
    else if (ev.unstable.has(targetId)) kind = 'conditional';
    else if (hasAlternates && convergesVia.length >= 2) kind = 'shared';
    if (!kind) continue;

    const anc = fails ? ancestry(sim, targetId) : { nodes: new Set<string>(), links: new Set<string>() };
    const chain = fails ? chainSteps(sim, targetId).slice(1).map((s) => s.via!).filter(Boolean) : pathLinks(entries, uid);
    const supportIds = fails ? [...anc.links] : chain.map((l) => l.id);
    const unconfirmed = supportIds.map((id) => deps.find((d) => d.id === id)!).filter(isUnconfirmed);
    const defeats = fails && [...anc.nodes].some((n) => sim.causeKind.get(n) === 'alternates');
    const dependsOnAbsent =
      kind === 'conditional'
        ? unconfirmedInChain.filter((l) => simulateFailure(assets, deps.filter((d) => d.id !== l.id), { nodes: [uid] }).failed.has(targetId))
        : [];
    const alsoFails = [...sim.failed].filter((id) => id !== uid && id !== targetId && !upstreamIds.has(id)).map((id) => idx.byId.get(id)!);
    const score = [...sim.failed].reduce((sum, id) => sum + CRIT_WEIGHT[idx.byId.get(id)!.criticality], 0);
    const direct = (idx.providers.get(targetId) ?? []).some((d) => d.providerId === uid);
    const evidence = fails ? (ev.tiers.get(targetId) ?? 'unknown') : null;
    const T = target.name;

    const why: string[] = [];
    if (kind === 'spof') {
      const round = sim.roundOf.get(targetId)!;
      why.push(
        direct
          ? `${T} lists ${U.name} as a provider. If ${U.name} alone fails, ${T} fails in round ${round}.`
          : `${T} does not list ${U.name} directly, but failure travels ${[uid, ...chainSteps(sim, targetId).slice(1).map((s) => s.assetId)].map((id) => idx.byId.get(id)!.name).join(' → ')}. Failing ${U.name} alone is enough to take ${T} down (round ${round}).`,
      );
      if (defeats) why.push(`${T} has alternate providers, but they share this dependency, so the redundancy does not protect against it.`);
      if (alsoFails.length) why.push(`The same failure also takes down ${alsoFails.length} asset${alsoFails.length === 1 ? '' : 's'} outside ${T}'s own chain, so this dependency is shared.`);
      why.push(
        evidence === 'confirmed'
          ? 'Every link needed to reach this conclusion is confirmed.'
          : `Reaching this conclusion needs ${unconfirmed.length} link${unconfirmed.length === 1 ? '' : 's'} that ${unconfirmed.length === 1 ? 'is' : 'are'} not confirmed (${TIER_LABEL[evidence ?? 'unknown'].toLowerCase()}).`,
      );
    } else if (kind === 'conditional') {
      why.push(
        `With every mapped link live, ${T} survives the loss of ${U.name} because at least one alternate provider remains. If the unconfirmed link${dependsOnAbsent.length === 1 ? '' : 's'} below ${dependsOnAbsent.length === 1 ? 'does' : 'do'} not exist, ${T} fails.`,
      );
      why.push('This is a possible single point of failure, not a confirmed one. Verify the backup before relying on it.');
    } else {
      why.push(`${U.name} is reached through ${convergesVia.length} of ${T}'s providers (${convergesVia.map((a) => a.name).join(', ')}), so these providers are less independent than they look.`);
      why.push(`${T} survives its loss only because an alternate provider is unaffected.`);
    }

    findings.push({
      id: `${kind}:${uid}`,
      kind,
      asset: U,
      direct,
      hops: entry.hops,
      defeatsRedundancy: defeats,
      convergesVia,
      alsoFails,
      evidence,
      support: chain,
      supportIds,
      unconfirmed,
      dependsOnAbsent,
      score: fails ? score : 0,
      why,
      signature: [kind, evidence, defeats ? 'r' : '', direct ? 'd' : 'i', unconfirmed.length].join(':'),
    });
  }
  findings.sort(
    (a, b) =>
      KIND_RANK[a.kind] - KIND_RANK[b.kind] || Number(a.direct) - Number(b.direct) || b.score - a.score || a.asset.name.localeCompare(b.asset.name),
  );

  const gaps: Gap[] = [];
  if (!directProviders.length)
    gaps.push({ kind: 'nothing-mapped', asset: target, text: `No providers are mapped for ${target.name}. If it relies on anything, that is missing from the model.` });
  for (const l of unconfirmedInChain)
    gaps.push({
      kind: 'unconfirmed-link',
      link: l,
      text: `${idx.byId.get(l.dependentId)!.name} → ${idx.byId.get(l.providerId)!.name} is ${l.status}${l.mode === 'alternate' ? ' and is assumed to be a working backup' : ''}.`,
    });
  for (const [id, e] of entries)
    if (!(idx.providers.get(id)?.length)) gaps.push({ kind: 'chain-ends', asset: e.asset, text: `The chain stops at ${e.asset.name}: nothing is mapped upstream of it, so anything it relies on is unknown.` });

  let downstreamCount = 0;
  {
    const seen = new Set([targetId]);
    const stack = [targetId];
    while (stack.length) {
      for (const d of idx.dependents.get(stack.pop()!) ?? []) if (!seen.has(d.dependentId)) (seen.add(d.dependentId), stack.push(d.dependentId), downstreamCount++);
    }
  }

  return { target, upstream: [...entries.values()].sort((a, b) => a.hops - b.hops || a.asset.name.localeCompare(b.asset.name)), linkIds, findings, gaps, downstreamCount };
}

/* ------------------------------------------------------------------ what-if */

/** A plausible alternative to what the model says about one unconfirmed link. Only the fields that deviate from the model are set. */
export interface Hypothesis {
  /** false: the link does not actually exist. */
  exists?: false;
  /** The link works in this mode instead of the mapped one. */
  mode?: DependencyMode;
}
export type Hypotheses = Record<string, Hypothesis>;

/** Only unconfirmed links can be questioned. Confirmed links are treated as verified facts. */
export const isAssumable = (d: Dependency) => d.status !== 'confirmed';

/** Drops fields that match the model, so an unchanged hypothesis is not an active one. */
export function normaliseHypothesis(dep: Dependency, h: Hypothesis): Hypothesis | null {
  const out: Hypothesis = {};
  if (h.exists === false) out.exists = false;
  else if (h.mode && h.mode !== dep.mode) out.mode = h.mode;
  return out.exists === false || out.mode ? out : null;
}

export function activeHypothesisIds(deps: Dependency[], hyps: Hypotheses): string[] {
  return deps.filter((d) => isAssumable(d) && hyps[d.id] && normaliseHypothesis(d, hyps[d.id])).map((d) => d.id);
}

/** The dependencies as they would be if the hypotheses were true. */
export function applyHypotheses(deps: Dependency[], hyps: Hypotheses): Dependency[] {
  const out: Dependency[] = [];
  for (const d of deps) {
    const h = isAssumable(d) && hyps[d.id] ? normaliseHypothesis(d, hyps[d.id]) : null;
    if (!h) out.push(d);
    else if (h.exists === false) continue;
    else out.push({ ...d, mode: h.mode! });
  }
  return out;
}

export function describeHypothesis(dep: Dependency, h: Hypothesis, nameOf: (id: string) => string): string {
  const link = `${nameOf(dep.dependentId)} → ${nameOf(dep.providerId)}`;
  if (h.exists === false) return `${link} does not actually exist`;
  return `${link} is ${h.mode === 'alternate' ? 'an alternate (backup)' : 'a required'} dependency, not ${dep.mode === 'alternate' ? 'an alternate' : 'a required one'}`;
}

export interface Change {
  key: string;
  direction: 'added' | 'removed';
  /** Hypotheses that produce this change on their own. */
  alone: string[];
  /** No single hypothesis does it; the active ones together do. */
  combined: boolean;
}

/**
 * Compares an analysis under the model against the same analysis under the hypotheses, and explains each difference by testing
 * every hypothesis on its own. `evaluate` turns a dependency set into the set of keys that hold in it (failed assets, findings...).
 */
export function attributeChanges(
  deps: Dependency[],
  hyps: Hypotheses,
  evaluate: (deps: Dependency[]) => Set<string>,
): { before: Set<string>; after: Set<string>; changes: Change[]; active: string[] } {
  const active = activeHypothesisIds(deps, hyps);
  const before = evaluate(deps);
  if (!active.length) return { before, after: before, changes: [], active };
  const after = evaluate(applyHypotheses(deps, hyps));
  const single = new Map(active.map((id) => [id, evaluate(applyHypotheses(deps, { [id]: hyps[id] }))]));
  const changes: Change[] = [];
  for (const key of new Set([...before, ...after])) {
    if (before.has(key) === after.has(key)) continue;
    const alone = active.filter((id) => single.get(id)!.has(key) === after.has(key));
    changes.push({ key, direction: after.has(key) ? 'added' : 'removed', alone, combined: alone.length === 0 });
  }
  return { before, after, changes, active };
}

export type Variant = 'absent' | 'mode';

export interface SensitivityRow {
  link: Dependency;
  variant: Variant;
  hypothesis: Hypothesis;
  added: string[];
  removed: string[];
}

/**
 * For every unconfirmed link, what would change if it were wrong? Each link is tested on its own, in two ways: it does not exist,
 * or it works in the other mode. Rows with no change mean the result does not depend on that link.
 */
export function sensitivity(deps: Dependency[], candidates: Dependency[], evaluate: (deps: Dependency[]) => Set<string>): SensitivityRow[] {
  const base = evaluate(deps);
  const rows: SensitivityRow[] = [];
  for (const link of candidates.filter(isAssumable)) {
    const variants: [Variant, Hypothesis][] = [
      ['absent', { exists: false }],
      ['mode', { mode: link.mode === 'required' ? 'alternate' : 'required' }],
    ];
    for (const [variant, hypothesis] of variants) {
      const after = evaluate(applyHypotheses(deps, { [link.id]: hypothesis }));
      rows.push({
        link,
        variant,
        hypothesis,
        added: [...after].filter((k) => !base.has(k)),
        removed: [...base].filter((k) => !after.has(k)),
      });
    }
  }
  return rows;
}

/* ----------------------------------------------------- evidence to verify */

const RELATION_EVIDENCE: Record<Dependency['relation'], string[]> = {
  power: ['Single-line diagram or feeder schedule showing the supply path', 'A switching or loss-of-supply test record, or a utility connection agreement'],
  data: ['An interface or data-flow specification', 'Logs or a trace showing the data actually flowing between the two systems'],
  network: ['Circuit or route inventory from the carrier or network team', 'A traceroute or path-diversity audit showing which links share a route'],
  control: ['Control-system architecture drawing showing the telemetry path', 'A test that removes the signal and records what the dependent does'],
  physical: ['A site survey or duct and conduit records showing shared routes or co-location', 'Photographs or as-built drawings'],
  service: ['A contract, SLA or runbook naming the provider', 'A failover or dependency test run with the provider switched off'],
  other: ['Written confirmation from the owner of the dependent asset', 'A documented test or survey that exercises this relationship'],
};

export interface EvidenceNeed {
  claim: string;
  evidence: string[];
  /** What changes in the model once it is verified. */
  then: string;
}

/** Suggested ways to settle a hypothesis. These are prompts for investigation, not findings from the model. */
export function evidenceNeeded(dep: Dependency, h: Hypothesis | null, nameOf: (id: string) => string): EvidenceNeed {
  const d = nameOf(dep.dependentId);
  const p = nameOf(dep.providerId);
  const base = RELATION_EVIDENCE[dep.relation];
  const gap = dep.status === 'unknown' ? 'Nobody has checked this link yet, so any direct evidence moves it forward.' : 'The link is believed to exist from indirect evidence only.';
  if (h?.exists === false)
    return {
      claim: `${d} does not depend on ${p}.`,
      evidence: [...base.map((e) => `${e}, showing there is no such path`), gap],
      then: `Remove the dependency from the map. Anything that failed only because of it no longer does.`,
    };
  if (h?.mode) {
    const toAlt = h.mode === 'alternate';
    return {
      claim: toAlt ? `${d} can keep running when ${p} is lost, as long as another provider survives.` : `${d} cannot keep running without ${p}.`,
      evidence: toAlt
        ? ['A failover test showing the dependent keeps working with this provider removed', 'Evidence that another provider is independent of the same upstream assets and can carry the load', gap]
        : ['A test or design record showing there is no working alternative to this provider', gap],
      then: `Set the dependency type to ${h.mode}${toAlt ? ' and map the other provider as an alternate' : ''}.`,
    };
  }
  return {
    claim: `${d} depends on ${p} (${STATUS_LABEL[dep.status].toLowerCase()}${dep.mode === 'alternate' ? ', as a backup' : ''}).`,
    evidence: [...base, ...(dep.mode === 'alternate' ? ['A failover test showing this backup actually takes over'] : []), gap],
    then: 'Mark the dependency as confirmed. It then counts as verified in every analysis.',
  };
}
