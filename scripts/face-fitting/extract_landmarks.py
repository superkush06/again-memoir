"""Extract source-photo face landmarks locally; no photographs leave this machine.

The result separates observed image landmarks from the generic canonical mesh.
MediaPipe's inferred occluded landmarks are NOT observations of the hidden face.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

import mediapipe as mp
import numpy as np
from PIL import Image, ImageDraw


PRESETS = {
    'color': {
        'source': 'data/uploads/e9d80ee8-3865-4e50-8603-78f022776580.jpg',
        'fingerprint': 'c31172304442754df2059a495bde9ed0',
        'faces': [
            {'id': 'subject-1', 'box': [326, 697, 544, 918]},
            {'id': 'subject-2', 'box': [320, 378, 510, 565]},
            {'id': 'subject-3', 'box': [276, 32, 474, 270], 'skip': 'Head faces away; face is not visible.'},
        ],
    },
    'mono': {
        'source': 'data/uploads/116b1c0b-6ec8-4007-9368-9af23fa6839f.jpg',
        'fingerprint': '02b903fb94fe38cb6e3daf83de3ea3dd',
        'faces': [
            {'id': 'subject-0', 'box': [540, 244, 744, 425]},
            {'id': 'subject-1', 'box': [483, 431, 693, 610]},
            {'id': 'subject-2', 'box': [474, 639, 682, 828]},
        ],
    },
}


def load_canonical(path):
    positions, texcoords, triangles, uv_triangles = [], [], [], []
    for line in path.read_text().splitlines():
        parts = line.split()
        if not parts:
            continue
        if parts[0] == 'v':
            positions.append([float(v) for v in parts[1:4]])
        elif parts[0] == 'vt':
            texcoords.append([float(v) for v in parts[1:3]])
        elif parts[0] == 'f':
            face = [p.split('/') for p in parts[1:]]
            for i in range(1, len(face) - 1):
                triangles.append([int(face[j][0]) - 1 for j in [0, i, i + 1]])
                uv_triangles.append([int(face[j][1]) - 1 for j in [0, i, i + 1]])
    return {
        'positions': positions, 'texcoords': texcoords,
        'triangles': triangles, 'uvTriangles': uv_triangles,
        'units': 'centimeters',
        'axes': '+x image-right on a frontal face, +y up, +z toward viewer',
    }


def similarity_fit(canonical, detected):
    """Least-squares rigid pose; all dimensions in consistent screen-pixel units."""
    c0, d0 = canonical.mean(0), detected.mean(0)
    c, d = canonical - c0, detected - d0
    u, s, vt = np.linalg.svd(c.T @ d)
    rotation = vt.T @ u.T
    if np.linalg.det(rotation) < 0:
        vt[-1] *= -1
        rotation = vt.T @ u.T
    scale = float(np.sum(d * (c @ rotation.T)) / np.sum(c * c))
    translation = d0 - scale * rotation @ c0
    reconstructed = scale * canonical @ rotation.T + translation
    return {
        'rotation': rotation.tolist(), 'scalePixelsPerCm': scale,
        'translationPixels': translation.tolist(),
        'rmsPixels': float(np.sqrt(np.mean(np.sum((reconstructed - detected) ** 2, axis=1)))),
    }


def crop_rect(box, size, margin):
    top, left, bottom, right = box
    cx, cy = (left + right) / 2, (top + bottom) / 2
    side = max(right - left, bottom - top) * (1 + 2 * margin)
    # Padding is valid: PIL fills beyond the image with black instead of squashing faces.
    return tuple(int(round(v)) for v in [cx-side/2, cy-side/2, cx+side/2, cy+side/2])


def extract(preset_name, out_dir, model_path, canonical):
    preset = PRESETS[preset_name]
    source_path = Path(preset['source'])
    source = Image.open(source_path).convert('RGB')
    width, height = source.size
    options = mp.tasks.vision.FaceLandmarkerOptions(
        base_options=mp.tasks.BaseOptions(model_asset_path=str(model_path)),
        running_mode=mp.tasks.vision.RunningMode.IMAGE,
        num_faces=1, min_face_detection_confidence=0.3,
        min_face_presence_confidence=0.4,
        output_facial_transformation_matrixes=True,
        output_face_blendshapes=True,
    )
    faces, summaries = [], []
    with mp.tasks.vision.FaceLandmarker.create_from_options(options) as detector:
        for face in preset['faces']:
            row = {'subjectId': face['id'], 'sourceHeadBoxPixels': face['box']}
            if face.get('skip'):
                row.update({'status': 'unobserved', 'reason': face['skip']})
                faces.append(row)
                continue
            found = None
            for margin in [0.25, 0.1, 0.5]:
                rect = crop_rect(face['box'], source.size, margin)
                crop = source.crop(rect)
                # Upsampling only stabilizes detector input; it does not add photo detail.
                sample = np.asarray(crop.resize((512, 512), Image.Resampling.LANCZOS))
                result = detector.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=sample))
                if result.face_landmarks:
                    found = (rect, crop, result, margin)
                    break
            if not found:
                row.update({'status': 'undetected', 'reason': 'No reliable MediaPipe detection across three crop margins.'})
                faces.append(row)
                continue
            rect, crop, result, margin = found
            points = result.face_landmarks[0]
            crop_width, crop_height = crop.size
            image_points = np.array([
                [(p.x * crop_width + rect[0]) / width,
                 (p.y * crop_height + rect[1]) / height,
                 p.z * crop_width / width] for p in points
            ])
            screen_points = image_points[:468] * np.array([width, -height, -width])
            fit = similarity_fit(np.asarray(canonical['positions']), screen_points)
            local_points = (screen_points - fit['translationPixels']) @ np.asarray(fit['rotation']) / fit['scalePixelsPerCm']
            row.update({
                'status': 'detected', 'cropPixels': list(rect), 'cropMargin': margin,
                'landmarks': np.round(image_points, 8).tolist(),
                'landmarksPixels': np.round(image_points * np.array([width, height, width]), 5).tolist(),
                'screenPositionsPixels': np.round(screen_points, 5).tolist(),
                'landmarkCoordinates': 'x and y normalized to original image; z relative depth normalized to original image width, positive away from viewer',
                'poseMatrix': np.asarray(result.facial_transformation_matrixes[0]).tolist(),
                'screenSimilarity': fit,
                'unposedPositionsCm': np.round(local_points, 6).tolist(),
                'blendshapes': {s.category_name: round(s.score, 6) for s in result.face_blendshapes[0]},
                'occlusionNotice': 'Occluded side coordinates are model estimates, not recovered observations.',
            })
            faces.append(row)
            overlay = crop.resize((512, 512), Image.Resampling.LANCZOS)
            draw = ImageDraw.Draw(overlay)
            for triangle in canonical['triangles']:
                corners = [(points[i].x * 512, points[i].y * 512) for i in triangle]
                draw.line(corners + [corners[0]], fill=(25, 220, 160), width=1)
            for idx in [1, 4, 10, 33, 133, 152, 168, 263, 362, 61, 291]:
                p = points[idx]
                draw.ellipse([p.x * 512 - 3, p.y * 512 - 3, p.x * 512 + 3, p.y * 512 + 3], fill='red')
                draw.text((p.x * 512 + 3, p.y * 512), str(idx), fill='white')
            overlay.save(out_dir / f'{preset_name}-{face["id"]}-landmarks.png')
            crop.resize((512, 512), Image.Resampling.LANCZOS).save(out_dir / f'{preset_name}-{face["id"]}-source.png')
            summaries.append({'subjectId': face['id'], 'rmsPixels': fit['rmsPixels'], 'scalePixelsPerCm': fit['scalePixelsPerCm']})
    output = {
        'schemaVersion': 1, 'model': 'MediaPipe FaceLandmarker float16 v1',
        'modelSha256': hashlib.sha256(model_path.read_bytes()).hexdigest(),
        'source': preset['source'], 'sourceSha256': hashlib.sha256(source_path.read_bytes()).hexdigest(),
        'fingerprint': preset['fingerprint'], 'width': width, 'height': height, 'faces': faces,
        'canonical': canonical,
    }
    path = out_dir / f'{preset_name}-landmarks.json'
    path.write_text(json.dumps(output, separators=(',', ':')) + '\n')
    print(json.dumps({'output': str(path), 'faces': summaries, 'statuses': {r['subjectId']: r['status'] for r in faces}}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--preset', choices=[*PRESETS, 'all'], default='all')
    parser.add_argument('--output', type=Path, default=Path('.local/face-fitting'))
    parser.add_argument('--model', type=Path, default=Path('.local/face-fitting/face_landmarker.task'))
    parser.add_argument('--canonical', type=Path, default=Path('.local/face-fitting/canonical_face_model.obj'))
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    canonical = load_canonical(args.canonical)
    for preset in PRESETS if args.preset == 'all' else [args.preset]:
        extract(preset, args.output, args.model, canonical)


if __name__ == '__main__':
    main()
