import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { HUMAN_POSE_LANDMARK_NAMES, type HumanPose } from "../types";
import { fitHumanPose, projectPosePoint } from "./human-pose";
import { humanPoseScales, layoutHumanBodies } from "./human-layout";

function fixture(seated = false): HumanPose {
  const joints: Record<number, number[]> = {
    0: [0, 0.69, 0.04],
    2: [-0.033, 0.72, 0.03],
    5: [0.033, 0.72, 0.03],
    7: [-0.08, 0.7, 0],
    8: [0.08, 0.7, 0],
    11: [-0.195, 0.46, 0],
    12: [0.195, 0.46, 0],
    13: [-0.25, 0.18, 0.02],
    14: [0.25, 0.18, 0.02],
    15: [-0.27, -0.07, 0.04],
    16: [0.27, -0.07, 0.04],
    23: [-0.103, 0, 0],
    24: [0.103, 0, 0],
    25: [-0.11, seated ? -0.12 : -0.415, seated ? 0.39 : 0.02],
    26: [0.11, seated ? -0.12 : -0.415, seated ? 0.39 : 0.02],
    27: [-0.12, seated ? -0.51 : -0.82, seated ? 0.38 : 0],
    28: [0.12, seated ? -0.51 : -0.82, seated ? 0.38 : 0],
    29: [-0.12, seated ? -0.56 : -0.87, seated ? 0.35 : -0.03],
    30: [0.12, seated ? -0.56 : -0.87, seated ? 0.35 : -0.03],
    31: [-0.12, seated ? -0.57 : -0.88, seated ? 0.52 : 0.14],
    32: [0.12, seated ? -0.57 : -0.88, seated ? 0.52 : 0.14],
  };
  return {
    version: 1,
    source: "mediapipe-pose",
    model: "pose-landmarker-full",
    confidence: 0.95,
    observedFraction: 1,
    sourceBox: [0, 0, 1, 1],
    landmarks: HUMAN_POSE_LANDMARK_NAMES.map((name, i) => {
      const [x, y, z] = joints[i] ?? [0, 0.69, 0];
      return {
        name,
        image: [0.5 + x * 0.4, 0.45 - y * 0.4, -z * 0.4],
        world: [x, -y, -z],
        visibility: 0.98,
        presence: 0.99,
      };
    }),
  };
}
const image = { width: 1000, height: 1000 };

test("native ImageData-style dimension getters produce finite world placements", () => {
  const browserImage = Object.create(
    {},
    {
      width: { get: () => 1000 },
      height: { get: () => 1000 },
    },
  ) as { width: number; height: number };
  assert.deepEqual(
    { ...browserImage },
    {},
    "native dimensions are not enumerable own properties",
  );
  const rig = fitHumanPose(fixture(), browserImage)!;
  assert.deepEqual(rig.sourceSize, image);
  const pixels = { width: 8, height: 8, data: new Uint8Array(256).fill(255) };
  const positions = layoutHumanBodies(
    [{ poseRig: rig, box: [0, 0, 1, 1], mask: pixels, bodyMinY: -0.9 }],
    pixels,
  );
  assert.ok(
    positions.flat().every(Number.isFinite),
    "undefined dimensions must never poison camera bounds",
  );
});

test("observed seated hips and folded knees remain bent in a complete 3D skeleton", () => {
  const standing = fitHumanPose(fixture(), image)!;
  const seated = fitHumanPose(fixture(true), image)!;
  assert.ok(seated.joints.leftKnee.z - seated.joints.leftHip.z > 0.3);
  assert.ok(seated.joints.leftAnkle.y > standing.joints.leftAnkle.y + 0.2);
  const thigh = seated.joints.leftKnee
    .clone()
    .sub(seated.joints.leftHip)
    .normalize();
  const calf = seated.joints.leftAnkle
    .clone()
    .sub(seated.joints.leftKnee)
    .normalize();
  assert.ok(
    Math.abs(thigh.dot(calf)) < 0.55,
    "a seated thigh and calf do not become a standing leg",
  );
  assert.ok(standing.joints.leftAnkle.y < -0.75);
});

test("raised arms retain source side under a mirrored photograph", () => {
  const pose = fixture();
  for (const [index, x, y] of [
    [13, -0.28, 0.72],
    [15, -0.25, 0.98],
  ]) {
    pose.landmarks[index].world = [x, -y, 0];
    pose.landmarks[index].image = [0.5 + x * 0.4, 0.45 - y * 0.4, 0];
  }
  const rig = fitHumanPose(pose, image)!;
  assert.ok(rig.joints.leftWrist.y > rig.joints.head.y);
  const mirrored = structuredClone(pose);
  mirrored.landmarks.forEach((lm) => {
    lm.image[0] = 1 - lm.image[0];
    lm.world[0] *= -1;
  });
  const other = fitHumanPose(mirrored, image)!;
  assert.ok(other.joints.rightWrist.y > other.joints.head.y);
  assert.ok(
    Math.abs(rig.joints.leftWrist.x + other.joints.rightWrist.x) < 1e-8,
  );
});

test("a horizontal torso remains horizontal instead of being forced into a standing avatar", () => {
  const pose = fixture();
  pose.landmarks.forEach((lm) => {
    const [x, y, z] = lm.world;
    lm.world = [-y, x, z];
    lm.image = [0.5 - y * 0.4, 0.45 - x * 0.4, lm.image[2]];
  });
  const rig = fitHumanPose(pose, image)!;
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(rig.torsoQuaternion);
  assert.ok(Math.abs(up.x) > 0.98);
  assert.ok(Math.abs(rig.joints.shoulders.y - rig.joints.hips.y) < 0.01);
});

test("weak out-of-frame limbs use bounded anatomy instead of hallucinated detector coordinates", () => {
  const pose = fixture();
  for (const i of [25, 27, 29, 31]) {
    pose.landmarks[i].world = [3, -3, 3];
    pose.landmarks[i].image = [2, -2, 3];
    pose.landmarks[i].visibility = 0.05;
  }
  const rig = fitHumanPose(pose, image)!;
  assert.ok(
    rig.joints.leftKnee.y < -0.3 && Math.abs(rig.joints.leftKnee.x) < 0.2,
  );
  assert.ok(rig.joints.leftAnkle.distanceTo(rig.joints.leftKnee) <= 0.52);
  assert.equal(rig.confidenceByJoint.leftAnkle, 0.05);
  assert.equal(fitHumanPose({ ...pose, confidence: 0.1 }, image), undefined);
});

test("one occluded shoulder retains the visible seated body and raised elbow", () => {
  const pose = fixture(true);
  pose.landmarks[11].visibility = 0.2;
  pose.landmarks[13].world = [-0.27, -0.75, -0.02];
  pose.landmarks[13].image = [0.5 - 0.27 * 0.4, 0.45 - 0.75 * 0.4, -0.02 * 0.4];
  const rig = fitHumanPose(pose, image)!;
  assert.ok(
    rig,
    "partial visibility must not replace the whole pose with a standing fallback",
  );
  assert.ok(rig.joints.leftKnee.z > 0.3, "visible seated leg remains bent");
  assert.ok(
    rig.joints.leftElbow.y > rig.joints.leftShoulder.y,
    "visible elbow guides an inferred shoulder connection",
  );
  assert.equal(rig.confidenceByJoint.leftShoulder, 0.2);
  assert.ok(
    Object.values(rig.joints).every((p) => p.toArray().every(Number.isFinite)),
  );
});

test("an uncertain crossing leg is bounded while an observed cross-legged pose is retained", () => {
  const pose = fixture(true);
  pose.landmarks[25].world = [0.23, 0.2, -0.08];
  pose.landmarks[25].image = [0.5 + 0.23 * 0.4, 0.45 + 0.2 * 0.4, -0.08 * 0.4];
  const observed = fitHumanPose(pose, image)!;
  const adduction = (rig: NonNullable<ReturnType<typeof fitHumanPose>>) => {
    const thigh = rig.joints.leftKnee
      .clone()
      .sub(rig.joints.leftHip)
      .normalize();
    return thigh.dot(
      new THREE.Vector3(1, 0, 0).applyQuaternion(rig.torsoQuaternion),
    );
  };
  assert.ok(
    adduction(observed) > 0.6,
    "visible crossing legs remain observed evidence",
  );
  pose.landmarks[27].visibility = 0.2;
  const inferred = fitHumanPose(pose, image)!;
  assert.ok(
    adduction(inferred) <= 0.500001,
    "uncertain extrapolated leg cannot run across the neighbor",
  );
});

test("pose-local texture registration sends joint endpoints back to their original source pixels", () => {
  const rig = fitHumanPose(fixture(true), image)!;
  for (const [joint, part] of [
    ["leftElbow", "left-upper-arm"],
    ["rightWrist", "right-forearm"],
    ["leftKnee", "left-thigh"],
  ] as const) {
    const p = projectPosePoint(rig.joints[joint], rig, image, part);
    const expected = rig.pose.landmarks[rig.sourceLandmarkIndex[joint]].image;
    assert.ok(
      Math.abs(p.u - expected[0]) < 1e-9 && Math.abs(p.v - expected[1]) < 1e-9,
    );
  }
});

test("layout retains source spacing and relative scale while grounding each articulated body", () => {
  const first = fitHumanPose(fixture(), image)!,
    shifted = fixture(true);
  shifted.landmarks.forEach((lm) => {
    lm.image[0] = 0.5 + (lm.image[0] - 0.5) * 0.7 + 0.1;
    lm.image[1] += 0.08;
  });
  const second = fitHumanPose(shifted, image)!;
  const pixels = { width: 8, height: 8, data: new Uint8Array(256).fill(255) };
  const scales = humanPoseScales([{ poseRig: first }, { poseRig: second }]);
  assert.ok(scales[1] < scales[0]);
  const subjects = [first, second].map((poseRig, i) => ({
    poseRig,
    mask: pixels,
    box: [0, 0, 1, 1] as [number, number, number, number],
    bodyScale: scales[i],
    bodyMinY: i === 0 ? -0.9 : -0.55,
  }));
  const positions = layoutHumanBodies(subjects, pixels);
  assert.ok(positions[1][0] > positions[0][0]);
  assert.ok(positions[1][1] < positions[0][1]);
  subjects.forEach((subject, i) =>
    assert.ok(
      Math.abs(positions[i][1] + subject.bodyMinY * subject.bodyScale) < 1e-9,
    ),
  );
  assert.ok(
    positions[1][0] - positions[0][0] < 0.76,
    "observed overlaps do not create an artificial row",
  );
  assert.ok(positions.flat().every(Number.isFinite));
});

test("occluded rear-row feet rest on the floor without straightening their inferred body pose", () => {
  const front = fitHumanPose(fixture(true), image)!,
    hidden = fixture();
  hidden.landmarks.forEach((lm) => {
    lm.image[1] -= 0.23;
  });
  for (const i of [27, 28, 29, 30, 31, 32])
    hidden.landmarks[i].visibility = 0.2;
  const rear = fitHumanPose(hidden, image)!,
    before = rear.joints.leftKnee.toArray();
  const pixels = { width: 8, height: 8, data: new Uint8Array(256).fill(255) };
  const subjects = [front, rear].map((poseRig, i) => ({
    poseRig,
    mask: pixels,
    box: [0, 0, 1, 1] as [number, number, number, number],
    bodyScale: i ? 0.8 : 1,
    bodyMinY: i ? -0.94 : -0.58,
  }));
  const positions = layoutHumanBodies(subjects, pixels);
  subjects.forEach((s, i) =>
    assert.ok(
      Math.abs(positions[i][1] + s.bodyMinY * s.bodyScale) < 1e-9,
      "no body floats above the ground",
    ),
  );
  assert.deepEqual(
    rear.joints.leftKnee.toArray(),
    before,
    "grounding is translation only",
  );
  assert.ok(front.joints.leftKnee.z > 0.3, "the seated figure stays seated");
});

test("small photographed people move into depth instead of becoming tiny adults", () => {
  const near = fitHumanPose(fixture(), image)!,
    distant = fixture();
  distant.landmarks.forEach((lm) => {
    lm.image[0] = 0.62 + (lm.image[0] - 0.5) * 0.32;
    lm.image[1] = 0.45 + (lm.image[1] - 0.45) * 0.32;
  });
  const far = fitHumanPose(distant, image)!,
    rigs = [near, far];
  const scales = humanPoseScales(rigs.map((poseRig) => ({ poseRig })));
  assert.ok(scales.every((s) => s >= 0.85 && s <= 1.15));
  const pixels = { width: 8, height: 8, data: new Uint8Array(256).fill(255) };
  const positions = layoutHumanBodies(
    rigs.map((poseRig, i) => ({
      poseRig,
      mask: pixels,
      box: [0, 0, 1, 1] as [number, number, number, number],
      bodyScale: scales[i],
      bodyMinY: -0.9,
    })),
    pixels,
    1.25,
    { fov: 60 },
  );
  assert.ok(
    positions[1][2] < positions[0][2] - 2,
    "separate photographed rows occupy genuinely different depths",
  );
  const focal = image.height / (2 * Math.tan(Math.PI / 6));
  positions.forEach((p, i) => {
    const u = 0.5 + ((p[0] / -p[2]) * focal) / image.width;
    assert.ok(
      Math.abs(u - rigs[i].sourceAnchor[0]) < 1e-9,
      "placement stays on the photographed camera ray",
    );
  });
});
