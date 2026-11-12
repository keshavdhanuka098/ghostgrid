import { describe, expect, it } from 'vitest';
import { chainIds, downstreamPaths, sharedBetween, upstreamPaths } from './trace';
import { asset, dep } from './testkit';

// web -> api -> db ; web2 -> api2 -> db (inferred) ; web -> cache (unknown)
const assets = ['web', 'api', 'db', 'web2', 'api2', 'cache'].map((id) => asset(id));
const deps = [dep('web', 'api'), dep('api', 'db'), dep('web2', 'api2'), dep('api2', 'db', 'required', { status: 'inferred' }), dep('web', 'cache', 'required', { status: 'unknown' })];

describe('dependency trace', () => {
  it('finds upstream paths with hops and the weakest status', () => {
    const up = upstreamPaths(assets, deps, 'web');
    expect(up.map((e) => [e.asset.id, e.hops, e.status])).toEqual([['api', 1, 'confirmed'], ['cache', 1, 'unknown'], ['db', 2, 'confirmed']]);
    expect(chainIds(up.find((e) => e.asset.id === 'db')!.links)).toEqual(['web', 'api', 'db']);
  });
  it('finds downstream paths in reliance order', () => {
    const down = downstreamPaths(assets, deps, 'db');
    expect(down.map((e) => e.asset.id).sort()).toEqual(['api', 'api2', 'web', 'web2']);
    const web2 = down.find((e) => e.asset.id === 'web2')!;
    expect(chainIds(web2.links)).toEqual(['web2', 'api2', 'db']);
    expect(web2.status).toBe('inferred');
  });
  it('finds what two assets share, and reports the weaker evidence', () => {
    const shared = sharedBetween(assets, deps, 'web', 'web2');
    expect(shared.map((x) => x.asset.id)).toEqual(['db']);
    expect(shared[0].status).toBe('inferred');
    expect(sharedBetween(assets, deps, 'web', 'web')).toEqual([]);
  });
  it('handles cycles and missing assets without looping', () => {
    const cyc = [dep('a', 'b'), dep('b', 'a'), dep('a', 'ghost')];
    expect(upstreamPaths(['a', 'b'].map((i) => asset(i)), cyc, 'a').map((e) => e.asset.id)).toEqual(['b']);
  });
});
