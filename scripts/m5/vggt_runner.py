#!/usr/bin/env python3
"""VGGT adapter: single-photo depth on the fixed photo set, as a shared M5 dump.

The same model can later run a whole event folder for camera/point-map consistency;
that is a separate track and is not scored in the single-image winner column.
"""
import argparse

import torch
from vggt.models.vggt import VGGT
from vggt.utils.load_fn import load_and_preprocess_images

from dump_format import DumpWriter, photo_files, pick_device, timed


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('--input', required=True, help='a photo or the fixed photo folder')
    parser.add_argument('--output-dir', required=True)
    parser.add_argument('--checkpoint', default='facebook/VGGT-1B-Commercial')
    parser.add_argument('--license', default='record the checkpoint license here', help='e.g. "VGGT-1B-Commercial license" or "CC BY-NC 4.0 (VGGT-1B, evaluation only)"')
    parser.add_argument('--device', default='auto', choices=('auto', 'cpu', 'mps', 'cuda'))
    parser.add_argument('--repeats', type=int, default=3)
    args = parser.parse_args()
    device = pick_device(torch, args.device)
    photos = photo_files(args.input)
    writer = DumpWriter(args.output_dir, torch, device, 'vggt', f'vggt ({device.type}, single-view)', 'facebook/vggt',
                        {'repeats': args.repeats, 'mode': 'single-view', 'input': 'load_and_preprocess_images (518 wide)'},
                        checkpoint=args.checkpoint, license=args.license)
    # Decoding and resizing stay outside the timer; the model call is what is measured.
    images = [load_and_preprocess_images([str(photo)]) for photo in photos]

    model, load_ms = timed(torch, device, lambda: VGGT.from_pretrained(args.checkpoint).to(device).eval())

    def infer(batch):
        return model(batch.to(device))['depth'].detach().float().cpu().numpy().squeeze()

    with torch.inference_mode():
        _, warm_ms = timed(torch, device, lambda: infer(images[0]))
        for photo, batch in zip(photos, images):
            samples = []
            for _ in range(args.repeats + 1):
                depth, ms = timed(torch, device, lambda: infer(batch))
                samples.append(ms)
                writer.note_memory()
            # VGGT depth is distance-like (larger is farther, scene-normalized scale), so it is stored as 'metric'.
            writer.add(photo, depth, 'metric', samples)
    writer.finish(load_ms + warm_ms)


if __name__ == '__main__':
    main()
