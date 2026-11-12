"""Dataset loading, validation and leakage-safe splitting (Python standard library only)."""
from __future__ import annotations
import csv, hashlib, json, random
from pathlib import Path
from typing import Any

SUPPORTED = {'.json', '.jsonl', '.ndjson', '.csv'}

class DatasetError(ValueError):
    pass

def _coerce_csv_value(value: str):
    if value is None or value == '': return None
    try:
        number = float(value)
        return int(number) if number.is_integer() else number
    except (TypeError, ValueError):
        return value

def load_records(path: str | Path) -> list[dict[str, Any]]:
    path = Path(path)
    if not path.exists(): raise DatasetError(f"Dataset file not found: {path}")
    if path.suffix.lower() not in SUPPORTED: raise DatasetError(f"Unsupported format {path.suffix}; use JSON, JSONL or CSV")
    try:
        if path.suffix.lower() == '.json':
            data = json.loads(path.read_text(encoding='utf-8'))
            if isinstance(data, dict): data = data.get('records', [data])
        elif path.suffix.lower() in {'.jsonl', '.ndjson'}:
            data = [json.loads(line) for line in path.read_text(encoding='utf-8').splitlines() if line.strip()]
        else:
            with path.open(newline='', encoding='utf-8') as f: data = list(csv.DictReader(f))
            # CSV convention: feature__<name> columns become a numeric feature object.
            for row in data:
                feature_columns = [key for key in row if key.startswith('feature__')]
                if feature_columns:
                    row['features'] = {key.removeprefix('feature__'): _coerce_csv_value(row.pop(key)) for key in feature_columns}
    except (json.JSONDecodeError, csv.Error) as exc:
        raise DatasetError(f"Could not parse {path}: {exc}") from exc
    if not isinstance(data, list) or any(not isinstance(row, dict) for row in data):
        raise DatasetError('Dataset must contain a list of record objects')
    return data

def validate_graph(graph: dict[str, Any], record_id: str = 'graph') -> list[str]:
    errors: list[str] = []
    assets, deps = graph.get('assets'), graph.get('dependencies')
    if not isinstance(assets, list): return [f'{record_id}: assets must be an array']
    if not isinstance(deps, list): return [f'{record_id}: dependencies must be an array']
    ids = [a.get('id') for a in assets if isinstance(a, dict)]
    if len(ids) != len(assets): errors.append(f'{record_id}: every asset must be an object')
    if any(not isinstance(i, str) or not i for i in ids): errors.append(f'{record_id}: every asset needs a non-empty string id')
    if len(ids) != len(set(ids)): errors.append(f'{record_id}: duplicate asset ids')
    for asset in assets:
        if not isinstance(asset, dict): continue
        if asset.get('kind') is not None and asset.get('kind') not in {'power','network','compute','data','water','transport','service','other'}: errors.append(f'{record_id}: asset {asset.get("id")} has invalid kind {asset.get("kind")!r}')
        if asset.get('criticality') is not None and asset.get('criticality') not in {'low','medium','high','critical'}: errors.append(f'{record_id}: asset {asset.get("id")} has invalid criticality {asset.get("criticality")!r}')
    known = set(ids)
    dep_ids: set[str] = set()
    dep_pairs: set[tuple[str, str]] = set()
    for index, dep in enumerate(deps):
        label = f'{record_id}: dependency[{index}]'
        if not isinstance(dep, dict): errors.append(f'{label} must be an object'); continue
        did = dep.get('id')
        if not isinstance(did, str) or not did: errors.append(f'{label} needs a non-empty id')
        elif did in dep_ids: errors.append(f'{label} duplicate dependency id {did}')
        else: dep_ids.add(did)
        for field in ('dependentId', 'providerId'):
            if dep.get(field) not in known: errors.append(f'{label} references missing {field}: {dep.get(field)!r}')
        if dep.get('dependentId') == dep.get('providerId'): errors.append(f'{label} cannot depend on itself')
        pair = (str(dep.get('dependentId')), str(dep.get('providerId')))
        if pair in dep_pairs: errors.append(f'{label} duplicates dependency pair {pair}')
        dep_pairs.add(pair)
        if dep.get('mode') is not None and dep.get('mode') not in {'required', 'alternate'}: errors.append(f'{label} has invalid mode {dep.get("mode")!r}')
        if dep.get('status') is not None and dep.get('status') not in {'confirmed', 'inferred', 'unknown'}: errors.append(f'{label} has invalid status {dep.get("status")!r}')
        if dep.get('relation') is not None and dep.get('relation') not in {'power','data','network','control','physical','service','other'}: errors.append(f'{label} has invalid relation {dep.get("relation")!r}')
    return errors

def validate_records(records: list[dict[str, Any]], *, require_target: bool = False, allowed_labels: set[str] | None = None) -> list[str]:
    errors: list[str] = []
    seen: set[str] = set()
    seen_payloads: set[str] = set()
    for i, row in enumerate(records):
        rid = row.get('record_id')
        label = f'record[{i}]'
        if not isinstance(rid, str) or not rid: errors.append(f'{label}: record_id is required')
        elif rid in seen: errors.append(f'{label}: duplicate record_id {rid}')
        else: seen.add(rid)
        payload = json.dumps({k:v for k,v in row.items() if k != 'record_id'}, sort_keys=True, separators=(',', ':'), ensure_ascii=False)
        if payload in seen_payloads: errors.append(f'{label}: duplicate record content (excluding record_id)')
        else: seen_payloads.add(payload)
        if require_target and 'target' not in row: errors.append(f'{label}: target is required for supervised training')
        if allowed_labels is not None and 'target' in row and str(row['target']) not in allowed_labels: errors.append(f'{label}: invalid target label {row["target"]!r}; allowed: {sorted(allowed_labels)}')
        if 'features' in row and not isinstance(row['features'], dict): errors.append(f'{label}: features must be an object')
        if 'graph' in row:
            if not isinstance(row['graph'], dict): errors.append(f'{label}: graph must be an object')
            else: errors.extend(validate_graph(row['graph'], str(rid or label)))
        if 'failed_dependency_ids' in row:
            graph_dep_ids = {d.get('id') for d in row.get('graph', {}).get('dependencies', []) if isinstance(d, dict)}
            if graph_dep_ids:
                for did in row['failed_dependency_ids']:
                    if did not in graph_dep_ids: errors.append(f'{label}: failed dependency {did!r} is absent from graph')
        if 'failed_asset_ids' in row:
            graph_ids = {a.get('id') for a in row.get('graph', {}).get('assets', []) if isinstance(a, dict)}
            if graph_ids:
                for aid in row['failed_asset_ids']:
                    if aid not in graph_ids: errors.append(f'{label}: failed asset {aid!r} is absent from graph')
    return errors

def stable_group_id(row: dict[str, Any]) -> str:
    # All samples derived from one graph/scenario stay in the same split.
    return str(row.get('graph_id') or row.get('scenario_id') or row.get('record_id'))

def split_records(records: list[dict[str, Any]], train: float = .70, validation: float = .15, test: float = .15, seed: int = 42) -> dict[str, list[dict[str, Any]]]:
    if any(x <= 0 for x in (train, validation, test)) or abs(train + validation + test - 1) > 1e-8:
        raise DatasetError('Split ratios must be positive and sum to 1.0')
    groups: dict[str, list[dict[str, Any]]] = {}
    for row in records:
        if ('graph' in row or 'failed_asset_ids' in row or 'failed_dependency_ids' in row) and not (row.get('graph_id') or row.get('scenario_id')):
            raise DatasetError(f"Graph/scenario record {row.get('record_id')!r} needs graph_id or scenario_id for leakage-safe splitting")
        groups.setdefault(stable_group_id(row), []).append(row)
    keys = list(groups)
    random.Random(seed).shuffle(keys)
    n = len(keys)
    if n < 3: raise DatasetError('At least 3 independent graph/scenario groups are required for train/validation/test splitting')
    n_train = max(1, int(n * train)); n_val = max(1, int(n * validation))
    if n_train + n_val >= n: n_train, n_val = n - 2, 1
    assignments = {'train': keys[:n_train], 'validation': keys[n_train:n_train+n_val], 'test': keys[n_train+n_val:]}
    result = {name: [row for key in assigned for row in groups[key]] for name, assigned in assignments.items()}
    assert_no_leakage(result)
    return result

def assert_no_leakage(splits: dict[str, list[dict[str, Any]]]) -> None:
    owners: dict[str, str] = {}
    for split, rows in splits.items():
        for row in rows:
            group = stable_group_id(row)
            if group in owners and owners[group] != split:
                raise DatasetError(f'Data leakage: group {group!r} appears in {owners[group]} and {split}')
            owners[group] = split

def write_jsonl(path: Path, records: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(''.join(json.dumps(r, ensure_ascii=False, sort_keys=True) + '\n' for r in records), encoding='utf-8')

def dataset_fingerprint(records: list[dict[str, Any]]) -> str:
    payload = json.dumps(records, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()
    return hashlib.sha256(payload).hexdigest()
