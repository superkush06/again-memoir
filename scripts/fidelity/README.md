# Source-camera image fidelity evaluator

This standalone tool compares baseline and candidate renders against the same reference photo. It uses the existing `sharp` and `tsx` dependencies and does not run models or alter the application, inference caches, or photo tests.

The separate `prepare-depth-ablation.ts` helper **does** run local CPU depth inference, exclusively and serially. It reads the saved album report/originals and already cached model weights, reproduces production source preparation, derives old and retained depth from the same prediction, and checks the old result against saved baseline pixels. It writes only the explicitly selected experiment directory and never calls scene completion or a cloud model:

```powershell
npx tsx scripts/fidelity/prepare-depth-ablation.ts C:/path/to/VR_Multiplayer_Memoir C:/path/to/experiment-output 1,2,3
```

Choose a separate output directory, preserve the generated manifest and checkpoint hash, and run one model-heavy job at a time. The generated per-case `capture.json` files can be passed to `capture.ts`. See [the measured pilot results](../../docs/depth-resolution-results.md) for the actual three-photo experiment and its limits.

Use **clean canvas captures from the original source camera**, with identical crop, viewport, resolution, camera intrinsics/extrinsics and exposure/color settings. Browser screenshots containing controls, borders, text, or different camera views are not suitable. `alignmentVerified: true` records the caller's assertion; the evaluator does not prove alignment. Off-axis captures cannot be compared to the source photograph with this tool.

## Run

```powershell
npx tsx scripts/fidelity/evaluate.ts path/to/manifest.json
npx tsx scripts/fidelity/evaluate.ts path/to/manifest.json --output path/to/report.json
npx tsx --test scripts/fidelity/evaluate.test.ts
```

Successful evaluation prints only JSON to stdout. Errors go to stderr with exit status 1. No files are written unless `--output` is supplied. Its parent directory must exist; an output path cannot replace the manifest or any input image/mask. The optional output path is relative to the shell's working directory.

The manifest uses paths relative to its own directory:

```json
{
  "view": "source-camera",
  "alignmentVerified": true,
  "reference": "source.png",
  "baseline": "baseline-source-camera.png",
  "candidate": "candidate-source-camera.png",
  "regions": [
    { "name": "people", "mask": "people-mask.png" },
    { "name": "umbrella-pole", "mask": "umbrella-pole-mask.png" }
  ],
  "capture": {
    "canvasOnly": true,
    "camera": "Record the shared camera matrix and intrinsics here",
    "viewport": [1920, 1080]
  },
  "provenance": {
    "baselineRevision": "Record revision and dirty diff hash",
    "candidateRevision": "Record revision and dirty diff hash",
    "modelRevision": "Record exact model/checkpoint revision and seed"
  }
}
```

`regions`, `capture`, and `provenance` are optional. The last two accept JSON objects and are copied into the report without verification. Region names must be nonempty and unique. Unsupported top-level or region fields fail, to avoid silently ignoring misspelled settings.

## Input and metric rules

- EXIF orientation is applied, then images are converted to 8-bit sRGB. Oriented width and height must match exactly across all images and masks. No resize, registration, crop, exposure matching, color fitting, or alpha compositing is performed.
- Images must be fully opaque. RGB and fully opaque RGBA inputs are supported; any nonopaque pixel fails, including in masks. Grayscale input images are expanded to RGB. Animated/multipage inputs fail.
- Masks must contain opaque grayscale pixels (single-channel images, or equal R/G/B values). Values **>= 128** select a pixel; lower values exclude it. Each region must select at least one pixel. Masks are fixed from the reference, not chosen independently for each render. Regions may overlap.
- MAE is the mean absolute RGB-channel error divided by 255. RMSE is the square root of the mean squared RGB-channel error after division by 255. Both are normalized to [0, 1], with lower values indicating closer source pixels.
- PSNR is `-10 * log10(MSE)` for normalized RGB errors, with higher values indicating closer source pixels. Exact matches have infinite PSNR, encoded as `psnrDb: null` and `exactMatch: true`. A PSNR delta involving an exact match is undefined, encoded as `null` with `psnrDeltaDefined: false`.
- `changedPixelFraction` counts selected pixels where **any RGB channel differs by more than 10/255**. Exactly 10/255 does not count. It is divided by selected pixel count, not channel count.
- Every comparison reports baseline, candidate, and **candidate minus baseline** deltas. Negative MAE, RMSE, and changed-pixel deltas indicate closer source pixels; positive finite PSNR deltas indicate closer source pixels.
- SHA-256 hashes identify the exact encoded manifest, image and mask bytes used. They do not imply a correct camera or semantic match.

Global scores include every pixel. Region scores use only selected pixels, which helps reveal face, clothing, hand, thin-structure, or object regressions that a large background can dilute. Keep a fixed reviewed mask set for comparisons.

## Interpretation limits

These are source-view pixel measurements in sRGB, not linear-light or perceptual measurements. They do not compute SSIM or LPIPS, and do not establish correct geometry, pose, hidden surfaces, identity, novel-view quality, or successful 3D reconstruction. A flat photograph can score perfectly from the source camera. There is deliberately no automatic acceptance threshold or verdict.

Review held-out novel views, silhouette/pose alignment, occlusion and contact, and source-view crops alongside the report. Do not feed the existing browser UI screenshots to this evaluator until clean, aligned source-camera canvas captures are available.

## Reproducible depth-surface captures

`capture.ts` is a separate headless WebGL experiment. It imports `createPhotoSurface`, its projector/triangulation, and `cleanPhotoDepth` from one frozen checkout for both variants. It does not start the application or run inference. The comparison changes only the supplied depth maps and nearest-sampled mesh resolution; it excludes the complete world's people, objects and environment geometry.

```powershell
npx tsx scripts/fidelity/capture.ts path/to/capture.json
npx tsx scripts/fidelity/evaluate.ts path/to/captures/evaluate.json --output path/to/captures/scores.json
npx tsx scripts/fidelity/evaluate.ts path/to/captures/evaluate-plane-control.json
npx tsx --test scripts/fidelity/capture-math.test.ts
```

Example per-case capture manifest (paths are relative to the manifest):

```json
{
  "source": "source.jpg",
  "referenceOriginal": "original-photo.jpg",
  "baselineDepth": "depth-baseline-256.png",
  "candidateDepth": "depth-candidate-518.png",
  "background": "background.jpg",
  "baselineRoot": "../../photo-scene-baseline",
  "outputDir": "captures",
  "maxOutputEdge": 960,
  "baselineMeshMaxEdge": 256,
  "candidateMeshMaxEdge": 384,
  "projection": {
    "near": 2,
    "far": 12,
    "fov": 60,
    "strength": 1,
    "cameraHeight": 1.6
  },
  "views": [
    { "name": "source-camera", "offset": [0, 0, 0] },
    { "name": "left-8cm", "offset": [-0.08, 0, 0] },
    { "name": "right-8cm", "offset": [0.08, 0, 0] }
  ]
}
```

The optional `playwrightModule` and `browserExecutable` fields override the bundled Playwright module and installed Chrome defaults for this workspace. The helper uses local `esbuild` from the existing dependency tree. It serves only in-memory experiment assets on an ephemeral localhost port, launches its own headless Chrome instance with SwiftShader, and closes both after capture. Run serially after inference finishes on memory-constrained machines.

The original reference is oriented, converted to sRGB, and explicitly resized once with Lanczos3 to the fixed capture size. The source and original must have matching aspect ratios; their crop/alignment must still be verified by the caller. No resize occurs in `evaluate.ts`. A textured two-triangle plane control quantifies the shared texture filtering, color and registration error against the original. A perfect flat plane result is not evidence of 3D accuracy.

Captures contain no UI. `capture-report.json` records exact inputs and frozen source hashes, mesh dimensions and triangle counts, camera matrices, WebGL renderer, and steady render durations fenced with `gl.finish()`. The depth grids are capped without upscaling using pixel-centre nearest sampling before the frozen cleanup step. Both variants share textures, FOV, unit depth strength, tone mapping, color space, pixel ratio and projection. The depth files must derive from the same prediction to isolate output retention/resampling; the helper records evidence but does not infer that relationship.

Each variant (`baseline`, `candidate`, `plane`) gets a PNG for every named view plus a `-coverage.png` pass. Coverage renders only the foreground geometry white on black with no backing surface, and reports uncovered fraction (white threshold >=128), partial-coverage fraction, and mean white coverage. The side cameras translate by fixed offsets and retain their original orientation. Side-view pixel errors must not be compared with the front reference; use those images for qualitative and coverage inspection without claiming held-out novel-view accuracy. SwiftShader timings are diagnostic and do not measure headset/GPU performance.
