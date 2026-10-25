# Local face fitting inputs

These scripts extract source-photo facial landmarks on the CPU. They do not send photographs to a service. The existing `.local/triposr-venv` Python 3.11 environment can run them:

```powershell
.local/triposr-venv/Scripts/python.exe -m pip install -r scripts/face-fitting/requirements.txt
.local/triposr-venv/Scripts/python.exe scripts/face-fitting/fetch_assets.py
.local/triposr-venv/Scripts/python.exe scripts/face-fitting/extract_landmarks.py
```

The public 3.8 MB model and 46 KB canonical mesh are checksum-pinned. The code/model/canonical data come from Google's Apache 2.0 MediaPipe project. Sources: [Face Landmarker documentation](https://developers.google.com/edge/mediapipe/solutions/vision/face_landmarker/python), [canonical mesh](https://github.com/google-ai-edge/mediapipe/blob/master/mediapipe/modules/face_geometry/data/canonical_face_model.obj), [project license](https://github.com/google-ai-edge/mediapipe/blob/master/LICENSE), and [FaceMesh model card](https://storage.googleapis.com/mediapipe-assets/Model%20Card%20MediaPipe%20Face%20Mesh%20V2.pdf).

The `.local/face-fitting/{color,mono}-landmarks.json` files contain:

- Source image dimensions, file hash, reconstruction fingerprint and subject IDs.
- 478 detected `landmarks`: x/y normalized to the full original image; relative z normalized to the original image width, positive away from the camera. `landmarksPixels` has pixel equivalents.
- `screenPositionsPixels` for the first 468 landmarks, with x right, y up, z toward viewer; this accounts for image aspect ratio.
- `screenSimilarity`: least-squares proper rotation, scale in pixels per centimeter and translation. Column-vector mapping is `screen = scale * rotation * canonical + translation`.
- `unposedPositionsCm`: the detected face with the estimated similarity transform removed. This is an estimated shape, not measured geometry.
- MediaPipe's native facial transformation matrix and expression blendshapes.
- Shared canonical 468-vertex positions, UV coordinates and triangle topology. Canonical coordinates are in centimeters, with y up and z toward the viewer.

Diagnostic PNGs show the source crop and detected triangular mesh. Only the detection input is resized; no image detail is generated. The two profile faces and three frontal monochrome faces are detected. The person facing away is deliberately marked `unobserved` because their face is not present in the photo. Occluded points on every detection are inferred by the model; do not treat them as observations or project background colors onto them.

Landmark indices used for alignment: forehead 10, chin 152, nose tip 1/4, nose bridge 168, outer eye corners 33/263, inner eye corners 133/362, mouth corners 61/291. The 468-point canonical mesh excludes the additional ten iris landmarks.

## Fit complete heads

After building the corrected MakeHuman templates and reviewed hair grafts:

```powershell
.local/triposr-venv/Scripts/python.exe scripts/body-templates/build_templates.py
.local/triposr-venv/Scripts/python.exe scripts/body-hair/graft_caps.py
.local/triposr-venv/Scripts/python.exe scripts/face-fitting/fit_heads.py
```

The last command compares rigid pose fitting with a bounded smooth correction for all three body shapes. It writes review-only GLBs and a numerical report under `.local/face-fitting/fitted/`. The full head mesh, UV topology and body remain intact. Pose uses observed landmarks with a prior from MediaPipe; occluded profile landmarks have reduced weight. Facial displacement is capped at 8 mm, and candidates with flipped face triangles or excessive triangle collapse are rejected. The neck blends below the true chin, so the jaw and facial features turn together.

Each GLB embeds a calibrated source camera in `scene.extras.photoFaceFit`. The viewer skips the old yaw-only deformation for these already posed heads. A separate image-space correction, limited to 12 source pixels, aligns the eyes and lips without further distorting anatomy. The photographic UV bake retains source RGB values. A mirrored facial view supplies estimated texture on the unseen cheek/eye before the observed photograph takes priority; it is restricted to facial skin and eyes, excluding the neck, skull and clothing.

Review both source and offset viewpoints before importing selected files with `scripts/import-neural-asset.ts`. Import configs use the ordinary MakeHuman anatomical-template descriptor and three shape paths; calibration travels inside each GLB. The importer validates geometry, copies content-hashed assets and saves the previous reconstruction manifest. Changing body shape retains each shape's calibrated head.

These scripts target the five detectable faces in the two reviewed memories. The back-facing person has no observed face and retains the inferred head. Single-view depth, unseen details and facial symmetry are estimates; this pipeline does not recover a person's exact 3D face or add genuine image resolution.
