"""Hardened ZIP extraction for downloaded third-party datasets (standard library only).

Every entry is checked *before* anything is written: no absolute paths, no ``..`` segments, no symlinks, no
device files, only allow-listed extensions, bounded file count, bounded declared and actual uncompressed size, and a
bounded compression ratio (zip bombs). The destination must not already exist, so an import can never overwrite data.
"""
from __future__ import annotations
import re, stat, zipfile
from pathlib import Path, PurePosixPath
from typing import Any

DATA_EXTENSIONS = {'.json', '.jsonl', '.ndjson', '.csv'}
DOC_EXTENSIONS = {'.md', '.txt', '.pdf'}  # licence/readme material is useful provenance; never executed
DEFAULT_ALLOWED = DATA_EXTENSIONS | DOC_EXTENSIONS
SAFE_NAME = re.compile(r'[^A-Za-z0-9._-]+')

class UnsafeArchive(ValueError):
    pass

def _flat_name(parts: tuple[str, ...]) -> str:
    """Flattens a nested archive path into one safe file name (data/train.csv -> data__train.csv)."""
    name = '__'.join(SAFE_NAME.sub('_', p) for p in parts).lstrip('.')
    if not name: raise UnsafeArchive('Archive entry has an empty name')
    return name[:180]

def inspect_zip(archive: str | Path, *, allowed: set[str] | None = None, max_files: int = 200,
                max_total_bytes: int = 1024**3, max_ratio: float = 200.0) -> list[tuple[zipfile.ZipInfo, str]]:
    allowed = allowed or DEFAULT_ALLOWED
    try:
        zf = zipfile.ZipFile(archive)
    except zipfile.BadZipFile as exc:
        raise UnsafeArchive(f'Not a valid ZIP archive: {exc}') from exc
    with zf:
        infos = [i for i in zf.infolist() if not i.is_dir()]
        if len(infos) > max_files: raise UnsafeArchive(f'Archive has {len(infos)} files; the limit is {max_files}')
        total = 0; plan: list[tuple[zipfile.ZipInfo, str]] = []; seen: set[str] = set()
        for info in infos:
            raw = info.filename
            if '\x00' in raw or '\\' in raw: raise UnsafeArchive(f'Unsafe entry name: {raw!r}')
            posix = PurePosixPath(raw)
            if posix.is_absolute() or re.match(r'^[A-Za-z]:', raw): raise UnsafeArchive(f'Absolute path in archive: {raw!r}')
            if any(part in ('..', '') for part in posix.parts): raise UnsafeArchive(f'Path traversal in archive: {raw!r}')
            mode = info.external_attr >> 16
            if mode and (stat.S_ISLNK(mode) or stat.S_ISCHR(mode) or stat.S_ISBLK(mode) or stat.S_ISFIFO(mode) or stat.S_ISSOCK(mode)):
                raise UnsafeArchive(f'Links and special files are not allowed: {raw!r}')
            if info.flag_bits & 0x1: raise UnsafeArchive(f'Encrypted entries are not supported: {raw!r}')
            ext = posix.suffix.lower()
            if ext not in allowed: raise UnsafeArchive(f'File type {ext or "(none)"} is not allowed: {raw!r}')
            if info.file_size and info.compress_size and info.file_size / max(info.compress_size, 1) > max_ratio:
                raise UnsafeArchive(f'Suspicious compression ratio for {raw!r}')
            total += info.file_size
            if total > max_total_bytes: raise UnsafeArchive(f'Archive expands to more than {max_total_bytes} bytes')
            flat = _flat_name(posix.parts)
            if flat.lower() in seen: raise UnsafeArchive(f'Two archive entries would collide as {flat!r}')
            seen.add(flat.lower()); plan.append((info, flat))
        return plan

def safe_extract(archive: str | Path, dest: str | Path, **limits: Any) -> dict[str, Any]:
    """Extracts into a NEW directory (refuses to reuse an existing one). Returns the files written."""
    dest = Path(dest)
    plan = inspect_zip(archive, **limits)
    max_total = limits.get('max_total_bytes', 1024**3)
    dest.mkdir(parents=True, exist_ok=False)  # exist_ok=False is the no-overwrite guarantee
    written: list[dict[str, Any]] = []; total = 0
    try:
        with zipfile.ZipFile(archive) as zf:
            for info, flat in plan:
                target = dest / flat
                if target.resolve().parent != dest.resolve(): raise UnsafeArchive(f'Entry escapes destination: {info.filename!r}')
                size = 0
                with zf.open(info) as src, open(target, 'xb') as out:  # 'x': never overwrite
                    while chunk := src.read(1024 * 1024):
                        size += len(chunk); total += len(chunk)
                        if total > max_total: raise UnsafeArchive('Archive expanded beyond the allowed size while extracting')
                        out.write(chunk)
                written.append({'name': flat, 'source': info.filename, 'bytes': size})
    except Exception:
        # Remove only what this call created.
        for item in written: (dest / item['name']).unlink(missing_ok=True)
        for leftover in dest.glob('*'): leftover.unlink(missing_ok=True)
        dest.rmdir()
        raise
    return {'destination': str(dest), 'files': written, 'total_bytes': total}

if __name__ == '__main__':
    import argparse, json, sys
    p = argparse.ArgumentParser(description='Safely extract a dataset ZIP into a new directory')
    p.add_argument('archive'); p.add_argument('dest')
    p.add_argument('--max-files', type=int, default=200); p.add_argument('--max-total-bytes', type=int, default=1024**3)
    a = p.parse_args()
    try:
        print(json.dumps(safe_extract(a.archive, a.dest, max_files=a.max_files, max_total_bytes=a.max_total_bytes)))
    except (UnsafeArchive, OSError) as exc:
        print(json.dumps({'error': str(exc)})); sys.exit(3)
