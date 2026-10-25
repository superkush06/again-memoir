import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import * as THREE from "three";
import type { HumanPoseRig, HumanJoint } from "./human-pose";
import {
  choosePoseTemplateShape,
  deformHumanTemplate,
  loadHumanPoseTemplate,
  parseHumanPoseTemplate,
  poseTemplateOf,
  type PoseTemplateMetadata,
} from "./posed-template";

const bytes = async (shape = "average") => {
  const buffer = await readFile(
    new URL(`../../public/models/human/${shape}.glb`, import.meta.url),
  );
  return buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  ) as ArrayBuffer;
};
function neutralRig(metadata: PoseTemplateMetadata): HumanPoseRig {
  const origin = new THREE.Vector3(...metadata.joints.hips);
  const joints = Object.fromEntries(
    Object.entries(metadata.joints).map(([name, p]) => [
      name,
      new THREE.Vector3(...p).sub(origin),
    ]),
  ) as Record<HumanJoint, THREE.Vector3>;
  return {
    joints,
    torsoQuaternion: new THREE.Quaternion(),
    shoulderWidth: joints.leftShoulder.distanceTo(joints.rightShoulder),
    hipWidth: joints.leftHip.distanceTo(joints.rightHip),
    torsoLength: joints.shoulders.length(),
    confidenceByJoint: Object.fromEntries(
      Object.keys(joints).map((k) => [k, 1]),
    ),
    sourceLandmarkIndex: {},
    sourceAnchor: [0.42, 0.51],
    pixelsPerMeter: 280,
    headRoll: 0,
    pose: { landmarks: [] } as unknown as HumanPoseRig["pose"],
  } as HumanPoseRig;
}
function poseFixture(rig: HumanPoseRig, kind: string) {
  const j = rig.joints;
  for (const side of ["left", "right"] as const) {
    const s = side === "left" ? -1 : 1;
    if (kind === "seated") {
      j[`${side}Knee`]
        .copy(j[`${side}Hip`])
        .add(new THREE.Vector3(s * 0.02, -0.06, 0.41));
      j[`${side}Ankle`]
        .copy(j[`${side}Knee`])
        .add(new THREE.Vector3(0, -0.42, 0.02));
    } else if (kind === "crouched") {
      j[`${side}Knee`]
        .copy(j[`${side}Hip`])
        .add(new THREE.Vector3(s * 0.05, -0.26, 0.32));
      j[`${side}Ankle`]
        .copy(j[`${side}Knee`])
        .add(new THREE.Vector3(s * 0.01, -0.24, -0.34));
    } else if (kind === "raised-arms") {
      j[`${side}Elbow`]
        .copy(j[`${side}Shoulder`])
        .add(new THREE.Vector3(s * 0.12, 0.25, 0.015));
      j[`${side}Wrist`]
        .copy(j[`${side}Elbow`])
        .add(new THREE.Vector3(s * 0.07, 0.25, 0.025));
    } else if (kind === "folded-arms") {
      j[`${side}Elbow`]
        .copy(j[`${side}Shoulder`])
        .add(new THREE.Vector3(s * 0.11, -0.26, 0.05));
      j[`${side}Wrist`]
        .copy(j[`${side}Elbow`])
        .add(new THREE.Vector3(-s * 0.29, 0.1, 0.08));
    }
    if (kind === "seated" || kind === "crouched") {
      j[`${side}Heel`]
        .copy(j[`${side}Ankle`])
        .add(new THREE.Vector3(0, -0.025, -0.055));
      j[`${side}Toe`]
        .copy(j[`${side}Ankle`])
        .add(new THREE.Vector3(0, -0.045, 0.14));
    }
  }
  if (kind === "lying") {
    const rotation = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 0, 1),
      Math.PI / 2,
    );
    Object.values(j).forEach((point) => point.applyQuaternion(rotation));
    rig.torsoQuaternion.copy(rotation);
    rig.headRoll = Math.PI / 2;
  }
  return rig;
}

test("all distributable bodies contain distinct authored topology, complete finite weights and no photo textures", async () => {
  const signatures = [];
  for (const shape of ["slim", "average", "broad"] as const) {
    const asset = await parseHumanPoseTemplate(await bytes(shape), shape);
    const metadata = poseTemplateOf(asset.group)!;
    assert.equal(metadata.bones.length, 15);
    assert.equal(asset.group.userData.license, "CC0-1.0");
    const names: string[] = [];
    let vertices = 0;
    asset.group.traverse((node) => {
      const mesh = node as THREE.Mesh;
      if (!mesh.isMesh) return;
      names.push(mesh.name);
      const positions = mesh.geometry.getAttribute("position"),
        uv = mesh.geometry.getAttribute("uv");
      const ids = mesh.geometry.getAttribute("_pose_joints"),
        weights = mesh.geometry.getAttribute("_pose_weights");
      assert.equal(uv.count, positions.count);
      vertices += positions.count;
      for (let i = 0; i < positions.count; i++) {
        let sum = 0;
        for (let k = 0; k < 4; k++) {
          assert.ok(ids.getComponent(i, k) >= 0 && ids.getComponent(i, k) < 15);
          sum += weights.getComponent(i, k);
        }
        assert.ok(Math.abs(sum - 1) < 1e-5);
      }
      for (const material of Array.isArray(mesh.material)
        ? mesh.material
        : [mesh.material])
        assert.equal((material as THREE.MeshBasicMaterial).map, null);
    });
    assert.ok(vertices > 17000 && vertices < 18000);
    for (const name of [
      "Head",
      "Skin",
      "Shirt",
      "Pants",
      "Shoes",
      "Hair",
      "Eyes",
    ])
      assert.ok(names.includes(name));
    signatures.push(metadata.joints.leftShoulder[0]);
    asset.dispose();
  }
  assert.equal(new Set(signatures).size, 3);
});

for (const kind of [
  "standing",
  "seated",
  "crouched",
  "raised-arms",
  "folded-arms",
  "lying",
])
  for (const shape of ["slim", "average", "broad"] as const) {
    test(`authored ${shape} geometry retains UVs, a rigid face and nondegenerate surfaces for ${kind}`, async () => {
      const asset = await parseHumanPoseTemplate(await bytes(shape), shape);
      const metadata = poseTemplateOf(asset.group)!,
        rig = poseFixture(neutralRig(metadata), kind);
      const head = asset.group.getObjectByName("Head") as THREE.Mesh;
      const original = head.geometry.getAttribute("position").array.slice();
      const uv = head.geometry.getAttribute("uv").array.slice();
      const color = head.geometry.getAttribute("color").array.slice();
      const { report, bounds } = deformHumanTemplate(asset.group, rig);
      assert.equal(report.nearDegenerateTriangles, 0);
      const quality = Object.fromEntries(
        asset.group.children.map((child) => [
          child.name,
          child.userData.poseOrientationReversals,
        ]),
      );
      assert.equal(
        report.orientationReversals,
        0,
        `${kind}: reversed triangle orientation ${JSON.stringify(quality)} correction=${report.maximumClothCorrection}`,
      );
      assert.ok(report.minimumAreaRatio > 0.001);
      assert.ok(report.maximumClothCorrection <= 0.0500001);
      assert.ok(report.maximumSkinCorrection <= 0.0200001);
      assert.ok(report.vertices > 17000 && report.triangles > 28000);
      assert.ok(
        bounds.min
          .toArray()
          .concat(bounds.max.toArray())
          .every(Number.isFinite),
      );
      assert.deepEqual(head.geometry.getAttribute("uv").array, uv);
      assert.deepEqual(head.geometry.getAttribute("color").array, color);
      const positions = head.geometry.getAttribute("position");
      const face: number[] = [];
      for (let i = 0; i < positions.count; i++)
        if (original[i * 3 + 1] > metadata.headRigidAboveY) face.push(i);
      for (let i = 0; i < face.length - 30; i += 31) {
        const a = face[i],
          b = face[i + 30];
        const prior = new THREE.Vector3()
          .fromArray(original, a * 3)
          .distanceTo(new THREE.Vector3().fromArray(original, b * 3));
        const current = new THREE.Vector3()
          .fromBufferAttribute(positions, a)
          .distanceTo(new THREE.Vector3().fromBufferAttribute(positions, b));
        assert.ok(
          Math.abs(prior - current) < 2e-6,
          `face distance changed ${Math.abs(prior - current)}`,
        );
      }
      assert.deepEqual(
        asset.group.userData.poseFit.sourceAnchor,
        rig.sourceAnchor,
      );
      // A lying body remains horizontal and hip-centered; it is never grounded
      // and then mistaken for a vertically shortened standing person.
      if (kind === "lying")
        assert.ok(bounds.getSize(new THREE.Vector3()).x > 1.5);
      const first = positions.array.slice();
      deformHumanTemplate(asset.group, rig);
      assert.deepEqual(
        positions.array,
        first,
        "repeated fitting must not accumulate deformation",
      );
      asset.dispose();
    });
  }

test("visible proportions select morphology and limb lengths without changing facial geometry", async () => {
  const asset = await parseHumanPoseTemplate(await bytes());
  const metadata = poseTemplateOf(asset.group)!,
    rig = neutralRig(metadata);
  assert.equal(choosePoseTemplateShape(rig), "average");
  rig.shoulderWidth *= 0.8;
  rig.hipWidth *= 0.8;
  assert.equal(choosePoseTemplateShape(rig), "slim");
  rig.shoulderWidth *= 1.6;
  rig.hipWidth *= 1.6;
  assert.equal(choosePoseTemplateShape(rig), "broad");
  rig.confidenceByJoint.leftShoulder = 0;
  rig.confidenceByJoint.leftHip = 0;
  assert.equal(choosePoseTemplateShape(rig), "average");
  for (const side of ["left", "right"] as const) {
    const hip = rig.joints[`${side}Hip`];
    for (const suffix of ["Knee", "Ankle", "Heel", "Toe"] as const)
      rig.joints[`${side}${suffix}`].sub(hip).multiplyScalar(1.18).add(hip);
  }
  const { report } = deformHumanTemplate(asset.group, rig);
  assert.ok(report.maximumBoneScale > 1.15);
  assert.ok(report.maximumBoneScale <= 1.5);
  asset.dispose();
});

test("invalid landmarks fail before modifying a reusable neutral asset", async () => {
  const asset = await parseHumanPoseTemplate(await bytes());
  const rig = neutralRig(poseTemplateOf(asset.group)!);
  rig.joints.leftWrist.x = NaN;
  assert.throws(
    () => deformHumanTemplate(asset.group, rig),
    /Non-finite body joint/,
  );
  asset.dispose();
});

test("repeated template loads share download bytes but own geometry and materials", async () => {
  const originalFetch = globalThis.fetch,
    buffer = await bytes("slim");
  let requests = 0;
  globalThis.fetch = (async () => {
    requests++;
    return new Response(buffer.slice(0));
  }) as typeof fetch;
  try {
    const [first, second] = await Promise.all([
      loadHumanPoseTemplate("slim"),
      loadHumanPoseTemplate("slim"),
    ]);
    assert.equal(requests, 1);
    const a = first.group.getObjectByName("Head") as THREE.Mesh,
      b = second.group.getObjectByName("Head") as THREE.Mesh;
    assert.notEqual(a.geometry, b.geometry);
    assert.notEqual(a.material, b.material);
    const original = b.geometry.getAttribute("position").array.slice();
    deformHumanTemplate(
      first.group,
      poseFixture(neutralRig(poseTemplateOf(first.group)!), "lying"),
    );
    assert.deepEqual(b.geometry.getAttribute("position").array, original);
    first.dispose();
    second.dispose();
  } finally {
    globalThis.fetch = originalFetch;
  }
});
