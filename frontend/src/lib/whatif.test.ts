import { describe, expect, it } from 'vitest';
import { applyChanges, attribute, cleanChanges, compareFindings, compareSimulation, countChanges, describeChanges, emptyChanges } from './whatif';
import { simulate } from './graph';
import { asset, dep } from './testkit';

const assets = ['db', 'api', 'web', 'gen'].map((id) => asset(id, { criticality: id === 'web' ? 'critical' : 'medium' }));
const deps = [dep('api', 'db'), dep('web', 'api'), dep('web', 'gen', 'alternate', { status: 'inferred' })];
const base = { assets, dependencies: deps };

describe('what-if changes', () => {
  it('never mutates the saved model', () => {
    const snap = JSON.stringify(base);
    const ch = { ...emptyChanges(), links: { 'api-db': { exists: false as const } }, assets: { gen: { exists: false as const } } };
    applyChanges(assets, deps, ch);
    expect(JSON.stringify(base)).toBe(snap);
  });
  it('removing an asset removes its links; criticality edits copy the asset', () => {
    const r = applyChanges(assets, deps, { ...emptyChanges(), assets: { gen: { exists: false }, web: { criticality: 'low' } } });
    expect(r.assets.map((a) => a.id)).toEqual(['db', 'api', 'web']);
    expect(r.assets.find((a) => a.id === 'web')!.criticality).toBe('low');
    expect(r.deps.some((d) => d.providerId === 'gen')).toBe(false);
  });
  it('supports new assets and links, and cleans stale changes', () => {
    const wa = asset('wi-as-1');
    const ch = { ...emptyChanges(), addedAssets: [wa], addedLinks: [dep('api', 'wi-as-1', 'alternate', { id: 'wi-dp-1' }), dep('api', 'ghost', 'required', { id: 'wi-dp-2' })], links: { nope: { exists: false as const } } };
    const clean = cleanChanges(base, ch);
    expect(countChanges(clean)).toBe(2);
    expect(applyChanges(assets, deps, clean).deps.some((d) => d.id === 'wi-dp-1')).toBe(true);
  });
  it('simulation comparison shows what a hypothetical changes', () => {
    const ch = { ...emptyChanges(), links: { 'web-api': { mode: 'alternate' as const } } };
    const c = compareSimulation(base, ch, { nodes: ['db'] });
    expect(c.before.failed).toContain('web');
    expect(c.newlyDown).toEqual([]);
    expect(c.noLongerDown).toEqual(['web']); // api becomes an alternate and gen is still alive
    const removed = compareSimulation(base, { ...emptyChanges(), links: { 'api-db': { exists: false } } }, { nodes: ['db'] });
    expect(removed.noLongerDown.sort()).toEqual(['api', 'web']);
  });
  it('findings comparison and attribution name the change that caused it', () => {
    const ch = { ...emptyChanges(), links: { 'web-gen': { exists: false as const } } };
    const items = describeChanges(base, ch);
    expect(items[0].text).toMatch(/does not exist/);
    const f = compareFindings(base, ch, 'web');
    expect(f.before).not.toBeNull();
    const attr = attribute(base, ch, items, (a, d) => simulate(a, d, ['gen']).failed);
    expect([...attr.keys()]).toEqual(['web']); // its only alternate (gen) was down, so removing the link saves it
    const attr2 = attribute(base, { ...emptyChanges(), links: { 'web-api': { exists: false } } }, describeChanges(base, { ...emptyChanges(), links: { 'web-api': { exists: false } } }), (a, d) => simulate(a, d, ['db']).failed);
    expect(attr2.get('web')).toMatchObject({ direction: 'removed' });
    expect(attr2.get('web')!.causes[0]).toMatch(/web → api/);
  });
  it('flags changes that contradict a confirmed link', () => {
    const items = describeChanges(base, { ...emptyChanges(), links: { 'web-api': { exists: false } } });
    expect(items[0].contradictsConfirmed).toBe(true);
  });
});
