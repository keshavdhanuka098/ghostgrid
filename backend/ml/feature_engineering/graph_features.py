"""Deterministic numeric features derived only from a record's mapped GhostGrid graph."""
from typing import Any
from .topology import extract_graph_features

class GraphFeatureExtractor:
    def extract(self, record: dict[str, Any]) -> dict[str, float]:
        graph = record.get('graph')
        if not isinstance(graph, dict): raise ValueError(f"Record {record.get('record_id')} has no graph object")
        assets = graph.get('assets', []); dependencies = graph.get('dependencies', [])
        n = len(assets); m = len(dependencies)
        features: dict[str, float] = {
            'asset_count': float(n), 'dependency_count': float(m),
            'dependency_density': float(m / (n * (n - 1))) if n > 1 else 0.0,
            'criticality_weight_sum': 0.0,
            'required_dependency_count': float(sum(d.get('mode') == 'required' for d in dependencies)),
            'alternate_dependency_count': float(sum(d.get('mode') == 'alternate' for d in dependencies)),
            'confirmed_dependency_count': float(sum(d.get('status') == 'confirmed' for d in dependencies)),
            'inferred_dependency_count': float(sum(d.get('status') == 'inferred' for d in dependencies)),
            'unknown_dependency_count': float(sum(d.get('status') == 'unknown' for d in dependencies)),
        }
        criticality_weights = {'low':1.0,'medium':2.0,'high':4.0,'critical':8.0}
        kind_values = {'power','network','compute','data','water','transport','service','other'}
        for kind in kind_values: features[f'asset_kind_{kind}_count'] = 0.0
        for asset in assets:
            features['criticality_weight_sum'] += criticality_weights.get(asset.get('criticality'), 0.0)
            kind = asset.get('kind')
            if kind in kind_values: features[f'asset_kind_{kind}_count'] += 1.0
        features.update(extract_graph_features(graph)['graph'])
        return features

def create_extractor() -> GraphFeatureExtractor:
    return GraphFeatureExtractor()
