#!/usr/bin/env python3
"""Optional Depth Pro adapter for the M5 benchmark lane.

Runs one photo or the fixed photo folder and writes the shared M5 dump
(scripts/m5/dump_format.py) plus a normalized preview PNG per photo. The Node app
does not import Python or Depth Pro; scripts/m5/score-depth.ts judges the dump
with the production mesh and readiness code before anything is promoted.
"""
import argparse
import dataclasses

import numpy as np
from PIL import Image
import torch
import depth_pro
from depth_pro.depth_pro import DEFAULT_MONODEPTH_CONFIG_DICT

from dump_format import DumpWriter, photo_files, pick_device, sha256_file, timed


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True, help="a photo or the fixed photo folder")
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--checkpoint", default="checkpoints/depth_pro.pt")
    parser.add_argument("--device", default="auto", choices=("auto", "cpu", "mps", "cuda"))
    parser.add_argument("--precision", default="fp32", choices=("fp32", "fp16"))
    parser.add_argument("--repeats", type=int, default=3)
    args = parser.parse_args()
    device = pick_device(torch, args.device)
    precision = torch.half if args.precision == "fp16" else torch.float32
    config = dataclasses.replace(DEFAULT_MONODEPTH_CONFIG_DICT, checkpoint_uri=args.checkpoint)
    photos = photo_files(args.input)
    writer = DumpWriter(args.output_dir, torch, device, "depth-pro", f"depth-pro ({device.type}, {args.precision})", "apple/ml-depth-pro",
                        {"precision": args.precision, "repeats": args.repeats, "input": "full photo (model resizes to 1536)"},
                        checkpoint=args.checkpoint, checkpoint_sha256=sha256_file(args.checkpoint), license="Apple ml-depth-pro LICENSE (research/sample code terms)")
    loaded = [depth_pro.load_rgb(str(photo)) for photo in photos]  # decoding stays outside the timer

    (model, transform), load_ms = timed(torch, device, lambda: depth_pro.create_model_and_transforms(config=config, device=device, precision=precision))
    model.eval()

    def infer(item):
        image, _, focal_length_px = item
        prediction = model.infer(transform(image), f_px=focal_length_px)
        return prediction["depth"].detach().float().cpu().numpy()

    with torch.no_grad():
        _, warm_ms = timed(torch, device, lambda: infer(loaded[0]))
        for photo, item in zip(photos, loaded):
            samples = []
            for _ in range(args.repeats + 1):
                depth, ms = timed(torch, device, lambda: infer(item))
                samples.append(ms)
                writer.note_memory()
            if not np.isfinite(depth).any():
                raise RuntimeError(f"Depth Pro returned no finite depth for {photo.name}.")
            writer.add(photo, depth, "metric", samples)
            finite = depth[np.isfinite(depth)]
            normalized = np.clip((depth - finite.min()) / max(float(finite.max() - finite.min()), np.finfo(np.float32).eps), 0.0, 1.0)
            Image.fromarray((np.nan_to_num(normalized) * 255).astype(np.uint8), mode="L").save(writer.output_dir / f"{photo.stem}-depth-pro.png")
    writer.finish(load_ms + warm_ms)


if __name__ == "__main__":
    main()
