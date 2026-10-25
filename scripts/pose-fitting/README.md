# Local body-pose evidence

The reconstruction server now estimates 33 joints per detected person automatically.
It stores source-aligned 2D coordinates, hip-relative 3D coordinates in meters, and
separate visibility/presence scores. Sitting, raised arms, crouching and sideways
limbs use the observed joint arrangement instead of deriving a standing skeleton
from the bounding box. Occluded joints are estimates, not recovered observations.
After matching, image points outside that person's segmented silhouette have their
visibility capped at 0.2; the original inferred coordinates and presence remain.
This keeps a confidently mislocalized neighbour's limb from being treated as an
observed limb of the current person. Raw model output remains separately cached.

MediaPipe **Heavy** is the default. In the current Carriage group-photo comparison,
Heavy retained one additional distinct person and better localized an occluded
upper torso than Full. Full remains an optional faster CPU choice. Neither model
recovered every person or invisible limb reliably in that crowded photograph.

## Setup

Use Python 3.11 in a dedicated environment:

```powershell
python -m venv .venv-pose
.venv-pose/Scripts/python -m pip install -r scripts/pose-fitting/requirements.txt
.venv-pose/Scripts/python scripts/pose-fitting/fetch_model.py
```

The downloader retrieves pinned Google data files and checks SHA256: Heavy is
30.7 MB, optional Full is 9.4 MB, and the face-proposal model is 3.8 MB. Files stay
under ignored `data/models/mediapipe`; no external code or photographs are uploaded.
The face model only finds image-space crop proposals and deduplicates crowded
observations; it does not identify people.

Set `POSE_PYTHON_PATH` to another compatible interpreter if necessary. The server
otherwise checks `.venv-pose` and then the existing development `.local/triposr-venv`.
It does not install packages or download model files during a scene request.

To use the faster model:

```powershell
.venv-pose/Scripts/python scripts/pose-fitting/fetch_model.py --variant full
$env:POSE_MODEL_VARIANT = 'full'
```

## Evidence and cache

The extractor evaluates the full frame, existing person boxes, overlapping crowd
tiles, and detected-face crop proposals. It preserves each proposal's original
image coordinates and rejects duplicate detections. Subject association uses
visible head/shoulder mask pixels rather than guessed legs; head-cropped bodies can
match through visible shoulders.

```powershell
.venv-pose/Scripts/python scripts/pose-fitting/extract_poses.py `
  --image data/uploads/example.jpg --output .local/poses.json `
  --overlay .local/poses.jpg
```

The saved JSON contains named landmarks and model-generated person masks. Reducing
the model input resolution, occlusion, or a face being turned away can materially
change detection quality. Model confidence is not an accuracy guarantee.

Cached worlds are enriched locally without repeating Gemini texture generation.
Reviewed GLB descriptors, masks and fitted-face assets remain intact. New unreviewed
worlds may gain people missed by semantic segmentation, up to 12 people. Extra pose
masks exclude already segmented people so they do not duplicate foreground pixels.
Model changes invalidate only the pose cache. Missing runtime/model failures back
off for five minutes and retry, rather than permanently freezing a failed scene.

The browser renderer decides how much of each joint estimate is safe to use. This
is a stronger pose constraint, not a photorealistic human-mesh reconstruction model.

Official references:

- [Pose Landmarker models and 33-joint convention](https://developers.google.com/edge/mediapipe/solutions/vision/pose_landmarker)
- [Python options and image/world coordinate outputs](https://developers.google.com/edge/mediapipe/solutions/vision/pose_landmarker/python)
