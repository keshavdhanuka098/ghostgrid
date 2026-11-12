import { describe, expect, it } from 'vitest';
import {
  computeLevels,
  edgeGeometry,
  findSharedDependencies,
  layoutGraph,
  NODE_H,
  NODE_W,
  outcomeFor,
  simulate,
  traceAsset,
  traceChain,
} from './graph';
import { applyOption, compareOptions } from './mitigation';
import { buildReport, reportToMarkdown } from './report';
import { makeSampleScenario, SAMPLE_KEYS } from './sample';
import {
  addAsset,
  addAssumption,
  addDependency,
  assumptionsFor,
  clearPositions,
  removeAsset,
  removeDependency,
  removalImpact,
  setAssetPosition,
  updateAsset,
  updateDependency,
  validateAsset,
  validateAssumption,
  validateDependency,
} from './scenarioOps';
import type { Asset, Dependency } from './types';

const asset = (id: string, over: Partial<Asset> = {}): Asset => ({ id, name: id, kind: 'service', criticality: 'medium', notes: '', ...over });
const dep = (dependentId: string, providerId: string, mode: Dependency['mode'] = 'required', over: Partial<Dependency> = {}): Dependency => ({
  id: `${dependentId}-${providerId}`,
  dependentId,
  providerId,
  mode,
  status: 'confirmed',
  relation: 'service',
  notes: '',
  ...over,
});

describe('simulate', () => {
  it('cascades through required dependencies in rounds', () => {
    const assets = ['a', 'b', 'c'].map((id) => asset(id));
    const sim = simulate(assets, [dep('b', 'a'), dep('c', 'b')], ['a']);
    expect(sim.rounds).toEqual([['a'], ['b'], ['c']]);
    expect(traceChain(sim, 'c')).toEqual(['a', 'b', 'c']);
  });

  it('keeps a dependent alive while one alternate provider survives', () => {
    const assets = ['p1', 'p2', 'x'].map((id) => asset(id));
    const deps = [dep('x', 'p1', 'alternate'), dep('x', 'p2', 'alternate')];
    expect(simulate(assets, deps, ['p1']).failed.has('x')).toBe(false);
    expect(simulate(assets, deps, ['p1', 'p2']).failed.has('x')).toBe(true);
  });

  it('terminates on cycles and ignores unknown ids', () => {
    const assets = ['a', 'b'].map((id) => asset(id));
    const sim = simulate(assets, [dep('a', 'b'), dep('b', 'a')], ['a', 'ghost']);
    expect([...sim.failed].sort()).toEqual(['a', 'b']);
  });

  it('treats inferred and unknown links as live', () => {
    const assets = ['a', 'b', 'c'].map((id) => asset(id));
    const deps = [dep('b', 'a', 'required', { status: 'inferred' }), dep('c', 'b', 'required', { status: 'unknown' })];
    expect(simulate(assets, deps, ['a']).failed.size).toBe(3);
  });
});

describe('tracing', () => {
  // d relies on c; c relies on a and b; e relies on c. f is unrelated.
  const assets = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => asset(id));
  const deps = [dep('c', 'a'), dep('c', 'b'), dep('d', 'c'), dep('e', 'c')];

  it('finds upstream providers with hop counts', () => {
    const t = traceAsset(assets, deps, 'd', 'up');
    expect(Object.fromEntries(t.upstream)).toEqual({ c: 1, a: 2, b: 2 });
    expect(t.downstream.size).toBe(0);
    expect([...t.links].sort()).toEqual(['c-a', 'c-b', 'd-c']);
  });

  it('finds downstream dependents with hop counts', () => {
    const t = traceAsset(assets, deps, 'a', 'down');
    expect(Object.fromEntries(t.downstream)).toEqual({ c: 1, d: 2, e: 2 });
    expect(t.upstream.size).toBe(0);
  });

  it('traces both directions and leaves unrelated assets out', () => {
    const t = traceAsset(assets, deps, 'c', 'both');
    expect([...t.upstream.keys()].sort()).toEqual(['a', 'b']);
    expect([...t.downstream.keys()].sort()).toEqual(['d', 'e']);
    expect(t.upstream.has('f') || t.downstream.has('f')).toBe(false);
  });

  it('is safe on cycles and never lists the origin as its own ancestor', () => {
    const cyc = traceAsset([asset('a'), asset('b')], [dep('a', 'b'), dep('b', 'a')], 'a', 'both');
    expect([...cyc.upstream.keys()]).toEqual(['b']);
    expect([...cyc.downstream.keys()]).toEqual(['b']);
  });
});

describe('layout', () => {
  it('places providers left of their dependents', () => {
    const assets = ['a', 'b', 'c'].map((id) => asset(id));
    const deps = [dep('b', 'a'), dep('c', 'b')];
    expect([...computeLevels(assets, deps).values()]).toEqual([0, 1, 2]);
    const l = layoutGraph(assets, deps);
    expect(l.pos.get('a')!.x).toBeLessThan(l.pos.get('b')!.x);
    expect(l.pos.get('b')!.x).toBeLessThan(l.pos.get('c')!.x);
    expect(l.pinned.size).toBe(0);
  });

  it('keeps pinned positions and grows the bounds to include them', () => {
    const assets = [asset('a'), asset('b', { x: 900, y: 400 })];
    const l = layoutGraph(assets, [dep('b', 'a')]);
    expect(l.pinned.has('b')).toBe(true);
    expect(l.pos.get('b')).toEqual({ x: 900, y: 400 });
    expect(l.width).toBeGreaterThanOrEqual(900 + NODE_W);
    expect(l.height).toBeGreaterThanOrEqual(400 + NODE_H);
  });

  it('shifts everything when a node is pinned at negative coordinates', () => {
    const l = layoutGraph([asset('a', { x: -300, y: -100 }), asset('b')], []);
    for (const p of l.pos.values()) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeGreaterThanOrEqual(0);
    }
  });

  it('draws left-to-right edges between facing sides and falls back when nodes are rearranged', () => {
    const normal = edgeGeometry({ x: 0, y: 0 }, { x: 400, y: 100 });
    expect(normal.d.startsWith(`M${NODE_W} ${NODE_H / 2}`)).toBe(true);
    expect(normal.mid.x).toBeGreaterThan(NODE_W);
    expect(normal.mid.x).toBeLessThan(400);
    const stacked = edgeGeometry({ x: 0, y: 0 }, { x: 20, y: 300 }); // overlapping horizontally
    expect(stacked.d).toContain(`M${NODE_W / 2} ${NODE_H}`);
    const backwards = edgeGeometry({ x: 600, y: 0 }, { x: 0, y: 0 }); // provider is right of dependent
    expect(Number.isFinite(backwards.mid.x) && Number.isFinite(backwards.mid.y)).toBe(true);
  });
});

describe('bundled simulated samples', () => {
  it('has the expected scenarios, all internally consistent', () => {
    expect(SAMPLE_KEYS).toEqual(['metro-corridor', 'harbour-water', 'hospital-campus']);
    for (const key of SAMPLE_KEYS) {
      const s = makeSampleScenario(key);
      const ids = new Set(s.assets.map((a) => a.id));
      expect(s.isSample).toBe(true);
      expect(s.dependencies.every((d) => ids.has(d.dependentId) && ids.has(d.providerId) && d.dependentId !== d.providerId)).toBe(true);
      expect(s.runs.every((r) => r.failedIds.every((id) => ids.has(id)))).toBe(true);
      expect(s.strategies.every((m) => ids.has(m.dependentId) && ids.has(m.providerId) && (m.kind === 'decouple' ? m.backupId === '' : ids.has(m.backupId)))).toBe(true);
      const linkIds = new Set(s.dependencies.map((d) => d.id));
      expect(s.runs.every((r) => r.failedLinkIds.every((id) => linkIds.has(id)) && r.failedIds.length + r.failedLinkIds.length > 0)).toBe(true);
      const depIds = new Set(s.dependencies.map((d) => d.id));
      expect(s.assumptions.every((a) => (a.targetType === 'node' ? ids.has(a.targetId!) : a.targetType === 'link' ? depIds.has(a.targetId!) : a.targetId === null))).toBe(true);
      // Every strategy is anchored on an existing dependency, so none starts out invalid.
      expect(s.strategies.every((m) => s.dependencies.some((d) => d.dependentId === m.dependentId && d.providerId === m.providerId))).toBe(true);
      // Each sample has hidden shared dependencies for the investigation to find.
      expect(findSharedDependencies(s.assets, s.dependencies).some((x) => x.isHiddenShared)).toBe(true);
    }
  });
});

describe('metro corridor analysis', () => {
  const s = makeSampleScenario('metro-corridor');

  it('exposes the hidden shared dependency behind the colocation', () => {
    const shared = findSharedDependencies(s.assets, s.dependencies);
    expect(shared[0].asset.id).toBe('northgate');
    expect(shared[0].direct).toEqual(['colo']);
    expect(shared[0].hidden).toContain('hospital');
    expect(shared[0].isHiddenShared).toBe(true);
    expect(shared.find((x) => x.asset.id === 'colo')?.hidden).toContain('dispatch');
  });

  it('shows the power backup helping and the dispatch backup not helping', () => {
    const run = s.runs[0].failedIds;
    const { baseline, results } = compareOptions(s.assets, s.dependencies, { nodes: run }, s.strategies);
    // Northgate + colo, fibre, cloud, SCADA, dispatch, traffic, payments, pumping, treatment, hospital
    expect(baseline.total).toBe(11);
    expect(baseline.critical).toBe(3);
    const power = results.find((r) => r.option.id === 'mit-colo-power')!;
    const link = results.find((r) => r.option.id === 'mit-dispatch-link')!;
    expect(power.outcome.total).toBe(1);
    expect(power.protectedIds).toHaveLength(10);
    expect(link.outcome.total).toBe(11);
  });

  it('applyOption converts the dependency to alternate and adds a proposed backup link', () => {
    const next = applyOption(s.dependencies, s.strategies[0]).deps;
    expect(next.find((d) => d.dependentId === 'colo' && d.providerId === 'northgate')?.mode).toBe('alternate');
    const added = next.find((d) => d.dependentId === 'colo' && d.providerId === 'riverside')!;
    expect(added).toMatchObject({ mode: 'alternate', status: 'inferred', relation: 'power' });
    expect(outcomeFor(s.assets, next, ['northgate']).total).toBe(1);
  });
});

describe('other samples behave as described', () => {
  it('the hospital campus survives a utility outage thanks to the generator, but not with a fuel shortage too', () => {
    const s = makeSampleScenario('hospital-campus');
    const utility = outcomeFor(s.assets, s.dependencies, ['utility']);
    const double = outcomeFor(s.assets, s.dependencies, ['utility', 'fuel']);
    expect(utility.sim.failed.has('ats')).toBe(false);
    expect(double.sim.failed.has('ats')).toBe(true);
    expect(double.critical).toBeGreaterThan(utility.critical);
  });

  it('the harbour sample has a single-hub weakness that a mitigation fixes', () => {
    const s = makeSampleScenario('harbour-water');
    const hub = s.runs.find((r) => r.id === 'run-hub')!;
    const { baseline, results } = compareOptions(s.assets, s.dependencies, { nodes: hub.failedIds }, s.strategies);
    expect(baseline.total).toBeGreaterThan(3);
    expect(results.find((r) => r.option.id === 'mit-hub-power')).toBeTruthy();
  });
});

describe('scenario operations', () => {
  it('removing an asset cleans dependencies, strategies, runs and assumptions', () => {
    const s = makeSampleScenario();
    const impact = removalImpact(s, 'northgate');
    expect(impact.assumptions).toBeGreaterThan(0);
    const next = removeAsset(s, 'northgate');
    expect(next.assets.some((a) => a.id === 'northgate')).toBe(false);
    expect(next.dependencies.some((d) => d.providerId === 'northgate')).toBe(false);
    expect(next.strategies.some((m) => m.providerId === 'northgate')).toBe(false);
    expect(next.runs.map((r) => r.id)).toEqual(['run-fiber-colo-link']); // the run that failed Northgate is dropped; the link-only run survives
    expect(next.assumptions.some((a) => a.targetType === 'link' && a.targetId === 'd-colo-northgate')).toBe(false);
    expect(next.assumptions.some((a) => a.targetType === 'scenario')).toBe(true);
  });

  it('removing a dependency drops strategies and assumptions built on it', () => {
    const s = makeSampleScenario();
    const id = s.dependencies.find((d) => d.dependentId === 'colo' && d.providerId === 'northgate')!.id;
    const next = removeDependency(s, id);
    expect(next.strategies.map((m) => m.id)).toEqual(['mit-dispatch-link', 'mit-dispatch-cloud']);
    expect(assumptionsFor(next, 'link', id)).toHaveLength(0);
  });

  it('editing a dependency keeps strategies unless its endpoints change', () => {
    const s = makeSampleScenario();
    const d = s.dependencies.find((x) => x.dependentId === 'colo' && x.providerId === 'northgate')!;
    const { id: _id, ...input } = d;
    const relabelled = updateDependency(s, d.id, { ...input, status: 'unknown', notes: '  now unknown  ' });
    expect(relabelled.dependencies.find((x) => x.id === d.id)).toMatchObject({ status: 'unknown', notes: 'now unknown' });
    expect(relabelled.strategies).toHaveLength(3);
    const rerouted = updateDependency(s, d.id, { ...input, providerId: 'riverside' });
    expect(rerouted.strategies.map((m) => m.id)).toEqual(['mit-dispatch-link', 'mit-dispatch-cloud']);
  });

  it('positions: pinning, editing details without losing the pin, and clearing', () => {
    let s = makeSampleScenario();
    s = setAssetPosition(s, 'colo', 100.6, 50.2);
    expect(s.assets.find((a) => a.id === 'colo')).toMatchObject({ x: 101, y: 50 });
    s = updateAsset(s, 'colo', { name: 'Colo', kind: 'network', criticality: 'high', notes: '' });
    expect(s.assets.find((a) => a.id === 'colo')).toMatchObject({ name: 'Colo', x: 101, y: 50 });
    s = clearPositions(s);
    expect(s.assets.every((a) => a.x === null && a.y === null)).toBe(true);
  });

  it('adds assets, dependencies and assumptions', () => {
    const s = makeSampleScenario();
    const { scenario: s1, asset: created } = addAsset(s, { name: ' New site ', kind: 'power', criticality: 'low', notes: '' }, { x: 10.4, y: 20.6 });
    expect(created).toMatchObject({ name: 'New site', x: 10, y: 21 });
    const { scenario: s2, dependency } = addDependency(s1, { dependentId: created.id, providerId: 'riverside', mode: 'required', status: 'unknown', relation: 'power', notes: '' });
    expect(s2.dependencies.at(-1)).toMatchObject({ id: dependency.id, status: 'unknown' });
    const s3 = addAssumption(s2, { text: '  Assumed single feeder  ', targetType: 'link', targetId: dependency.id, confidence: 'low' });
    expect(assumptionsFor(s3, 'link', dependency.id)[0].text).toBe('Assumed single feeder');
  });

  it('validates assets, dependencies and assumptions', () => {
    const s = makeSampleScenario();
    expect(validateAsset({ name: '  ', notes: '' }, s).name).toBeTruthy();
    expect(validateAsset({ name: 'northgate substation', notes: '' }, s).name).toMatch(/already exists/);
    expect(validateAsset({ name: 'Brand new', notes: '' }, s)).toEqual({});
    expect(validateDependency({ dependentId: 'colo', providerId: 'colo', notes: '' }, s).providerId).toMatch(/itself/);
    expect(validateDependency({ dependentId: 'colo', providerId: 'northgate', notes: '' }, s).providerId).toMatch(/already/);
    const own = s.dependencies.find((d) => d.dependentId === 'colo' && d.providerId === 'northgate')!;
    expect(validateDependency({ dependentId: 'colo', providerId: 'northgate', notes: '' }, s, own.id)).toEqual({});
    expect(validateDependency({ dependentId: '', providerId: '', notes: '' }, s)).toMatchObject({ dependentId: expect.any(String), providerId: expect.any(String) });
    expect(validateAssumption({ text: '   ' }).text).toBeTruthy();
  });
});

describe('report', () => {
  it('builds markdown with status, assumptions, the simulated notice and the mitigation table', () => {
    const s = makeSampleScenario();
    const md = reportToMarkdown(
      buildReport(s, { inventory: true, dependencies: true, assumptions: true, shared: true, runId: s.runs[0].id, mitigation: true }),
    );
    expect(md).toContain('not a certified safety system');
    expect(md).toContain('simulated sample data');
    expect(md).toContain('Hidden shared dependencies');
    expect(md).toContain('| Inferred |');
    expect(md).toContain('## Assumptions');
    expect(md).toContain('inferred or unknown');
    expect(md).toContain('Second power feed for the colocation');
    expect(md).toContain('| Baseline (no change) | 11 | 3 | - |');
  });
});
