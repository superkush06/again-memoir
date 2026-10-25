import test from 'node:test';
import assert from 'node:assert/strict';
import { associatePoses, constrainPoseToMask, type PoseDetection } from './pose-estimation.js';
import { HUMAN_POSE_LANDMARK_NAMES, type HumanPose, type WorldCompletion } from '../src/types.js';

function pose(x: number): HumanPose {
  return { version: 1, source: 'mediapipe-pose', model: 'pose-landmarker-full', confidence: .9, observedFraction: 1,
    sourceBox: [0, Math.max(0, x - .2), 1, Math.min(1, x + .2)],
    landmarks: HUMAN_POSE_LANDMARK_NAMES.map((name, i) => ({ name, image: [x, i < 11 ? .2 : .6, 0], world: [0, 0, 0], visibility: .9, presence: .9 })) };
}
const subjects: WorldCompletion['subjects'] = [
  { id: 'left', label: 'person', kind: 'person', box: [0, 0, 1, .8], maskUrl: '/uploads/reconstructions/test-left.png' },
  { id: 'right', label: 'person', kind: 'person', box: [0, .2, 1, 1], maskUrl: '/uploads/reconstructions/test-right.png' },
  { id: 'chair', label: 'chair', kind: 'object', box: [0, 0, 1, 1], maskUrl: '/uploads/reconstructions/test-chair.png' },
];

test('overlapping crowd boxes associate unique poses using observed person-mask pixels', () => {
  const masks = new Map(['left', 'right'].map((id, index) => [id, { width: 10, height: 10,
    data: Uint8Array.from({ length: 100 }, (_, i) => (i % 10 < 5) === (index === 0) ? 255 : 0) }]));
  const detections: PoseDetection[] = [{ pose: pose(.7), maskUrl: '/uploads/reconstructions/a.png' }, { pose: pose(.3), maskUrl: '/uploads/reconstructions/b.png' }];
  const result = associatePoses(subjects, detections, masks);
  assert.deepEqual(result.matches.map(match => [subjects[match.subject].id, match.detection]).sort(), [['left', 1], ['right', 0]]);
  assert.deepEqual(result.unmatched, []);
});

test('one pose cannot attach to two overlapping subjects and hidden joints cannot win matching', () => {
  const detection = { pose: pose(.4), maskUrl: '/uploads/reconstructions/a.png' };
  const result = associatePoses(subjects, [detection]);
  assert.equal(result.matches.length, 1);
  for (const point of detection.pose.landmarks) point.visibility = .2;
  assert.equal(associatePoses(subjects, [detection]).matches.length, 0);
});

test('a cropped or back-facing head does not prevent association from visible shoulders', () => {
  const detection = { pose: pose(.3), maskUrl: '/uploads/reconstructions/a.png' };
  for (const point of detection.pose.landmarks.slice(0, 11)) { point.image = [2, -1, 0]; point.visibility = .1; }
  const result = associatePoses([subjects[0]], [detection]);
  assert.equal(result.matches.length, 1);
});

test('mask evidence lowers confidence in a neighbour-owned limb without changing inferred shape or source points', () => {
  const original = pose(.3);
  original.landmarks[14].image = [.8, .5, .1];
  const mask = { width: 100, height: 100, data: Uint8Array.from({ length: 10000 }, (_, i) => i % 100 < 50 ? 255 : 0) };
  const constrained = constrainPoseToMask(original, mask);
  assert.equal(constrained.landmarks[14].visibility, .2);
  assert.equal(constrained.landmarks[14].presence, .9);
  assert.deepEqual(constrained.landmarks[14].image, original.landmarks[14].image);
  assert.deepEqual(constrained.landmarks[14].world, original.landmarks[14].world);
  assert.equal(constrained.landmarks[11].visibility, .9);
  assert.equal(original.landmarks[14].visibility, .9, 'Raw model evidence remains immutable.');
  assert.equal(constrained.observedFraction, 32 / 33);
});
