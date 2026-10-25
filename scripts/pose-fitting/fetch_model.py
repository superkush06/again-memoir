"""Download Google's pinned Pose Landmarker data file; never execute remote code."""
from __future__ import annotations

import argparse
import hashlib
from pathlib import Path
import urllib.request

URL = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task'
SHA256 = '5134a3aad27a58b93da0088d431f366da362b44e3ccfbe3462b3827a839011b1'
HEAVY_URL = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_heavy/float16/1/pose_landmarker_heavy.task'
HEAVY_SHA256 = '64437af838a65d18e5ba7a0d39b465540069bc8aae8308de3e318aad31fcbc7b'
MAX_BYTES = 40 * 1024 * 1024


def fetch(destination: Path, url=URL, checksum=SHA256):
    if destination.exists():
        payload = destination.read_bytes()
    else:
        with urllib.request.urlopen(url, timeout=60) as response:
            payload = response.read(MAX_BYTES + 1)
    if len(payload) > MAX_BYTES or hashlib.sha256(payload).hexdigest() != checksum:
        raise ValueError('Pose model size or SHA256 does not match the pinned Google release.')
    destination.parent.mkdir(parents=True, exist_ok=True)
    if not destination.exists():
        destination.write_bytes(payload)
    print(f'{destination.name} verified: {len(payload)} bytes')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--variant', choices=['heavy', 'full'], default='heavy')
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    output = args.output or Path(f'data/models/mediapipe/pose_landmarker_{args.variant}.task')
    fetch(output, HEAVY_URL if args.variant == 'heavy' else URL, HEAVY_SHA256 if args.variant == 'heavy' else SHA256)
    fetch(output.with_name('face_landmarker.task'),
          'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
          '64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff')
