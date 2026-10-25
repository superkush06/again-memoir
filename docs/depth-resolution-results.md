# Depth resolution implementation and measured results

October 24, 2026. This is an actual local experiment on the first three café photographs, following [the research handoff](image-fidelity-research-handoff.md). The [broader project survey](image-to-vr-worlds-survey.md) supplies additional methods to evaluate; its literature claims are separate from these measurements.

## Outcome

Preserving model depth before meshing improved source-camera fidelity in **3 of 3 tested photographs**, with normalized mean absolute RGB error reduced **12.19–19.28%**. Foreground holes in the source-camera rasterization fell by about half. This is a controlled **depth-resolution-only** comparison, not a measurement of all combined pose, object, environment and edge-coverage changes.

[Open the local saved comparison](http://127.0.0.1:5181/?photo=1&left=depth-256&right=depth-384&view=source-camera&mode=side&crop=full) to switch photos, versions, fixed views and regions, or use a swipe divider. All 33 original thumbnails are listed; only the three measured cases have depth comparison captures. The URL restores the selection. Start it again with `npx tsx scripts/fidelity/compare.ts` if needed; [viewer instructions](../scripts/fidelity/compare-README.md).

The candidate retains depth up to 518 pixels on the long edge and uses the implementation chat's bounded 384-pixel mesh sampling. Model inference remains at 518 pixels. Existing 256-pixel depth must be regenerated from the photograph; enlarging an old depth map does not recover the lost detail.

| Photo | Normalized MAE, old → retained | MAE reduction | PSNR, old → retained | Uncovered foreground, old → retained |
|---|---:|---:|---:|---:|
| 1: Under the café umbrella | 0.011851 → 0.009924 | 16.26% | 27.85 → 30.36 dB | 4.33% → 2.23% |
| 2: Phone beside the patio table | 0.012009 → 0.009693 | 19.28% | 27.83 → 30.72 dB | 5.21% → 2.64% |
| 3: Across the glass table | 0.014862 → 0.013051 | 12.19% | 28.41 → 30.53 dB | 5.58% → 2.84% |

The exact JSON reports, rather than rounded table values, are authoritative. MAE measures channel error in 8-bit sRGB, normalized to [0,1]; lower is better. PSNR is higher for closer pixel matches. Coverage uses a separate white foreground-only render without its backing, with raster threshold 128. A smaller uncovered area is not proof that the added geometry is physically correct.

**27 fixed diagnostic regions** cover faces, clothing/poses, poles, chairs, tables and the phone. All 27 PSNR differences were positive, but photo 3's left-standing-face result was almost unchanged (+0.021 dB), and its MAE worsened by **0.15%**. Thus 26/27 regions improved in MAE; the result is not an across-the-board identity or face-quality claim. The umbrella-pole regions reduced MAE by 38.27%, 24.94% and 26.11%, respectively. Photo 2's phone region improved by 22.98%, without proving correct hand contact or complete phone geometry.

## What changed in the application

The shared implementation checkout is `C:\Users\prran\.codex\worktrees\photo-scene-improvements\VR_Multiplayer_Memoir`.

The integrated candidate was committed as `265a9705f4cd9e027e167780937fcbb1ea92b07f` ("Preserve photo evidence and enrich poses, scenery, and object coverage"). Its production build passed and its isolated API is on port 3002. The three-photo ablation below remains a separate artifact: it deliberately uses the frozen earlier renderer to isolate resolution.

- `server/reconstruction.ts` retains photo depth up to 518 pixels with nearest sampling and no enlargement, replacing the old unconditional 256-pixel reduction. Source-image preparation, inference input and camera framing stay fixed.
- Photo depth cache metadata and lookup version are now separate from the source/completion fingerprint. Upgrading depth keeps reviewed world manifests, body GLBs and texture atlases under their original identity, instead of triggering unnecessary regeneration.
- Depth and source artifact replacement is atomic. A failed inference upgrade leaves the existing usable depth and reviewed assets intact.
- The implementation chat's renderer samples retained depth at up to 384 pixels on the long edge, using nearest sampling. Legacy smaller artifacts remain smaller. For these photos, geometry changed from 256×192 to 384×288.
- Video retains its existing 512-pixel model input, 128-pixel depth artifact and cache identity. This change is for photographs.

Nine focused backend tests passed, including one-pixel detail preservation, stale-cache rejection, reviewed completion reuse with zero cloud calls, transient upgrade failure, EXIF orientation, bounds and video cache compatibility. The implementation chat separately reported 322 passing integrated regression tests; its broader candidate includes additional changes beyond this experiment. A fresh candidate API is necessary because an already-running API can retain an older scene in memory.

## How the comparison was controlled

1. Used the original 4032×3024 café photographs, verified by SHA-256, and independently reproduced the existing 1600×1200 JPEG preparation. The prepared source files matched exactly.
2. Ran cached `onnx-community/depth-anything-v2-small`, fp32 CPU, once per photograph with production input size 518×389. No external inference service or new model download was used.
3. Derived both old 256×192 and retained 518×389 artifacts from that **same learned prediction**. All three old artifacts reproduced the historical cached depth PNGs **byte for byte**, with zero pixel mismatches.
4. Used the same frozen photographic-surface implementation, triangulation, speckle cleanup, texture, backing, camera and settings for both variants. Only depth artifact/sampling resolution changed. Candidate-specific edge patches, inferred floor, body and object replacements were excluded, so they cannot explain the improvement reported here.
5. Captured clean 960×720 WebGL images at the source viewpoint and fixed ±0.08 scene-unit lateral translations with unchanged orientation. These offsets use inferred scene scale, not measured physical camera motion. Each case has 18 images: three representations (old, retained, flat-plane control), three views, and color/foreground-coverage passes.
6. Evaluated source-camera renders against the original photograph resized to the same 960×720 framing. No image registration, exposure fitting or candidate-specific masks were applied. Region rectangles were annotated on the original source images and are hash-anchored in [cafe-regions.json](../scripts/fidelity/cafe-regions.json).

The flat-plane control has full source-camera coverage and PSNR 38.27 / 38.99 / 35.31 dB. It exposes shared source-JPEG/filtering error and shows why a perfect source-view result would not prove useful 3D. Side views have no calibrated held-out photographic ground truth and were not scored against the source photograph.

## Costs and remaining defects

Foreground triangle counts increased from **92,936 / 92,081 / 91,603** to **214,465 / 213,591 / 212,944**, approximately 2.3×. This justifies retaining the bounded mesh cap and measuring actual stereo/headset cost before further increases. The headless renderer used SwiftShader; its diagnostic render timing is not a Quest or GPU performance result.

Source and lateral visual inspection still shows fragmented/shifted pole edges, person/chair boundary gaps, and invented backing exposed by movement. Higher resolution reduces the damage but does not solve occlusion completion or recover hidden surfaces. These three closely related café photos are a **3/33 pilot**, not a representative pass over the entire album. Scene completion, pose fitting, held objects, reflections, text, crop handling, memory failures and headset comfort still require the candidate-only album tests.

The local depth-only run took about 4 seconds per case after a 9.2-second model load. Those per-case durations include source verification and artifact preparation. Sampled post-case process RSS was about 0.48–0.60 GB; peak memory was not measured. This is not a full scene-generation speed comparison.

## Evidence and reproduction

The original baseline and originals were not modified. Experiment artifacts are in `.local/depth-fidelity-v1/`:

| Evidence | Photo 1 | Photo 2 | Photo 3 |
|---|---|---|---|
| Capture matrices, hashes and geometry | [capture report](../.local/depth-fidelity-v1/case-01/captures/capture-report.json) | [capture report](../.local/depth-fidelity-v1/case-02/captures/capture-report.json) | [capture report](../.local/depth-fidelity-v1/case-03/captures/capture-report.json) |
| Global source-image measurements | [scores](../.local/depth-fidelity-v1/case-01/captures/global-scores.json) | [scores](../.local/depth-fidelity-v1/case-02/captures/global-scores.json) | [scores](../.local/depth-fidelity-v1/case-03/captures/global-scores.json) |
| Region measurements | [scores](../.local/depth-fidelity-v1/case-01/captures/evaluation-regions.json) | [scores](../.local/depth-fidelity-v1/case-02/captures/evaluation-regions.json) | [scores](../.local/depth-fidelity-v1/case-03/captures/evaluation-regions.json) |
| Foreground coverage | [coverage](../.local/depth-fidelity-v1/case-01/captures/coverage-regions.json) | [coverage](../.local/depth-fidelity-v1/case-02/captures/coverage-regions.json) | [coverage](../.local/depth-fidelity-v1/case-03/captures/coverage-regions.json) |

The [preparation manifest](../.local/depth-fidelity-v1/manifest.json) records source and output hashes, dimensions and exact baseline reproduction. ONNX checkpoint SHA-256: `afb6a5c28f3b6bf1618c6e43f02073ef9dfdc70e937502d51603e57b0a1df10c`. The three cases share browser bundle SHA-256 `4b9be3ef258a7085d1d29b902f5c14a060389dfb7d489b1d3ff6524c29b7f74b`.

Use the commands in [the fidelity tooling README](../scripts/fidelity/README.md). `prepare-depth-ablation.ts` generates an independent experiment from the original report and cached model; `capture.ts` creates the clean fixed-camera images; `evaluate.ts` and `evaluate-cafe-regions.ts` calculate metrics. Four capture tests and strict TypeScript checks passed, in addition to the existing 11 metric tests. No off-axis PSNR or invented accuracy score is supplied.

## Testing handoff

The photo-testing chat stopped scheduling baseline runs at the user's instruction and preserved its six completed scenes, earlier failures and existing screenshots. The new workflow is **candidate-only**: begin with representative café/group/living-room cases (the ready configuration prioritizes indices 1, 4, 6, 2, 3), then continue the 33-photo set serially using the implementation chat's isolated API/data configuration. Keep the frozen full baseline, this depth-only ablation and the combined renderer/pose/object candidate as distinct named variants. Do not present the depth-only scores as measured gains for all combined changes.

The implementation and testing chats also received the user's request for an easy, restorable comparison of available named versions. Missing or failed variants must remain visible as unavailable/failed, and previous successful artifacts must remain selectable.

The next justified batch is a bounded hidden color/depth layer around validated occlusion boundaries, following 3D Photo Inpainting and Flash3D. Current candidate edge patches restore missing source-camera coverage at a local depth; they do not reconstruct the unseen background. Keep that next batch separately named, preserve observed pixels, reject fills conflicting with known geometry, and evaluate side-view content rather than accepting white coverage alone. The full survey and this addendum were relayed to the implementation chat after candidate freeze.

## First combined-candidate visual review

On October 24, the testing chat completed and archived photo 1 with combined candidate commit `265a9705f4cd9e027e167780937fcbb1ea92b07f`. This is **1/33 full candidate scenes tested**, separately from the three-photo depth-only experiment above. The tester reported a 518×389 depth artifact and 358.5-second full generation. Cloud scene analysis was rate-limited, so this result includes partial local analysis.

The [saved review](../.local/candidate-album-scenes/qa-v1.json) records five views. Inspection of its front and side screenshots confirms that the source viewpoint retains the photographed people and clothing, while the completed side view has severe stretched strips and gaps. The tester also found a false umbrella placement over the tabletop. All four detected people remain in the photograph; the viewer reports zero rendered pose-fitted bodies, despite two matched pose records in the saved world. These processing counts must not be presented as successful rendered replacements.

These screenshots include viewer controls and were assessed qualitatively. They do not supply a numerical before/after fidelity result or calibrated wide-view ground truth. The depth-only numerical gains above therefore remain the measured improvement; the combined candidate has unresolved visual defects. The implementation chat has the findings, and the tester is holding subsequent representative cases for the next named patch while retaining this version's artifacts.
