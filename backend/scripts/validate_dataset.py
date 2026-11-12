#!/usr/bin/env python3
import argparse, json, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from ml.dataset import load_records, validate_records
p=argparse.ArgumentParser(description='Validate a GhostGrid JSON/JSONL/CSV dataset')
p.add_argument('file'); p.add_argument('--require-target', action='store_true'); p.add_argument('--allowed-labels', help='Comma-separated target labels to enforce'); args=p.parse_args()
try:
    rows=load_records(args.file); errors=validate_records(rows, require_target=args.require_target, allowed_labels=set(args.allowed_labels.split(',')) if args.allowed_labels else None)
    print(json.dumps({'file':args.file,'records':len(rows),'errors':errors,'valid':not errors}, indent=2))
    raise SystemExit(0 if not errors else 1)
except Exception as exc:
    print(f'ERROR: {exc}'); raise SystemExit(2)
