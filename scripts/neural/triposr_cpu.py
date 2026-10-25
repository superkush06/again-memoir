"""Run the official TripoSR weights locally on CPU and export a review-only GLB.

The sole numerical compatibility adapter replaces torchmcubes' native extraction
with scikit-image marching cubes. The pretrained architecture is unchanged.
Generated results are candidates for visual review, never auto-activated.
"""

import argparse
import gc
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import types

sys.dont_write_bytecode = True


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--image", required=True)
    parser.add_argument("--crop", nargs=4, type=float, metavar=("TOP", "LEFT", "BOTTOM", "RIGHT"))
    parser.add_argument("--repo", default=".local/TripoSR")
    parser.add_argument("--model", default=".local/models/triposr")
    parser.add_argument("--output", default=".local/neural-trial")
    parser.add_argument("--resolution", type=int, default=128)
    parser.add_argument("--chunk-size", type=int, default=4096)
    parser.add_argument("--threads", type=int, default=4)
    parser.add_argument("--reuse", action="store_true", help="Re-export cached scene-code.npy and person.glb without repeating inference")
    parser.add_argument("--scene-code", help="Extract a new mesh from this saved triplane without repeating image inference")
    args = parser.parse_args()
    if args.reuse and args.scene_code:
        parser.error("Choose --reuse for the existing mesh or --scene-code for a new extraction.")
    output = Path(args.output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    os.environ["HF_HOME"] = str(Path(".local/model-cache").resolve())
    os.environ["OMP_NUM_THREADS"] = str(args.threads)
    os.environ["MKL_NUM_THREADS"] = str(args.threads)
    # rembg is imported by upstream utilities but not used for this already
    # prepared input. Avoid compiling its unrelated matting functions on import.
    os.environ["NUMBA_DISABLE_JIT"] = "1"
    import numpy as np
    import psutil
    import torch
    from PIL import Image
    from skimage.measure import marching_cubes
    from omegaconf import OmegaConf
    from colored_glb import export_colored_glb

    torch.set_num_threads(args.threads)
    torch.set_num_interop_threads(1)
    torch.manual_seed(0)
    diagnostics = {
        "status": "running", "provider": "TripoSR", "device": "cpu",
        "sourceImage": str(Path(args.image).resolve()), "crop": args.crop,
        "sourceSha256": hashlib.sha256(Path(args.image).read_bytes()).hexdigest(),
        "checkpoint": "stabilityai/TripoSR/model.ckpt", "license": "MIT",
        "repository": "https://github.com/VAST-AI-Research/TripoSR",
        "revision": subprocess.check_output(["git", "-C", args.repo, "rev-parse", "HEAD"], text=True).strip(),
        "torch": torch.__version__, "threads": args.threads,
        "resolution": args.resolution, "queryChunkSize": args.chunk_size,
        "compatibility": "scikit-image marching cubes replaces native torchmcubes only; no model architecture or checkpoint changes",
        "inputCaveat": "The input is an inferred full-body atlas crop, not a directly captured complete human body.",
        "rendering": "Pretrained triplane RGB decoded to vertex colors; not PBR, SDS, or a trained scene scan.",
        "upAxis": "z", "frontYaw": -1.5707963267948966,
        "orientationBasis": "Official azimuth-zero camera is at +X with +Z up; frontYaw follows an X rotation of -pi/2.",
        "approvedForApp": False, "stages": [],
    }
    if args.scene_code:
        diagnostics["cachedTriplane"] = str(Path(args.scene_code).resolve())
    if args.reuse and (output / "diagnostics.json").exists():
        diagnostics["originalRun"] = json.loads((output / "diagnostics.json").read_text(encoding="utf-8"))

    def record(stage):
        process = psutil.Process()
        event = {"stage": stage, "elapsedSeconds": round(time.monotonic() - started, 2),
                 "rssMB": round(process.memory_info().rss / 1024**2, 1),
                 "availableRAMMB": round(psutil.virtual_memory().available / 1024**2, 1)}
        diagnostics["stages"].append(event)
        (output / "diagnostics.json").write_text(json.dumps(diagnostics, indent=2), encoding="utf-8")
        print(json.dumps(event), flush=True)

    # torchmcubes returns reverse-order axes; the upstream MarchingCubeHelper
    # reverses them back. Match that API so it sees the same world-axis order.
    def cpu_marching_cubes(level, threshold):
        vertices, faces, _, _ = marching_cubes(level.detach().cpu().numpy(), level=threshold)
        return (torch.from_numpy(vertices[:, [2, 1, 0]].copy()),
                torch.from_numpy(faces.astype(np.int64).copy()))

    adapter = types.ModuleType("torchmcubes")
    adapter.marching_cubes = cpu_marching_cubes
    sys.modules["torchmcubes"] = adapter
    sys.path.insert(0, str(Path(args.repo).resolve()))
    from tsr.system import TSR

    try:
        photo = Image.open(args.image).convert("RGB")
        if args.crop:
            top, left, bottom, right = args.crop
            if not (0 <= top < bottom <= 1 and 0 <= left < right <= 1):
                raise ValueError("Crop must be normalized [top,left,bottom,right].")
            photo = photo.crop((round(left * photo.width), round(top * photo.height),
                                round(right * photo.width), round(bottom * photo.height)))
        # Preserve the entire person and aspect ratio; input padding is model
        # preprocessing, and never changes the original or served texture.
        padding_color = tuple(int(v) for v in np.median(np.asarray(photo)[0], axis=0))
        side = round(max(photo.size) / 0.85)
        prepared = Image.new("RGB", (side, side), padding_color)
        prepared.paste(photo, ((side - photo.width) // 2, (side - photo.height) // 2))
        prepared.save(output / "input.png")
        record("input_prepared")
        config = OmegaConf.load(Path(args.model) / "config.yaml")
        OmegaConf.resolve(config)
        record("initializing_model")
        # Avoid holding random initialized weights and the 1.68GB checkpoint
        # simultaneously on this 12GB Windows machine. This changes allocation,
        # not the model's layers, parameters, or learned values.
        with torch.device("meta"):
            model = TSR(config)
        checkpoint = torch.load(Path(args.model) / "model.ckpt", map_location="cpu", weights_only=True, mmap=True)
        model.load_state_dict(checkpoint, assign=True)
        # These two upstream constants are nonpersistent buffers, so they are
        # intentionally absent from the checkpoint and must be materialized.
        model.image_tokenizer.image_mean = torch.tensor([0.485, 0.456, 0.406]).reshape(1, 1, 3, 1, 1)
        model.image_tokenizer.image_std = torch.tensor([0.229, 0.224, 0.225]).reshape(1, 1, 3, 1, 1)
        if any(t.device.type == "meta" for t in list(model.parameters()) + list(model.buffers())):
            raise RuntimeError("Model contains an unmaterialized tensor; refusing partial inference.")
        del checkpoint
        gc.collect()
        model.eval()
        model.renderer.set_chunk_size(args.chunk_size)
        record("model_loaded")
        with torch.inference_mode():
            if args.reuse or args.scene_code:
                import trimesh
                scene_codes = torch.from_numpy(np.load(args.scene_code or output / "scene-code.npy"))
                if args.reuse:
                    mesh = trimesh.load(output / "person.glb", force="mesh", process=False)
            else:
                scene_codes = model([prepared], device="cpu")
            record("cached_triplane_loaded" if args.reuse or args.scene_code else "triplane_predicted")
            if not args.reuse:
                meshes = model.extract_mesh(scene_codes, has_vertex_color=True, resolution=args.resolution)
                mesh = meshes[0]
            # Correct triangle winding from the alternate extraction backend.
            mesh.fix_normals()
            record("colored_mesh_extracted")
            # Query the learned color field directly to avoid Trimesh's uint8
            # sRGB color quantization, then store FLOAT linear RGB per glTF spec.
            raw_colors = model.renderer.query_triplane(model.decoder,
                torch.as_tensor(np.asarray(mesh.vertices).copy(), dtype=torch.float32), scene_codes[0])["color"].cpu().numpy()
            diagnostics.update(export_colored_glb(mesh, raw_colors, output / "person.glb"))
            np.save(output / "scene-code.npy", scene_codes.cpu().numpy())
        diagnostics.update({"status": "completed", "vertices": len(mesh.vertices),
                            "faces": len(mesh.faces), "bounds": mesh.bounds.tolist(),
                            "watertight": bool(mesh.is_watertight),
                            "glb": str(output / "person.glb")})
        record("glb_exported_for_review")
    except Exception as error:
        diagnostics.update({"status": "failed", "error": f"{type(error).__name__}: {error}"})
        record("failed")
        raise


if __name__ == "__main__":
    main()
