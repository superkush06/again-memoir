# M5 3D benchmark lane

Measured results, run status and the exact commands for the remaining runs: [m5-results.md](m5-results.md).

Branch: `m5-3d-geometry-benchmark`

The production default remains Depth Anything V2. This branch adds a safe comparison lane so an M5 can test a stronger single-image backend without changing the fast path or forcing CUDA-only dependencies into the app.

## Checks

```bash
npm run typecheck
npm run test:3d
npm run test:3d:simulate
npm run test:3d:full-simulate
npm run test:3d:live
npm run benchmark:3d -- --input ./path/to/photos --output ./data/m3-depth-report.json
```

Run that exact command on the M3 and M5, changing only the output filename. The report records per-photo latency, finite-depth validity, depth statistics, mesh vertex count, and triangle count. Keep the photo folder and model revision identical between machines.

Start the app first for the live check:

```bash
npm run dev
LIVE_3D_BASE_URL=http://127.0.0.1:8787 npm run test:3d:live
LIVE_3D_BASE_URL=http://127.0.0.1:8787 LIVE_3D_MEMORY_ID=<id> npm run test:3d:live
```

## M5 comparison rule

Run the same photo set through the current backend and one candidate backend (Depth Pro, MoGe, or VGGT). Compare:

- valid finite depth output;
- mesh triangle count and discarded edge vertices;
- readiness score and reasons;
- wall-clock time and peak memory;
- subjective VR walk-through quality on the same Quest scene.

The candidate should only replace the default if it improves geometry validity and VR quality enough to justify its latency. A larger depth range alone is not a better world: it can also mean foreground stretching or unstable silhouettes.

This contract intentionally supports an external M5 runner. The runner can live in a separate Python environment and report results into this branch without adding heavyweight model packages to the browser/server install.

## Candidate suite

The exact report format, fixed-photo requirements, and acceptance gates are in [`scripts/m5/runner-format.md`](../scripts/m5/runner-format.md). The suite includes Depth Pro, MoGe, and VGGT as isolated candidates. Use `node scripts/m5/run-suite.mjs /path/to/fixed-photo-set` to generate the current baseline report, then run each model's isolated adapter and compare:

```bash
npm run benchmark:3d:compare -- \
  --report data/m5-reports/depth-anything-v2.json \
  --report data/m5-reports/depth-pro.json \
  --report data/m5-reports/moge.json \
  --report data/m5-reports/vggt.json \
  --output data/m5-reports/comparison.json
```

Depth Pro is the first direct single-image candidate. MoGe provides metric depth, point maps, normals, and camera FOV in one pass, but the current MoGe-3 upstream notes that macOS is unsupported because of its Triton/FlexGEMM dependency; use it only on a Linux/CUDA worker. VGGT is the multi-image/point-map candidate and can also run single-view tests, but its checkpoint/license choice must be recorded in the report. See the official [Depth Pro](https://github.com/apple-aiml-research/ml-depth-pro), [MoGe](https://github.com/microsoft/MoGe), and [VGGT](https://github.com/facebookresearch/vggt) repositories before installing.

## Additional high-compute tracks

- [VGGT-Ω](https://github.com/facebookresearch/vggt-omega): multi-photo cameras, point maps, and more consistent event geometry. Checkpoint access is gated.
- [SAM 3D Body](https://github.com/facebookresearch/sam-3d-body): higher-quality full-body people, hands, feet, and occlusion handling. This is a person subsystem, not a room-depth replacement.
- [HunyuanWorld](https://github.com/Tencent-Hunyuan/HunyuanWorld-1.0): semantic world completion around an anchor photo. Judge it on spatial plausibility and walkable openness, not pixel accuracy.
- [Hunyuan3D-2](https://github.com/Tencent-Hunyuan/Hunyuan3D-2): selected object/prop meshes and textures. Do not use it to generate the entire memory world.
- [COLMAP](https://github.com/colmap/colmap) plus [gsplat](https://github.com/nerfstudio-project/nerfstudio): the quality ceiling when an album contains genuinely overlapping views; not a replacement for single-photo inference.

Recommended order: VGGT-Ω and SAM 3D Body first, HunyuanWorld second, Hunyuan3D for props, and COLMAP/gsplat only for albums with enough overlap. The branch now names these tracks in the backend contract, but they should remain separate benchmark lanes until their adapters and licenses are verified.

