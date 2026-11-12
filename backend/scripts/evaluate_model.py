#!/usr/bin/env python3
import argparse, json, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from ml.pipeline import evaluate_checkpoint
p=argparse.ArgumentParser(description='Evaluate a registered GhostGrid model on the held-out test split'); p.add_argument('experiment_id'); p.add_argument('--config',default='ml/configs/example.json'); a=p.parse_args()
try: print(json.dumps(evaluate_checkpoint(a.config,a.experiment_id),indent=2))
except Exception as exc: raise SystemExit(f'Evaluation failed: {exc}')
