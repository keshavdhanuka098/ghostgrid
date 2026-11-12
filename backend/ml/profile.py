"""Descriptive statistics for a dataset file, used to ground dataset-quality explanations in real numbers."""
from __future__ import annotations
from collections import Counter
from pathlib import Path
from typing import Any
from ml.dataset import load_records, validate_records

def profile(path: str | Path, *, max_errors: int = 20) -> dict[str, Any]:
    rows = load_records(path)
    errors = validate_records(rows, require_target=False)
    ids = [r.get('record_id') for r in rows]
    labels = Counter(str(r['target']) for r in rows if 'target' in r)
    groups = Counter(str(r.get('graph_id') or r.get('scenario_id')) for r in rows if r.get('graph_id') or r.get('scenario_id'))
    feature_keys: Counter[str] = Counter(); non_numeric: Counter[str] = Counter(); missing: Counter[str] = Counter()
    for r in rows:
        feats = r.get('features') if isinstance(r.get('features'), dict) else {}
        for k, v in feats.items():
            feature_keys[k] += 1
            if v is None: missing[k] += 1
            elif isinstance(v, bool) or not isinstance(v, (int, float)): non_numeric[k] += 1
    n = len(rows); majority = max(labels.values()) if labels else 0
    return {
        'file': Path(path).name, 'record_count': n,
        'with_target': sum('target' in r for r in rows), 'label_counts': dict(labels),
        'majority_class_share': round(majority / sum(labels.values()), 4) if labels else None,
        'duplicate_record_ids': sum(c - 1 for c in Counter(ids).values() if c > 1 and ids),
        'group_count': len(groups), 'smallest_group': min(groups.values()) if groups else None, 'largest_group': max(groups.values()) if groups else None,
        'records_without_group': sum(not (r.get('graph_id') or r.get('scenario_id')) for r in rows),
        'feature_count': len(feature_keys), 'features_with_missing_values': dict(missing.most_common(10)),
        'features_non_numeric': dict(non_numeric.most_common(10)),
        'features_partially_present': {k: c for k, c in feature_keys.items() if c != n} if n else {},
        'validation_error_count': len(errors), 'validation_errors': errors[:max_errors],
        'can_split_without_leakage': len(groups) >= 3,
    }
