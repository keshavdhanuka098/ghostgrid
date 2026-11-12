import { describe, expect, it } from 'vitest';
import { applyHypotheses } from './analysis';
import { applyOption, compareOptions, explainOrder, isProposed, PRIORITIES, rankExplanations, type OptionResult } from './mitigation';
import { makeSampleScenario } from './sample';
import { asset, dep } from './testkit';
import type { Strategy } from './types';

// p (high) feeds x (critical), y (medium). z (critical) relies on y. q is an independent spare source.
const assets = [
  asset('p', { criticality: 'high' }),
  asset('q', { criticality: 'low' }),
  asset('x', { criticality: 'critical' }),
  asset('y', { criticality: 'medium' }),
  asset('z', { criticality: 'critical' }),
];
const deps = [dep('x', 'p'), dep('y', 'p'), dep('z', 'y')];

const opt = (id: string, over: Partial<Strategy>): Strategy => ({
  id,
  name: id,
  kind: 'backup',
  dependentId: 'x',
  providerId: 'p',
  backupId: 'q',
  costLevel: null,
  effortLevel: null,
  ...over,
});

// Baseline when p fails: p, x, y, z down → 2 critical, weight 4+8+2+8 = 22, 4 assets.
const O1 = opt('O1', { name: 'Spare for x', dependentId: 'x', effortLevel: 'low', costLevel: 'medium' }); // → p, y, z: 1 critical, 14
const O2 = opt('O2', { name: 'Decouple y', kind: 'decouple', dependentId: 'y', backupId: '', effortLevel: 'high', costLevel: 'low' }); // → p, x: 1 critical, 12
const O3 = opt('O3', { name: 'Spare for y', dependentId: 'y', effortLevel: 'low', costLevel: 'high' }); // → p, x: 1 critical, 12
const O4 = opt('O4', { name: 'Spare for z', dependentId: 'z', providerId: 'y', backupId: 'p', costLevel: 'low', effortLevel: 'low' }); // p also fails: no help

const names = (rs: OptionResult[]) => rs.map((r) => r.option.id);

describe('applying a mitigation option', () => {
  it('backup: turns the dependency into an alternate and adds a proposed inferred link; reports each change', () => {
    const a = applyOption(deps, O1);
    expect(a.valid).toBe(true);
    expect(a.deps.find((d) => d.id === 'x-p')!.mode).toBe('alternate');
    const added = a.deps.find(isProposed)!;
    expect(added).toMatchObject({ dependentId: 'x', providerId: 'q', mode: 'alternate', status: 'inferred' });
    expect(a.changes.map((c) => c.type)).toEqual(['mode', 'added']);
    expect(deps.find((d) => d.id === 'x-p')!.mode).toBe('required'); // the input is not mutated
  });

  it('decouple removes the dependency', () => {
    const a = applyOption(deps, O2);
    expect(a.deps.map((d) => d.id)).toEqual(['x-p', 'z-y']);
    expect(a.changes.map((c) => c.type)).toEqual(['removed']);
  });

  it('rejects options that cannot apply, with a reason', () => {
    expect(applyOption(deps, opt('bad', { dependentId: 'z', providerId: 'p' })).reason).toMatch(/no longer exists/);
    expect(applyOption(deps, opt('bad', { backupId: '' })).reason).toMatch(/No backup/);
    expect(applyOption(deps, opt('bad', { backupId: 'x' })).reason).toMatch(/different/);
    expect(applyOption([...deps, dep('x', 'q')], O1).reason).toMatch(/already depends/);
  });
});

describe('comparing options against the same failure', () => {
  const run = (options: Strategy[], priority: 'impact' | 'effort' | 'cost' = 'impact', d = deps) => compareOptions(assets, d, { nodes: ['p'] }, options, priority);

  it('computes the baseline and each option from the model', () => {
    const c = run([O1, O2]);
    expect(c.baselineMetrics).toEqual({ critical: 2, weighted: 22, assets: 4 });
    const r1 = c.results.find((r) => r.option.id === 'O1')!;
    expect(r1.residual).toEqual({ critical: 1, weighted: 14, assets: 3 });
    expect(r1.reduction).toEqual({ critical: 1, weighted: 8, assets: 1 });
    expect(r1.protectedIds).toEqual(['x']);
    expect(r1.worsenedIds).toEqual([]);
    const r2 = c.results.find((r) => r.option.id === 'O2')!;
    expect(r2.protectedIds.sort()).toEqual(['y', 'z']);
    expect(r2.residual).toEqual({ critical: 1, weighted: 12, assets: 2 });
  });

  it('impact first: orders by critical, weighted, assets, then effort and cost', () => {
    const c = run([O1, O2, O3]);
    // O2 and O3 tie on every model criterion; O3 has lower effort, so it is ahead. O1 leaves more weighted impact.
    expect(names(c.results)).toEqual(['O3', 'O2', 'O1']);
    expect(c.results.map((r) => r.rank)).toEqual([1, 2, 3]);
  });

  it('other priorities reorder, and a different criterion decides', () => {
    expect(names(run([O1, O2, O3], 'effort').results)).toEqual(['O3', 'O1', 'O2']); // low, low (O3 wins on weighted), high
    expect(names(run([O1, O2, O3], 'cost').results)).toEqual(['O2', 'O1', 'O3']); // low, medium, high
  });

  it('an option that protects nothing ranks last under every priority, even with the best estimates', () => {
    for (const p of Object.keys(PRIORITIES) as (keyof typeof PRIORITIES)[]) {
      const c = run([O4, O1, O2], p);
      expect(c.results.at(-1)!.option.id).toBe('O4');
      expect(c.results.at(-1)!.protectedIds).toEqual([]);
    }
  });

  it('options that tie on every criterion share a rank and are listed alphabetically', () => {
    const twin = { ...O3, id: 'O3b', name: 'Another spare for y' };
    const c = run([O3, twin]);
    expect(c.results.map((r) => [r.option.name, r.rank])).toEqual([['Another spare for y', 1], ['Spare for y', 1]]);
    expect(explainOrder(c.results[0], c.results[1], 'impact')).toMatch(/tied on every criterion/);
  });

  it('explains why one option is ahead of another, naming the deciding criterion and the equal ones', () => {
    const c = run([O1, O2, O3]);
    const [first, second, third] = c.results;
    expect(explainOrder(first, second, 'impact')).toMatch(/Spare for y ranks ahead of Decouple y on “effort \(your estimate\)”: low against high\. They are equal on critical assets still down and weighted impact still down and assets still down\./);
    expect(explainOrder(second, third, 'impact')).toMatch(/Decouple y ranks ahead of Spare for x on “weighted impact still down”: 12 against 14\. They are equal on critical assets still down\./);
    expect(explainOrder(third, c.results[0], 'impact')).toMatch(/ahead/); // argument order does not matter
    const withNoHelp = run([O4, O1]);
    expect(explainOrder(withNoHelp.results[0], withNoHelp.results[1], 'impact')).toMatch(/protects none/);
  });

  it('unestimated cost and effort sort after estimated ones and are labelled, not guessed', () => {
    const bare = opt('B', { name: 'Bare', dependentId: 'y' });
    const c = run([bare, O3]);
    expect(names(c.results)).toEqual(['O3', 'B']);
    expect(explainOrder(c.results[0], c.results[1], 'impact')).toContain('not estimated');
    expect(c.results[1].caveats).toEqual(expect.arrayContaining(['Cost has not been estimated.', 'Effort has not been estimated.']));
  });

  it('puts invalid options last with no rank and a reason', () => {
    const c = run([opt('gone', { name: 'Gone', dependentId: 'z', providerId: 'p' }), O1]);
    expect(names(c.results)).toEqual(['O1', 'gone']);
    expect(c.results[1]).toMatchObject({ valid: false, rank: null });
    expect(c.results[1].reason).toBeTruthy();
  });

  it('states its assumptions: capacity is not modelled, the new link is only a proposal, an unconfirmed dependency may not exist', () => {
    const weak = deps.map((d) => (d.id === 'x-p' ? { ...d, status: 'inferred' as const } : d));
    const r = run([O1], 'impact', weak).results[0];
    expect(r.caveats.join(' ')).toMatch(/Capacity is not modelled/);
    expect(r.caveats.join(' ')).toMatch(/proposal/);
    expect(r.caveats.join(' ')).toMatch(/is inferred\. If it does not exist/);
    expect(run([O2]).results[0].caveats.join(' ')).toMatch(/degraded or manual mode/);
  });

  it('is pure: the same inputs give the same output', () => {
    expect(JSON.stringify(run([O1, O2, O3]))).toBe(JSON.stringify(run([O1, O2, O3])));
  });

  it('recalculates when a relevant input changes (an assumption about a dependency)', () => {
    const uncertain = deps.map((d) => (d.id === 'y-p' ? { ...d, status: 'inferred' as const } : d));
    const before = run([O1, O2, O3], 'impact', uncertain);
    expect(names(before.results)).toEqual(['O3', 'O2', 'O1']);
    // Suppose y does not actually depend on p.
    const after = run([O1, O2, O3], 'impact', applyHypotheses(uncertain, { 'y-p': { exists: false } }));
    expect(after.baselineMetrics).toEqual({ critical: 1, weighted: 12, assets: 2 }); // only p and x fail now
    expect(after.results.find((r) => r.option.id === 'O1')!.rank).toBe(1); // O1 is now the only one that helps
    expect(after.results.filter((r) => !r.valid).map((r) => r.option.id).sort()).toEqual(['O2', 'O3']); // anchored on the missing link
  });

  it('works on a link failure as the scenario', () => {
    const c = compareOptions(assets, deps, { links: ['y-p'] }, [O2, O3]);
    expect(c.baselineMetrics).toEqual({ critical: 1, weighted: 10, assets: 2 }); // y and z
    // The failed link y→p is the one being decoupled or backed up; the option replaces it, so the failure no longer reaches y.
    expect(c.results.every((r) => r.valid)).toBe(true);
    // Backing up or removing the failed link means y no longer depends on it alone, so both options protect y and z.
    expect(c.results.map((r) => r.protectedIds.sort())).toEqual([['y', 'z'], ['y', 'z']]);
  });

  it('on the metro sample the power backup is first and the dispatch backup does not help', () => {
    const s = makeSampleScenario('metro-corridor');
    const c = compareOptions(s.assets, s.dependencies, { nodes: ['northgate'] }, s.strategies, 'impact');
    expect(c.results[0].option.id).toBe('mit-colo-power');
    const dispatch = c.results.find((r) => r.option.id === 'mit-dispatch-link')!;
    expect(dispatch.protectedIds).toEqual([]);
    expect(c.results.at(-1)!.protectedIds).toEqual([]);
  });
});

describe('rankExplanations', () => {
  it('explains every option and names the criterion that separates neighbours', () => {
    const s = makeSampleScenario('metro-corridor');
    const run = s.runs[0];
    const c = compareOptions(s.assets, s.dependencies, { nodes: run.failedIds, links: run.failedLinkIds }, s.strategies, 'impact');
    const ex = rankExplanations(c.results, 'impact');
    expect(ex.size).toBe(c.results.length);
    expect(ex.get(c.results[0].option.id)).toMatch(/Ranked first/);
    if (c.results.length > 1) expect(ex.get(c.results[1].option.id)).toMatch(/ranks ahead|tied|protects/);
  });
});
