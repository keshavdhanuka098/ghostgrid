#!/usr/bin/env python3
"""CLI wrapper: python scripts/safe_extract.py archive.zip new_dir [--max-files N] [--max-total-bytes N]"""
import runpy, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
runpy.run_module('ml.safe_extract', run_name='__main__')
