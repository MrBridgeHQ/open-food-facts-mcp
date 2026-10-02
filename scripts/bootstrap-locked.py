#!/usr/bin/env python3
"""Materialize pinned npm archives into a new node_modules without cleanup."""
import argparse
import base64
import hashlib
import io
import json
import tarfile
import urllib.parse
import urllib.request
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[1])
parser.add_argument('--cache-root', type=Path, help='Read existing npm SHA512 content cache; no network')
args = parser.parse_args()
ROOT = args.root.resolve()
MODULES = ROOT / 'node_modules'
MAX_TARBALL = 30_000_000
MAX_UNPACKED = 100_000_000

def parts(value):
    if not value or '\\' in value or '\x00' in value or value.startswith('/'):
        raise ValueError(f'unsafe path: {value!r}')
    result = value.rstrip('/').split('/')
    if any(p in ('', '.', '..') or ':' in p for p in result):
        raise ValueError(f'unsafe path: {value!r}')
    return result

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        raise ValueError(f'redirect refused: {newurl!r}')

def tarball(meta):
    url = meta.get('resolved', '')
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme != 'https' or parsed.hostname != 'registry.npmjs.org' or parsed.username or parsed.password or parsed.port not in (None, 443) or parsed.query or parsed.fragment:
        raise ValueError(f'non-registry tarball: {url!r}')
    hashes = [base64.b64decode(x[7:], validate=True) for x in meta.get('integrity', '').split() if x.startswith('sha512-')]
    if not hashes or any(len(h) != 64 for h in hashes):
        raise ValueError(f'missing or invalid SHA512: {url!r}')
    if args.cache_root:
        digest = hashes[0].hex()
        cache_file = args.cache_root / digest[:2] / digest[2:4] / digest[4:]
        with cache_file.open('rb') as handle:
            data = handle.read(MAX_TARBALL + 1)
    else:
        with urllib.request.build_opener(NoRedirect).open(url, timeout=30) as response:
            data = response.read(MAX_TARBALL + 1)
    if len(data) > MAX_TARBALL:
        raise ValueError(f'tarball too large: {url!r}')
    if hashlib.sha512(data).digest() not in hashes:
        raise ValueError(f'SHA512 mismatch: {url!r}')
    return data

def unpack(data, package_dir):
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
        entries = archive.getmembers()
        if len(entries) > 10000:
            raise ValueError('too many tar members')
        seen, roots, checked, size = set(), set(), [], 0
        for entry in entries:
            name = parts(entry.name)
            roots.add(name[0])
            rel = tuple(name[1:])
            if not (entry.isfile() or entry.isdir()) or (entry.isfile() and not rel):
                raise ValueError(f'unsafe tar member: {entry.name!r}')
            if rel in seen:
                raise ValueError(f'duplicate tar member: {entry.name!r}')
            seen.add(rel)
            size += entry.size
            if size > MAX_UNPACKED:
                raise ValueError('unpacked package too large')
            checked.append((entry, rel))
        if len(roots) != 1:
            raise ValueError('archive must have one top-level directory')
        package_dir.mkdir(parents=True, exist_ok=True)
        for entry, rel in checked:
            dest = package_dir.joinpath(*rel)
            if entry.isdir():
                dest.mkdir(parents=True, exist_ok=True)
            else:
                dest.parent.mkdir(parents=True, exist_ok=True)
                source = archive.extractfile(entry)
                if source is None:
                    raise ValueError(f'unreadable member: {entry.name!r}')
                with source, dest.open('xb') as out:
                    while chunk := source.read(1_048_576):
                        out.write(chunk)
                if entry.mode & 0o111:
                    dest.chmod(dest.stat().st_mode | 0o111)

if MODULES.exists() or MODULES.is_symlink():
    raise SystemExit('node_modules already exists; refusing to modify it')
lock = json.loads((ROOT / 'package-lock.json').read_text())
if lock.get('lockfileVersion') != 3:
    raise SystemExit('package-lock v3 required')
packages = [(path, meta) for path, meta in lock.get('packages', {}).items() if path]
for path, meta in packages:
    name = parts(path)
    if name[0] != 'node_modules' or meta.get('link'):
        raise ValueError(f'unsupported package path: {path!r}')
for path, meta in packages:
    unpack(tarball(meta), ROOT.joinpath(*parts(path)))
print(json.dumps({'installed_packages': len(packages), 'source': 'existing npm cache' if args.cache_root else 'npm registry', 'create_only': True}))
