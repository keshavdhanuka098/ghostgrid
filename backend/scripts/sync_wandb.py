#!/usr/bin/env python3
"""Sync one completed GhostGrid experiment to Weights & Biases. Reads WANDB_API_KEY from the environment.
Prints one JSON object. Exit codes: 0 ok, 3 duplicate run, 4 wandb missing, 5 other failure."""
import argparse, json, sys
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from ml.tracking.wandb_tracker import EXPERIMENT_ID, TrackingError, sync_record
p = argparse.ArgumentParser(); p.add_argument('experiment_id'); p.add_argument('--project', required=True); p.add_argument('--entity')
p.add_argument('--upload-checkpoint', action='store_true'); p.add_argument('--update', action='store_true'); a = p.parse_args()
CODES = {'duplicate_run': 3, 'wandb_not_installed': 4}
try:
    if not EXPERIMENT_ID.match(a.experiment_id): raise TrackingError('Invalid experiment id')
    record = json.loads((ROOT / 'ml' / 'experiments' / f'{a.experiment_id}.json').read_text(encoding='utf-8'))
    print(json.dumps(sync_record(record, project=a.project, entity=a.entity, upload_checkpoint=a.upload_checkpoint, backend_root=ROOT, mode='update' if a.update else 'create')))
except TrackingError as exc:
    print(json.dumps({'error': str(exc), 'error_code': exc.code})); sys.exit(CODES.get(exc.code, 5))
except FileNotFoundError:
    print(json.dumps({'error': 'Experiment record not found', 'error_code': 'not_found'})); sys.exit(5)
except Exception as exc:  # never leak provider payloads or credentials
    print(json.dumps({'error': f'Unexpected failure ({type(exc).__name__})', 'error_code': 'tracking_failed'})); sys.exit(5)
