"""Shared dump writer for the isolated M5 Python runners.

Writes the same run.json + float32 depth files as scripts/m5/dump-format.ts, so
scripts/m5/score-depth.ts can judge every backend with the production mesh and
readiness code. Runners never decide validity themselves.
"""
import hashlib
import json
import os
import platform
import resource
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

PHOTO_SUFFIXES = {'.jpg', '.jpeg', '.png', '.webp'}


def photo_files(value):
    path = Path(value)
    candidates = sorted(path.iterdir()) if path.is_dir() else [path]
    return [item.resolve() for item in candidates if item.suffix.lower() in PHOTO_SUFFIXES]


def pick_device(torch, requested):
    if requested != 'auto':
        return torch.device(requested)
    return torch.device('cuda' if torch.cuda.is_available() else 'mps' if torch.backends.mps.is_available() else 'cpu')


def sync(torch, device):
    """GPU work is asynchronous; without this a timer measures queueing, not inference."""
    if device.type == 'cuda':
        torch.cuda.synchronize()
    elif device.type == 'mps':
        torch.mps.synchronize()


def device_bytes(torch, device):
    if device.type == 'cuda':
        return int(torch.cuda.max_memory_allocated())
    if device.type == 'mps':
        return int(torch.mps.driver_allocated_memory())
    return None


def _sysctl(name):
    try:
        return subprocess.run(['sysctl', '-n', name], capture_output=True, text=True, check=True).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        return None


def machine_info(torch):
    chip = _sysctl('machdep.cpu.brand_string') if sys.platform == 'darwin' else platform.processor()
    memory = _sysctl('hw.memsize') if sys.platform == 'darwin' else None
    return {'chip': chip or platform.machine(), 'cores': os.cpu_count(), 'memoryBytes': int(memory) if memory else None,
            'platform': sys.platform, 'arch': platform.machine(), 'osRelease': platform.release(),
            'python': platform.python_version(), 'torch': torch.__version__}


def git_commit():
    try:
        return subprocess.run(['git', 'rev-parse', 'HEAD'], capture_output=True, text=True, check=True).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        return None


def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b''):
            digest.update(chunk)
    return digest.hexdigest()


def peak_rss_bytes():
    peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return int(peak if sys.platform == 'darwin' else peak * 1024)


def timed(torch, device, task):
    sync(torch, device)
    started = time.perf_counter()
    result = task()
    sync(torch, device)
    return result, (time.perf_counter() - started) * 1000


class DumpWriter:
    def __init__(self, output_dir, torch, device, backend, label, model, settings, checkpoint=None, checkpoint_sha256=None, license=None):
        self.output_dir = Path(output_dir)
        self.output_dir.mkdir(parents=True, exist_ok=True)
        self.torch, self.device = torch, device
        self.peak_device = 0
        self.run = {'version': 1, 'backend': backend, 'label': label, 'model': model, 'checkpoint': checkpoint,
                    'checkpointSha256': checkpoint_sha256, 'license': license, 'device': str(device), 'settings': settings,
                    'machine': machine_info(torch), 'commit': git_commit(),
                    'createdAt': datetime.now(timezone.utc).isoformat(), 'modelLoadMs': None, 'photos': []}

    def note_memory(self):
        used = device_bytes(self.torch, self.device)
        if used is not None:
            self.peak_device = max(self.peak_device, used)

    def add(self, photo, depth, kind, inference_ms):
        """depth: (H, W) array in meters ('metric', inf = sky) or larger-is-nearer ('inverse')."""
        depth = np.ascontiguousarray(np.asarray(depth, dtype='<f4').squeeze())
        if depth.ndim != 2:
            raise ValueError(f'Expected a 2-D depth map, got shape {depth.shape}.')
        stem = Path(photo).stem
        depth.tofile(self.output_dir / f'{stem}.depth.f32')
        self.run['photos'].append({'id': stem, 'input': str(photo), 'sha256': sha256_file(photo), 'depthFile': f'{stem}.depth.f32',
                                   'width': int(depth.shape[1]), 'height': int(depth.shape[0]), 'kind': kind,
                                   'inferenceMs': [round(ms) for ms in inference_ms]})
        steady = sorted(inference_ms[1:] or inference_ms)[len(inference_ms[1:] or inference_ms) // 2]
        print(f'{stem} {steady:.0f}ms ({depth.shape[1]}x{depth.shape[0]})', flush=True)

    def finish(self, model_load_ms):
        self.run['modelLoadMs'] = round(model_load_ms)
        self.run['peakRssBytes'] = peak_rss_bytes()
        self.run['peakDeviceBytes'] = self.peak_device or None
        (self.output_dir / 'run.json').write_text(json.dumps(self.run, indent=2) + '\n')
        print(f"Wrote {len(self.run['photos'])} depth dumps to {self.output_dir} (model load {model_load_ms:.0f}ms).")
