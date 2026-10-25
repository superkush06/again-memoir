"""Fetch hash-pinned CC0 template assets; uses official byte-range ZIP entries."""
import hashlib
import json
from pathlib import Path
import sys
sys.dont_write_bytecode = True
import urllib.request
import zipfile
from fetch_range_assets import RemoteZip

root = Path('.local/body-templates').resolve()
manifest = json.loads(Path(__file__).with_name('assets.json').read_text())
archives = {}
try:
    for asset in manifest['assets']:
        target = (root / asset['path']).resolve()
        if not target.is_relative_to(root):
            raise ValueError('Asset path escapes template directory')
        if target.is_file() and hashlib.sha256(target.read_bytes()).hexdigest() == asset['sha256']:
            print('Verified', asset['path'], flush=True)
            continue
        if 'entry' in asset:
            if asset['url'] not in archives:
                archives[asset['url']] = zipfile.ZipFile(RemoteZip(asset['url']))
            data = archives[asset['url']].read(asset['entry'])
        else:
            with urllib.request.urlopen(asset['url'], timeout=45) as response:
                data = response.read()
        if hashlib.sha256(data).hexdigest() != asset['sha256']:
            raise ValueError('Downloaded data changed: ' + asset['path'])
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = target.with_suffix(target.suffix+'.partial')
        temporary.write_bytes(data)
        temporary.replace(target)
        print('Fetched', asset['path'], flush=True)
finally:
    for archive in archives.values():
        archive.close()
