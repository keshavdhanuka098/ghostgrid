import { describe, expect, it } from 'vitest';
import { ancestry, chainSteps, describeStep, explainCascade } from './analysis';
import { outcomeFor, simulate, simulateFailure } from './graph';
import { assetsOf, dep } from './testkit';

describe('failure propagation with link failures', () => {
  const assets = assetsOf('a', 'b', 'c', 'd');
  // b relies on a, c relies on b, d relies on a. Failing the link b→a must not touch d.
  const deps = [dep('b', 'a'), dep('c', 'b'), dep('d', 'a')];

  it('failing one required link cascades only through that dependent', () => {
    const sim = simulateFailure(assets, deps, { links: ['b-a'] });
    expect([...sim.failed].sort()).toEqual(['b', 'c']);
    expect(sim.failed.has('a')).toBe(false);
    expect(sim.failed.has('d')).toBe(false);
    expect(sim.rounds).toEqual([[], ['b'], ['c']]);
    expect(sim.roundOf.get('b')).toBe(1);
    expect(sim.causeKind.get('b')).toBe('required');
    expect(sim.causeLinks.get('b')!.map((l) => l.id)).toEqual(['b-a']);
    expect(sim.causeLinks.get('c')!.map((l) => l.id)).toEqual(['c-b']);
    expect(sim.linkDownRound.get('b-a')).toBe(0);
    expect(sim.linkDownRound.get('c-b')).toBe(1);
    expect(sim.linkDownRound.has('d-a')).toBe(false);
  });

  it('failing a node takes down every link out of it, in round order', () => {
    const sim = simulate(assets, deps, ['a']);
    expect(sim.rounds).toEqual([['a'], ['b', 'd'], ['c']]);
    expect(sim.linkDownRound.get('b-a')).toBe(0);
    expect(sim.linkDownRound.get('c-b')).toBe(1);
  });

  it('combines node and link failures and ignores ids that are not in the model', () => {
    const sim = simulateFailure(assets, deps, { nodes: ['d', 'ghost'], links: ['b-a', 'nope'] });
    expect([...sim.failed].sort()).toEqual(['b', 'c', 'd']);
    expect(sim.seedNodes).toEqual(['d']);
    expect(sim.seedLinks).toEqual(['b-a']);
  });

  it('an alternate survives losing one link and fails when every alternate link is down', () => {
    const alts = assetsOf('p1', 'p2', 'x');
    const d = [dep('x', 'p1', 'alternate'), dep('x', 'p2', 'alternate')];
    expect(simulateFailure(alts, d, { links: ['x-p1'] }).failed.has('x')).toBe(false);
    const both = simulateFailure(alts, d, { links: ['x-p1', 'x-p2'] });
    expect(both.failed.has('x')).toBe(true);
    expect(both.causeKind.get('x')).toBe('alternates');
    // Mixed: one link failed directly and the other provider failed.
    const mixed = simulateFailure(alts, d, { nodes: ['p2'], links: ['x-p1'] });
    expect(mixed.failed.has('x')).toBe(true);
    expect(mixed.causeLinks.get('x')!.map((l) => l.id).sort()).toEqual(['x-p1', 'x-p2']);
  });

  it('is deterministic: the same inputs always give the same cascade', () => {
    const a = simulateFailure(assets, deps, { nodes: ['a'] });
    const b = simulateFailure(assets, deps, { nodes: ['a'] });
    expect(JSON.stringify([a.rounds, [...a.roundOf], [...a.causeKind]])).toBe(JSON.stringify([b.rounds, [...b.roundOf], [...b.causeKind]]));
  });

  it('terminates on cycles with link failures', () => {
    const cyc = assetsOf('a', 'b');
    const sim = simulateFailure(cyc, [dep('a', 'b'), dep('b', 'a')], { links: ['a-b'] });
    expect([...sim.failed].sort()).toEqual(['a', 'b']);
  });

  it('with no valid seed nothing fails and there are no rounds', () => {
    const sim = simulateFailure(assets, deps, { nodes: ['ghost'], links: [] });
    expect(sim.failed.size).toBe(0);
    expect(sim.rounds).toEqual([]);
  });

  it('outcomeFor accepts a seed and counts cascaded failures', () => {
    const out = outcomeFor(assets, deps, { links: ['b-a'] });
    expect(out.total).toBe(2);
    expect(out.cascaded).toBe(2);
  });
});

describe('explaining the cascade', () => {
  const assets = assetsOf('a', 'b', 'c', 'x', 'p1', 'p2');
  const deps = [dep('b', 'a', 'required', { status: 'inferred' }), dep('c', 'b', 'required', { status: 'unknown' }), dep('x', 'p1', 'alternate'), dep('x', 'p2', 'alternate')];
  const name = (id: string) => id.toUpperCase();

  it('names the link behind each step and the weakest evidence it rests on', () => {
    const steps = explainCascade(simulate(assets, deps, ['a']));
    expect(steps.map((s) => [s.assetId, s.round, s.kind, s.evidence])).toEqual([
      ['a', 0, 'seed', 'confirmed'],
      ['b', 1, 'required', 'inferred'],
      ['c', 2, 'required', 'unknown'],
    ]);
    expect(steps[1].reasons[0]).toMatchObject({ reason: 'provider-failed', downRound: 0 });
    expect(describeStep(steps[2], name)).toContain('B failed in round 1');
    expect(describeStep(steps[2], name)).toContain('unknown');
  });

  it('says so when a link, not a provider, was failed', () => {
    const steps = explainCascade(simulateFailure(assets, deps, { links: ['b-a'] }));
    expect(steps.find((s) => s.assetId === 'b')!.reasons[0].reason).toBe('link-failed');
    expect(describeStep(steps.find((s) => s.assetId === 'b')!, name)).toContain('failed directly');
  });

  it('explains an exhausted alternate group', () => {
    const steps = explainCascade(simulate(assets, deps, ['p1', 'p2']));
    const x = steps.find((s) => s.assetId === 'x')!;
    expect(x.kind).toBe('alternates');
    expect(describeStep(x, name)).toContain('no backup remains');
  });

  it('ancestry and chain list the contributing links, root first', () => {
    const sim = simulate(assets, deps, ['a']);
    expect([...ancestry(sim, 'c').links].sort()).toEqual(['b-a', 'c-b']);
    const chain = chainSteps(sim, 'c');
    expect(chain.map((s) => s.assetId)).toEqual(['a', 'b', 'c']);
    expect(chain.map((s) => s.via?.id ?? null)).toEqual([null, 'b-a', 'c-b']);
  });
});
