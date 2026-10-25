"""Fetch public MediaPipe data, checking exact bytes before use."""
import hashlib
from pathlib import Path
import urllib.request


ASSETS = {
    'face_landmarker.task': (
        'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
        '64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff',
    ),
    'canonical_face_model.obj': (
        'https://raw.githubusercontent.com/google-ai-edge/mediapipe/master/mediapipe/modules/face_geometry/data/canonical_face_model.obj',
        '8bac80443397e113f41a8b565ea72c59390bc031d9defab289dba7bc0c54e618',
    ),
}


def main():
    folder = Path('.local/face-fitting')
    folder.mkdir(parents=True, exist_ok=True)
    for name, (url, checksum) in ASSETS.items():
        path = folder / name
        payload = path.read_bytes() if path.exists() else urllib.request.urlopen(url, timeout=60).read()
        actual = hashlib.sha256(payload).hexdigest()
        if actual != checksum:
            raise ValueError(f'{name} checksum mismatch: {actual}')
        if not path.exists():
            path.write_bytes(payload)
        print(f'{name}: verified {len(payload)} bytes')


if __name__ == '__main__':
    main()
