from __future__ import annotations
import importlib, json, uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from ml.dataset import DatasetError, load_records, validate_records, assert_no_leakage, dataset_fingerprint
from ml.evaluation.metrics import evaluate

def _factory(spec: str, kwargs: dict[str, Any]):
    if ':' not in spec: raise ValueError("model_factory must be 'python.module:factory'")
    module_name, function_name = spec.split(':', 1)
    factory = getattr(importlib.import_module(module_name), function_name)
    return factory(**kwargs)

def _xy(records):
    for row in records:
        if not isinstance(row.get('features'), dict): raise DatasetError(f"Record {row.get('record_id')} has no features object")
        if 'target' not in row: raise DatasetError(f"Record {row.get('record_id')} has no target")
    return [r['features'] for r in records], [r['target'] for r in records]

def _apply_preprocessing(config: dict[str, Any], train_rows: list[dict[str, Any]], other_splits: list[list[dict[str, Any]]], fitted_preprocessor=None):
    """Extract features, fit transforms on training data only, then transform every split."""
    if config.get('feature_extractor_factory'):
        extractor = _factory(config['feature_extractor_factory'], config.get('feature_extractor_kwargs', {}))
        if not hasattr(extractor, 'extract'): raise TypeError('Feature extractor must implement extract(record)')
        def apply_features(rows):
            prepared=[]
            for row in rows:
                updated=dict(row); updated['features']=extractor.extract(row); prepared.append(updated)
            return prepared
        train_rows = apply_features(train_rows)
        other_splits = [apply_features(rows) for rows in other_splits]
    processor = fitted_preprocessor
    if config.get('preprocessor_factory'):
        if processor is None:
            processor = _factory(config['preprocessor_factory'], config.get('preprocessor_kwargs', {}))
            if not hasattr(processor, 'fit') or not hasattr(processor, 'transform'):
                raise TypeError('Preprocessor must implement fit(records) and transform(records)')
            processor.fit(train_rows)
        train_rows = processor.transform(train_rows)
        other_splits = [processor.transform(rows) for rows in other_splits]
    return train_rows, other_splits, processor

def _maybe_track(record: dict[str, Any], config: dict[str, Any], root: Path) -> None:
    """Optional W&B logging. It can never fail or slow down local training: any problem is recorded and training still succeeds."""
    settings = (config.get('tracking') or {}).get('wandb') or {}
    if not settings.get('enabled'): return
    try:
        import os
        if not os.environ.get('WANDB_API_KEY'): raise RuntimeError('WANDB_API_KEY is not set')
        from ml.tracking.wandb_tracker import sync_record
        result = sync_record(record, project=settings.get('project', 'ghostgrid'), entity=settings.get('entity'), upload_checkpoint=bool(settings.get('upload_checkpoint', False)), backend_root=root)
        record['tracking'] = {'wandb': {'status': 'synced', 'run_id': result['run_id'], 'run_url': result.get('run_url'), 'project': result.get('project'), 'entity': result.get('entity'), 'synced_at': datetime.now(timezone.utc).isoformat()}}
    except Exception as exc:  # noqa: BLE001 - tracking must never break training
        record['tracking'] = {'wandb': {'status': 'failed', 'error': f'{type(exc).__name__}: {str(exc)[:200]}'}}

def train(config_path: str | Path) -> dict[str, Any]:
    config_path = Path(config_path).resolve(); config = json.loads(config_path.read_text(encoding='utf-8'))
    root = config_path.parent.parent.parent
    started_at = datetime.now(timezone.utc).isoformat()
    experiment_id = f"exp_{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}_{uuid.uuid4().hex[:8]}"
    models_root = (root / config.get('models_root', 'ml/models')).resolve()
    registry = models_root / 'registry'; registry.mkdir(parents=True, exist_ok=True)
    experiments = root / 'ml' / 'experiments'; experiments.mkdir(parents=True, exist_ok=True)
    registry_file = registry / f'{experiment_id}.json'
    experiment_file = experiments / f'{experiment_id}.json'
    record: dict[str, Any] = {
        'experiment_id': experiment_id, 'status': 'running', 'task': config.get('task'),
        'model_name': config.get('model_name', 'unnamed-model'), 'model_version': config.get('model_version', '0.1.0'),
        'dataset_version': config.get('dataset_version', 'unversioned'), 'hyperparameters': config.get('model_kwargs', {}),
        'preprocessor_factory': config.get('preprocessor_factory'), 'preprocessor_kwargs': config.get('preprocessor_kwargs', {}),
        'feature_extractor_factory': config.get('feature_extractor_factory'), 'feature_extractor_kwargs': config.get('feature_extractor_kwargs', {}),
        'started_at': started_at, 'completed_at': None, 'validation_metrics': None, 'test_metrics': None,
        'checkpoint': None, 'production_ready': False
    }
    def persist():
        payload = json.dumps(record, indent=2)
        registry_file.write_text(payload, encoding='utf-8')
        experiment_file.write_text(payload, encoding='utf-8')
    persist()
    try:
        data_root = (root / config.get('data_root', 'datasets/processed')).resolve()
        train_rows = load_records(data_root / 'train' / config.get('train_file', 'train.jsonl'))
        val_rows = load_records(data_root / 'validation' / config.get('validation_file', 'validation.jsonl'))
        errors = validate_records(train_rows + val_rows, require_target=True, allowed_labels=set(config['allowed_labels']) if config.get('allowed_labels') else None)
        if errors: raise DatasetError('; '.join(errors))
        assert_no_leakage({'train': train_rows, 'validation': val_rows})
        source_fingerprint = dataset_fingerprint(train_rows + val_rows)
        train_rows, (val_rows,), processor = _apply_preprocessing(config, train_rows, [val_rows])
        x_train, y_train = _xy(train_rows); x_val, y_val = _xy(val_rows)
        record.update({'dataset_fingerprint': source_fingerprint, 'train_records': len(train_rows), 'validation_records': len(val_rows)})
        model = _factory(config['model_factory'], {'task': config['task'], **config.get('model_kwargs', {})})
        model.fit(x_train, y_train, validation=(x_val, y_val))
        val_probabilities = model.predict_proba(x_val) if config['task'] == 'classification' and hasattr(model, 'predict_proba') else None
        model_classes = list(model.classes_) if val_probabilities is not None and hasattr(model, 'classes_') else None
        val_metrics = evaluate(config['task'], y_val, model.predict(x_val), val_probabilities, model_classes)
        checkpoint = models_root / 'checkpoints' / experiment_id
        checkpoint.mkdir(parents=True, exist_ok=False)
        if not hasattr(model, 'save'): raise TypeError('Model adapter must implement save(path)')
        model.save(str(checkpoint / 'model'))
        if processor is not None:
            if not hasattr(processor, 'save'): raise TypeError('A fitted preprocessor must implement save(path) so evaluation/inference can reuse its training-only state')
            processor.save(str(checkpoint / 'preprocessor'))
        record.update({'status': 'completed', 'validation_metrics': val_metrics, 'checkpoint': str(checkpoint.relative_to(root)), 'preprocessor_factory': config.get('preprocessor_factory'), 'feature_extractor_factory': config.get('feature_extractor_factory'), 'completed_at': datetime.now(timezone.utc).isoformat()})
        persist()
        _maybe_track(record, config, root)  # optional; recorded in the experiment, never raises
        if record.get('tracking'): persist()
        return record
    except Exception as exc:
        record.update({'status': 'failed', 'error': str(exc), 'completed_at': datetime.now(timezone.utc).isoformat()})
        persist()
        raise

def evaluate_checkpoint(config_path: str | Path, experiment_id: str) -> dict[str, Any]:
    """Evaluate a registered adapter on the held-out test set; adapter must expose load(path)."""
    config_path = Path(config_path).resolve(); config = json.loads(config_path.read_text(encoding='utf-8'))
    root = config_path.parent.parent.parent
    registry_file = root / config.get('models_root', 'ml/models') / 'registry' / f'{experiment_id}.json'
    record = json.loads(registry_file.read_text(encoding='utf-8'))
    data_root = (root / config.get('data_root', 'datasets/processed')).resolve()
    train_rows = load_records(data_root / 'train' / config.get('train_file', 'train.jsonl'))
    validation_rows = load_records(data_root / 'validation' / config.get('validation_file', 'validation.jsonl'))
    test_rows = load_records(data_root / 'test' / config.get('test_file', 'test.jsonl'))
    errors = validate_records(train_rows + validation_rows + test_rows, require_target=True, allowed_labels=set(config['allowed_labels']) if config.get('allowed_labels') else None)
    if errors: raise DatasetError('; '.join(errors))
    assert_no_leakage({'train': train_rows, 'validation': validation_rows, 'test': test_rows})
    processor = None
    if config.get('preprocessor_factory'):
        processor = _factory(config['preprocessor_factory'], config.get('preprocessor_kwargs', {}))
        if not hasattr(processor, 'load'): raise TypeError('A preprocessor must implement load(path) for held-out evaluation')
        processor.load(str((root / record['checkpoint'] / 'preprocessor').resolve()))
    train_rows, (validation_rows, test_rows), _ = _apply_preprocessing(config, train_rows, [validation_rows, test_rows], fitted_preprocessor=processor)
    x_test, y_test = _xy(test_rows)
    model = _factory(config['model_factory'], {'task': config['task'], **config.get('model_kwargs', {})})
    if not hasattr(model, 'load'): raise TypeError('Model adapter must implement load(path) for test evaluation')
    model.load(str((root / record['checkpoint'] / 'model').resolve()))
    test_probabilities = model.predict_proba(x_test) if config['task'] == 'classification' and hasattr(model, 'predict_proba') else None
    model_classes = list(model.classes_) if test_probabilities is not None and hasattr(model, 'classes_') else None
    record['test_metrics'] = evaluate(config['task'], y_test, model.predict(x_test), test_probabilities, model_classes)
    record['test_records'] = len(test_rows); record['test_evaluated_at'] = datetime.now(timezone.utc).isoformat()
    # Evaluation does not automatically approve a model for production.
    registry_file.write_text(json.dumps(record, indent=2), encoding='utf-8')
    (root / 'ml' / 'experiments' / f'{experiment_id}.json').write_text(json.dumps(record, indent=2), encoding='utf-8')
    return record
