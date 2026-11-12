// Mitigation options, evaluated against one failure scenario and ranked by documented criteria.
//
// What the model supports: which assets still fail, how many are critical, and a criticality-weighted total.
// What it does not: money, time, capacity, probability. Cost and effort are the user's own ordinal estimates and are
// only ever compared with each other, never combined with the computed numbers into a single score.

import { outcomeFor, type FailureSeed, type Outcome } from './graph';
import { CRIT_WEIGHT, type Asset, type Dependency, type EstimateLevel, type Strategy } from './types';

/* ---------------------------------------------------------------- applying */

export type DepChange =
  | { type: 'mode'; before: Dependency; after: Dependency }
  | { type: 'added'; after: Dependency }
  | { type: 'removed'; before: Dependency };

export interface Applied {
  valid: boolean;
  reason?: string;
  deps: Dependency[];
  changes: DepChange[];
}

export const PROPOSED_PREFIX = 'mit-';
export const isProposed = (d: Dependency) => d.id.startsWith(PROPOSED_PREFIX);

/** The dependency set as it would be with the option in place, and exactly what changed. */
export function applyOption(deps: Dependency[], s: Strategy): Applied {
  const original = deps.find((d) => d.dependentId === s.dependentId && d.providerId === s.providerId);
  if (!original) return { valid: false, reason: 'The dependency this option is anchored on no longer exists.', deps, changes: [] };

  if (s.kind === 'decouple') {
    return { valid: true, deps: deps.filter((d) => d.id !== original.id), changes: [{ type: 'removed', before: original }] };
  }

  if (!s.backupId) return { valid: false, reason: 'No backup provider is chosen.', deps, changes: [] };
  if (s.backupId === s.dependentId || s.backupId === s.providerId) return { valid: false, reason: 'The backup must be a different asset.', deps, changes: [] };
  if (deps.some((d) => d.dependentId === s.dependentId && d.providerId === s.backupId))
    return { valid: false, reason: 'The asset already depends on this backup, so it is not a new option.', deps, changes: [] };

  const changes: DepChange[] = [];
  const next = deps.map((d) => {
    if (d.id !== original.id || d.mode === 'alternate') return d;
    const after = { ...d, mode: 'alternate' as const };
    changes.push({ type: 'mode', before: d, after });
    return after;
  });
  // A proposed link: it does not exist yet, so it is shown as inferred and takes the relationship type of the one it backs up.
  const proposed: Dependency = {
    id: `${PROPOSED_PREFIX}${s.id}`,
    dependentId: s.dependentId,
    providerId: s.backupId,
    mode: 'alternate',
    status: 'inferred',
    relation: original.relation,
    notes: 'Proposed by a mitigation option. Not built yet.',
  };
  changes.push({ type: 'added', after: proposed });
  return { valid: true, deps: [...next, proposed], changes };
}

/* --------------------------------------------------------------- comparing */

export interface Metrics {
  /** Failed assets with critical criticality. */
  critical: number;
  /** Sum of criticality weights (low 1, medium 2, high 4, critical 8) over failed assets. */
  weighted: number;
  /** Failed assets. */
  assets: number;
}

const metricsOf = (assets: Asset[], o: Outcome): Metrics => {
  const byId = new Map(assets.map((a) => [a.id, a]));
  return {
    critical: o.critical,
    weighted: o.failed.reduce((sum, id) => sum + CRIT_WEIGHT[byId.get(id)?.criticality ?? 'low'], 0),
    assets: o.total,
  };
};

export interface OptionResult {
  option: Strategy;
  valid: boolean;
  reason?: string;
  deps: Dependency[];
  changes: DepChange[];
  outcome: Outcome;
  /** What still fails with the option in place (the residual risk the model can see). */
  residual: Metrics;
  /** Baseline minus residual. */
  reduction: Metrics;
  protectedIds: string[];
  /** Assets that fail with the option but not without it. Should be empty; reported rather than assumed. */
  worsenedIds: string[];
  cost: EstimateLevel | null;
  effort: EstimateLevel | null;
  /** Assumptions and limits that apply to this option, in plain words. */
  caveats: string[];
  /** 1-based; options that tie on every criterion share a rank. Null when the option is invalid. */
  rank: number | null;
}

export interface Comparison {
  baseline: Outcome;
  baselineMetrics: Metrics;
  /** Ranked first, then invalid options. */
  results: OptionResult[];
  priority: Priority;
}

/* ----------------------------------------------------------------- ranking */

export type CriterionId = 'critical' | 'weighted' | 'assets' | 'effort' | 'cost';
export type Priority = 'impact' | 'effort' | 'cost';

export interface Criterion {
  id: CriterionId;
  label: string;
  /** Where the number comes from. */
  source: 'model' | 'your estimate';
  help: string;
}

export const CRITERIA: Record<CriterionId, Criterion> = {
  critical: { id: 'critical', label: 'Critical assets still down', source: 'model', help: 'Fewer is better. Counted from the failure simulation with the option applied.' },
  weighted: { id: 'weighted', label: 'Weighted impact still down', source: 'model', help: 'Fewer is better. Failed assets weighted by criticality (low 1, medium 2, high 4, critical 8).' },
  assets: { id: 'assets', label: 'Assets still down', source: 'model', help: 'Fewer is better. Every failed asset counts once, including the initial failure.' },
  effort: { id: 'effort', label: 'Effort (your estimate)', source: 'your estimate', help: 'Lower is better. Options you have not estimated sort after those you have.' },
  cost: { id: 'cost', label: 'Cost (your estimate)', source: 'your estimate', help: 'Lower is better. Options you have not estimated sort after those you have.' },
};

export const PRIORITIES: Record<Priority, { label: string; description: string; order: CriterionId[] }> = {
  impact: {
    label: 'Impact first',
    description: 'Fewest critical assets down, then lowest weighted impact, then fewest assets down. Effort and cost break ties.',
    order: ['critical', 'weighted', 'assets', 'effort', 'cost'],
  },
  effort: {
    label: 'Low effort first',
    description: 'Lowest estimated effort, then impact. Options that protect nothing still rank last.',
    order: ['effort', 'critical', 'weighted', 'assets', 'cost'],
  },
  cost: {
    label: 'Low cost first',
    description: 'Lowest estimated cost, then impact. Options that protect nothing still rank last.',
    order: ['cost', 'critical', 'weighted', 'assets', 'effort'],
  },
};

const LEVEL_RANK: Record<EstimateLevel, number> = { low: 0, medium: 1, high: 2 };
const NOT_ESTIMATED = 3;

function valueOf(r: OptionResult, c: CriterionId): number {
  switch (c) {
    case 'critical':
    case 'weighted':
    case 'assets':
      return r.residual[c];
    case 'effort':
      return r.effort ? LEVEL_RANK[r.effort] : NOT_ESTIMATED;
    case 'cost':
      return r.cost ? LEVEL_RANK[r.cost] : NOT_ESTIMATED;
  }
}

export function showValue(r: OptionResult, c: CriterionId): string {
  if (c === 'effort') return r.effort ?? 'not estimated';
  if (c === 'cost') return r.cost ?? 'not estimated';
  return String(r.residual[c]);
}

/** An option helps if it protects at least one asset in this scenario. */
export const helps = (r: OptionResult) => r.valid && r.protectedIds.length > 0;

function compare(a: OptionResult, b: OptionResult, order: CriterionId[]): number {
  if (helps(a) !== helps(b)) return helps(a) ? -1 : 1;
  for (const c of order) {
    const d = valueOf(a, c) - valueOf(b, c);
    if (d) return d;
  }
  return 0;
}

/** Sorts options by the chosen priority. Ties on every criterion share a rank and are listed alphabetically. */
export function rankOptions(results: OptionResult[], priority: Priority): OptionResult[] {
  const order = PRIORITIES[priority].order;
  const valid = results.filter((r) => r.valid).sort((a, b) => compare(a, b, order) || a.option.name.localeCompare(b.option.name));
  let rank = 0;
  const ranked = valid.map((r, i) => {
    if (i === 0 || compare(valid[i - 1], r, order) !== 0) rank = i + 1;
    return { ...r, rank };
  });
  return [...ranked, ...results.filter((r) => !r.valid).map((r) => ({ ...r, rank: null }))];
}

/** Plain-language reason why `a` is listed ahead of `b` (or tied with it) under the priority. */
export function explainOrder(a: OptionResult, b: OptionResult, priority: Priority): string {
  const an = a.option.name;
  const bn = b.option.name;
  if (helps(a) !== helps(b)) {
    return helps(a)
      ? `${an} protects at least one asset in this scenario and ${bn} protects none, and options that protect nothing always rank last.`
      : `${bn} protects at least one asset in this scenario and ${an} protects none.`;
  }
  const order = PRIORITIES[priority].order;
  const equal: string[] = [];
  for (const c of order) {
    const va = valueOf(a, c);
    const vb = valueOf(b, c);
    if (va !== vb) {
      const lead = va < vb ? [an, bn, a, b] : [bn, an, b, a];
      const prior = equal.length ? ` They are equal on ${equal.join(' and ').toLowerCase()}.` : '';
      return `${lead[0]} ranks ahead of ${lead[1]} on “${CRITERIA[c].label.toLowerCase()}”: ${showValue(lead[2] as OptionResult, c)} against ${showValue(lead[3] as OptionResult, c)}.${prior}`;
    }
    equal.push(CRITERIA[c].label);
  }
  return `${an} and ${bn} are tied on every criterion (${order.map((c) => CRITERIA[c].label.toLowerCase()).join(', ')}). They are listed alphabetically.`;
}

/* ------------------------------------------------------------------ driver */

function caveatsFor(s: Strategy, applied: Applied, nameOf: (id: string) => string, baselineFailed: Set<string>, protectedIds: string[]): string[] {
  const out: string[] = [];
  const d = nameOf(s.dependentId);
  const p = nameOf(s.providerId);
  if (!applied.valid) return out;
  const original = applied.changes.find((c) => c.type === 'mode' || c.type === 'removed');
  const orig = original && (original.type === 'mode' ? original.before : original.type === 'removed' ? original.before : null);
  if (s.kind === 'backup') {
    const b = nameOf(s.backupId);
    out.push(`Assumes ${b} can carry ${d}'s load. Capacity is not modelled.`);
    out.push(`The link from ${b} to ${d} is a proposal. It is drawn as inferred until it is built and tested.`);
    if (baselineFailed.has(s.backupId)) out.push(`${b} also fails in this scenario, so it cannot step in.`);
  } else {
    out.push(`Assumes ${d} can run without ${p}, for example in a degraded or manual mode. That is not modelled.`);
  }
  if (orig && orig.status !== 'confirmed')
    out.push(`The dependency being changed (${d} on ${p}) is ${orig.status}. If it does not exist, this option changes nothing real.`);
  if (!protectedIds.length) out.push('No asset is protected in this scenario. The failure still reaches the same assets by other paths.');
  if (!s.costLevel) out.push('Cost has not been estimated.');
  if (!s.effortLevel) out.push('Effort has not been estimated.');
  return out;
}

/** Evaluates every option against the same failure, then ranks them. Pure: the same inputs always give the same output. */
export function compareOptions(assets: Asset[], deps: Dependency[], seed: FailureSeed, options: Strategy[], priority: Priority = 'impact'): Comparison {
  const nameOf = (id: string) => assets.find((a) => a.id === id)?.name ?? 'Unknown';
  const baseline = outcomeFor(assets, deps, seed);
  const baselineMetrics = metricsOf(assets, baseline);
  const baselineFailed = new Set(baseline.failed);

  const results: OptionResult[] = options.map((option) => {
    const applied = applyOption(deps, option);
    const outcome = applied.valid ? outcomeFor(assets, applied.deps, seed) : baseline;
    const residual = metricsOf(assets, outcome);
    const protectedIds = baseline.failed.filter((id) => !outcome.sim.failed.has(id));
    return {
      option,
      valid: applied.valid,
      reason: applied.reason,
      deps: applied.deps,
      changes: applied.changes,
      outcome,
      residual,
      reduction: { critical: baselineMetrics.critical - residual.critical, weighted: baselineMetrics.weighted - residual.weighted, assets: baselineMetrics.assets - residual.assets },
      protectedIds,
      worsenedIds: outcome.failed.filter((id) => !baselineFailed.has(id)),
      cost: option.costLevel,
      effort: option.effortLevel,
      caveats: caveatsFor(option, applied, nameOf, baselineFailed, protectedIds),
      rank: null,
    };
  });
  return { baseline, baselineMetrics, results: rankOptions(results, priority), priority };
}

export function describeChange(c: DepChange, nameOf: (id: string) => string): string {
  const link = (d: Dependency) => `${nameOf(d.dependentId)} → ${nameOf(d.providerId)}`;
  switch (c.type) {
    case 'mode':
      return `${link(c.after)}: ${c.before.mode} → ${c.after.mode}`;
    case 'added':
      return `${link(c.after)}: new alternate link (proposed)`;
    case 'removed':
      return `${link(c.before)}: ${c.before.mode} link removed`;
  }
}

/** One plain-language sentence per option saying why it sits where it does in the ranking. Keyed by option id. */
export function rankExplanations(results: OptionResult[], priority: Priority): Map<string, string> {
  const out = new Map<string, string>();
  const valid = results.filter((r) => r.valid);
  for (const r of results.filter((x) => !x.valid)) out.set(r.option.id, r.reason ?? 'This option cannot be applied.');
  valid.forEach((r, i) => {
    if (i > 0) return out.set(r.option.id, explainOrder(valid[i - 1], r, priority));
    const facts = PRIORITIES[priority].order.slice(0, 3).map((c) => `${CRITERIA[c].label.toLowerCase()}: ${showValue(r, c)}`).join('; ');
    out.set(
      r.option.id,
      helps(r)
        ? `Ranked first under “${PRIORITIES[priority].label}”. ${facts}.`
        : `Ranked first only because no option protects any asset in this scenario. ${facts}.`,
    );
  });
  return out;
}
