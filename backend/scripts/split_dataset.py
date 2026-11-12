#!/usr/bin/env python3
import argparse, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from ml.dataset import load_records, validate_records, split_records, write_jsonl
p=argparse.ArgumentParser(description='Create reproducible graph/scenario-level train/validation/test splits')
p.add_argument('input'); p.add_argument('--output', default='datasets/processed'); p.add_argument('--train', type=float, default=.70); p.add_argument('--validation', type=float, default=.15); p.add_argument('--test', type=float, default=.15); p.add_argument('--seed', type=int, default=42)
a=p.parse_args(); rows=load_records(a.input); errors=validate_records(rows, require_target=True)
if errors: raise SystemExit('\n'.join(errors))
splits=split_records(rows,a.train,a.validation,a.test,a.seed)
for name, data in splits.items(): write_jsonl(Path(a.output)/name/f'{name}.jsonl',data); print(f'{name}: {len(data)} records')
