import { describe, expect, it } from 'vitest';
import { applyHypotheses, attributeChanges, evidenceNeeded, evidenceTiers, investigate, normaliseHypothesis, sensitivity, activeHypothesisIds, type Hypotheses } from './analysis';
import { simulate } from './graph';
import { makeSampleScenario } from './sample';
import { assetsOf, dep } from './testkit';

const names = (id: string) => id;

describe('evidence tiers', () => {
  it('reports the weakest evidence each failure rests on', () => {
    const assets = assetsOf('a', 'b', 'c', 'd');
    const deps = [dep('b', 'a'), dep('c', 'b', 'required', { status: 'inferred' }), dep('d', 'c', 'required', { status: 'unknown' })];
    const { tiers } = evidenceTiers(assets, deps, { nodes: ['a'] });
    expect(Object.fromEntries(tiers)).toEqual({ a: 'confirmed', b: 'confirmed', c: 'inferred', d: 'unknown' });
  });

  it('flags assets that survive only because of an unconfirmed backup', () => {
    const assets = assetsOf('a', 'b', 'x');
    const deps = [dep('x', 'a', 'alternate'), dep('x', 'b', 'alternate', { status: 'unknown' })];
    const { tiers, unstable } = evidenceTiers(assets, deps, { nodes: ['a'] });
    expect(tiers.has('x')).toBe(false); // survives with every mapped link live
    expect(unstable.has('x')).toBe(true); // but would fail if the unknown backup did not exist
  });
});

describe('investigate: dependency chain, shared dependencies, single points of failure', () => {
  it('traces the upstream chain with hop counts and the weakest status on each path', () => {
    const assets = assetsOf('t', 'p', 'u', 'z');
    const deps = [dep('t', 'p'), dep('p', 'u', 'required', { status: 'inferred' })];
    const inv = investigate(assets, deps, 't')!;
    expect(inv.upstream.map((e) => [e.asset.id, e.hops, e.pathStatus])).toEqual([
      ['p', 1, 'confirmed'],
      ['u', 2, 'inferred'],
    ]);
    expect(inv.upstream.some((e) => e.asset.id === 'z')).toBe(false); // unrelated asset is not part of the chain
  });

  it('finds an indirect single point of failure, lists what rests on unconfirmed links, and names shared exposure', () => {
    const assets = assetsOf('t', 'p', 'u', 's');
    // t needs p; p needs u (inferred). s also needs u, so u is shared with s.
    const deps = [dep('t', 'p'), dep('p', 'u', 'required', { status: 'inferred' }), dep('s', 'u')];
    const inv = investigate(assets, deps, 't')!;
    const u = inv.findings.find((f) => f.asset.id === 'u')!;
    expect(u.kind).toBe('spof');
    expect(u.direct).toBe(false);
    expect(u.evidence).toBe('inferred');
    expect(u.unconfirmed.map((l) => l.id)).toEqual(['p-u']);
    expect(u.support.map((l) => l.id)).toEqual(['p-u', 't-p']);
    expect(u.alsoFails.map((a) => a.id)).toEqual(['s']);
    expect(u.why.join(' ')).toContain('does not list u directly');
    // The hidden one is listed before the direct one.
    expect(inv.findings.map((f) => f.asset.id)).toEqual(['u', 'p']);
    expect(inv.findings[1].direct).toBe(true);
    expect(inv.findings[1].evidence).toBe('confirmed');
  });

  it('shows when redundancy is defeated by a shared upstream asset', () => {
    const assets = assetsOf('t', 'a', 'b', 'u');
    const deps = [dep('t', 'a', 'alternate'), dep('t', 'b', 'alternate'), dep('a', 'u'), dep('b', 'u')];
    const inv = investigate(assets, deps, 't')!;
    const u = inv.findings.find((f) => f.asset.id === 'u')!;
    expect(u.kind).toBe('spof');
    expect(u.defeatsRedundancy).toBe(true);
    expect(u.convergesVia.map((a) => a.id).sort()).toEqual(['a', 'b']);
    // Neither alternate is a single point of failure on its own.
    expect(inv.findings.some((f) => f.asset.id === 'a' || f.asset.id === 'b')).toBe(false);
  });

  it('flags a shared dependency that thins redundancy without taking the target down', () => {
    const assets = assetsOf('t', 'a', 'b', 'c', 'u');
    const deps = [dep('t', 'a', 'alternate'), dep('t', 'b', 'alternate'), dep('t', 'c', 'alternate'), dep('a', 'u'), dep('b', 'u')];
    const inv = investigate(assets, deps, 't')!;
    const u = inv.findings.find((f) => f.asset.id === 'u')!;
    expect(u.kind).toBe('shared');
    expect(u.evidence).toBeNull();
    expect(simulate(assets, deps, ['u']).failed.has('t')).toBe(false);
  });

  it('flags a possible single point of failure that depends on an unconfirmed backup', () => {
    const assets = assetsOf('t', 'a', 'b');
    const deps = [dep('t', 'a', 'alternate'), dep('t', 'b', 'alternate', { status: 'unknown' })];
    const inv = investigate(assets, deps, 't')!;
    const a = inv.findings.find((f) => f.asset.id === 'a')!;
    expect(a.kind).toBe('conditional');
    expect(a.dependsOnAbsent.map((l) => l.id)).toEqual(['t-b']);
    expect(inv.findings.some((f) => f.asset.id === 'b')).toBe(false);
  });

  it('reports what is missing: unconfirmed links, a chain that stops, and nothing mapped', () => {
    const assets = assetsOf('t', 'p', 'lonely');
    const inv = investigate(assets, [dep('t', 'p', 'required', { status: 'unknown' })], 't')!;
    expect(inv.gaps.map((g) => g.kind).sort()).toEqual(['chain-ends', 'unconfirmed-link']);
    expect(investigate(assets, [], 'lonely')!.gaps.map((g) => g.kind)).toEqual(['nothing-mapped']);
    expect(investigate(assets, [], 'ghost')).toBeNull();
  });

  it('terminates on cycles', () => {
    const inv = investigate(assetsOf('a', 'b'), [dep('a', 'b'), dep('b', 'a')], 'a')!;
    expect(inv.upstream.map((e) => e.asset.id)).toEqual(['b']);
  });

  it('never produces percentages or probabilities', () => {
    const s = makeSampleScenario('metro-corridor');
    for (const a of s.assets) {
      const inv = investigate(s.assets, s.dependencies, a.id)!;
      const text = [...inv.findings.flatMap((f) => f.why), ...inv.gaps.map((g) => g.text)].join(' ');
      expect(text).not.toMatch(/%|probab|likel|confidence level|accuracy/i);
    }
  });

  it('finds the hidden shared power dependency behind the hospital in the metro sample', () => {
    const s = makeSampleScenario('metro-corridor');
    const inv = investigate(s.assets, s.dependencies, 'hospital')!;
    const north = inv.findings.find((f) => f.asset.id === 'northgate')!;
    expect(north.kind).toBe('spof');
    expect(north.direct).toBe(false);
    expect(north.evidence).not.toBe('confirmed'); // the route runs through inferred and unknown links
    expect(north.unconfirmed.length).toBeGreaterThan(0);
  });
});

describe('what-if hypotheses', () => {
  const assets = assetsOf('a', 'b', 'c', 'e', 'x', 'y');
  const deps = [
    dep('b', 'a'),
    dep('c', 'b', 'required', { status: 'inferred' }),
    dep('e', 'x', 'alternate', { status: 'inferred' }),
    dep('e', 'y', 'alternate', { status: 'unknown' }),
  ];

  it('applies only to unconfirmed links, and an unchanged hypothesis is not active', () => {
    const h: Hypotheses = { 'b-a': { exists: false }, 'c-b': { mode: 'required' }, 'e-x': { mode: 'required' } };
    expect(activeHypothesisIds(deps, h)).toEqual(['e-x']); // b-a is confirmed, c-b already required
    const next = applyHypotheses(deps, h);
    expect(next.find((d) => d.id === 'b-a')).toBeTruthy();
    expect(next.find((d) => d.id === 'e-x')!.mode).toBe('required');
    expect(applyHypotheses(deps, { 'c-b': { exists: false } }).some((d) => d.id === 'c-b')).toBe(false);
    expect(normaliseHypothesis(deps[1], { mode: 'required' })).toBeNull();
  });

  it('explains a changed result by the single hypothesis that causes it', () => {
    const evalFailed = (d: typeof deps) => simulate(assets, d, ['a']).failed;
    const r = attributeChanges(deps, { 'c-b': { exists: false } }, evalFailed);
    expect([...r.before].sort()).toEqual(['a', 'b', 'c']);
    expect([...r.after].sort()).toEqual(['a', 'b']);
    expect(r.changes).toEqual([{ key: 'c', direction: 'removed', alone: ['c-b'], combined: false }]);
  });

  it('attributes a change that needs two hypotheses together to the combination', () => {
    const evalFailed = (d: typeof deps) => simulate(assets, d, ['x', 'y']).failed;
    const both = attributeChanges(deps, { 'e-x': { exists: false }, 'e-y': { exists: false } }, evalFailed);
    expect(both.changes).toEqual([{ key: 'e', direction: 'removed', alone: [], combined: true }]);
    const one = attributeChanges(deps, { 'e-x': { exists: false } }, evalFailed);
    expect(one.changes).toEqual([]); // y still fails, so e still fails
  });

  it('removing an assumed backup can make a failure appear', () => {
    const evalFailed = (d: typeof deps) => simulate(assets, d, ['x']).failed;
    expect(evalFailed(deps).has('e')).toBe(false); // y still works
    const r = attributeChanges(deps, { 'e-y': { exists: false } }, evalFailed);
    expect(r.changes).toEqual([{ key: 'e', direction: 'added', alone: ['e-y'], combined: false }]);
  });

  it('with no active hypothesis nothing changes', () => {
    const r = attributeChanges(deps, {}, (d) => simulate(assets, d, ['a']).failed);
    expect(r.changes).toEqual([]);
    expect(r.active).toEqual([]);
  });

  it('sensitivity shows which unconfirmed links the result depends on, and which it does not', () => {
    const evalFailed = (d: typeof deps) => simulate(assets, d, ['a']).failed;
    const rows = sensitivity(deps, deps, evalFailed);
    const cb = rows.filter((r) => r.link.id === 'c-b');
    expect(cb.find((r) => r.variant === 'absent')!.removed).toEqual(['c']);
    expect(cb.find((r) => r.variant === 'mode')!.removed).toEqual([]); // as a lone alternate, c still fails when b does
    // The confirmed link b-a is never a candidate.
    expect(rows.some((r) => r.link.id === 'b-a')).toBe(false);
    // e's backups are not involved in a's failure.
    expect(rows.filter((r) => r.link.id.startsWith('e-')).every((r) => !r.added.length && !r.removed.length)).toBe(true);
  });

  it('recalculating an investigation under a hypothesis changes its findings, and says which link did it', () => {
    const s = makeSampleScenario('metro-corridor');
    const key = (d: typeof s.dependencies) => new Set((investigate(s.assets, d, 'hospital')?.findings ?? []).map((f) => f.id));
    const r = attributeChanges(s.dependencies, { 'd-hospital-dispatch': { exists: false } }, key);
    expect(r.changes.length).toBeGreaterThan(0);
    expect(r.changes.every((c) => c.direction === 'removed' || c.direction === 'added')).toBe(true);
    expect(r.changes.some((c) => c.alone.includes('d-hospital-dispatch'))).toBe(true);
  });
});

describe('what evidence would settle an assumption', () => {
  const d = dep('a', 'b', 'required', { status: 'unknown', relation: 'network' });
  it('asks for evidence that matches the relationship and the claim', () => {
    const absent = evidenceNeeded(d, { exists: false }, names);
    expect(absent.claim).toContain('a does not depend on b');
    expect(absent.evidence.join(' ')).toMatch(/route|circuit|traceroute/i);
    expect(absent.then).toMatch(/Remove the dependency/);
    const asBackup = evidenceNeeded(d, { mode: 'alternate' }, names);
    expect(asBackup.evidence.join(' ')).toMatch(/failover/i);
    const plain = evidenceNeeded(d, null, names);
    expect(plain.then).toMatch(/confirmed/);
    for (const e of [absent, asBackup, plain]) expect(JSON.stringify(e)).not.toMatch(/%/);
  });
});
