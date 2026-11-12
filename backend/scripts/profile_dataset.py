#!/usr/bin/env python3
import json, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from ml.profile import profile
try:
    print(json.dumps(profile(sys.argv[1])))
except Exception as exc:
    print(json.dumps({'error': str(exc)})); sys.exit(2)
