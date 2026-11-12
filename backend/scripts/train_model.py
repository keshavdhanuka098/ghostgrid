#!/usr/bin/env python3
import argparse, json, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from ml.pipeline import train
p=argparse.ArgumentParser(description='Run a configured GhostGrid model training experiment'); p.add_argument('--config',default='ml/configs/example.json'); a=p.parse_args()
try: print(json.dumps(train(a.config),indent=2))
except Exception as exc: raise SystemExit(f'Training failed: {exc}')
