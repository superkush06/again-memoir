# Image-to-3D fidelity: research and implementation handoff

Research checked October 24, 2026. Prepared for **Plan photo test improvements** (chat `01a16fa0-4a3d-7732-9df1-f540d86843ca`) at the user's request. This supplements [the earlier strategy](realistic-vr-reconstruction-strategy.md) and [the test improvement plan](photo-test-improvement-plan.md); it does not replace their evidence ledger.

Follow-through: the user subsequently authorized implementation and actual photo testing. See [the depth-resolution implementation and measured results](depth-resolution-results.md). Statements below about no inference or runtime changes describe the initial research stage, before that follow-through.

## Decision

Adapt **layered depth with explicit occlusion boundaries**, **camera/silhouette-constrained body and object fitting**, and **source-camera image comparisons** first. Then compare specialized pretrained models in isolated workers. Preserve observed face, clothing, sign and object pixels; generate only the missing surfaces. The current repository already contains source-photo projection and TripoSR, so those are baselines, not new discoveries.

Recommended model experiments, in order:

1. Existing Depth Anything V2 Small with preserved inference resolution and better layer topology.
2. **Depth Pro** for sharper scene depth and focal estimation; **DA3 metric** as an alternative.
3. **SAM 3D Body** for per-person pose, shape and hand evidence, while retaining original appearance.
4. **SAM 3D Objects** for cluttered/occluded scene objects; **TRELLIS.2** for clean isolated object crops.
5. A separate multiview reconstruction path when genuinely overlapping photographs or video exist.

These are research-backed candidates, **not measured wins on this album**. No new checkpoint was installed, no inference was run, and no live server/cache was changed by this research task. The existing hardware record describes Intel Iris Xe, no NVIDIA CUDA GPU and about 12 GB RAM. Large CUDA candidates therefore need a separate worker; their published GPU times are not local timing estimates.

## Current evidence and integration constraints

The first café reviews report broken umbrella poles/table edges after small movement, foreground boundary holes, a table labeled as a bed, a detached phone tile, and standing generic replacements for seated/cropped people. I also inspected [photo 2's completed front screenshot](../.local/album-scenes/screenshots/02-completed-front.png): the large flat removed-person areas and incorrect body placement are visible. The detailed reports remain in `.local/photo-scene-visual-review.json`; these are historical baseline artifacts, not results for the implementation checkout.

Relevant implementation findings in the original checkout:

| Location | Finding | Experiment it motivates |
|---|---|---|
| `server/reconstruction.ts` | Source texture is capped at 1600 px, model input at 518 px, saved depth at 256 px. Uses `onnx-community/depth-anything-v2-small`. | Preserve a separate full inference-depth artifact. Compare 256 vs retained resolution before changing the model. Upsampling a 256 px artifact cannot recreate lost depth detail. |
| `src/scene/reconstruction.ts` | One vertex per depth pixel; cuts triangles at large relative depth jumps. | Refine sampling around supported thin features, preserving genuine occlusion cuts. |
| `src/scene/photo-surface.ts` | Compresses uncertain relative depth and adds a two-triangle background backing. | Add locally depth-ordered hidden layers, rather than relying on one distant background plane. |
| `src/scene/photo-depth.ts` | Fills removed-person depth from the visible boundary. | Distinguish a fallback fill from inferred background geometry with continuity and confidence. |
| `scripts/pose-fitting/`, `src/human-pose-validation.ts` | MediaPipe Heavy evidence uses 33 landmarks with visibility/presence and person association. | Keep this working CPU route; introduce a separate backend schema for richer rigs. |
| `server/local-object-detector.ts` | Existing ONNX route is OWLv2 → Grounding DINO → SlimSAM. | Improve instance masks, category ambiguity and placement; adding category names alone cannot fix fidelity. |
| `src/scene/neural-photo-fitting.ts`, `src/scene/texture-projection.ts` | Existing camera visibility and source-photo projection. | Extend and test this logic for new geometry instead of duplicating it. |
| `scripts/import-neural-asset.ts` | Import currently selects **people only** and normalizes human assets downstream. | Do not route arbitrary furniture through this importer unchanged. Add an object-specific transform/import contract. |
| `src/neural-asset-validation.ts` | Explicit model allowlist, ordinary self-contained GLB, 32 MiB / 200k vertex / 500k triangle limits. | New model IDs, MHR output and splats need explicit contracts; a PLY is not an accepted GLB. |

## Methods and models to adapt

### Scene detail and parallax

| Project / exact model | Method to adopt | Practical decision |
|---|---|---|
| [3D Photo Inpainting](https://github.com/vt-vl-lab/3d-photo-inpainting) | Layered Depth Image with explicit connectivity; inpaint **color and depth** behind occlusion boundaries. Its [download script](https://github.com/vt-vl-lab/3d-photo-inpainting/blob/master/download.sh) identifies `edge-model.pth`, `depth-model.pth`, `color-model.pth` and MiDaS dependencies. | Direct method reference for revealed gaps. MIT repository; port the representation/algorithm rather than transplant its old Python 3.7/PyTorch 1.4 environment. |
| [Depth Anything V2](https://github.com/DepthAnything/Depth-Anything-V2), `depth-anything/Depth-Anything-V2-Small-hf`, official `depth_anything_v2_vits.pth` | Stronger resolution-controlled baseline. Upstream explicitly permits larger inference input and notes OpenCV/Pillow preprocessing differences. | Small is Apache 2.0; Base/Large/Giant have CC BY-NC terms. Preserve the current ONNX version as a distinct comparator and record preprocessing. |
| [Depth Pro](https://github.com/apple-aiml-research/ml-depth-pro), `depth_pro.pt` | High-resolution metric depth, boundary preservation and focal estimation; upstream includes depth-boundary evaluation helpers. | First new depth candidate. [Official weights manifest](https://github.com/apple-aiml-research/ml-depth-pro/blob/main/get_pretrained_models.sh); [Apple license](https://github.com/apple-aiml-research/ml-depth-pro/blob/main/LICENSE). Returns meters/focal pixels. Reference checkpoint differs from the paper model; do not quote paper accuracy as reproduced. |
| [Depth Anything 3](https://github.com/ByteDance-Seed/Depth-Anything-3), `depth-anything/DA3METRIC-LARGE`, `DA3MONO-LARGE`, `DA3-BASE` | Metric/relative depth or joint depth-camera evidence with confidence. | These checkpoints are Apache 2.0. Follow upstream metric-only scaling (`focal * net_output / 300`); verify adapter units. Base has no Gaussian head. Native Windows CPU feasibility remains unmeasured. |
| [Apple SHARP](https://github.com/apple-aiml-research/ml-sharp), `sharp_2572gikvuh.pt` | Depth-based two-layer Gaussian prediction, source RGB initialization and learned refinement for nearby viewpoints. | Research comparison only: [model license](https://github.com/apple-aiml-research/ml-sharp/blob/main/LICENSE_MODEL) excludes product development. Prediction supports CPU/CUDA/MPS; built-in video rendering requires CUDA. PLY output needs a splat renderer and a separate Quest resource budget. |
| [Flash3D](https://github.com/eldar/flash3d), `einsafutdinov/flash3d` / `model_re10k_v2.pth` | UniDepth foundation depth with layered Gaussian residuals; additional layers sit behind the observed surface. | Useful architectural comparison. CUDA-oriented setup; inspect dependency licenses before vendoring. The author's model page labels weights MIT, but that alone does not establish every dependency's terms. |

DA3's official table distinguishes checkpoints: corrected `DA3-GIANT-1.1` and `DA3NESTED-GIANT-LARGE-1.1` have Gaussian heads and CC BY-NC terms. Do not silently substitute the original pre-fix checkpoints, assume the smaller variants output splats, or transfer one variant's license to another. [Official model table](https://github.com/ByteDance-Seed/Depth-Anything-3#-model-cards).

### People, hands and clothing

| Project / exact model | Method to adopt | Practical decision |
|---|---|---|
| [SAM 3D Body](https://github.com/facebookresearch/sam-3d-body), `facebook/sam-3d-body-dinov3` or `facebook/sam-3d-body-vith` | Mask/box/keypoint-conditioned full body fitting with hand refinement and camera evidence. | First richer human estimator to benchmark on a GPU worker. Gated weights, [custom SAM license](https://github.com/facebookresearch/sam-3d-body/blob/main/LICENSE). Its implementation explicitly uses CUDA; no turnkey CPU or minimum VRAM claim is established here. |
| [MHR](https://github.com/facebookresearch/MHR), `mhr_model.pt` | Reusable articulated body rig, differentiable fitting and seven LODs. | Apache 2.0 rig, separate from Body's model license. It is a body representation, not an image estimator or clothing generator. |
| [ECON](https://github.com/YuliangXiu/ECON) | Fitted body prior → front/back clothed normals → detailed surface integration → completion. [Tuning notes](https://github.com/YuliangXiu/ECON/blob/master/docs/tricks.md) include `texture_src: image` and difficult-pose fitting choices. | Copy the staged methodology. Noncommercial research and separate SMPL-X asset terms apply to its implementation. It does not justify replacing visible clothes with a generic body. |
| [SiTH](https://github.com/SiTH-Diffusion/SiTH), `hohs/SiTH-diffusion-1K`, `checkpoints/recon_model.pth` | Body prior plus conditioned back-view synthesis and textured geometry. | Optional completion experiment; the back is hallucinated. Ubuntu/CUDA/RTX 3090 tested by authors. MIT code does not supersede SMPL-X asset terms. |

SAM Body's [estimator](https://github.com/facebookresearch/sam-3d-body/blob/main/sam_3d_body/sam_3d_body_estimator.py) accepts externally supplied boxes/masks and intrinsics. Use its full body/hand inference and preserve `pred_vertices`, `pred_cam_t`, `focal_length`, pose/hand/shape parameters and crop transforms. The current implementation expects a tensor for supplied intrinsics despite an annotation suggesting NumPy. Pin and test that API. MHR70 output must not be relabeled as MediaPipe's 33-joint output.

Additional baselines are [4D-Humans/HMR2](https://github.com/shubham-goel/4D-Humans) for pose/tracking, [HaMeR](https://github.com/geopavlakos/hamer) for visible hands, and [SMPLest-X](https://github.com/wqyin/SMPLest-X) for whole-body estimation. These add body-model dependencies and do not themselves recover faithful clothing texture. Prefer one integrated Body experiment before adding several overlapping estimators.

### Objects, masks and materials

| Project / exact model | Method to adopt | Practical decision |
|---|---|---|
| [SAM 3D Objects](https://github.com/facebookresearch/sam-3d-objects), `facebook/sam-3d-objects` | Full image plus instance mask → geometry, texture and inferred placement. Retains surrounding context. | Best conceptual match for cluttered café furniture. [Official setup](https://github.com/facebookresearch/sam-3d-objects/blob/main/doc/setup.md): Linux 64-bit, NVIDIA 32 GB+ VRAM, gated weights/custom SAM terms. Its [Body alignment notebook](https://github.com/facebookresearch/sam-3d-objects/blob/main/notebook/demo_3db_mesh_alignment.ipynb) is especially relevant to people and held objects sharing one frame. |
| [TRELLIS.2](https://github.com/microsoft/TRELLIS.2), `microsoft/TRELLIS.2-4B` | O-Voxel geometry/material representation; useful for thin/open structures and PBR object assets. | Clean isolated masked crops; MIT code/weights, Linux tested, NVIDIA 24 GB+ VRAM. Does not automatically recover scene placement. |
| [TRELLIS](https://github.com/microsoft/TRELLIS), `microsoft/TRELLIS-image-large` | Structured latents yielding meshes/Gaussians/radiance fields; experimental multi-image conditioning. | MIT, NVIDIA 16 GB+ official requirement. Its multi-image algorithm is not proof that unrelated album images form one reconstruction. |
| [Hunyuan3D 2.1](https://github.com/Tencent-Hunyuan/Hunyuan3D-2.1), `tencent/Hunyuan3D-2.1` | Separate shape (`hunyuan3d-dit-v2-1`, `hunyuan3d-vae-v2-1`) and PBR paint (`hunyuan3d-paintpbr-v2-1`) stages. | 10 GB shape / 21 GB paint / 29 GB combined per upstream. [Custom Tencent license](https://github.com/Tencent-Hunyuan/Hunyuan3D-2.1/blob/main/LICENSE) with territory/use conditions; not an MIT substitute. |
| [Stable Fast 3D](https://github.com/Stability-AI/stable-fast-3d), `stabilityai/stable-fast-3d` | UV-textured mesh, material prediction and illumination disentanglement. | Possible later CPU experiment; Windows support experimental. Gated weights/Community License. No local runtime/quality measurement yet. |
| [TripoSR](https://github.com/VAST-AI-Research/TripoSR), `stabilityai/TripoSR` | Triplane geometry/color baseline; upstream also supports texture baking. | Already tested locally; MIT. Increasing marching-cubes resolution only samples the existing field more densely. Keep recorded measurements in [the existing runner notes](../scripts/neural/README.md). |
| [InstantMesh](https://github.com/TencentARC/InstantMesh), `TencentARC/InstantMesh` / `instant_mesh_large.ckpt` | Customized Zero123++ view synthesis followed by sparse-view mesh reconstruction. | CUDA experiment; synthesized views are inferred, not additional observations. Repo/checkpoint Apache 2.0, dependencies separately licensed. |

For segmentation, compare [SAM 2.1](https://github.com/facebookresearch/sam2) (`sam2.1_hiera_large.pt`, Apache 2.0) or [SAM 3](https://github.com/facebookresearch/sam3) (`facebook/sam3`, gated/custom terms) on the hardest instances. SAM 3 supports concept-conditioned instance segmentation but has a newer CUDA/Python stack; keep it separate from Body's environment. The current ONNX OWLv2/Grounding DINO/SlimSAM path should remain the measured CPU baseline.

## Concrete implementation batches

These are engineering adaptations of the cited methods, not a claim that any single paper implements this exact combined system.

### A. Preserve thin details and fill actual disocclusions

1. Keep a high-resolution depth artifact separately from the runtime mesh LOD. Record actual model dimensions and preprocessing. First compare retained inference depth against the existing 256 px artifact; then vary inference resolution, one factor at a time.
2. Preserve one camera: original dimensions, oriented dimensions, crop/padding transforms, `fx/fy/cx/cy`, depth units/convention and camera coordinate convention. Depth Pro's meters cannot be fed into the current normalized inverse-depth mapping unchanged.
3. Store foreground/background connectivity at real depth discontinuities. A semantic mask boundary is not automatically a geometric break. Add a hidden depth/color layer behind an occluder with a minimum ordering margin; keep observed pixels unchanged.
4. Refine mesh sampling where annotated poles, table rims and chair legs require it. Test continuity within each structure without bridging foreground to background. Use layer-aware LOD/decimation and bound triangles/frame time.
5. Align occlusion removal with accepted replacements. Do not erase a photographed person before a replacement satisfies the source-view acceptance criteria.

### B. Fit poses to evidence, then retain identity and clothes

Use existing per-person crops/masks and MediaPipe as the immediate route. Add SAM Body as an independently cached backend once its worker is available. Fit camera/translation, body pose and silhouette before texture baking. Keep source head/clothing RGB on camera-visible surfaces; use fallback/generated appearance only elsewhere.

Crossed arms need front/back limb ordering and self-contact constraints. A hand at the chin needs wrist/finger orientation and contact evidence. A hand in a pocket should remain occluded by clothing; never force a visible hand into the scene to satisfy a guessed skeleton. Confidence-weight observed joints, disable unsupported contact constraints, and retain the photographed representation for tiny/cropped/occluded people that fail fitting. None of these poses is guaranteed by a model name.

A suitable fitting objective is a weighted combination of visible-keypoint reprojection, silhouette/boundary distance, relative depth ordering, pose prior and observed contact error. Tune these on a validation subset; do not use unobserved joints as ground truth or choose arbitrary weights from an unrelated paper. This objective is a proposal for the app, not an implemented optimizer.

### C. Reconstruct each object in its scene

Store instance ID, visible mask, original box, crop transform, ambiguous category candidates, shared camera, inferred depth/scale, support/hand contacts and provenance. Route the original image plus mask to SAM Objects; route a padded aspect-preserving cutout to TRELLIS.2/SF3D. Those are different input contracts.

Optimize rigid object pose/scale against the source silhouette and occlusion evidence. Fit the phone to a supported hand contact and depth order; fit furniture to supported ground/table relationships. A generated canonical object alone has no reliable scene transform. Keep unknown/ambiguous labels when a table/bed decision is unsupported.

Reuse source-photo visibility tests for UV baking onto accepted geometry. A phone texture must exclude the hand/background. Captured RGB already contains lighting: keep an unlit photographic appearance for matching; evaluate delit PBR separately for relighting.

### D. Use real extra views when available

Cluster only images with real overlap and consistent scene identity. Exclude moving people from static camera/scene optimization unless using a supported dynamic method. [VGGT](https://github.com/facebookresearch/vggt) can estimate cameras/depth and export COLMAP; its original and `facebook/VGGT-1B-Commercial` checkpoints have different terms. [DUSt3R](https://github.com/naver/dust3r) offers dense pairwise alignment but has noncommercial/share-alike conditions. [MVSplat](https://github.com/donydchen/mvsplat) and [pixelSplat](https://github.com/dcharatan/pixelsplat) assume sparse posed views; they are not single-photo asset generators. Check their exact data, pose and dependency contracts before use.

## Evaluation and promotion protocol

Capture the source camera and a fixed set of small camera translations using saved matrices, not 450 ms of key presses. Start with the first three café images, then include crowded people, pocket/crossed-arm/chin poses when present, thin structures, text, glass and indoor/outdoor scenes. Hold out some examples from tuning.

1. **Source view:** compare clean canvas renders against the same oriented reference at identical dimensions and framing. Measure image error globally and separately over faces, clothing, text and thin objects; also measure silhouette overlap/boundary error and visible-joint reprojection.
2. **Nearby views:** inspect fixed left/right/up/down translations and stereo eye offsets for holes, duplicated subjects, detached textures, broken poles and incorrect occlusion. Source-camera similarity alone can reward a flat billboard.
3. **Held-out real views:** when real overlapping images exist, compare against withheld images with calibrated cameras. This is different from comparing an offset render to the source photograph. Generated views do not count as ground truth.
4. **Practical costs:** record latency, RAM/VRAM, artifact sizes, triangle/splat counts, frame time and failure coverage. Report per-photo failures; do not hide them in averages.

The standalone [source-view evaluator](../scripts/fidelity/README.md) implements normalized MAE, RMSE and PSNR plus a changed-pixel fraction for baseline/candidate and named mask regions. It rejects mismatched dimensions, transparent inputs and empty regions. It performs no alignment, resizing or automatic quality approval. It is independent metric code, not copied from restricted upstream code. [3D Gaussian Splatting's evaluation](https://github.com/graphdeco-inria/gaussian-splatting/blob/main/metrics.py) provides the related evaluation precedent of PSNR/SSIM/LPIPS on matched rendered/reference views; this lightweight tool does **not** implement SSIM or LPIPS.

Existing album screenshots contain UI, differing viewport framing and camera controls; they are qualitative evidence and are not ready-made quantitative image pairs. Export clean aligned renders before claiming a measured score. Inspect source ROIs even when an aggregate score improves. The 10/255 changed-pixel threshold in the tool is a diagnostic convention, not a perceptual acceptance threshold.

A candidate may replace a subject only after source silhouette/visible appearance and the fixed-motion review pass. Failed candidates keep their photographic fallback. A completed process or imported GLB is not evidence of improved fidelity.

## Reproducibility and ownership

For each experiment record source SHA256, repo commit, checkpoint repository/file/revision/hash, license/version, input transformations, camera/depth conventions, seed, output hash, timings and explicit acceptance status. Model names above are exact selections to investigate; unspecified revisions are **not pinned**. Resolve and hash downloaded artifacts before a measured run.

The implementation chat owns runtime changes in its `photo-scene-improvements` worktree. This research task owns only this new document and `scripts/fidelity/`. No changes to the running photo-test baseline are needed to use this handoff. New model backends, additional depth artifacts and schema changes should use separate caches and retain existing validation, failure fallback and room-sharing contracts.

Validation of the delivered tooling: **11/11 focused tests passed**, standalone strict TypeScript checks passed (Bundler and NodeNext resolution), and formatting completed. These checks validate the evaluator; they do not measure a model's fidelity. Run `npx tsx --test scripts/fidelity/evaluate.test.ts` to repeat the focused checks. No application test suite was rerun because application code was unchanged.
