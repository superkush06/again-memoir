# Automatic human pose and proportion fitting

Research and implementation: October 24, 2026.

## Why the previous result failed

The automatic path used fixed standing-body coordinates, a mostly uniform adult height, a minimum spacing between people, and separate foot-to-floor grounding. These rules discarded the pose in the photograph. More texture generation could not repair seated people being reconstructed standing up. The earlier fitted faces and MakeHuman bodies were prepared for individual photographs; fresh imports did not receive them.

The environment also selected a fixed rectangle near the bottom of the image for floor material. With a crowded portrait, this rectangle could contain clothing or stretched occlusion filling. Repeating it covered the ground in stripes.

## Model roles

Use **a specialist pose model for geometry and Gemini for semantic/appearance information**. This is a division of responsibilities, not evidence that one general language model is universally better.

- **MediaPipe Pose Landmarker Heavy** runs locally and returns 33 image/world landmarks with confidence and optional masks. Multiple-person detection and padded source-image crops provide joint evidence. Its world coordinates are relative to each person's hips; they are not the person's position in a shared scene. Heavy is the quality default; Full remains a faster option. [Official guide](https://ai.google.dev/edge/mediapipe/solutions/vision/pose_landmarker/python).
- **Gemini** remains useful for visible descriptions, object separation, room classification, search, and plausible hidden color/texture completion. Boxes and masks are not a calibrated human mesh. Its quota or availability must not prevent local pose fitting. [Image understanding](https://ai.google.dev/gemini-api/docs/image-understanding).
- **SAM 3D Body** is a stronger candidate for a later mesh-recovery comparison, including shape, hands and uncommon poses. Its official checkpoint download requires access approval. Installation and performance must be evaluated before making it the default on this Windows CPU machine. [Repository](https://github.com/facebookresearch/sam-3d-body), [installation and checkpoint access](https://github.com/facebookresearch/sam-3d-body/blob/main/INSTALL.md).
- **MHR** is an Apache-2.0 parametric body/rig with shape and articulation parameters. It is a possible future geometry representation, rather than an image-to-pose model itself. [Official MHR repository](https://github.com/facebookresearch/MHR).

## Implemented pipeline

1. Detect people and estimate their landmarks in original-image coordinates. Retain crop transforms, 3D joints, model identity, confidence and visibility. Face-guided crops help find overlapping people; duplicate or weak body fits are not counted as recovered ground truth.
2. Associate poses with source masks. Lower visibility when a joint lands outside its assigned person's silhouette, so a neighboring person's arm is not treated as an observation. Existing curated models remain available. Cache enrichment adds local pose data without rerunning a paid social scrape or image-generation call.
3. Fit bounded shoulder/hip widths, torso and limb lengths. Use anatomical priors when joints are hidden or unreliable. A short seated bounding box is not interpreted as a short person's standing height.
4. Articulate complete anatomy from the fitted skeleton. Register source colors to posed surfaces. Use source camera rays and pixels-per-metre evidence for the group arrangement instead of enforcing a separated standing row. Apparent image size primarily changes camera distance; uniform physical scale stays within 0.85–1.15 of the fitted anatomy. Translate each completed mesh onto the ground without straightening its joints; image-space hip height alone is not evidence that someone is floating. This floor prior does not recover airborne or elevated poses without additional support-surface evidence.
5. Exclude people and filled holes when selecting a repeatable floor patch and projecting background detail onto walls. If no reliable patch remains, use a source-derived color instead of tiling human pixels.

For crowded photographs, independent body-size estimates can create false gaps in depth. Nearby, similarly sized faces with touching source silhouettes now constrain neighbouring root-depth differences to 0.45m. This is a conservative grouping prior, not a measurement of actual distance; separate silhouettes or substantially smaller distant faces retain independent depth. Reliable visible heads anchor horizontal placement on their source camera rays, accounting for the posed head's local offset. The automatic world's Front view now uses the original camera origin instead of backing away and changing the group's overlaps. Body scale, articulation and ground contact are preserved.

## Local setup

Use Python 3.11 and an isolated environment; the application does not install packages or download models during a scene request.

```powershell
python -m venv .venv-pose
.venv-pose/Scripts/python -m pip install -r scripts/pose-fitting/requirements.txt
.venv-pose/Scripts/python scripts/pose-fitting/fetch_model.py
```

`POSE_PYTHON_PATH` can select the environment's Python executable. `POSE_MODEL_VARIANT=heavy` is the default; `full` selects the faster model. Model assets live in ignored `data/models/mediapipe`. Dependency and model provenance are in the pose-fitting scripts; anatomical template provenance is included alongside the public neutral template assets. No imported personal photographs are part of those public templates.

An offline comparison on the same 1600-pixel Carriage group image found 10 distinct poses with Heavy versus 9 with Full, taking approximately 16 versus 7 seconds. Heavy recovered one additional partially occluded person and reduced confidence on hidden legs. This is one image, not a general accuracy benchmark; both models still missed people in the crowd.

## Scope and uncertainty

The articulated representation supports bent, seated, crouched, raised-arm and lying configurations. Detection does **not** recover every configuration reliably. Dense overlaps, hidden hips/feet, tiny faces and extreme foreshortening remain difficult. Inferred limbs, actual height, body thickness and invisible clothing cannot be measured uniquely from one photograph. Low-confidence joints use explicit priors, not claimed observations.

This change is not a photorealistic, identity-preserving full-scene reconstruction system. Fitting a realistic anatomical surface does not recover the actual clothing geometry, hair, face shape or hidden room. Multiple overlapping photographs or video coverage, or a separately evaluated human mesh model, remain the stronger next evidence sources.

The Carriage example's room was marked as indoor after visual review because the cloud atmosphere request was unavailable and the caption alone contains no room evidence. This reviewed classification is not an automatic room-recognition result. The scene exposes its fitted-person count and keeps two people without detected poses on the existing fallback path.
