#!/usr/bin/env python3
"""Create auditable metadata for a validated dataset and add it to the manifest."""
import argparse, hashlib, json, sys
from datetime import datetime, timezone
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from ml.dataset import load_records, validate_records
p=argparse.ArgumentParser(description='Register dataset metadata after validating the source file')
p.add_argument('file'); p.add_argument('--name',required=True); p.add_argument('--version',required=True); p.add_argument('--description',required=True); p.add_argument('--source',required=True); p.add_argument('--license',required=True); p.add_argument('--schema-version',default='1.0'); p.add_argument('--root',default='datasets'); p.add_argument('--allowed-labels')
a=p.parse_args(); source=Path(a.file); rows=load_records(source)
labels=set(a.allowed_labels.split(',')) if a.allowed_labels else None
errors=validate_records(rows, allowed_labels=labels)
if errors: raise SystemExit('Dataset validation failed:\n'+'\n'.join(errors))
digest=hashlib.sha256(source.read_bytes()).hexdigest(); root=Path(a.root); meta_dir=root/'manifests'/'metadata'; meta_dir.mkdir(parents=True,exist_ok=True)
slug=''.join(c.lower() if c.isalnum() else '-' for c in a.name).strip('-')
metadata={'name':a.name,'version':a.version,'description':a.description,'source':a.source,'license':a.license,'created_at':datetime.now(timezone.utc).isoformat(),'schema_version':a.schema_version,'record_count':len(rows),'format':source.suffix.lower().lstrip('.'),'target_labels':sorted({str(r['target']) for r in rows if 'target' in r}),'splits':None,'sha256':digest,'file':str(source)}
meta_path=meta_dir/f'{slug}-{a.version}.json'
if meta_path.exists(): raise SystemExit(f'Refusing to overwrite existing metadata: {meta_path}')
meta_path.write_text(json.dumps(metadata,indent=2),encoding='utf-8')
manifest_path=root/'manifests'/'datasets.json'; manifest=json.loads(manifest_path.read_text(encoding='utf-8')) if manifest_path.exists() else {'manifest_version':'1.0','datasets':[]}
manifest['datasets'].append({'name':a.name,'version':a.version,'metadata_file':str(meta_path),'sha256':digest})
manifest_path.write_text(json.dumps(manifest,indent=2),encoding='utf-8')
print(f'Registered {len(rows)} records: {meta_path}')
