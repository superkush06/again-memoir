import * as THREE from "three";
import type { HumanPose } from "../types";

export type HumanJoint =
  | "hips"
  | "shoulders"
  | "head"
  | `${"left" | "right"}${"Shoulder" | "Elbow" | "Wrist" | "Hip" | "Knee" | "Ankle" | "Heel" | "Toe"}`;
export interface HumanPoseRig {
  joints: Record<HumanJoint, THREE.Vector3>;
  confidenceByJoint: Record<string, number>;
  sourceLandmarkIndex: Record<string, number>;
  torsoQuaternion: THREE.Quaternion;
  shoulderWidth: number;
  hipWidth: number;
  torsoLength: number;
  sourceAnchor: [number, number];
  pixelsPerMeter: number;
  sourceSize: { width: number; height: number };
  headRoll: number;
  pose: HumanPose;
}
export function humanPoseReprojection(rig: HumanPoseRig) {
  const errors = Object.entries(rig.sourceLandmarkIndex)
    .flatMap(([name, index]) => {
      if (name === "head" || rig.confidenceByJoint[name] < 0.6) return [];
      const p = rig.joints[name as HumanJoint],
        target = rig.pose.landmarks[index].image;
      return [
        Math.hypot(
          (rig.sourceAnchor[0] - target[0]) * rig.sourceSize.width +
            p.x * rig.pixelsPerMeter,
          (rig.sourceAnchor[1] - target[1]) * rig.sourceSize.height -
            p.y * rig.pixelsPerMeter,
        ),
      ];
    })
    .sort((a, b) => a - b);
  return {
    observedJoints: errors.length,
    medianPixels: errors.length ? errors[Math.floor(errors.length / 2)] : 0,
    maximumPixels: errors.length ? errors[errors.length - 1] : 0,
  };
}
const clamp = THREE.MathUtils.clamp;
const median = (xs: number[]) =>
  [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const UP = new THREE.Vector3(0, 1, 0);

/** Recover articulated anatomy from observed joints. Image directions carry the
 * photographic pose; world depth disambiguates foreshortening. Weak joints use
 * explicit local priors, never an unreliable detector coordinate. */
export function fitHumanPose(
  pose: HumanPose | undefined,
  image: { width: number; height: number },
): HumanPoseRig | undefined {
  if (!pose || pose.landmarks.length !== 33 || pose.confidence < 0.25) return;
  const lm = pose.landmarks;
  const confidence = (i: number) => Math.min(lm[i].visibility, lm[i].presence);
  // Occlusion is per joint: one hidden shoulder must not discard a visible
  // seated torso, face or raised arm and replace the person with a standing body.
  const shouldersObserved = Math.min(confidence(11), confidence(12)) >= 0.32;
  if (Math.max(confidence(11), confidence(12)) < 0.32 && confidence(0) < 0.6)
    return;
  const world = (i: number) =>
    new THREE.Vector3(lm[i].world[0], -lm[i].world[1], -lm[i].world[2]);
  const photo = (i: number) =>
    new THREE.Vector2(
      lm[i].image[0] * image.width,
      -lm[i].image[1] * image.height,
    );
  const scales: number[] = [];
  for (const [a, b] of [
    [11, 12],
    [11, 23],
    [12, 24],
    [23, 24],
    [11, 13],
    [12, 14],
    [23, 25],
    [24, 26],
  ]) {
    if (Math.min(confidence(a), confidence(b)) < 0.5) continue;
    const w = world(a).sub(world(b));
    const px = photo(a).distanceTo(photo(b));
    const projected = Math.hypot(w.x, w.y);
    if (projected > 0.08 && px > 5) scales.push(px / projected);
  }
  const shoulderPx = photo(11).distanceTo(photo(12));
  const pixelsPerMeter = clamp(
    scales.length ? median(scales) : shoulderPx / 0.39,
    30,
    image.height * 5,
  );
  const vector = (a: number, b: number) => {
    const p = photo(b).sub(photo(a)).divideScalar(pixelsPerMeter);
    return new THREE.Vector3(p.x, p.y, clamp(world(b).z - world(a).z, -1, 1));
  };
  const length = (
    a: number,
    b: number,
    fallback: number,
    lo: number,
    hi: number,
  ) => {
    const c = Math.min(confidence(a), confidence(b));
    const measured = world(a).distanceTo(world(b));
    return THREE.MathUtils.lerp(
      fallback,
      clamp(measured, lo, hi),
      clamp((c - 0.3) / 0.5, 0, 0.85),
    );
  };
  const hipsObserved = Math.min(confidence(23), confidence(24)) >= 0.35;
  const hipMid = photo(23).add(photo(24)).multiplyScalar(0.5);
  const torsoLength = hipsObserved
    ? clamp(
        (length(11, 23, 0.47, 0.36, 0.62) + length(12, 24, 0.47, 0.36, 0.62)) /
          2,
        0.36,
        0.62,
      )
    : 0.47;
  const torsoVectors = [
    [23, 11],
    [24, 12],
  ]
    .filter(
      ([hip, shoulder]) =>
        Math.min(confidence(hip), confidence(shoulder)) >= 0.35,
    )
    .map(([hip, shoulder]) => vector(hip, shoulder));
  let torsoUp = torsoVectors.length
    ? torsoVectors.reduce((a, b) => a.add(b), new THREE.Vector3()).normalize()
    : world(11).add(world(12)).sub(world(23)).sub(world(24)).normalize();
  if (torsoUp.lengthSq() < 0.5) torsoUp = UP.clone();
  // Rig left/right names are camera-side. Keep the source association explicit:
  // a rear view reverses MediaPipe's anatomical left/right without crossing arms.
  const left = lm[11].image[0] <= lm[12].image[0] ? 11 : 12;
  const right = left === 11 ? 12 : 11;
  let across = (
    shouldersObserved ? vector(left, right) : world(right).sub(world(left))
  ).normalize();
  across.addScaledVector(torsoUp, -across.dot(torsoUp)).normalize();
  if (across.lengthSq() < 0.5) across.set(1, 0, 0);
  const front = across.clone().cross(torsoUp).normalize();
  const torsoQuaternion = new THREE.Quaternion().setFromRotationMatrix(
    new THREE.Matrix4().makeBasis(across, torsoUp, front),
  );
  const shoulderWidth = length(11, 12, 0.39, 0.29, 0.55);
  const hipWidth = hipsObserved ? length(23, 24, 0.205, 0.17, 0.34) : 0.205;
  const joints = {
    hips: new THREE.Vector3(),
    shoulders: torsoUp.clone().multiplyScalar(torsoLength),
  } as Record<HumanJoint, THREE.Vector3>;
  const anchorShoulder = confidence(11) >= confidence(12) ? 11 : 12;
  const anchorJoint = joints.shoulders
    .clone()
    .addScaledVector(
      across,
      ((anchorShoulder === left ? -1 : 1) * shoulderWidth) / 2,
    );
  const sourceAnchor: [number, number] = hipsObserved
    ? [hipMid.x / image.width, -hipMid.y / image.height]
    : [
        lm[anchorShoulder].image[0] -
          (anchorJoint.x * pixelsPerMeter) / image.width,
        lm[anchorShoulder].image[1] +
          (anchorJoint.y * pixelsPerMeter) / image.height,
      ];
  const confidenceByJoint: Record<string, number> = {
    hips: Math.min(confidence(23), confidence(24)),
    shoulders: Math.min(confidence(11), confidence(12)),
  };
  const sourceLandmarkIndex: Record<string, number> = {};
  const chain = (
    name: HumanJoint,
    parent: HumanJoint,
    a: number,
    b: number,
    fallback: THREE.Vector3,
    nominal: number,
    min: number,
    max: number,
  ) => {
    const c = Math.min(confidence(a), confidence(b));
    const measured =
      confidence(a) >= 0.38
        ? vector(a, b)
        : new THREE.Vector3(
            ((lm[b].image[0] - sourceAnchor[0]) * image.width) / pixelsPerMeter,
            (-(lm[b].image[1] - sourceAnchor[1]) * image.height) /
              pixelsPerMeter,
            world(b).z,
          ).sub(joints[parent]);
    const dir =
      confidence(b) >= 0.38 && measured.lengthSq() > 1e-5
        ? measured.normalize()
        : fallback.clone().normalize();
    joints[name] = joints[parent]
      .clone()
      .addScaledVector(dir, length(a, b, nominal, min, max));
    confidenceByJoint[name] = c;
    sourceLandmarkIndex[name] = b;
  };
  for (const [side, shoulder, sign] of [
    ["left", left, -1],
    ["right", right, 1],
  ] as const) {
    const hip = shoulder + 12,
      elbow = shoulder + 2,
      wrist = shoulder + 4,
      knee = shoulder + 14,
      ankle = shoulder + 16;
    joints[`${side}Shoulder`] = joints.shoulders
      .clone()
      .addScaledVector(across, (sign * shoulderWidth) / 2);
    joints[`${side}Hip`] = joints.hips
      .clone()
      .addScaledVector(across, (sign * hipWidth) / 2);
    for (const [name, i] of [
      [`${side}Shoulder`, shoulder],
      [`${side}Hip`, hip],
    ] as const) {
      confidenceByJoint[name] = confidence(i);
      sourceLandmarkIndex[name] = i;
    }
    chain(
      `${side}Elbow`,
      `${side}Shoulder`,
      shoulder,
      elbow,
      torsoUp
        .clone()
        .negate()
        .addScaledVector(across, sign * 0.18),
      0.29,
      0.22,
      0.38,
    );
    chain(
      `${side}Wrist`,
      `${side}Elbow`,
      elbow,
      wrist,
      joints[`${side}Elbow`].clone().sub(joints[`${side}Shoulder`]),
      0.255,
      0.2,
      0.34,
    );
    chain(
      `${side}Knee`,
      `${side}Hip`,
      hip,
      knee,
      new THREE.Vector3(0, -1, 0.04),
      0.415,
      0.32,
      0.53,
    );
    // With an uncertain ankle, a crowd detector's inward knee can otherwise
    // extrapolate an entire leg across its neighbor. Use a conservative prior
    // only for that uncertain chain; observed cross-legged poses stay intact.
    const thigh = joints[`${side}Knee`].clone().sub(joints[`${side}Hip`]);
    const thighLength = thigh.length(),
      inward = thigh.dot(across) * sign;
    const minimumLateral = -thighLength * Math.sin(Math.PI / 6);
    if (
      inward < minimumLateral &&
      (confidence(knee) < 0.6 || confidence(ankle) < 0.38)
    ) {
      const lateral = thigh.dot(across);
      const other = thigh
        .clone()
        .addScaledVector(across, -lateral)
        .normalize()
        .multiplyScalar(
          Math.sqrt(
            thighLength * thighLength - minimumLateral * minimumLateral,
          ),
        );
      joints[`${side}Knee`]
        .copy(joints[`${side}Hip`])
        .add(other)
        .addScaledVector(across, sign * minimumLateral);
    }
    chain(
      `${side}Ankle`,
      `${side}Knee`,
      knee,
      ankle,
      joints[`${side}Knee`].clone().sub(joints[`${side}Hip`]),
      0.405,
      0.3,
      0.52,
    );
    chain(
      `${side}Heel`,
      `${side}Ankle`,
      ankle,
      shoulder + 18,
      new THREE.Vector3(0, -0.45, -0.5),
      0.06,
      0.035,
      0.1,
    );
    chain(
      `${side}Toe`,
      `${side}Ankle`,
      ankle,
      shoulder + 20,
      new THREE.Vector3(0, -0.25, 1),
      0.15,
      0.1,
      0.22,
    );
  }
  const face = [0, 7, 8].filter((i) => confidence(i) > 0.45);
  const headDir = face.length
    ? face
        .map((i) =>
          new THREE.Vector3(
            ((lm[i].image[0] - sourceAnchor[0]) * image.width) / pixelsPerMeter,
            (-(lm[i].image[1] - sourceAnchor[1]) * image.height) /
              pixelsPerMeter,
            world(i).z,
          ).sub(joints.shoulders),
        )
        .reduce((a, b) => a.add(b), new THREE.Vector3())
        .normalize()
    : torsoUp;
  joints.head = joints.shoulders
    .clone()
    .addScaledVector(headDir.lengthSq() > 0.5 ? headDir : torsoUp, 0.245);
  confidenceByJoint.head = face.length
    ? face.reduce((sum, i) => sum + confidence(i), 0) / face.length
    : 0;
  sourceLandmarkIndex.head = 0;
  const eyes = photo(5).sub(photo(2));
  const headRoll =
    Math.min(confidence(2), confidence(5)) > 0.5
      ? Math.atan2(eyes.y * Math.sign(eyes.x || 1), Math.abs(eyes.x))
      : 0;
  return {
    joints,
    confidenceByJoint,
    sourceLandmarkIndex,
    torsoQuaternion,
    shoulderWidth,
    hipWidth,
    torsoLength,
    sourceAnchor,
    pixelsPerMeter,
    // Browser ImageData exposes width/height through prototype getters, so
    // spreading it produces an empty object and poisons all scene placements.
    sourceSize: { width: image.width, height: image.height },
    headRoll,
    pose,
  };
}

/** A per-bone camera registration avoids stretching an upright photo crop over
 * a seated torso or sending shoulder fabric down a raised forearm. */
export function projectPosePoint(
  point: THREE.Vector3,
  rig: HumanPoseRig,
  image: { width: number; height: number },
  part: string,
): { u: number; v: number; confidence: number } {
  const side = part.startsWith("left") ? "left" : "right";
  let a: HumanJoint = "hips",
    b: HumanJoint = "shoulders";
  if (/upper.arm|sleeve/.test(part)) {
    a = `${side}Shoulder`;
    b = `${side}Elbow`;
  } else if (/forearm|hand|finger|thumb/.test(part)) {
    a = `${side}Elbow`;
    b = `${side}Wrist`;
  } else if (/thigh/.test(part)) {
    a = `${side}Hip`;
    b = `${side}Knee`;
  } else if (/calf|knee/.test(part)) {
    a = `${side}Knee`;
    b = `${side}Ankle`;
  } else if (/shoe|sole/.test(part)) {
    a = `${side}Heel`;
    b = `${side}Toe`;
  }
  if (a === "hips")
    return {
      u: rig.sourceAnchor[0] + (point.x * rig.pixelsPerMeter) / image.width,
      v: rig.sourceAnchor[1] - (point.y * rig.pixelsPerMeter) / image.height,
      confidence: Math.min(
        rig.confidenceByJoint.hips,
        rig.confidenceByJoint.shoulders,
      ),
    };
  const ai = rig.sourceLandmarkIndex[a],
    bi = rig.sourceLandmarkIndex[b];
  const pa = rig.pose.landmarks[ai].image,
    pb = rig.pose.landmarks[bi].image;
  const ja = rig.joints[a],
    jb = rig.joints[b];
  const px = point.x - ja.x,
    py = point.y - ja.y,
    pz = point.z - ja.z;
  const bx = jb.x - ja.x,
    by = jb.y - ja.y,
    bz = jb.z - ja.z;
  const t = clamp(
    (px * bx + py * by + pz * bz) /
      Math.max(0.0001, bx * bx + by * by + bz * bz),
    -0.2,
    1.2,
  );
  return {
    u:
      THREE.MathUtils.lerp(pa[0], pb[0], t) +
      ((px - bx * t) * rig.pixelsPerMeter) / image.width,
    v:
      THREE.MathUtils.lerp(pa[1], pb[1], t) -
      ((py - by * t) * rig.pixelsPerMeter) / image.height,
    confidence: Math.min(rig.confidenceByJoint[a], rig.confidenceByJoint[b]),
  };
}
