import { describe, expect, it } from 'vitest';
import { createLimiter, extractFeatures } from './features.mjs';

const graph = {
  assets: [
    { id: 'feed', name: 'Feed', kind: 'power', criticality: 'high' },
    { id: 'a', name: 'A', kind: 'network', criticality: 'medium' },
    { id: 'b', name: 'B', kind: 'compute', criticality: 'medium' },
  ],
  dependencies: [
    { dependentId: 'a', providerId: 'feed', mode: 'required', status: 'confirmed' },
    { dependentId: 'b', providerId: 'a', mode: 'required', status: 'inferred' },
  ],
};

describe('graph feature extraction bridge', () => {
  it('returns graph and per-asset features from the Python module', async () => {
    const out = await extractFeatures(graph);
    expect(out.schema).toBe('ghostgrid.graph-features/1');
    expect(out.graph.asset_count).toBe(3);
    expect(out.assets[0].id).toBe('feed');
    expect(out.assets[0].features.cascade_reach).toBe(2);
  });
  it('reports a clear error when Python is missing', async () => {
    await expect(extractFeatures(graph, { python: 'definitely-not-python' })).rejects.toMatchObject({ status: 503 });
  });
  it('answers many concurrent requests correctly', async () => {
    const results = await Promise.all(Array.from({ length: 6 }, () => extractFeatures(graph)));
    expect(results.every((r) => r.graph.asset_count === 3)).toBe(true);
  });
});

describe('createLimiter', () => {
  it('never runs more than the allowed number of tasks at once and keeps order', async () => {
    const limit = createLimiter(2);
    let active = 0;
    let peak = 0;
    const started = [];
    const task = (n) => async () => {
      started.push(n);
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 10));
      active--;
      return n;
    };
    const out = await Promise.all([1, 2, 3, 4, 5].map((n) => limit(task(n))));
    expect(out).toEqual([1, 2, 3, 4, 5]);
    expect(started).toEqual([1, 2, 3, 4, 5]);
    expect(peak).toBe(2);
  });
  it('keeps working after a task fails', async () => {
    const limit = createLimiter(1);
    await expect(limit(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    await expect(limit(async () => 'ok')).resolves.toBe('ok');
  });
});
