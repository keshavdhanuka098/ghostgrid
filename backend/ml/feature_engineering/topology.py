"""Graph feature extraction (standard library only).

Mirrors the GhostGrid failure model: a *required* provider failing fails its dependent; a dependent with alternate
providers fails only when all of them have failed. Output is deterministic.
"""
from __future__ import annotations
from collections import defaultdict

CRIT = {'low': 1, 'medium': 2, 'high': 4, 'critical': 8}
SCHEMA = 'ghostgrid.graph-features/1'


def _cascade(ids, req, alt, seed):
    failed = {seed}
    changed = True
    while changed:
        changed = False
        for a in ids:
            if a in failed:
                continue
            if any(p in failed for p in req[a]) or (alt[a] and all(p in failed for p in alt[a])):
                failed.add(a)
                changed = True
    return failed


def _depths(ids, edges):
    """Longest path length from each node following edges (dependent -> provider), cycle-safe."""
    memo, state = {}, {}
    def go(n):
        if n in memo:
            return memo[n]
        if state.get(n) == 1:
            return 0
        state[n] = 1
        d = max((1 + go(m) for m in edges[n]), default=0)
        state[n] = 2
        memo[n] = d
        return d
    return {n: go(n) for n in ids}


def _components(ids, deps):
    parent = {i: i for i in ids}
    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x
    for d in deps:
        if d['dependentId'] in parent and d['providerId'] in parent:
            parent[find(d['dependentId'])] = find(d['providerId'])
    return len({find(i) for i in ids})


def _pagerank(ids, providers_of, iters=60, damping=0.85):
    """Importance flows from dependents to their providers: heavily relied-on assets score high."""
    n = len(ids)
    if not n:
        return {}
    rank = {i: 1 / n for i in ids}
    for _ in range(iters):
        nxt = {i: (1 - damping) / n for i in ids}
        sink = 0.0
        for i in ids:
            outs = providers_of[i]
            if outs:
                share = damping * rank[i] / len(outs)
                for p in outs:
                    nxt[p] += share
            else:
                sink += damping * rank[i]
        for i in ids:
            nxt[i] += sink / n
        rank = nxt
    return rank


def extract_graph_features(graph: dict) -> dict:
    assets = [a for a in graph.get('assets', []) if isinstance(a, dict) and 'id' in a]
    ids = [a['id'] for a in assets]
    known = set(ids)
    deps = [d for d in graph.get('dependencies', []) if d.get('dependentId') in known and d.get('providerId') in known]
    by_id = {a['id']: a for a in assets}

    req, alt = defaultdict(list), defaultdict(list)
    providers_of, dependents_of = defaultdict(set), defaultdict(set)
    for d in deps:
        (alt if d.get('mode') == 'alternate' else req)[d['dependentId']].append(d['providerId'])
        providers_of[d['dependentId']].add(d['providerId'])
        dependents_of[d['providerId']].add(d['dependentId'])
    for i in ids:
        req[i], alt[i], providers_of[i], dependents_of[i]  # materialise defaults

    up = _depths(ids, providers_of)
    down = _depths(ids, dependents_of)
    rank = _pagerank(ids, providers_of)

    nodes, total_weighted, hidden_shared, spofs = [], 0.0, 0, 0
    for i in ids:
        failed = _cascade(ids, req, alt, i)
        reached = failed - {i}
        hidden = reached - dependents_of[i]
        weighted = sum(CRIT.get(by_id[r].get('criticality'), 0) for r in reached)
        total_weighted += weighted
        is_hidden_shared = len(hidden) >= 2
        hidden_shared += is_hidden_shared
        spofs += bool(reached)
        nodes.append({
            'id': i, 'name': by_id[i].get('name', i), 'kind': by_id[i].get('kind'), 'criticality': by_id[i].get('criticality'),
            'features': {
                'dependents': len(dependents_of[i]), 'providers': len(providers_of[i]),
                'required_providers': len(set(req[i])), 'alternate_providers': len(set(alt[i])),
                'depth_upstream': up[i], 'depth_downstream': down[i],
                'cascade_reach': len(reached), 'hidden_reach': len(hidden),
                'weighted_reach': float(weighted),
                'reach_fraction': round(len(reached) / (len(ids) - 1), 4) if len(ids) > 1 else 0.0,
                'reliance_rank': round(rank[i], 6),
                'is_single_point_of_failure': bool(reached),
                'is_hidden_shared_dependency': is_hidden_shared,
            },
        })

    n, m = len(ids), len(deps)
    reach = [x['features']['cascade_reach'] for x in nodes]
    indeg = [x['features']['dependents'] for x in nodes]
    outdeg = [x['features']['providers'] for x in nodes]
    mode = lambda k, v: float(sum(d.get(k) == v for d in deps))
    unverified = mode('status', 'inferred') + mode('status', 'unknown')
    graph_features = {
        'asset_count': float(n), 'dependency_count': float(m),
        'dependency_density': round(m / (n * (n - 1)), 6) if n > 1 else 0.0,
        'required_dependency_count': mode('mode', 'required'), 'alternate_dependency_count': mode('mode', 'alternate'),
        'redundancy_ratio': round(mode('mode', 'alternate') / m, 4) if m else 0.0,
        'confirmed_dependency_count': mode('status', 'confirmed'), 'inferred_dependency_count': mode('status', 'inferred'),
        'unknown_dependency_count': mode('status', 'unknown'),
        'unverified_link_ratio': round(unverified / m, 4) if m else 0.0,
        'component_count': float(_components(ids, deps)) if n else 0.0,
        'max_dependents': float(max(indeg, default=0)), 'mean_dependents': round(sum(indeg) / n, 4) if n else 0.0,
        'max_providers': float(max(outdeg, default=0)),
        'max_dependency_depth': float(max(up.values(), default=0)),
        'max_cascade_reach': float(max(reach, default=0)), 'mean_cascade_reach': round(sum(reach) / n, 4) if n else 0.0,
        'single_point_of_failure_count': float(spofs), 'hidden_shared_dependency_count': float(hidden_shared),
        'criticality_weight_sum': float(sum(CRIT.get(a.get('criticality'), 0) for a in assets)),
        'weighted_exposure': float(total_weighted),
    }
    for k in ('power', 'network', 'compute', 'data', 'water', 'transport', 'service', 'other'):
        graph_features[f'asset_kind_{k}_count'] = float(sum(a.get('kind') == k for a in assets))
    nodes.sort(key=lambda x: (-x['features']['weighted_reach'], x['id']))
    return {'schema': SCHEMA, 'graph': graph_features, 'assets': nodes}
