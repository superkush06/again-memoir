"""Local, confidence-aware multiperson landmarks in the ORIGINAL photo coordinates.

No standing-pose or body-height assumption is used. Hidden joints remain estimates
with their own visibility/presence scores; world coordinates are hip-relative meters,
not an absolute camera reconstruction. The full image and overlapping crop proposals
are evaluated, deduplicated, and returned with each model's own person mask.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

import mediapipe as mp
import numpy as np
from PIL import Image, ImageDraw, ImageOps

from fetch_model import SHA256, HEAVY_SHA256

NAMES = ('nose left_eye_inner left_eye left_eye_outer right_eye_inner right_eye '
         'right_eye_outer left_ear right_ear mouth_left mouth_right left_shoulder '
         'right_shoulder left_elbow right_elbow left_wrist right_wrist left_pinky '
         'right_pinky left_index right_index left_thumb right_thumb left_hip right_hip '
         'left_knee right_knee left_ankle right_ankle left_heel right_heel '
         'left_foot_index right_foot_index').split()
TORSO = [11, 12, 23, 24]
BODY = list(range(11, 33))
EDGES = [(11, 12), (11, 23), (12, 24), (23, 24), (11, 13), (13, 15),
         (12, 14), (14, 16), (23, 25), (25, 27), (24, 26), (26, 28),
         (27, 29), (29, 31), (28, 30), (30, 32), (0, 7), (0, 8)]


def point_confidence(point):
    return min(float(point.visibility or 0), float(point.presence or 0))


def proposals(width, height, subjects, faces):
    yield (0, 0, width, height)
    for left, top, right, bottom in faces:
        # This is only a detector proposal, not a standing-body prediction. Square
        # context includes raised arms and sideways/seated torsos around the face.
        side = max(right-left, bottom-top)*3.6
        cx, cy = (left+right)/2, (top+bottom)/2
        yield (max(0, int(cx-side*.5)), max(0, int(cy-side*.23)),
               min(width, int(cx+side*.5)), min(height, int(cy+side*.77)))
    # Cropping increases a small person's detector resolution; no pixels are invented.
    for box in subjects[:12]:
        top, left, bottom, right = box
        dx, dy = (right-left)*.16, (bottom-top)*.10
        yield (max(0, int((left-dx)*width)), max(0, int((top-dy)*height)),
               min(width, int((right+dx)*width)), min(height, int((bottom+dy)*height)))
    for left in [0, .2, .4, .6]:
        for top in [0, .2, .4]:
            yield (int(left*width), int(top*height), min(width, int((left+.4)*width)),
                   min(height, int((top+.6)*height)))


def duplicate(a, b, aspect):
    points_a, points_b = a['pose']['landmarks'], b['pose']['landmarks']
    pa, pb = points_a[0], points_b[0]
    head_distance = np.linalg.norm((np.array(pa['image'][:2])-pb['image'][:2])*[aspect, 1])
    if min(pa['visibility'], pa['presence'], pb['visibility'], pb['presence']) >= .5:
        if head_distance < .028:
            return True
        if head_distance > .05:
            return False
    # Lower limbs can be wholly occluded and change between crops. A matching visible
    # face is stronger identity evidence than those inferred hips (not face recognition).
    face_distances = []
    for i in [0, 2, 5, 7, 8]:
        p, q = points_a[i], points_b[i]
        if min(p['visibility'], p['presence'], q['visibility'], q['presence']) >= .6:
            face_distances.append(np.linalg.norm((np.array(p['image'][:2])-q['image'][:2])*[aspect, 1]))
    if len(face_distances) >= 3 and float(np.median(face_distances)) < .025:
        return True
    distances = []
    for i in [0, 11, 12, 23, 24]:
        p, q = points_a[i], points_b[i]
        if min(p['visibility'], p['presence'], q['visibility'], q['presence']) < .45:
            continue
        distances.append(np.linalg.norm((np.array(p['image'][:2])-q['image'][:2])*[aspect, 1]))
    # People touching may have overlapping boxes. Compare their actual joints instead.
    return len(distances) >= 2 and float(np.median(distances)) < .045


def extract(source_path, model_path, destination, boxes, overlay, variant='heavy'):
    if hashlib.sha256(model_path.read_bytes()).hexdigest() != (HEAVY_SHA256 if variant == 'heavy' else SHA256):
        raise ValueError('Pose model checksum mismatch; run fetch_model.py.')
    source = ImageOps.exif_transpose(Image.open(source_path)).convert('RGB')
    width, height = source.size
    face_model = model_path.with_name('face_landmarker.task')
    faces = []
    if face_model.exists() and hashlib.sha256(face_model.read_bytes()).hexdigest() == '64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff':
        face_options = mp.tasks.vision.FaceLandmarkerOptions(
            base_options=mp.tasks.BaseOptions(model_asset_path=str(face_model)),
            running_mode=mp.tasks.vision.RunningMode.IMAGE, num_faces=12,
            min_face_detection_confidence=.35, min_face_presence_confidence=.4)
        with mp.tasks.vision.FaceLandmarker.create_from_options(face_options) as face_detector:
            face_rects = [(0, 0, width, height)] + [
                (int(x*width), int(y*height), min(width, int((x+.3)*width)), min(height, int((y+.4)*height)))
                for x in [0, .175, .35, .525, .7] for y in [0, .3, .6]]
            for rect in face_rects:
                face_result = face_detector.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=np.asarray(source.crop(rect))))
                cw, ch = rect[2]-rect[0], rect[3]-rect[1]
                for points in face_result.face_landmarks:
                    box = [min(p.x for p in points)*cw+rect[0], min(p.y for p in points)*ch+rect[1],
                           max(p.x for p in points)*cw+rect[0], max(p.y for p in points)*ch+rect[1]]
                    center = np.array([(box[0]+box[2])/2, (box[1]+box[3])/2])
                    if not any(np.linalg.norm(center-[(f[0]+f[2])/2, (f[1]+f[3])/2]) < min(box[2]-box[0], box[3]-box[1])*.5 for f in faces):
                        faces.append(box)
    options = mp.tasks.vision.PoseLandmarkerOptions(
        base_options=mp.tasks.BaseOptions(model_asset_path=str(model_path)),
        running_mode=mp.tasks.vision.RunningMode.IMAGE,
        num_poses=12, min_pose_detection_confidence=.35,
        min_pose_presence_confidence=.4, output_segmentation_masks=True,
    )
    candidates, seen = [], set()
    with mp.tasks.vision.PoseLandmarker.create_from_options(options) as detector:
        for rect in proposals(width, height, boxes, faces):
            if rect in seen or rect[2]-rect[0] < 32 or rect[3]-rect[1] < 32:
                continue
            seen.add(rect)
            crop = source.crop(rect)
            crop.thumbnail((1280, 1280), Image.Resampling.LANCZOS)
            result = detector.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=np.asarray(crop)))
            cw, ch = rect[2]-rect[0], rect[3]-rect[1]
            for index, (points, world_points) in enumerate(zip(result.pose_landmarks, result.pose_world_landmarks)):
                confidences = [point_confidence(p) for p in points]
                torso_conf = sum(confidences[i] for i in TORSO)/4
                if torso_conf < .42 or sum(confidences[i] >= .45 for i in TORSO) < 2:
                    continue
                landmarks = []
                for name, p, w in zip(NAMES, points, world_points):
                    landmarks.append({'name': name, 'image': [
                        round((p.x*cw+rect[0])/width, 7), round((p.y*ch+rect[1])/height, 7),
                        round(p.z*cw/width, 7)],
                        'world': [round(w.x, 7), round(w.y, 7), round(w.z, 7)],
                        'visibility': round(float(p.visibility or 0), 7),
                        'presence': round(float(p.presence or 0), 7)})
                if any(not np.isfinite(p['image']+p['world']).all() or
                       not all(-2 <= v <= 3 for v in p['image'][:2]) or
                       abs(p['image'][2]) > 5 or max(abs(v) for v in p['world']) > 4
                       for p in landmarks):
                    continue
                mask = np.asarray(result.segmentation_masks[index].numpy_view()).copy()
                mask_image = Image.fromarray(np.uint8(np.clip(mask, 0, 1)*255)).resize((cw, ch), Image.Resampling.BILINEAR)
                full_mask = Image.new('L', (width, height))
                full_mask.paste(mask_image, rect[:2])
                bounds = full_mask.point(lambda p: 255 if p >= 128 else 0).getbbox()
                if bounds is None:
                    continue
                left, top, right, bottom = bounds
                if (right-left)*(bottom-top) < width*height*.003:
                    continue
                pose = {'version': 1, 'source': 'mediapipe-pose', 'model': f'pose-landmarker-{variant}',
                        'confidence': round(torso_conf*.65+sum(confidences[i] for i in BODY)/len(BODY)*.35, 7),
                        'observedFraction': round(sum(c >= .5 for c in confidences)/33, 7),
                        'sourceBox': [top/height, left/width, bottom/height, right/width], 'landmarks': landmarks}
                # Penalize crops that clip visible joints. Keep the candidate with most actual observations.
                rank = pose['confidence'] + pose['observedFraction']*.18
                face_index = None
                # Independent face detection rejects body crops accidentally centered
                # on another person's collar or an occluder's chest. It is optional;
                # back-facing people are retained when their head itself is hidden.
                if faces and confidences[0] > .6:
                    nose = landmarks[0]['image']
                    face_matches = [(i, ((nose[0]*width-(left+right)/2)/(right-left))**2+
                                     ((nose[1]*height-(top+bottom)/2)/(bottom-top))**2)
                                    for i, (left, top, right, bottom) in enumerate(faces)
                                    if left/width <= nose[0] <= right/width and top/height <= nose[1] <= bottom/height]
                    if not face_matches:
                        continue
                    face_index, center_error = min(face_matches, key=lambda row: row[1])
                    rank -= min(.2, center_error*.2)
                candidates.append({'pose': pose, 'mask': full_mask, 'rank': rank, 'crop': rect, 'face': face_index})
    selected = []
    for candidate in sorted(candidates, key=lambda p: p['rank'], reverse=True):
        if not any((candidate['face'] is not None and candidate['face'] == other['face']) or
                   duplicate(candidate, other, width/height) for other in selected):
            selected.append(candidate)
        if len(selected) >= 12:
            break
    selected.sort(key=lambda item: item['pose']['landmarks'][0]['image'][0])
    destination.parent.mkdir(parents=True, exist_ok=True)
    result = {'version': 1, 'model': f'pose-landmarker-{variant}', 'sourceSize': [width, height], 'poses': []}
    preview = source.copy()
    draw = ImageDraw.Draw(preview)
    for face in faces:
        draw.rectangle(face, outline=(150, 150, 255), width=2)
    for index, item in enumerate(selected):
        mask_file = destination.with_name(f'{destination.stem}-mask-{index}.png')
        item['mask'].thumbnail((512, 512), Image.Resampling.BILINEAR)
        item['mask'].save(mask_file)
        result['poses'].append({'pose': item['pose'], 'maskFile': mask_file.name})
        color = [(30, 235, 110), (245, 70, 120), (50, 160, 255), (255, 190, 20)][index % 4]
        for a, b in EDGES:
            p, q = item['pose']['landmarks'][a], item['pose']['landmarks'][b]
            if min(p['visibility'], p['presence'], q['visibility'], q['presence']) >= .5:
                draw.line([(p['image'][0]*width, p['image'][1]*height),
                           (q['image'][0]*width, q['image'][1]*height)], fill=color, width=4)
        nose = item['pose']['landmarks'][0]['image']
        draw.text((nose[0]*width, nose[1]*height-25), f'{index}: {item["pose"]["confidence"]:.2f}', fill=color)
    destination.write_text(json.dumps(result, allow_nan=False), encoding='utf-8')
    if overlay:
        preview.save(overlay)
    print(json.dumps({'detected': len(selected), 'candidates': len(candidates), 'proposals': len(seen), 'faces': len(faces)}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--image', type=Path, required=True)
    parser.add_argument('--variant', choices=['heavy', 'full'], default='heavy')
    parser.add_argument('--model', type=Path)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--subjects', type=Path, help='Optional JSON array of normalized [top,left,bottom,right] proposal boxes.')
    parser.add_argument('--overlay', type=Path)
    args = parser.parse_args()
    subject_boxes = json.loads(args.subjects.read_text()) if args.subjects else []
    model = args.model or Path(f'data/models/mediapipe/pose_landmarker_{args.variant}.task')
    extract(args.image, model, args.output, subject_boxes, args.overlay, args.variant)
