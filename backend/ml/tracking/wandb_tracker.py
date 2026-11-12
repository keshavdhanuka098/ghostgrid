"""Weights & Biases logging for GhostGrid experiments (optional).

* ``wandb`` is imported lazily, so GhostGrid trains and evaluates with or without it installed.
* Only configuration, metrics, timing and dataset *references* (version and fingerprint) are logged. Dataset files are
  never uploaded; the checkpoint is uploaded only when ``upload_checkpoint`` is explicitly true.
* The W&B run id is derived from the GhostGrid experiment id and created with ``resume='never'``, so W&B itself
  refuses a second run for the same experiment. ``mode='update'`` resumes that same run (e.g. to add test metrics).
"""
from __future__ import annotations
import importlib, re
from datetime import datetime
from pathlib import Path
from typing import Any

EXPERIMENT_ID = re.compile(r'^exp_[A-Za-z0-9_]{1,80}$')
PROJECT_NAME = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$')

class TrackingError(RuntimeError):
    code = 'tracking_failed'
class WandbNotInstalled(TrackingError):
    code = 'wandb_not_installed'
class DuplicateRun(TrackingError):
    code = 'duplicate_run'

def run_id_for(experiment_id: str) -> str:
    if not EXPERIMENT_ID.match(experiment_id or ''): raise TrackingError('Invalid experiment id')
    return f'gg-{experiment_id}'

# GhostGrid metric names -> the names people expect in W&B charts.
_ALIASES = {'macro_precision': 'precision', 'macro_recall': 'recall', 'macro_f1': 'f1'}
_SKIP = {'task', 'labels', 'confusion_matrix', 'per_class'}

def flatten_metrics(prefix: str, metrics: dict[str, Any] | None) -> dict[str, float]:
    out: dict[str, float] = {}
    for key, value in (metrics or {}).items():
        if key in _SKIP or isinstance(value, bool) or not isinstance(value, (int, float)): continue
        out[f'{prefix}/{_ALIASES.get(key, key)}'] = float(value)
    for label, scores in ((metrics or {}).get('per_class') or {}).items():
        for name, value in scores.items():
            if isinstance(value, (int, float)): out[f'{prefix}/per_class/{label}/{name}'] = float(value)
    return out

def duration_seconds(record: dict[str, Any]) -> float | None:
    try:
        a = datetime.fromisoformat(record['started_at']); b = datetime.fromisoformat(record['completed_at'])
        return max(0.0, (b - a).total_seconds())
    except (KeyError, TypeError, ValueError):
        return None

def build_payload(record: dict[str, Any]) -> dict[str, Any]:
    """Everything that will be sent, built from the real experiment record and nothing else."""
    config = {
        'ghostgrid_experiment_id': record.get('experiment_id'), 'task': record.get('task'),
        'model_name': record.get('model_name'), 'model_version': record.get('model_version'),
        'hyperparameters': record.get('hyperparameters') or {},
        'dataset_version': record.get('dataset_version'), 'dataset_fingerprint': record.get('dataset_fingerprint'),
        'train_records': record.get('train_records'), 'validation_records': record.get('validation_records'),
        'test_records': record.get('test_records'),
        'preprocessor_factory': record.get('preprocessor_factory'), 'feature_extractor_factory': record.get('feature_extractor_factory'),
    }
    summary: dict[str, Any] = {}
    summary.update(flatten_metrics('validation', record.get('validation_metrics')))
    summary.update(flatten_metrics('test', record.get('test_metrics')))
    seconds = duration_seconds(record)
    if seconds is not None: summary['duration_seconds'] = seconds
    summary['ghostgrid_status'] = record.get('status')
    # Adapters that expose per-epoch history (list of dicts with numeric values) get real step-by-step curves.
    history = [h for h in (record.get('history') or []) if isinstance(h, dict)]
    return {'config': config, 'summary': summary, 'history': history, 'tags': ['ghostgrid', str(record.get('task') or 'unknown')]}

def _load_wandb(wandb_module=None):
    if wandb_module is not None: return wandb_module
    try: return importlib.import_module('wandb')
    except ImportError as exc: raise WandbNotInstalled('The wandb package is not installed. Run: pip install wandb') from exc

def sync_record(record: dict[str, Any], *, project: str, entity: str | None = None, upload_checkpoint: bool = False,
                backend_root: str | Path | None = None, mode: str = 'create', wandb_module=None) -> dict[str, Any]:
    if not PROJECT_NAME.match(project or ''): raise TrackingError('Invalid W&B project name')
    if mode not in ('create', 'update'): raise TrackingError("mode must be 'create' or 'update'")
    if record.get('status') != 'completed': raise TrackingError('Only completed experiments can be synchronised')
    wandb = _load_wandb(wandb_module)
    rid = run_id_for(str(record.get('experiment_id')))
    payload = build_payload(record)
    try:
        run = wandb.init(project=project, entity=entity, id=rid, name=f"{record.get('model_name', 'model')}-{record['experiment_id']}",
                         config=payload['config'], tags=payload['tags'], job_type='train',
                         resume='never' if mode == 'create' else 'must', reinit=True)
    except Exception as exc:
        text = str(exc).lower()
        if mode == 'create' and ('already' in text or 'resume' in text or 'exists' in text): raise DuplicateRun('A W&B run for this experiment already exists') from exc
        raise TrackingError(f'Could not start a W&B run: {type(exc).__name__}') from exc
    uploaded = False
    try:
        if mode == 'create':
            for step, row in enumerate(payload['history']):
                numeric = {k: v for k, v in row.items() if isinstance(v, (int, float)) and not isinstance(v, bool)}
                if numeric: run.log(numeric, step=int(row.get('step', row.get('epoch', step))))
        for key, value in payload['summary'].items(): run.summary[key] = value
        if upload_checkpoint and record.get('checkpoint') and backend_root:
            ckpt = (Path(backend_root) / record['checkpoint']).resolve()
            if ckpt.is_dir() and Path(backend_root).resolve() in ckpt.parents:
                art = wandb.Artifact(f"{record.get('model_name', 'model')}-{record['experiment_id']}", type='model',
                                     metadata={'ghostgrid_experiment_id': record['experiment_id'], 'dataset_fingerprint': record.get('dataset_fingerprint')})
                art.add_dir(str(ckpt)); run.log_artifact(art); uploaded = True
        url = getattr(run, 'url', None)
        return {'run_id': rid, 'run_url': url, 'entity': getattr(run, 'entity', entity), 'project': getattr(run, 'project', project),
                'uploaded_checkpoint': uploaded, 'logged_metrics': len(payload['summary']), 'mode': mode}
    finally:
        run.finish()
