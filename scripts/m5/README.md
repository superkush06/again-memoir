# Optional M5 geometry workers

The Node app does not install these model environments. Keep them isolated so a failed or incompatible research model cannot break photo import or the default VR path.

## How a run works

1. `node scripts/m5/fetch-photo-set.mjs data/m5-photos` downloads the fixed photo set listed in [`photo-set.json`](photo-set.json) and verifies every file by SHA-256. Photos stay out of Git.
2. A runner writes a **dump**: `run.json` plus one float32 depth map per photo ([format](runner-format.md#dump-format)). Runners only produce depth and timings; they never decide validity.
3. `scripts/m5/score-depth.ts` judges any dump with the production mesh builder (`createDepthGeometry`) and the production readiness scorer (`DepthReadinessScorer`), on the same 384px mesh grid, and writes a runner-format report.
4. `npx tsx scripts/m5/render-views.ts --report ... --photos data/m5-photos --output data/m5-reports-local/review` renders every model's production mesh, textured, from the source eye and after a 0.5 m head move, in shuffled A/B columns with a separate key: a blind desktop packet to prepare the Quest review.
5. `npm run benchmark:3d:compare -- --report baseline.json --report candidate.json ...` matches photos by hash (so M3 and M5 paths may differ), evaluates the acceptance gates and, for the same model on two chips, reports the hardware speedup.

Timing excludes model load and photo decoding. Each photo runs `repeats + 1` times; the first call is reported separately (`firstCallMs`, shape warm-up) and the median of the rest is the steady-state `elapsedMs`. Python runners synchronize MPS/CUDA before and after every timed call.

## Baseline: Depth Anything V2 (production)

```bash
node scripts/m5/run-suite.mjs data/m5-photos                     # production default -> m5-da2.json
node scripts/m5/run-suite.mjs data/m5-photos --device cpu        # the previous production path -> m5-da2-cpu.json
node scripts/m5/run-suite.mjs data/m5-photos --device webgpu     # WebGPU with CPU fallback -> m5-da2-webgpu.json
node scripts/m5/run-suite.mjs data/m5-photos --device coreml     # probe, same weights -> m5-da2-probe-coreml.json
node scripts/m5/run-suite.mjs data/m5-photos --device cpu --threads 18   # probe -> m5-da2-probe-cpu-18t.json
```

With `--device auto`, `webgpu`, or `cpu` at the default 4 threads, the runner calls `sharedDepthEstimator` and `sharedRawDepthEstimator` from `server/depth-model.ts` unchanged through `DEPTH_DEVICE`, and records the device each photo actually ran on. If a fallback changes the device mid-run, the report is labelled with both devices, its `device` is `mixed`, and it is never paired for a hardware speedup. `coreml`, or `cpu` with another thread count, is a probe on the same ONNX weights; `--threads` is rejected for other devices. Report names follow the chip (`m5-…`, or the CPU model elsewhere; pass `--name` to choose), and probes never reuse a production name. On macOS the report also records the peak physical footprint, which, unlike RSS, includes GPU memory. For a hardware comparison, pin the same `--device` on both machines. `run-suite.mjs` starts its steps with `node --import tsx`, so it also works on Windows.

## Depth Pro

Apple's reference repository recommends Python 3.9. Create a dedicated environment from the official [Depth Pro repository](https://github.com/apple/ml-depth-pro), install it and download `checkpoints/depth_pro.pt` (about 1.9 GB), then:

```bash
python scripts/m5/depth_pro_runner.py --input data/m5-photos --output-dir data/m5-reports-local/dumps/depth-pro \
  --checkpoint /path/to/ml-depth-pro/checkpoints/depth_pro.pt --device auto
npx tsx scripts/m5/score-depth.ts --dump data/m5-reports-local/dumps/depth-pro --output data/m5-reports-local/depth-pro.json
```

The runner also saves a normalized preview PNG per photo. Metric depth is useful, but it is not automatically a better VR world: silhouette stability, walkable surfaces, and absence of stretched foreground matter more.

## MoGe

```bash
# MoGe-3: Linux/CUDA only (FlexGEMM/Triton has no macOS wheels)
python scripts/m5/moge_runner.py --input data/m5-photos --output-dir data/m5-reports-local/dumps/moge3 --checkpoint Ruicheng/moge-3-vitl
# MoGe-2: pure PyTorch, runs on MPS. fp16 autocast currently fails on MPS (Half input vs float bias), so pass --fp32 there.
python scripts/m5/moge_runner.py --input data/m5-photos --output-dir data/m5-reports-local/dumps/moge2 --checkpoint Ruicheng/moge-2-vitl-normal --model-version v2 --device mps --fp32
```

## VGGT

```bash
python scripts/m5/vggt_runner.py --input data/m5-photos --output-dir data/m5-reports-local/dumps/vggt \
  --checkpoint facebook/VGGT-1B-Commercial --license "VGGT-1B-Commercial license"
```

VGGT is the multi-image candidate; the wrapper runs one-image cases for apples-to-apples depth tests, while the same model can later be run on a folder to evaluate camera/point-map reconstruction. The commercial checkpoint is gated on Hugging Face; record the exact checkpoint and license with `--license`.

Score every dump with `score-depth.ts` as above, then compare with the production baseline first:

```bash
npm run benchmark:3d:compare -- --report data/m5-reports-local/m5-da2.json \
  --report data/m5-reports-local/depth-pro.json --report data/m5-reports-local/vggt.json --output data/m5-reports-local/comparison.json
```
