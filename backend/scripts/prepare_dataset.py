#!/usr/bin/env python3
"""Validate raw records and copy them into the processed pipeline input as JSONL."""
import argparse, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from ml.dataset import load_records, validate_records, write_jsonl
p=argparse.ArgumentParser(description='Validate and normalise a dataset into JSONL'); p.add_argument('input'); p.add_argument('--output',default='datasets/processed/all.jsonl'); p.add_argument('--require-target',action='store_true'); a=p.parse_args()
rows=load_records(a.input); errors=validate_records(rows,require_target=a.require_target)
if errors: raise SystemExit('\n'.join(errors))
write_jsonl(Path(a.output),rows); print(f'Validated and wrote {len(rows)} records to {a.output}')
