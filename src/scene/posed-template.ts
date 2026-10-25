import * as THREE from "three";
import type { HumanJoint, HumanPoseRig } from "./human-pose";
import { validateNeuralGlb } from "../neural-asset-validation";

export type PoseTemplateShape = "slim" | "average" | "broad";
export interface PoseTemplateMetadata {
  version: 1;
  method: "authored-weights";
  bones: string[];
  joints: Record<string, [number, number, number]>;
  headRigidAboveY: number;
  referenceHeight: number;
}
export interface PoseTemplateReport {
  method: "authored-dual-quaternion";
  vertices: number;
  triangles: number;
  nearDegenerateTriangles: number;
  orientationReversals: number;
  minimumAreaRatio: number;
  maximumBoneScale: number;
  minimumBoneScale: number;
  maximumClothCorrection: number;
  maximumSkinCorrection: number;
  maximumNeckCorrection: number;
}
const clamp = THREE.MathUtils.clamp;
const UP = new THREE.Vector3(0, 1, 0);
const FRONT = new THREE.Vector3(0, 0, 1);
const expectedBones = [
  "pelvis",
  "torso",
  "head",
  "leftUpperArm",
  "leftForearm",
  "leftHand",
  "rightUpperArm",
  "rightForearm",
  "rightHand",
  "leftThigh",
  "leftCalf",
  "leftFoot",
  "rightThigh",
  "rightCalf",
  "rightFoot",
];
const bytesCache = new Map<PoseTemplateShape, Promise<ArrayBuffer>>();
const restPositions = new WeakMap<THREE.BufferGeometry, Float32Array>();

export function poseTemplateOf(
  group: THREE.Object3D,
): PoseTemplateMetadata | undefined {
  let result: PoseTemplateMetadata | undefined;
  group.traverse((node) => {
    const value = node.userData.poseTemplate as
      PoseTemplateMetadata | undefined;
    if (value?.version === 1 && value.method === "authored-weights")
      result = value;
  });
  return result;
}

/** Three different authored morphology blends, selected only from visible
 * geometric ratios. This does not infer gender, age, ancestry or body mass. */
export function choosePoseTemplateShape(rig: HumanPoseRig): PoseTemplateShape {
  const torso = clamp(rig.torsoLength, 0.36, 0.62);
  const shoulder = Math.min(
    rig.confidenceByJoint.leftShoulder ?? 0,
    rig.confidenceByJoint.rightShoulder ?? 0,
  );
  const hips = Math.min(
    rig.confidenceByJoint.leftHip ?? 0,
    rig.confidenceByJoint.rightHip ?? 0,
  );
  const measurements: [number, number, number][] = [];
  if (shoulder >= 0.55)
    measurements.push([rig.shoulderWidth / torso, 0.81, shoulder]);
  if (hips >= 0.55) measurements.push([rig.hipWidth / torso, 0.47, hips * 0.7]);
  if (!measurements.length) return "average";
  const ratio =
    measurements.reduce(
      (sum, [value, nominal, weight]) => sum + (value / nominal) * weight,
      0,
    ) / measurements.reduce((sum, [, , weight]) => sum + weight, 0);
  return ratio < 0.91 ? "slim" : ratio > 1.09 ? "broad" : "average";
}

/** Cache neutral bytes, not mutable meshes or textures. Every person gets an
 * independent instance so posing/disposal cannot alter somebody else's body. */
export async function loadHumanPoseTemplate(
  shape: PoseTemplateShape = "average",
) {
  if (!["slim", "average", "broad"].includes(shape))
    throw new Error("Unknown human template shape");
  let request = bytesCache.get(shape);
  if (!request) {
    request = (async () => {
      const response = await fetch(`/models/human/${shape}.glb`, {
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok)
        throw new Error(`Human template unavailable (${response.status})`);
      const buffer = await response.arrayBuffer();
      if (buffer.byteLength > 2_000_000)
        throw new Error("Human template exceeds the geometry budget");
      validateNeuralGlb(buffer);
      return buffer;
    })();
    bytesCache.set(shape, request);
    request.catch(() => {
      if (bytesCache.get(shape) === request) bytesCache.delete(shape);
    });
  }
  return parseHumanPoseTemplate(await request, shape);
}

export async function parseHumanPoseTemplate(
  buffer: ArrayBuffer,
  shape: PoseTemplateShape = "average",
) {
  validateNeuralGlb(buffer);
  const { GLTFLoader } = await import("three/addons/loaders/GLTFLoader.js");
  const manager = new THREE.LoadingManager();
  manager.setURLModifier(() => {
    throw new Error("Human templates must be self-contained");
  });
  const gltf = await new GLTFLoader(manager).parseAsync(buffer.slice(0), "");
  const group = gltf.scene;
  const metadata = poseTemplateOf(group);
  if (!metadata || metadata.bones.join(",") !== expectedBones.join(","))
    throw new Error("Missing authored template rig");
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  group.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh) return;
    geometries.add(mesh.geometry);
    if (
      !mesh.geometry.hasAttribute("_pose_joints") ||
      !mesh.geometry.hasAttribute("_pose_weights")
    ) {
      throw new Error("Missing authored skin weights");
    }
    const originals = Array.isArray(mesh.material)
      ? mesh.material
      : [mesh.material];
    const converted = originals.map((original) => {
      original.dispose();
      const material = new THREE.MeshBasicMaterial({
        vertexColors: true,
        toneMapped: false,
        side: original.side,
      });
      materials.add(material);
      return material;
    });
    mesh.material = Array.isArray(mesh.material) ? converted : converted[0];
    mesh.castShadow = true;
    mesh.receiveShadow = true;
  });
  group.name = `Pose-fitted MakeHuman ${shape}`;
  group.userData.kind = "anatomical-human";
  group.userData.shape = shape;
  group.userData.inputKind = "anatomical-template";
  group.userData.model = "makehuman";
  let disposed = false;
  return {
    group,
    bounds: new THREE.Box3().setFromObject(group, true),
    dispose() {
      if (disposed) return;
      disposed = true;
      // Appearance fitting may replace the initial material and add textures.
      group.traverse((node) => {
        const mesh = node as THREE.Mesh;
        if (!mesh.isMesh) return;
        geometries.add(mesh.geometry);
        for (const material of Array.isArray(mesh.material)
          ? mesh.material
          : [mesh.material]) {
          materials.add(material);
          for (const value of Object.values(material))
            if (value?.isTexture) textures.add(value);
        }
      });
      textures.forEach((texture) => texture.dispose());
      materials.forEach((material) => material.dispose());
      geometries.forEach((geometry) => geometry.dispose());
    },
  };
}

type Transform = {
  rotation: THREE.Quaternion;
  dual: THREE.Quaternion;
  scale: THREE.Matrix4;
  lengthScale: number;
};

function frame(
  direction: THREE.Vector3,
  front: THREE.Vector3,
): THREE.Quaternion {
  const y = direction.clone().normalize();
  if (y.lengthSq() < 0.5) throw new Error("Degenerate template bone");
  let z = front.clone().addScaledVector(y, -front.dot(y));
  if (z.lengthSq() < 0.0001) z = UP.clone().addScaledVector(y, -UP.dot(y));
  if (z.lengthSq() < 0.0001)
    z = new THREE.Vector3(1, 0, 0).addScaledVector(y, -y.x);
  z.normalize();
  const x = y.clone().cross(z).normalize();
  z = x.clone().cross(y).normalize();
  return new THREE.Quaternion().setFromRotationMatrix(
    new THREE.Matrix4().makeBasis(x, y, z),
  );
}

function boneTransform(
  restA: THREE.Vector3,
  restB: THREE.Vector3,
  targetA: THREE.Vector3,
  targetB: THREE.Vector3,
  targetFront: THREE.Vector3,
  width = 1,
  fixedRotation?: THREE.Quaternion,
): Transform {
  const restDirection = restB.clone().sub(restA),
    targetDirection = targetB.clone().sub(targetA);
  const restFrame = frame(restDirection, FRONT),
    targetFrame = frame(targetDirection, targetFront);
  const rotation =
    fixedRotation?.clone() ?? targetFrame.multiply(restFrame.clone().invert());
  const lengthScale = clamp(
    targetDirection.length() / restDirection.length(),
    0.65,
    1.5,
  );
  const scale = new THREE.Matrix4()
    .makeTranslation(restA.x, restA.y, restA.z)
    .multiply(new THREE.Matrix4().makeRotationFromQuaternion(restFrame))
    .multiply(
      new THREE.Matrix4().makeScale(width, lengthScale, Math.sqrt(width)),
    )
    .multiply(
      new THREE.Matrix4().makeRotationFromQuaternion(
        restFrame.clone().invert(),
      ),
    )
    .multiply(
      new THREE.Matrix4().makeTranslation(-restA.x, -restA.y, -restA.z),
    );
  const translation = targetA
    .clone()
    .sub(restA.clone().applyQuaternion(rotation));
  const dual = new THREE.Quaternion(
    translation.x,
    translation.y,
    translation.z,
    0,
  ).multiply(rotation);
  dual.set(dual.x * 0.5, dual.y * 0.5, dual.z * 0.5, dual.w * 0.5);
  return { rotation, dual, scale, lengthScale };
}

function transformsFor(
  metadata: PoseTemplateMetadata,
  rig: HumanPoseRig,
): Transform[] {
  const rest = (name: string) => new THREE.Vector3(...metadata.joints[name]);
  const target = (name: HumanJoint) => rig.joints[name];
  const front = FRONT.clone().applyQuaternion(rig.torsoQuaternion);
  const width = clamp(
    rig.shoulderWidth / rest("leftShoulder").distanceTo(rest("rightShoulder")),
    0.78,
    1.25,
  );
  const hipWidth = clamp(
    rig.hipWidth / rest("leftHip").distanceTo(rest("rightHip")),
    0.78,
    1.25,
  );
  const headUp = target("head").clone().sub(target("shoulders")).normalize();
  const restHeadUp = rest("head").sub(rest("shoulders")).normalize();
  const headRotation = frame(headUp, front).multiply(
    frame(restHeadUp, FRONT).invert(),
  );
  // Roll is observed in image coordinates. Apply only the residual from torso
  // roll, so a lying body's face is not rotated twice.
  const torsoUp = UP.clone().applyQuaternion(rig.torsoQuaternion);
  const torsoRoll = Math.atan2(-torsoUp.x, torsoUp.y);
  const residualRoll = clamp(rig.headRoll - torsoRoll, -0.7, 0.7);
  if (rig.confidenceByJoint.head > 0.5)
    headRotation.premultiply(
      new THREE.Quaternion().setFromAxisAngle(front, residualRoll),
    );
  // The pelvic garment follows part of the hip bend instead of being welded
  // to the chest. This keeps crossed/leaning thighs from folding the crotch.
  const legUp = new THREE.Vector3();
  let legEvidence = 0;
  for (const side of ["left", "right"] as const) {
    const confidence = Math.min(
      rig.confidenceByJoint[`${side}Hip`] ?? 0,
      rig.confidenceByJoint[`${side}Knee`] ?? 0,
    );
    if (confidence > 0.45) {
      legUp.addScaledVector(
        target(`${side}Hip`)
          .clone()
          .sub(target(`${side}Knee`))
          .normalize(),
        confidence,
      );
      legEvidence += confidence;
    }
  }
  const pelvisUp = torsoUp.clone();
  if (legEvidence > 0) {
    legUp.normalize();
    const swing = new THREE.Quaternion().setFromUnitVectors(torsoUp, legUp);
    const angle = 2 * Math.acos(clamp(Math.abs(swing.w), -1, 1));
    pelvisUp.applyQuaternion(
      new THREE.Quaternion().slerp(
        swing,
        Math.min(0.45, 0.35 / Math.max(angle, 0.001)),
      ),
    );
  }
  const result: Transform[] = [
    boneTransform(
      rest("hips"),
      rest("shoulders"),
      target("hips"),
      target("hips").clone().addScaledVector(pelvisUp, rig.torsoLength),
      front,
      hipWidth,
    ),
    boneTransform(
      rest("hips"),
      rest("shoulders"),
      target("hips"),
      target("shoulders"),
      front,
      width,
    ),
    boneTransform(
      rest("head"),
      rest("head").add(UP),
      target("head"),
      target("head").clone().add(headUp),
      front,
      1,
      headRotation,
    ),
  ];
  const segments: [string, string, string, number][] = [];
  for (const side of ["left", "right"]) {
    const first = side === "left" ? 3 : 6;
    segments.push(
      [side + "Shoulder", side + "Elbow", "arm", 1],
      [side + "Elbow", side + "Wrist", "arm", first],
      [side + "Wrist", side + "HandTip", "hand", first + 1],
    );
  }
  for (const side of ["left", "right"]) {
    const first = side === "left" ? 9 : 12;
    segments.push(
      [side + "Hip", side + "Knee", "leg", 0],
      [side + "Knee", side + "Ankle", "leg", first],
      [side + "Ankle", side + "Toe", "foot", first + 1],
    );
  }
  for (const [a, b, kind, parent] of segments) {
    const start = target(a as HumanJoint);
    const end =
      kind === "hand"
        ? start.clone().add(
            target(a as HumanJoint)
              .clone()
              .sub(target(a.replace("Wrist", "Elbow") as HumanJoint))
              .normalize()
              .multiplyScalar(rest(a).distanceTo(rest(b))),
          )
        : target(b as HumanJoint);
    // Parallel-transport the parent's orientation, then apply the smallest
    // swing that matches the observed bone. A separate camera-facing frame
    // per bone introduces a 180-degree twist when an elbow points at camera.
    const parentRotation = result[parent].rotation.clone();
    const from = rest(b)
      .sub(rest(a))
      .normalize()
      .applyQuaternion(parentRotation);
    const to = end.clone().sub(start).normalize();
    const rotation = new THREE.Quaternion()
      .setFromUnitVectors(from, to)
      .multiply(parentRotation);
    result.push(
      boneTransform(
        rest(a),
        rest(b),
        start,
        end,
        front,
        kind === "arm"
          ? Math.sqrt(width)
          : kind === "leg"
            ? Math.sqrt(hipWidth)
            : 1,
        rotation,
      ),
    );
  }
  return result;
}

/** Project folded joint surfaces onto positive orientation constraints without
 * changing topology or UVs. Seam duplicates move together. Clothes may move
 * up to 50 mm; exposed arm skin and lower neck up to 20 mm. Every facial
 * vertex above the chin is pinned, as are eyes and hair. This is not a
 * self-collision simulation, and unresolved folds remain in the report. */
function relaxSurfaceFolds(
  geometry: THREE.BufferGeometry,
  original: Float32Array,
  orientations: Float32Array,
  correctionLimit = 0.05,
  movable?: (index: number) => boolean,
) {
  const positions = geometry.getAttribute("position"),
    index = geometry.index;
  const count = index?.count ?? positions.count,
    groups = new Map<string, number[]>(),
    seams: number[][] = [];
  const baseline = new Float32Array(positions.count * 3);
  for (let i = 0; i < positions.count; i++) {
    const key = [0, 1, 2].map((k) => original[i * 3 + k]).join(",");
    let group = groups.get(key);
    if (!group) {
      group = [];
      groups.set(key, group);
    }
    group.push(i);
    seams[i] = group;
    baseline[i * 3] = positions.getX(i);
    baseline[i * 3 + 1] = positions.getY(i);
    baseline[i * 3 + 2] = positions.getZ(i);
  }
  const a = new THREE.Vector3(),
    b = new THREE.Vector3(),
    c = new THREE.Vector3(),
    normal = new THREE.Vector3();
  const reference = new THREE.Quaternion(),
    corner = new THREE.Quaternion(),
    average = new THREE.Quaternion();
  const constraints: { ids: number[]; normal: THREE.Vector3; area: number }[] =
    [];
  for (let i = 0; i < count; i += 3) {
    const ids = [0, 1, 2].map((k) => (index ? index.getX(i + k) : i + k));
    normal
      .copy(
        a
          .fromArray(original, ids[0] * 3)
          .sub(b.fromArray(original, ids[1] * 3)),
      )
      .cross(c.fromArray(original, ids[2] * 3).sub(b));
    const area = normal.length();
    if (area < 1e-10) continue;
    reference.fromArray(orientations, ids[0] * 4);
    average.set(0, 0, 0, 0);
    for (const id of ids) {
      corner.fromArray(orientations, id * 4);
      const sign = corner.dot(reference) < 0 ? -1 : 1;
      average.x += corner.x * sign;
      average.y += corner.y * sign;
      average.z += corner.z * sign;
      average.w += corner.w * sign;
    }
    constraints.push({
      ids,
      normal: normal.normalize().applyQuaternion(average.normalize()).clone(),
      area,
    });
  }
  const ab = new THREE.Vector3(),
    cb = new THREE.Vector3(),
    ga = new THREE.Vector3(),
    gb = new THREE.Vector3(),
    gc = new THREE.Vector3();
  const candidate = new THREE.Vector3(),
    delta = new THREE.Vector3(),
    prior = new THREE.Vector3();
  let maximum = 0;
  for (let pass = 0; pass < 768; pass++) {
    let active = 0;
    for (const { ids, normal, area } of constraints) {
      a.fromBufferAttribute(positions, ids[0]);
      b.fromBufferAttribute(positions, ids[1]);
      c.fromBufferAttribute(positions, ids[2]);
      ab.copy(a).sub(b);
      cb.copy(c).sub(b);
      const signed = delta.copy(ab).cross(cb).dot(normal),
        target = area * 0.025;
      // A finite positive margin is sufficient. Requiring exact convergence
      // to the target keeps neighboring constraints fighting at float32
      // precision and needlessly repeats every pass.
      if (signed >= area * 0.005) continue;
      active++;
      ga.copy(cb).cross(normal);
      gc.copy(normal).cross(ab);
      gb.copy(ga).add(gc).negate();
      if (movable) {
        if (!movable(ids[0])) ga.set(0, 0, 0);
        if (!movable(ids[1])) gb.set(0, 0, 0);
        if (!movable(ids[2])) gc.set(0, 0, 0);
      }
      const denominator = ga.lengthSq() + gb.lengthSq() + gc.lengthSq();
      if (denominator < 1e-16) continue;
      const lambda = ((target - signed) / denominator) * 0.8;
      for (let k = 0; k < 3; k++) {
        const id = ids[k],
          gradient = [ga, gb, gc][k];
        delta.copy(gradient).multiplyScalar(lambda);
        if (delta.length() > 0.002) delta.setLength(0.002);
        candidate.fromBufferAttribute(positions, id).add(delta);
        prior.fromArray(baseline, id * 3);
        delta.copy(candidate).sub(prior);
        if (delta.length() > correctionLimit) delta.setLength(correctionLimit);
        maximum = Math.max(maximum, delta.length());
        candidate.copy(prior).add(delta);
        for (const duplicate of seams[id])
          positions.setXYZ(duplicate, candidate.x, candidate.y, candidate.z);
      }
    }
    if (!active) break;
  }
  return maximum;
}

/** Pose authored anatomy with volume-preserving dual-quaternion blending.
 * Bone-length scaling is bounded; the entire face/head receives one rigid
 * transform. Never ground or upright the result here: support is scene-specific.
 * Repeated calls always start from stored neutral positions, not the last pose. */
export function deformHumanTemplate(group: THREE.Object3D, rig: HumanPoseRig) {
  const metadata = poseTemplateOf(group);
  if (!metadata) throw new Error("Missing authored template rig");
  if (
    Object.values(rig.joints).some(
      (point) => !point.toArray().every(Number.isFinite),
    )
  )
    throw new Error("Non-finite body joint");
  const transforms = transformsFor(metadata, rig);
  const report: PoseTemplateReport = {
    method: "authored-dual-quaternion",
    vertices: 0,
    triangles: 0,
    nearDegenerateTriangles: 0,
    orientationReversals: 0,
    minimumAreaRatio: Infinity,
    maximumBoneScale: Math.max(...transforms.map((t) => t.lengthScale)),
    minimumBoneScale: Math.min(...transforms.map((t) => t.lengthScale)),
    maximumClothCorrection: 0,
    maximumSkinCorrection: 0,
    maximumNeckCorrection: 0,
  };
  const point = new THREE.Vector3(),
    scaled = new THREE.Vector3(),
    work = new THREE.Vector3();
  const real = new THREE.Quaternion(),
    dual = new THREE.Quaternion(),
    conjugate = new THREE.Quaternion();
  group.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh) return;
    const geometry = mesh.geometry,
      position = geometry.getAttribute("position");
    const joints = geometry.getAttribute("_pose_joints"),
      weights = geometry.getAttribute("_pose_weights");
    if (!joints || !weights)
      throw new Error("Template has no authored skin weights");
    let original = restPositions.get(geometry);
    if (!original) {
      original = new Float32Array(position.count * 3);
      for (let i = 0; i < position.count; i++) {
        original[i * 3] = position.getX(i);
        original[i * 3 + 1] = position.getY(i);
        original[i * 3 + 2] = position.getZ(i);
      }
      restPositions.set(geometry, original);
    }
    const orientation = new Float32Array(position.count * 4);
    for (let i = 0; i < position.count; i++) {
      point.fromArray(original, i * 3);
      scaled.set(0, 0, 0);
      real.set(0, 0, 0, 0);
      dual.set(0, 0, 0, 0);
      const reference = transforms[joints.getX(i)].rotation;
      for (let k = 0; k < 4; k++) {
        const weight = weights.getComponent(i, k);
        if (weight <= 0) continue;
        const transform = transforms[joints.getComponent(i, k)];
        if (!transform || !Number.isFinite(weight))
          throw new Error("Invalid authored skin weights");
        scaled.addScaledVector(
          work.copy(point).applyMatrix4(transform.scale),
          weight,
        );
        const sign = reference.dot(transform.rotation) < 0 ? -1 : 1,
          amount = weight * sign;
        real.x += transform.rotation.x * amount;
        real.y += transform.rotation.y * amount;
        real.z += transform.rotation.z * amount;
        real.w += transform.rotation.w * amount;
        dual.x += transform.dual.x * amount;
        dual.y += transform.dual.y * amount;
        dual.z += transform.dual.z * amount;
        dual.w += transform.dual.w * amount;
      }
      const norm = real.length();
      if (norm < 1e-8) throw new Error("Degenerate skinning blend");
      real.set(real.x / norm, real.y / norm, real.z / norm, real.w / norm);
      real.toArray(orientation, i * 4);
      dual.set(dual.x / norm, dual.y / norm, dual.z / norm, dual.w / norm);
      dual.multiply(conjugate.copy(real).conjugate());
      scaled
        .applyQuaternion(real)
        .add(work.set(dual.x * 2, dual.y * 2, dual.z * 2));
      if (!scaled.toArray().every(Number.isFinite))
        throw new Error("Non-finite posed geometry");
      position.setXYZ(i, scaled.x, scaled.y, scaled.z);
    }
    if (mesh.name === "Shirt" || mesh.name === "Pants")
      report.maximumClothCorrection = Math.max(
        report.maximumClothCorrection,
        relaxSurfaceFolds(geometry, original, orientation),
      );
    if (mesh.name === "Skin")
      report.maximumSkinCorrection = Math.max(
        report.maximumSkinCorrection,
        relaxSurfaceFolds(geometry, original, orientation, 0.02),
      );
    if (mesh.name === "Head")
      report.maximumNeckCorrection = Math.max(
        report.maximumNeckCorrection,
        relaxSurfaceFolds(
          geometry,
          original,
          orientation,
          0.02,
          (index) => original![index * 3 + 1] < metadata.headRigidAboveY,
        ),
      );
    report.vertices += position.count;
    const index = geometry.index,
      count = index?.count ?? position.count;
    const a = new THREE.Vector3(),
      b = new THREE.Vector3(),
      c = new THREE.Vector3(),
      expected = new THREE.Vector3();
    const average = new THREE.Quaternion(),
      reference = new THREE.Quaternion(),
      corner = new THREE.Quaternion();
    let orientationReversals = 0;
    for (let i = 0; i < count; i += 3) {
      const indices = [0, 1, 2].map((k) => (index ? index.getX(i + k) : i + k));
      expected.copy(
        a
          .fromArray(original, indices[0] * 3)
          .sub(b.fromArray(original, indices[1] * 3))
          .cross(c.fromArray(original, indices[2] * 3).sub(b)),
      );
      const before = expected.length();
      a.fromBufferAttribute(position, indices[0])
        .sub(b.fromBufferAttribute(position, indices[1]))
        .cross(c.fromBufferAttribute(position, indices[2]).sub(b));
      const after = a.length();
      if (before > 1e-10) {
        const ratio = after / before;
        report.minimumAreaRatio = Math.min(report.minimumAreaRatio, ratio);
        if (ratio < 0.001) report.nearDegenerateTriangles++;
        reference.fromArray(orientation, indices[0] * 4);
        average.set(0, 0, 0, 0);
        for (const index of indices) {
          corner.fromArray(orientation, index * 4);
          const sign = corner.dot(reference) < 0 ? -1 : 1;
          average.x += corner.x * sign;
          average.y += corner.y * sign;
          average.z += corner.z * sign;
          average.w += corner.w * sign;
        }
        expected.applyQuaternion(average.normalize());
        if (a.dot(expected) < -before * after * 0.01) {
          report.orientationReversals++;
          orientationReversals++;
        }
      }
      report.triangles++;
    }
    mesh.userData.poseOrientationReversals = orientationReversals;
    position.needsUpdate = true;
    geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
  });
  group.userData.poseFit = {
    ...report,
    sourceAnchor: [...rig.sourceAnchor],
    pixelsPerMeter: rig.pixelsPerMeter,
  };
  group.updateMatrixWorld(true);
  return { bounds: new THREE.Box3().setFromObject(group, true), report };
}
