#!/usr/bin/env python3
"""MoGe adapter, as a shared M5 dump. Run in the isolated MoGe environment.

MoGe-3 (--model-version v3, the default) needs Linux/CUDA: its FlexGEMM/Triton
dependency has no macOS wheels. MoGe-2 (v2) is pure PyTorch and can run on MPS.
"""
import argparse
import sys

import numpy as np
from PIL import Image
import torch
from moge.model import import_model_class_by_version

from dump_format import DumpWriter, photo_files, pick_device, timed


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('--input', required=True, help='a photo or the fixed photo folder')
    parser.add_argument('--output-dir', required=True)
    parser.add_argument('--checkpoint', required=True, help='Hugging Face id or local path, e.g. Ruicheng/moge-2-vitl-normal')
    parser.add_argument('--model-version', default='v3', choices=('v2', 'v3'))
    parser.add_argument('--device', default='auto', choices=('auto', 'cpu', 'mps', 'cuda'))
    parser.add_argument('--fp32', action='store_true', help='disable MoGe\'s default fp16 autocast')
    parser.add_argument('--repeats', type=int, default=3)
    args = parser.parse_args()
    device = pick_device(torch, args.device)
    if args.model_version == 'v3' and (device.type == 'mps' or sys.platform == 'darwin'):
        raise RuntimeError('MoGe-3 is not supported on macOS/MPS by the upstream project; use a Linux/CUDA worker (MoGe-2 runs with --model-version v2).')
    photos = photo_files(args.input)
    writer = DumpWriter(args.output_dir, torch, device, 'moge', f'moge-{args.model_version} {args.checkpoint.split("/")[-1]} ({device.type}{", fp32" if args.fp32 else ", fp16"})',
                        f'microsoft/MoGe {args.model_version}', {'repeats': args.repeats, 'fp16': not args.fp32, 'resolutionLevel': 9, 'input': 'full photo'},
                        checkpoint=args.checkpoint, license='MoGe: MIT code; see the checkpoint card for weight terms')
    # Decoding stays outside the timer.
    images = [torch.from_numpy(np.asarray(Image.open(photo).convert('RGB'), dtype=np.float32) / 255.0).permute(2, 0, 1) for photo in photos]

    model, load_ms = timed(torch, device, lambda: import_model_class_by_version(args.model_version).from_pretrained(args.checkpoint).to(device).eval())

    def infer(image):
        # Masked pixels (sky) come back as +inf: a valid far plane, inverse depth 0.
        return model.infer(image.to(device), use_fp16=not args.fp32)['depth'].detach().float().cpu().numpy()

    with torch.inference_mode():
        _, warm_ms = timed(torch, device, lambda: infer(images[0]))
        for photo, image in zip(photos, images):
            samples = []
            for _ in range(args.repeats + 1):
                depth, ms = timed(torch, device, lambda: infer(image))
                samples.append(ms)
                writer.note_memory()
            writer.add(photo, depth, 'metric', samples)
    writer.finish(load_ms + warm_ms)


if __name__ == '__main__':
    main()
