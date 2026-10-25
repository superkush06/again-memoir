# M5 geometry benchmark results

> [!IMPORTANT]
> **The M3 run (run A) was NOT done.** No M3 was available, and that run was dropped. Every number in this document comes from **one Apple M5 Pro**. There is **no measured M3-to-M5 hardware speedup** anywhere here: the "before" figures are the previous CPU code path *on the same M5*, not an M3. [How to run the M3 comparison](#if-you-want-the-m3-comparison-later) if it is ever needed.

October 24, 2026, following [the M5 handoff](m5-claude-handoff.md). Measured with the machine on AC power at load average 2.5–3; repeat runs agreed within 2%.

## What shipped

| Change | Before (same M5) | After (same M5) |
|---|---:|---:|
| Depth inference per photo, warm session | 116 ms, p95 135 ms (CPU) | **42 ms, p95 51 ms (WebGPU), 2.8× faster** |
| Readiness depth (252px), warm session | 29 ms, p95 33 ms | **12 ms, p95 14 ms, 2.4× faster** |
| **Photo reconstruction job, as the app runs it** (fresh worker per photo, model load included; median of 15 jobs) | 374 ms in the worker, 552 ms wall | **313 ms, 490 ms wall: 16% (11%) faster** |
| **Offline-safe model loading** | 2.0–8.9 s to the first result, up to 156 s on a slow network; **fails offline** | **0.26 s (WebGPU), 0.33 s (CPU); loads offline** |
| Peak physical footprint, benchmark process (two runs each) | 1,044–1,053 MiB | **1,197–1,222 MiB: 144–178 MiB more (about +15%)** |

- **Where the speedup lands.** The app runs every model job in a short-lived child process (`server/scene-inference.ts`), so each photo reconstruction pays a fresh model load, and process start-up dominates its cost. The warm speedups apply where the session stays alive: about 2.4× for readiness batches (up to 64 photos per worker) after the first photo, and about 2.8× for video depth, which runs several frames in one job. For a one-photo readiness batch, WebGPU is about 10 ms slower (session creation plus one call: 112–119 ms against 102–108 ms on CPU, in five paired runs); it wins from the second photo.
- **Memory goes up, not down.** RSS falls (about 1,097 → 742 MiB), but RSS leaves out WebGPU's GPU allocations, which are ordinary RAM on Apple unified memory. The physical footprint, which is what memory pressure is based on, is 144–178 MiB higher on WebGPU, measured exactly with `footprint` (reports `m5-da2-mem1/2`, `m5-da2-cpu-mem1/2`).
- **Same model, same answer.** WebGPU runs the same fp32 ONNX weights (SHA-256 `afb6a5c2…df10c`). Across all 14 benchmark photos, raw readiness depth matches CPU within 8e-5 and 8-bit reconstruction depth within one gray level (Pearson r ≥ 0.9999998). Mesh triangle counts differ by at most 9 per photo (of about 200,000), and every readiness decision and gate outcome is identical: the stretch and grazing counts differ by under 0.02%, and the cut share by 0.01 percentage points. Cached depth artifacts made on CPU stay valid, so the depth cache version is unchanged.
- **Device policy (`DEPTH_DEVICE`).** With `auto` (the default), macOS tries WebGPU and falls back to CPU. Every other platform uses CPU, because WebGPU there is unmeasured, and a host without a GPU can expose a slow software adapter that never fails. `webgpu` opts in on any platform, with the same CPU fallback. `cpu` restores the previous path exactly. onnxruntime-node ships no WebGPU for Linux arm64 (per transformers.js's support table), so a WebGPU attempt there falls back.
- **Fallback.** If WebGPU fails to load, the CPU is used. If WebGPU fails or returns non-finite depth at runtime, that photo is retried on the CPU. Only if the CPU succeeds does the process stay on the CPU; an input that fails on both does not cost WebGPU. A load-time failure keeps that one process on the CPU until it exits (even when the cause was a passing network error during a first download); every model job runs in a fresh process, so the next job tries WebGPU again.
- **Which device ran.** Worker output is discarded (it can contain paths or provider responses), so the workers report the device over IPC as fixed values, and the API logs them, for example `{"event":"scene-inference","stage":"depth",...,"depthDevice":"webgpu"}` and `{"event":"readiness-inference",...,"depthDevice":"webgpu"}`. A fallback adds `"depthFallback":"webgpu-load-failed"` or `"webgpu-run-failed"`. In-process users such as the benchmark scripts also print `[depth] webgpu unavailable (...); using cpu` or `[depth] webgpu failed (...); switched to cpu`.
- **The offline bug.** `pipeline()` checks for `preprocessor_config.json` through transformers.js's own default cache, ignoring `cache_dir`, and asks `huggingface.co` when it misses. That happened in every model process, even with the model already in `data/models`. With the network blocked, the depth model **failed to load**. `server/model-cache.ts` points that cache at the model directory for the depth model, the OWLv2 object detector and the panoptic segmenter. With the network blocked, both depth estimators, the readiness scorer and OWLv2 now load with zero network attempts. A test guards this: removing the fix makes it fail. This is a plausible cause of the "depth model could not run" 503 in [photo-test-improvement-plan.md](photo-test-improvement-plan.md), not a confirmed one.
- **Known remaining network dependency.** The panoptic segmenter (`Xenova/detr-resnet-50-panoptic`) still probes `tokenizer_config.json`, a file that model does not have, so transformers.js always asks the hub for it and fails that load offline. Skipping it would need the global `env.allowRemoteModels` flag, which would race with first-run downloads in the same process, so it is left as is; the segmenter keeps its existing fallback path.
- **End to end in the app** (API server, upload, then scene, a fresh data directory each time): the readiness worker scored the photo through the depth model (0.912, ready), and both workers logged the device actually used. The scene's later "complete" stage (segmentation, objects, pose) took 117 s, or hit the 180 s limit, earlier on this network, and 6.8–9.8 s after the cache fix. That change is consistent with the removed hub requests, but network conditions also varied, so it was not isolated.
- **Benchmark harness.** `scripts/m5/` provides a fixed, hash-verified photo set, one dump format for every model, production-code scoring with per-photo device recording, gate-aware comparison, and blind desktop renders; see [scripts/m5/README.md](../scripts/m5/README.md).

**Not shipped, with evidence:** MoGe-2 ViT-S failed the stretched-silhouette gate. CoreML was 3.7× slower than CPU (410 ms against 110 ms, pre-change runs) and peaked at 7,219 MiB (7.0 GiB) RSS. More CPU threads (18) gave no gain. Depth Pro and VGGT were not run (see [status](#run-status)).

## How to run

macOS or Linux shell:

```bash
npm install
npm run dev                       # API + web. Depth: WebGPU with CPU fallback on macOS, CPU elsewhere
DEPTH_DEVICE=cpu npm run dev      # force the previous CPU path
DEPTH_DEVICE=webgpu npm run dev   # opt in to WebGPU on Windows/Linux (CPU fallback stays)
npm test && npm run typecheck && npm run build
```

Windows PowerShell: `$env:DEPTH_DEVICE="webgpu"; npm run dev`, or put `DEPTH_DEVICE=webgpu` in `.env`. The forked workers inherit the setting.

Benchmark this machine before changing the default:

```bash
node scripts/m5/fetch-photo-set.mjs data/m5-photos                  # 14 fixed photos, SHA-256 verified
node scripts/m5/run-suite.mjs data/m5-photos --device cpu           # -> data/m5-reports-local/<chip>-da2-cpu.json
node scripts/m5/run-suite.mjs data/m5-photos --device webgpu        # -> data/m5-reports-local/<chip>-da2-webgpu.json
npm run benchmark:3d:compare -- --report data/m5-reports-local/<chip>-da2-cpu.json --report data/m5-reports-local/<chip>-da2-webgpu.json
```

`<chip>` is `m5`/`m3` on Apple silicon and the CPU model elsewhere (or pass `--name`). If the WebGPU report says `mixed`, or its device is `cpu`, WebGPU fell back on that machine. Keep the CPU default where WebGPU is not clearly faster.

## Run status

| Run | Machine | Backend | Status |
|---|---|---|---|
| A | M3 | Depth Anything V2 | **NOT DONE. Dropped.** No M3 measurement exists. |
| B | M5 Pro | Depth Anything V2 | **Done**, on CPU (the code path before this change) and on WebGPU (the new macOS default). |
| B probes | M5 Pro | Same weights on CoreML; CPU with 18 threads | **Done.** Neither helped. |
| C | M5 Pro | Depth Pro | **Not run.** The checkpoint is about 1.9 GB, and this network measured 6–17 KB/s (1.5–3.5 days). Runner updated and compiled. |
| D | M5 Pro | VGGT | **Not run.** About 5 GB on the same network; `facebook/VGGT-1B-Commercial` is also gated (manual approval on Hugging Face). Runner updated and compiled. |
| E | M5 Pro | MoGe-3 | **Unsupported on macOS.** Upstream: FlexGEMM/Triton has no macOS wheels. Not substituted. |
| E′ | M5 Pro | MoGe-2 ViT-S (`Ruicheng/moge-2-vits-normal`) | **Done.** Its weights were already cached; pure PyTorch on MPS. Not eligible (gate 3). |

## Answers to the handoff's questions

1. **How much faster is the M5 than the M3 for the same model?** **Unknown: the M3 run was not done.** On the M5 alone, moving the same model from the CPU to the M5's GPU is 2.8× faster per inference, and 16% faster per photo reconstruction job as the app runs it. The CPU path does not scale with the M5 Pro's extra cores (18 threads: 108 ms against 110 ms with 4, in the pre-change probes).
2. **Does a candidate improve visible VR quality?** The one candidate that could run, MoGe-2 ViT-S, shows no clear improvement: +49% stretched triangles (more on 11 of 14 photos), more holes (2.41% against 1.64% of the mesh), a 7–7 per-photo split on the second stretch measure, and no consistent winner in side-view renders.
3. **Does quality justify the latency and memory?** Not for MoGe-2 ViT-S: 273 ms per photo, 2.4× slower than the CPU path and 6.5× slower than the new default, with 1,392 MiB RSS plus 3,236 MiB of MPS (GPU) memory against about 1.0–1.2 GiB for DA2, and a failed gate.
4. **Which model for single photos, people, props and albums?** Depth Anything V2 for single photos, on WebGPU on macOS. People (SAM 3D Body), props (Hunyuan3D) and albums (VGGT, COLMAP) remain untested.

## Timing detail (M5 Pro, steady state)

Each photo ran `repeats + 1 = 4` times. The median of the last three is the photo's time, and the first call is reported separately. Model load and photo decoding are excluded; Python runners synchronize the GPU around every call. Reports are in the git-ignored `data/m5-reports-local/` on the M5.

| Configuration (report) | Avg ms | p50 | p95 | First call | Readiness avg / p95 | Load | RSS (MiB) |
|---|---:|---:|---:|---:|---:|---:|---:|
| **DA2, new default: WebGPU** (`m5-da2`, `m5-da2-repeat`) | **41.9 / 41.4** | 42 / 41 | 51 / 50 | 43 / 42 | 12 / 14 | 0.26–0.27 s | 730–749 |
| DA2, CPU, the previous path (`m5-da2-cpu`, `m5-da2-cpu-repeat`) | 115.4 / 117.2 | 116 | 135 | 116 / 118 | 29 / 33–34 | 0.33–0.35 s | 1,093–1,098 |
| *Pre-change:* DA2 CPU, 4 threads (`prechange-m5-da2-cpu-rerun`) | 110 | 109 | 132 | 110 | 27 / 31 | network-bound | 1,108 |
| *Pre-change:* DA2 CPU, 18 threads (`prechange-m5-da2-probe-cpu-18t`) | 108 | 107 | 131 | 110 | 31 / 36 | network-bound | 1,119 |
| *Pre-change:* DA2 WebGPU probe (`prechange-m5-da2-probe-webgpu`, `-rerun`) | 42 / 39 | 42 / 39 | 51 / 47 | 42 / 39 | 12 / 13 | network-bound | 739–752 |
| *Pre-change:* DA2 CoreML probe (`prechange-m5-da2-probe-coreml`) | 410 | 399 | 524 | 413 | 93 / 111 | network-bound | 7,219 |
| MoGe-2 ViT-S, MPS fp32 (`moge2-vits`) | 273 | 272 | 281 | 291 | n/a | 2.6 s | 1,392 (+ 3,236 MPS) |

*Pre-change* reports ran before the offline-loading fix, so their load times include the hub request (2.0–8.9 s across runs). The first pre-change CPU run (112 ms) was overwritten, and only its repeat (110 ms) survives. Memory figures are MiB (2^20 bytes). RSS excludes GPU memory; the physical footprint (exact, from `footprint`) is in the "What shipped" table, from separate memory runs (`m5-da2-mem1/2`: 38.1 / 38.6 ms; `m5-da2-cpu-mem1/2`: 110.8 / 110.1 ms, consistent with the timing runs).

**Per-job cold start** (`coldstart-per-job.json`, produced by `coldstart.mts`): 15 production depth jobs per device, alternating order, each in a fresh scene-inference worker with an empty upload cache. Median worker time is 313 ms on WebGPU and 374 ms on CPU (minimum 305 / 363 ms); wall time including the fork is 490 / 552 ms.

**Fresh-process startup** (`startup-probe-fixed-cache.jsonl`, an ad-hoc probe, median of five, with the offline fix): session creation 74 ms on CPU and 86 ms on WebGPU; first readiness call 30 / 28 ms; first reconstruction call 120 / 43 ms. The same probe without the fix spent 0.77–3.7 s, and once 156 s, creating the session while waiting on huggingface.co (not saved as a report).

MoGe's default fp16 autocast fails on MPS (a conv receives Half input against a float32 bias), so MoGe-2 ran in fp32.

## Quality gates (14 photos, against DA2 on CPU)

Every model is scored through one path: `scripts/m5/score-depth.ts` builds its depth with the production `createDepthGeometry` on the production 384px grid, and runs the production `DepthReadinessScorer` with only the depth source swapped.

| | DA2 CPU | DA2 WebGPU | MoGe-2 ViT-S |
|---|---:|---:|---:|
| 1. Finite depth on every photo | 14/14 | 14/14 | 14/14 |
| 2. Valid mesh for every 3D-ready photo | yes | yes | yes |
| 3. Stretched triangles (kept, over half the cut threshold) | 25,893 | 25,892 | **38,640 (fail)** |
| (independent check) grazing triangles, within 10° of the view ray | 174,801 | 174,832 | 202,421 (7 photos worse, 7 better) |
| Average cut (hole) share of the mesh | 1.64% | 1.65% | 2.41% |
| 4. Flat wall and screen rejected | 2/2 | 2/2 | 2/2 |
| Night photos 3D-ready | 1/2 | 1/2 | 2/2 |
| Photos 3D-ready | 6/14 | 6/14 | 8/14 |
| 5. Blind Quest review | not done | not needed (same output) | not done |
| 6. Latency per photo, warm | 116 ms | 42 ms | 273 ms |

MoGe-2 ViT-S has clearly fewer grazing triangles on both landscapes and the lit night street, and clearly more on both portraits, the crowded temple road (17.0% against 8.7%) and the brick wall. It marks two scenes 3D-ready that DA2 rejects, the lit plaza at night and the festival field. Both are plausible walkable scenes, but the readiness thresholds were tuned on DA2's relative depth, so this is a calibration shift, not proof of better quality.

### Caveats

- Both stretch counts are proxies. The first undercounts rubber sheets that a blurry model spreads over many small steps; the second also counts distant floors, which are legitimately grazing. Neither replaces a blind Quest review.
- Every model's depth is min-max normalized into the production 2–12 m mapping, the same as Depth Anything V2, so metric scale is deliberately unused.
- MoGe-2 ViT-S is the smallest MoGe-2 checkpoint (the one already cached); ViT-B and ViT-L may do better. OpenCV was not downloaded at this bandwidth: MoGe imports it at module level, but the inference path never calls it, so it ran with an import-only stand-in that raises on any use.
- WebGPU equivalence and speed were measured on this Apple GPU only, which is why `auto` enables WebGPU on macOS only. Measure on any other machine before opting in.

## Fixed photo set

`scripts/m5/photo-set.json`: 14 Wikimedia Commons photos at 1920px, two for each required category (indoor with people, street, landscape with ground, portrait, flat wall or screen, night, crowded with thin boundaries), all CC BY or CC BY-SA with the author recorded. `node scripts/m5/fetch-photo-set.mjs data/m5-photos` re-downloads them and verifies each SHA-256; a re-download matched the stored hash.

## If you want the M3 comparison later

It was not run. On the M3, from `main`, with nothing heavy running, pin the same device on both machines so that only the hardware differs:

```bash
npm install
node scripts/m5/fetch-photo-set.mjs data/m5-photos
node scripts/m5/run-suite.mjs data/m5-photos --device cpu      # -> data/m5-reports-local/m3-da2-cpu.json
node scripts/m5/run-suite.mjs data/m5-photos --device webgpu   # -> data/m5-reports-local/m3-da2-webgpu.json
```

The M5 reports exist only in the git-ignored `data/m5-reports-local/` on the M5 Pro. Copy `m5-da2-cpu.json` and `m5-da2.json` (WebGPU) into the same folder on the M3, or run the commands above on the M5 too, then compare like with like. The comparison matches photos by hash and prints the same-model speedup:

```bash
npm run benchmark:3d:compare -- --report data/m5-reports-local/m5-da2-cpu.json --report data/m5-reports-local/m3-da2-cpu.json
npm run benchmark:3d:compare -- --report data/m5-reports-local/m5-da2.json --report data/m5-reports-local/m3-da2-webgpu.json
```

## Runs C and D on a faster connection

```bash
# Depth Pro: isolated Python 3.9 environment from https://github.com/apple/ml-depth-pro, checkpoint via get_pretrained_models.sh
python scripts/m5/depth_pro_runner.py --input data/m5-photos --output-dir data/m5-reports-local/dumps/depth-pro --checkpoint /path/to/depth_pro.pt --device mps
npx tsx scripts/m5/score-depth.ts --dump data/m5-reports-local/dumps/depth-pro --photos data/m5-photos --output data/m5-reports-local/depth-pro.json

# VGGT: isolated environment from https://github.com/facebookresearch/vggt; accept the commercial checkpoint's terms first
python scripts/m5/vggt_runner.py --input data/m5-photos --output-dir data/m5-reports-local/dumps/vggt --checkpoint facebook/VGGT-1B-Commercial --license "VGGT-1B-Commercial license" --device mps
npx tsx scripts/m5/score-depth.ts --dump data/m5-reports-local/dumps/vggt --photos data/m5-photos --output data/m5-reports-local/vggt.json

npm run benchmark:3d:compare -- --report data/m5-reports-local/m5-da2-cpu.json --report data/m5-reports-local/depth-pro.json --report data/m5-reports-local/vggt.json
npx tsx scripts/m5/render-views.ts --report data/m5-reports-local/m5-da2-cpu.json --report data/m5-reports-local/depth-pro.json --report data/m5-reports-local/vggt.json --photos data/m5-photos --output data/m5-reports-local/review
```

## Exact runs and versions

- Machine: Apple M5 Pro (6 super + 12 performance cores), 64 GB, macOS 26.5.1, on AC power. Final runs at load average 2.5–3; two earlier passes taken under unrelated heavy load (another process at 118% CPU) were discarded.
- Node v24.11.1, `@huggingface/transformers` 4.3.1, `onnxruntime-node` 1.30.0. Model `onnx-community/depth-anything-v2-small`, `onnx/model.onnx` fp32, SHA-256 `afb6a5c2…df10c`, identical to the checkpoint in [depth-resolution-results.md](depth-resolution-results.md).
- Python 3.12.6, torch 2.14.1 (MPS), assembled offline from the local uv cache. MoGe at `74fbce05`, utils3d-moge at `62f09d58` (the commit MoGe pins), checkpoint `Ruicheng/moge-2-vits-normal` (blob `79a16621…`).
- Checks: `npm test` (all passed, including the real-model offline test and the worker IPC device tests; the depth-model tests also pass with `DEPTH_DEVICE=cpu` exported), `npm run typecheck`, `npm run build`, `npm run test:3d`, `npm run test:3d:simulate`, `npm run test:3d:full-simulate`, and strict TypeScript over `scripts/m5`. The production depth modules ran with the network blocked under `DEPTH_DEVICE` unset, `webgpu` and `cpu`: zero network attempts and identical readiness. The real app (API, upload, scene) ran under the default and `cpu`, and its worker logs reported the device that was actually used.
