"""Draw actual cached detections/subject associations without running inference."""
import argparse
import json
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

from extract_poses import EDGES


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--image', type=Path, required=True)
    parser.add_argument('--poses', type=Path, required=True)
    parser.add_argument('--world', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    image = Image.open(args.image).convert('RGB')
    width, height = image.size
    output = Image.new('RGB', (width+430, height), (20, 24, 30))
    output.paste(image)
    draw = ImageDraw.Draw(output)
    try:
        font = ImageFont.truetype('arial.ttf', 18)
        small = ImageFont.truetype('arial.ttf', 14)
    except OSError:
        font = small = ImageFont.load_default()
    detections = json.loads(args.poses.read_text())['poses']
    subjects = json.loads(args.world.read_text())['subjects']
    draw.text((width+18, 16), 'Local pose evidence', fill='white', font=font)
    draw.text((width+18, 45), 'Colored: visibility + presence >= 0.5\nGray points: inferred / occluded\nNo standing-pose assumption', fill='#c0c8d4', font=small)
    for index, detection in enumerate(detections):
        pose = detection['pose']
        subject = next((s for s in subjects if s.get('humanPose', {}).get('landmarks', [{}])[0].get('image') == pose['landmarks'][0]['image']), None)
        matched = subject['id'] if subject else 'unmatched'
        pose = subject['humanPose'] if subject else pose
        color = [(30, 235, 110), (245, 90, 130), (60, 175, 255), (255, 200, 35)][index % 4]
        points = pose['landmarks']
        for a, b in EDGES:
            pa, pb = points[a], points[b]
            if min(pa['visibility'], pa['presence'], pb['visibility'], pb['presence']) >= .5:
                draw.line([(pa['image'][0]*width, pa['image'][1]*height),
                           (pb['image'][0]*width, pb['image'][1]*height)], fill=color, width=3)
        for point in points:
            x, y = point['image'][0]*width, point['image'][1]*height
            if 0 <= x < width and 0 <= y < height:
                confidence = min(point['visibility'], point['presence'])
                draw.ellipse((x-2,y-2,x+2,y+2), fill=color if confidence >= .5 else (130,130,130))
        x, y = points[0]['image'][0]*width, points[0]['image'][1]*height
        draw.text((x+8, y-28), f'P{index}', fill=color, font=font, stroke_width=2, stroke_fill='black')
        row = 135+index*100
        draw.text((width+18,row), f'P{index} -> {matched}', fill=color, font=font)
        draw.text((width+18,row+27), f"Model confidence {pose['confidence']:.2f}\nVisible joints {round(pose['observedFraction']*33)}/33", fill='#dddddd', font=small)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    output.save(args.output, quality=94)


if __name__ == '__main__':
    main()
