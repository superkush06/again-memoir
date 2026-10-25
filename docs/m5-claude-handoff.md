# M5 geometry benchmark handoff

> **Status (October 24, 2026): run A (the M3 baseline) was NOT done and has been dropped.** Runs B and E′ were done on an M5 Pro; C and D were not run. Results, what shipped to `main` and how to run it: [m5-results.md](m5-results.md).
>
> **The prompt below is historical.** Report names and defaults have changed since it was written: `run-suite.mjs` now names reports after the chip and device (`m3-da2-cpu.json`, `m5-da2-cpu.json`, ...), and a hardware comparison must pin the same `--device` on both machines. Use the commands in [m5-results.md](m5-results.md#if-you-want-the-m3-comparison-later) instead.

This branch is `m5-3d-geometry-benchmark`. It adds a repeatable comparison lane for the M3 and M5. The production depth model is unchanged; on macOS it now runs on WebGPU with a CPU fallback ([m5-results.md](m5-results.md)).

## Copy this prompt into Claude

```text
You are working in the VR_Multiplayer_Memoir repository on branch m5-3d-geometry-benchmark.

Goal: run the existing M3 baseline and compare it against the optional M5 geometry candidates without changing production behavior or committing secrets.

Rules:
- Read docs/m5-3d-benchmark.md, docs/m5-claude-handoff.md, and scripts/m5/runner-format.md first.
- Never overwrite .env, print secrets, commit model checkpoints, or commit photo data/reports.
- Keep Depth Anything V2 as the default app backend unless a candidate passes every acceptance gate.
- Do not install heavyweight model dependencies into the Node environment. Use isolated Python environments.
- If a model cannot run on Apple Silicon, record it as unsupported and continue; do not fake a result.

First inspect:
1. git status --short --branch
2. node --version and python3 --version
3. npm install
4. npm run typecheck
5. npm run test:3d
6. npm run test:3d:simulate

Create or use a fixed photo directory containing the same photos for every model. It should include an indoor scene with people, travel/street scene, landscape with visible ground, portrait, flat wall or screen, dark/night scene, and crowded scene with thin boundaries.

The required before/after matrix is:

| Run | Machine | Backend | Purpose |
|---|---|---|---|
| A | M3 | current Depth Anything V2 | historical baseline: how the app worked before the M5 work |
| B | M5 | current Depth Anything V2 | hardware-only change: does M5 reduce compute time? |
| C | M5 | Depth Pro | single-photo quality candidate |
| D | M5 | VGGT or VGGT-Ω | multi-photo/camera-consistency candidate |
| E | M5/Linux CUDA if available | MoGe | optional metric-depth candidate; skip on macOS/MPS if unsupported |

Do not compare different photo sets, image sizes, model revisions, or preprocessing settings. Save the machine, device, commit, model/checkpoint, resolution, average time, p95 time, peak memory if available, and output report for every run.

Run the baseline:
node scripts/m5/run-suite.mjs /absolute/path/to/fixed-photo-set

Run it once on the M3 and once on the M5. Name the reports `m3-before.json` and `m5-da2.json`. The baseline script uses the current production Depth Anything V2 path, so this isolates hardware improvement from model improvement.

Run Depth Pro in its own Python 3.9 environment using scripts/m5/depth_pro_runner.py. Follow the official Apple repository for installation and checkpoint download. Use --device auto. Save the report outside Git-tracked source, for example data/m5-reports-local/depth-pro.json.

Run VGGT in its own environment using scripts/m5/vggt_runner.py. Prefer the commercial checkpoint if this is intended for product use, and record the checkpoint/license in the local report notes.

Do not run MoGe-3 on macOS/MPS: the upstream project currently requires Linux/CUDA for its FlexGEMM/Triton dependency. If no Linux/CUDA worker is available, mark MoGe unsupported on this machine. Do not substitute a fake report.

Compare only reports generated from the identical fixed photo set:
npm run benchmark:3d:compare -- --report data/m5-reports-local/depth-anything-v2.json --report data/m5-reports-local/depth-pro.json --report data/m5-reports-local/vggt.json --output data/m5-reports-local/comparison.json

For each candidate report:
- check finite depth on every input;
- check valid mesh output;
- check readiness behavior on flat walls/screens and night photos;
- record average and p95 inference time if available;
- inspect the same scenes in Quest using the same renderer and camera movement;
- note foreground stretching, broken silhouettes, floating people, holes, and walkable-floor quality.

The final comparison must answer these questions:
1. How much faster is M5 than M3 for the same current model?
2. Does each candidate improve visible VR quality over the M5 baseline?
3. Does the quality improvement justify its extra latency and memory?
4. Which model should be used for single photos, people, props, and multi-photo albums?

Quality must be scored in two ways: automated gates from `scripts/m5/runner-format.md`, and a blind Quest review of the same scenes. Automated depth range alone is not a quality win.

Only recommend a production replacement if it passes all gates in scripts/m5/runner-format.md and improves the blind Quest comparison. Otherwise leave the default unchanged and report the evidence.

At the end, report: exact commands run, machine/device, model/checkpoint revisions, successful tests, unsupported models, comparison summary, and the recommended next code change. Do not make production code changes without showing the comparison evidence first.
```

## Local setup

From a fresh checkout:

```bash
git clone https://github.com/PrranitArora/VR_Multiplayer_Memoir.git
cd VR_Multiplayer_Memoir
git fetch origin
git switch --track origin/m5-3d-geometry-benchmark
npm install
```

Do not copy a real `.env` into Git. Create a local `.env` only if the app needs it, using the existing `.env.example`/`.env` conventions.

## Baseline and app checks

```bash
npm run typecheck
npm run test:3d
npm run test:3d:simulate
npm run build
npm run dev
```

In another terminal, while the app is running:

```bash
LIVE_3D_BASE_URL=http://127.0.0.1:8787 npm run test:3d:live
```

To exercise a real memory scene, set `LIVE_3D_MEMORY_ID` to an existing local memory ID. This does not upload anything or contact a model provider by itself.

## Reports and privacy

Keep reports and photos in an ignored local directory such as `data/m5-reports-local/`. Reports may contain absolute local paths, timings, and model metadata. Never commit photos, checkpoints, OAuth credentials, Gemini keys, or a real `.env`.

The app still uses `onnx-community/depth-anything-v2-small` by default, on WebGPU with a CPU fallback on macOS and on the CPU elsewhere (`DEPTH_DEVICE`). The M5 work is an evaluation lane; no candidate model automatically replaces production.

