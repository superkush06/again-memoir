import * as THREE from "three";
import type { HumanAppearance, PhotoBox } from "./human-appearance";
import type { VolumePixels } from "./volume";
import type { HumanJoint, HumanPoseRig } from "./human-pose";
import { projectPosePoint, humanPoseReprojection } from "./human-pose";
import {
  bakePhotographsToUv,
  seedAnatomicalAppearance,
} from "./neural-photo-fitting";
import {
  orthographicPhotoProjection,
  type VertexPhotoView,
} from "./texture-projection";

/** The authored morphologies share UVs. Shape comparisons reuse the fitted
 * photograph, with independent GPU resources and the same photographic detail. */
export function capturePosePhotographs(group: THREE.Group) {
  const source = new Map<string, THREE.Material | THREE.Material[]>();
  group.traverse((node) => {
    if (node instanceof THREE.Mesh) source.set(node.name, node.material);
  });
  const diagnostics = {
    humanPoseFitted: group.userData.humanPoseFitted,
    textureBaking: group.userData.textureBaking,
    poseConfidence: group.userData.poseConfidence,
    poseObservedFraction: group.userData.poseObservedFraction,
    poseReprojection: group.userData.poseReprojection,
  };
  return (target: THREE.Group) => {
    const textures = new Set<THREE.Texture>(),
      materials = new Set<THREE.Material>();
    const replaced: {
      mesh: THREE.Mesh;
      original: THREE.Material | THREE.Material[];
    }[] = [];
    target.traverse((node) => {
      if (!(node instanceof THREE.Mesh)) return;
      const original = source.get(node.name);
      if (!original) return;
      const copy = (material: THREE.Material) => {
        const clone = material.clone() as THREE.MeshBasicMaterial;
        if (clone.map) {
          clone.map = clone.map.clone();
          clone.map.needsUpdate = true;
          textures.add(clone.map);
        }
        materials.add(clone);
        return clone;
      };
      replaced.push({ mesh: node, original: node.material });
      node.material = Array.isArray(original)
        ? original.map(copy)
        : copy(original);
    });
    Object.assign(target.userData, diagnostics);
    let disposed = false;
    return {
      dispose() {
        if (disposed) return;
        disposed = true;
        replaced.forEach(({ mesh, original }) => {
          mesh.material = original;
        });
        textures.forEach((texture) => texture.dispose());
        materials.forEach((material) => material.dispose());
      },
    };
  };
}

/** Anatomical landmark crops replace mask-top guesses for tilted, seated and
 * overlapping people. These are photo coordinates, never synthetic face pixels. */
export function poseAppearance(
  appearance: HumanAppearance,
  rig: HumanPoseRig,
  source: { width: number; height: number },
): HumanAppearance {
  const lm = rig.pose.landmarks;
  const facial = [0, 2, 5, 7, 8].filter(
    (i) => Math.min(lm[i].presence, lm[i].visibility) > 0.5,
  );
  if (facial.length < 3) return appearance;
  const points = facial.map((i) => lm[i].image);
  const cx =
    (Math.min(...points.map((p) => p[0])) +
      Math.max(...points.map((p) => p[0]))) /
    2;
  const cy = points.reduce((sum, p) => sum + p[1], 0) / points.length;
  const earSpan = Math.abs(lm[7].image[0] - lm[8].image[0]) * source.width;
  const eyeSpan = Math.hypot(
    (lm[2].image[0] - lm[5].image[0]) * source.width,
    (lm[2].image[1] - lm[5].image[1]) * source.height,
  );
  const widthPx = THREE.MathUtils.clamp(
    Math.max(earSpan * 1.23, eyeSpan * 2.7),
    0.14 * rig.pixelsPerMeter,
    0.28 * rig.pixelsPerMeter,
  );
  const heightPx = widthPx * 1.32;
  const faceBox: PhotoBox = [
    Math.max(0, cy - (heightPx * 0.56) / source.height),
    Math.max(0, cx - (widthPx * 0.5) / source.width),
    Math.min(1, cy + (heightPx * 0.44) / source.height),
    Math.min(1, cx + (widthPx * 0.5) / source.width),
  ];
  return { ...appearance, faceBox, yaw: 0 };
}

const segments: [string, HumanJoint, HumanJoint][] = [
  ["torso", "hips", "shoulders"],
  ...(["left", "right"] as const).flatMap(
    (side) =>
      [
        [`${side}-upper-arm`, `${side}Shoulder`, `${side}Elbow`],
        [`${side}-forearm`, `${side}Elbow`, `${side}Wrist`],
        [`${side}-thigh`, `${side}Hip`, `${side}Knee`],
        [`${side}-calf`, `${side}Knee`, `${side}Ankle`],
        [`${side}-shoe`, `${side}Heel`, `${side}Toe`],
      ] as [string, HumanJoint, HumanJoint][],
  ),
];

/** Texture the posed, authored mesh itself. The UV bake uses the original image
 * at full detail and a depth buffer, so an arm occludes the torso it covers.
 * The unseen surface gets the sampled photograph palette rather than white UVs. */
export async function fitPosedHumanPhotographs(
  group: THREE.Group,
  rig: HumanPoseRig,
  input: {
    source: VolumePixels;
    mask: VolumePixels;
    appearance: HumanAppearance;
  },
) {
  seedAnatomicalAppearance(group, input.appearance);
  const prepared = segments.map(([name, a, b]) => ({
    name,
    a: rig.joints[a],
    b: rig.joints[b],
    delta: rig.joints[b].clone().sub(rig.joints[a]),
    lengthSq: Math.max(0.00001, rig.joints[b].distanceToSquared(rig.joints[a])),
    confidence: Math.min(rig.confidenceByJoint[a], rig.confidenceByJoint[b]),
  }));
  const nearestPart = (point: THREE.Vector3) => {
    let best = Infinity,
      chosen = prepared[0];
    for (const segment of prepared) {
      const x = point.x - segment.a.x,
        y = point.y - segment.a.y,
        z = point.z - segment.a.z,
        d = segment.delta;
      const t = THREE.MathUtils.clamp(
        (x * d.x + y * d.y + z * d.z) / segment.lengthSq,
        0,
        1,
      );
      const dx = x - d.x * t,
        dy = y - d.y * t,
        dz = z - d.z * t;
      const distance = dx * dx + dy * dy + dz * dz;
      if (distance < best) {
        best = distance;
        chosen = segment;
      }
    }
    return chosen;
  };
  const views: VertexPhotoView[] = [
    {
      image: input.source,
      mask: input.mask,
      camera: {
        direction: new THREE.Vector3(0, 0, 1),
        project: (point) => {
          const p = projectPosePoint(
            point,
            rig,
            input.source,
            nearestPart(point).name,
          );
          return { u: p.u, v: p.v, depth: point.z };
        },
      },
      acceptSample: (_rgb, point) => nearestPart(point).confidence >= 0.4,
      meshFilter: (mesh) => !/head|hair|eye|brow|lash/i.test(mesh.name),
    },
  ];
  const headBounds = new THREE.Box3();
  group.updateMatrixWorld(true);
  const point = new THREE.Vector3();
  group.traverse((node) => {
    if (!(node instanceof THREE.Mesh) || !/head/i.test(node.name)) return;
    const positions = node.geometry.getAttribute("position"),
      joints = node.geometry.getAttribute("_pose_joints"),
      weights = node.geometry.getAttribute("_pose_weights");
    for (let i = 0; i < positions.count; i++) {
      let headWeight = 0;
      if (joints && weights)
        for (let k = 0; k < 4; k++)
          if (joints.getComponent(i, k) === 2)
            headWeight += weights.getComponent(i, k);
      // A Head mesh includes the neck transition. That transition must never
      // lengthen the face photograph down over the collar.
      if (joints && headWeight < 0.995) continue;
      headBounds.expandByPoint(
        point.fromBufferAttribute(positions, i).applyMatrix4(node.matrixWorld),
      );
    }
  });
  if (
    !headBounds.isEmpty() &&
    input.appearance.faceBox &&
    rig.confidenceByJoint.head >= 0.4
  ) {
    // Camera-axis head registration preserves one original photographic face;
    // never rotate the already-turned source face a second time.
    views.push({
      image: input.source,
      mask: input.mask,
      box: input.appearance.faceBox,
      camera: orthographicPhotoProjection({
        left: headBounds.min.x,
        right: headBounds.max.x,
        bottom: headBounds.min.y,
        top: headBounds.max.y,
      }),
      meshFilter: (mesh) => /head|hair|eye|brow|lash/i.test(mesh.name),
      edgeFeather: 0.025,
    });
  }
  const result = await bakePhotographsToUv(group, views, (mesh) =>
    /head|face|hair/i.test(mesh.name) ? 512 : 256,
  );
  group.userData.textureBaking = "pose-registered-uv";
  group.userData.humanPoseFitted = true;
  group.userData.poseConfidence = rig.pose.confidence;
  group.userData.poseObservedFraction = rig.pose.observedFraction;
  group.userData.poseReprojection = humanPoseReprojection(rig);
  return result;
}
