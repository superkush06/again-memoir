import * as THREE from "three";
import { analyzeHumanAppearance, type HumanAppearance } from "./human-appearance";
import type { VolumePixels } from "./volume";
import type { HumanPoseRig } from "./human-pose";
import { projectPosePoint } from "./human-pose";
import {
  orthographicPhotoProjection, projectionConfidence, rasterizePhotoVisibility,
  registerTurnaroundSilhouette, turnaroundForeground,
} from "./texture-projection";

export type { HumanAppearance } from "./human-appearance";
type Box = [number, number, number, number];
type V3 = [number, number, number];
type Ring = [y: number, radiusX: number, radiusZ: number, centerX?: number];

export interface HumanBodyInput {
  source: VolumePixels;
  mask: VolumePixels;
  box: Box;
  label: string;
  appearance?: HumanAppearance;
  poseRig?: HumanPoseRig;
  /** Optional inferred full-length views. The original head always takes precedence. */
  photographicBody?: {
    front: VolumePixels;
    back: VolumePixels;
    frontBox?: Box;
    backBox?: Box;
  };
}

/** Closed anatomical geometry with a photographic surface. The observed head
 * outline conditions the rounded skull, while unseen limbs remain complete. */
export function buildHumanBody(input: HumanBodyInput) {
  const appearance = input.appearance ?? analyzeHumanAppearance(input);
  const fit = appearance as HumanAppearance & {
    torsoBox?: Box; neckBox?: Box; headWidthScale?: number; headHeightScale?: number;
    torsoWidthScale?: number;
  };
  const group = new THREE.Group();
  group.name = input.label;
  group.userData.kind = "complete-human";
  group.userData.inferredParts = ["back", "arms", "hands", "pelvis", "legs", "feet"];
  const textures = new Set<THREE.Texture>();
  const materials = new Set<THREE.Material>();
  const geometries = new Set<THREE.BufferGeometry>();

  const plain = (color: string, roughness = 0.88, cloth = false) => {
    const detail = makeDetailTexture(color, cloth);
    textures.add(detail);
    const material = new THREE.MeshStandardMaterial({ map: detail, roughness, metalness: 0,
      emissive: color, emissiveIntensity: 0.12, bumpMap: detail, bumpScale: cloth ? 0.002 : 0.00025 });
    materials.add(material);
    return material;
  };
  const skin = plain(appearance.skinColor, 0.86);
  const shirt = plain(appearance.shirtColor, 0.98, true);
  const pants = plain(appearance.pantsColor, 0.98, true);
  const shoe = plain(appearance.shoeColor, 0.84);
  const soleColor = new THREE.Color(appearance.shoeColor).multiplyScalar(0.66);
  const sole = new THREE.MeshStandardMaterial({ color: soleColor, roughness: 0.95 });
  materials.add(sole);

  const sourceMaterial = (crop: Box | undefined, fallback: string, face: boolean) => {
    const map = makeBodyTexture(input.source, input.mask, crop ?? input.box, fallback, face,
      appearance.sourceView === "back");
    textures.add(map);
    const material = photographicMaterial(map, face ? 0.93 : 0.99);
    materials.add(material);
    return material;
  };
  const torsoBox = fit.torsoBox ?? expandedTorsoBox(appearance.chestBox ?? input.box, input.box);
  const chestMaterial = sourceMaterial(torsoBox, appearance.shirtColor, false);
  const head = photoHead(input.source, input.mask, appearance.faceBox ?? input.box, appearance, input.photographicBody);
  textures.add(head.texture);
  const faceMaterial = photographicMaterial(head.texture, 0.96);
  materials.add(faceMaterial);

  const add = (name: string, geometry: THREE.BufferGeometry, material: THREE.Material,
    position: V3 = [0, 0, 0]) => {
    geometries.add(geometry);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = name;
    mesh.position.set(...position);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    return mesh;
  };
  const ellipsoid = (name: string, center: V3, scale: V3, material: THREE.Material) => {
    const geometry = new THREE.SphereGeometry(1, 28, 20);
    geometry.scale(...scale);
    geometry.userData.surfaceAt = (u: number, v: number) => new THREE.Vector3(
      -Math.cos(u * Math.PI * 2) * Math.sin((1 - v) * Math.PI) * scale[0],
      Math.cos((1 - v) * Math.PI) * scale[1],
      Math.sin(u * Math.PI * 2) * Math.sin((1 - v) * Math.PI) * scale[2],
    );
    return add(name, geometry, material, center);
  };
  const limb = (name: string, start: V3, end: V3, r0: number, r1: number,
    material: THREE.Material, depth = 1) => {
    const a = new THREE.Vector3(...start);
    const b = new THREE.Vector3(...end);
    const length = a.distanceTo(b);
    const rMid = (r0 + r1) * 0.5;
    const sleeve = name.endsWith("-sleeve");
    const geometry = ringGeometry([
      [-r0 * 0.65, 0, 0], [-r0 * 0.35, r0 * 0.76, r0 * 0.76 * depth],
      [0, r0, r0 * depth], [length * 0.35, rMid * 1.05, rMid * 1.05 * depth],
      [length * 0.72, r1 * 1.08, r1 * 1.08 * depth],
      [length, r1, r1 * depth],
      [length + (sleeve ? 0.001 : r1 * 0.35), r1 * (sleeve ? 0.98 : 0.76), r1 * (sleeve ? 0.98 : 0.76) * depth],
      [length + (sleeve ? 0.002 : r1 * 0.65), 0, 0],
    ], 24);
    const mesh = add(name, geometry, material, start);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.sub(a).normalize());
    return mesh;
  };

  // A real pelvis and a tapering chest give the silhouette independent front,
  // side and rear profiles. Neither surface follows the input mask boundary.
  ellipsoid("pelvis", [0, 0.925, -0.005], [0.169, 0.143, 0.114], pants);
  const torso = add("shirt-torso", ringGeometry([
    [0.955, 0, 0], [0.957, 0.153, 0.107], [0.985, 0.163, 0.112],
    [1.045, 0.159, 0.109], [1.13, 0.17, 0.118], [1.235, 0.19, 0.13],
    [1.315, 0.208, 0.127], [1.365, 0.213, 0.112], [1.395, 0.19, 0.093],
    [1.423, 0.13, 0.072], [1.438, 0.065, 0.058], [1.441, 0, 0],
  ], 64, true), chestMaterial);
  torso.scale.x = THREE.MathUtils.clamp(fit.torsoWidthScale ?? 1, 0.8, 1.28);
  const neckMaterial = fit.neckBox
    ? sourceMaterial(fit.neckBox, appearance.skinColor, true) : skin;
  limb("neck", [0, 1.415, -0.005], [0, 1.535, -0.005], 0.059, 0.054, neckMaterial, 0.94);

  // Hair, eyes, ears and the profile are already in the photograph. Project
  // those pixels onto one rounded, closed head instead of obscuring them with
  // a second generic cap, nose or set of eyes.
  add("head", head.geometry, faceMaterial);
  for (const side of [-1, 1] as const) {
    const prefix = side === -1 ? "left" : "right";
    const shoulder: V3 = [side * 0.195, 1.35, -0.003];
    const elbow: V3 = [side * 0.277, 1.116, 0.01];
    const wrist: V3 = [side * 0.31, 0.913, 0.038];
    if (appearance.sleeves === "long") {
      limb(`${prefix}-upper-arm`, shoulder, elbow, 0.074, 0.057, shirt, 1.06);
      limb(`${prefix}-forearm`, elbow, wrist, 0.057, 0.038, shirt, 1.06);
    } else {
      const sleeveEnd: V3 = [side * 0.248, 1.21, 0.005];
      limb(`${prefix}-upper-arm`, sleeveEnd, elbow, 0.058, 0.05, skin, 1.06);
      limb(`${prefix}-sleeve`, shoulder, sleeveEnd, 0.069, 0.063, shirt, 1.08);
      limb(`${prefix}-forearm`, elbow, wrist, 0.052, 0.034, skin, 1.08);
    }
    const hand = ellipsoid(`${prefix}-hand`, [side * 0.318, 0.865, 0.041], [0.037, 0.056, 0.023], skin);
    hand.rotation.z = side * 0.12;
    for (let finger = 0; finger < 4; finger++) {
      const x = side * (0.291 + finger * 0.015);
      const length = finger === 1 ? 0.052 : finger === 2 ? 0.048 : 0.041;
      limb(`${prefix}-finger-${finger}`, [x, 0.844, 0.045], [x + side * 0.003, 0.844 - length, 0.052], 0.0083, 0.0065, skin);
    }
    limb(`${prefix}-thumb`, [side * 0.289, 0.883, 0.048], [side * 0.274, 0.846, 0.068], 0.011, 0.008, skin);

    const hip: V3 = [side * 0.088, 0.902, -0.003];
    const knee: V3 = [side * 0.101, 0.505, 0.017];
    const ankle: V3 = [side * 0.115, 0.126, -0.008];
    limb(`${prefix}-thigh`, hip, knee, 0.087, 0.064, pants, 1.13);
    ellipsoid(`${prefix}-knee`, knee, [0.064, 0.075, 0.068], pants);
    limb(`${prefix}-calf`, knee, ankle, 0.061, 0.039, pants, 1.12);
    ellipsoid(`${prefix}-shoe`, [side * 0.116, 0.065, 0.06], [0.058, 0.054, 0.139], shoe);
    ellipsoid(`${prefix}-sole`, [side * 0.116, 0.026, 0.062], [0.059, 0.018, 0.141], sole);
  }
  const headAssembly = new THREE.Group();
  headAssembly.name = "head-assembly";
  headAssembly.position.y = 1.62;
  for (const part of [...group.children]) {
    if (/^(head|hair|nose-|face-)|-ear/.test(part.name)) {
      part.position.y -= 1.62;
      headAssembly.add(part);
    }
  }
  // The original crop already contains the person's head turn. Rotating that
  // photographed profile again hides their face from the reference viewpoint.
  headAssembly.rotation.y = -(appearance.yaw ?? 0);
  headAssembly.userData.observedHeadYaw = appearance.headYaw ?? 0;
  group.add(headAssembly);

  const height = Math.max(1.35, Math.min(2.1, appearance.height ?? 1.76));
  if (input.poseRig) {
    poseProceduralBody(group, input.poseRig);
    applyPosePhotographs(input, group, appearance, textures, materials);
  } else {
    group.scale.setScalar(height / 1.766);
    group.rotation.y = Number.isFinite(appearance.yaw) ? appearance.yaw! : 0;
    applyBodyPhotographs(input, group, appearance, torsoBox, textures, materials);
  }
  group.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(group);
  // Place the soles on the ground even if the selected height changes.
  if (!input.poseRig) group.position.y -= bounds.min.y;
  group.updateMatrixWorld(true);
  bounds.setFromObject(group);

  return {
    group,
    bounds,
    dispose() {
      for (const geometry of geometries) geometry.dispose();
      for (const material of materials) material.dispose();
      for (const texture of textures) texture.dispose();
    },
  };
}

function poseProceduralBody(group: THREE.Group, rig: HumanPoseRig) {
  const j = rig.joints;
  const fitSegment = (name: string, start: THREE.Vector3, end: THREE.Vector3, oldLength: number) => {
    const mesh = group.getObjectByName(name)!;
    mesh.position.copy(start);
    const delta = end.clone().sub(start);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), delta.clone().normalize());
    mesh.scale.set(1, delta.length() / oldLength, 1);
  };
  const torso = group.getObjectByName("shirt-torso")!;
  const torsoScale = new THREE.Vector3(rig.shoulderWidth / .39, rig.torsoLength / .425,
    Math.sqrt(rig.shoulderWidth / .39));
  torso.position.copy(new THREE.Vector3(0, -.925, 0).multiply(torsoScale).applyQuaternion(rig.torsoQuaternion));
  torso.quaternion.copy(rig.torsoQuaternion); torso.scale.copy(torsoScale);
  const pelvis = group.getObjectByName("pelvis")!;
  pelvis.position.copy(j.hips); pelvis.quaternion.copy(rig.torsoQuaternion);
  pelvis.scale.set(rig.hipWidth / .205, 1, Math.sqrt(rig.hipWidth / .205));
  const neckDir = j.head.clone().sub(j.shoulders).normalize();
  fitSegment("neck", j.shoulders.clone().addScaledVector(neckDir, .07), j.head.clone().addScaledVector(neckDir, -.085), .12);
  const head = group.getObjectByName("head-assembly")!;
  head.position.copy(j.head); head.rotation.set(0, 0, rig.headRoll);
  for (const side of ["left", "right"] as const) {
    const shoulder = j[`${side}Shoulder`], elbow = j[`${side}Elbow`], wrist = j[`${side}Wrist`];
    const upper = elbow.clone().sub(shoulder);
    const sleeve = group.getObjectByName(`${side}-sleeve`);
    if (sleeve) {
      const sleeveEnd = shoulder.clone().addScaledVector(upper, .59);
      fitSegment(`${side}-sleeve`, shoulder, sleeveEnd, Math.hypot(.053, .14, .008));
      fitSegment(`${side}-upper-arm`, sleeveEnd, elbow, Math.hypot(.029, .094, .005));
    } else fitSegment(`${side}-upper-arm`, shoulder, elbow, Math.hypot(.082, .234, .013));
    fitSegment(`${side}-forearm`, elbow, wrist, Math.hypot(.033, .203, .028));
    const sign = side === "left" ? -1 : 1;
    const oldWrist = new THREE.Vector3(sign * .31, .913, .038);
    const oldHandDirection = new THREE.Vector3(sign * .033, -.203, .028).normalize();
    const rotation = new THREE.Quaternion().setFromUnitVectors(oldHandDirection, wrist.clone().sub(elbow).normalize());
    for (const node of group.children.filter(node => node.name.startsWith(`${side}-`) && /hand|finger|thumb/.test(node.name))) {
      node.position.sub(oldWrist).applyQuaternion(rotation).add(wrist); node.quaternion.premultiply(rotation);
    }
    const hip = j[`${side}Hip`], knee = j[`${side}Knee`], ankle = j[`${side}Ankle`];
    fitSegment(`${side}-thigh`, hip, knee, Math.hypot(.013, .397, .02));
    group.getObjectByName(`${side}-knee`)!.position.copy(knee);
    fitSegment(`${side}-calf`, knee, ankle, Math.hypot(.014, .379, .025));
    const heel = j[`${side}Heel`], toe = j[`${side}Toe`];
    const footDir = toe.clone().sub(heel).normalize();
    const footRotation = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), footDir);
    for (const part of ["shoe", "sole"]) {
      const foot = group.getObjectByName(`${side}-${part}`)!;
      foot.position.copy(heel).lerp(toe, .48); foot.position.y -= part === "sole" ? .027 : 0;
      foot.quaternion.copy(footRotation);
    }
  }
  group.userData.humanPoseFitted = true;
  group.userData.poseConfidence = rig.pose.confidence;
  group.userData.poseObservedFraction = rig.pose.observedFraction;
}

function applyPosePhotographs(input: HumanBodyInput, group: THREE.Group, appearance: HumanAppearance,
  textures: Set<THREE.Texture>, materials: Set<THREE.Material>) {
  const rig = input.poseRig!;
  group.updateMatrixWorld(true);
  for (const mesh of group.children) {
    if (!(mesh instanceof THREE.Mesh)) continue;
    const surface = mesh.geometry.userData.surfaceAt as ((u: number, v: number) => THREE.Vector3) | undefined;
    if (!surface) continue;
    const isShirt = /shirt|sleeve/.test(mesh.name) || appearance.sleeves === "long" && /arm/.test(mesh.name);
    const fallback = isShirt ? appearance.shirtColor : /thigh|pelvis|calf|knee/.test(mesh.name) ? appearance.pantsColor :
      /shoe|sole/.test(mesh.name) ? appearance.shoeColor : appearance.skinColor;
    const base = rgbOf(fallback), size = mesh.name === "shirt-torso" ? 512 : 128;
    const data = new Uint8Array(size * size * 4), normalMatrix = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const u = x / (size - 1), v = y / (size - 1), local = surface(u, v);
      const p = local.clone().applyMatrix4(mesh.matrixWorld);
      const du = surface((u + .002) % 1, v).sub(local);
      const dv = surface(u, Math.min(1, v + .002)).sub(surface(u, Math.max(0, v - .002)));
      const n = du.cross(dv).applyMatrix3(normalMatrix).normalize();
      const projected = projectPosePoint(p, rig, input.source, mesh.name);
      const valid = projected.u >= 0 && projected.u <= 1 && projected.v >= 0 && projected.v <= 1;
      const blend = valid && projected.confidence >= .4 && maskAt(input.mask, projected.u, projected.v)
        ? THREE.MathUtils.smoothstep(n.z, .1, .55) : 0;
      const sample = blend ? rgbaSample(input.source, projected.u, projected.v) : base;
      const index = (y * size + x) * 4;
      for (let c = 0; c < 3; c++) data[index + c] = Math.round(THREE.MathUtils.lerp(base[c], sample[c], blend));
      data[index + 3] = 255;
    }
    const map = dataTexture(data, size, size), material = photographicMaterial(map, .98);
    textures.add(map); materials.add(material); mesh.material = material;
    mesh.userData.photoProjection = "pose-registered-source";
  }
  group.userData.textureBaking = "pose-registered-source";
}

/** Closed ellipsoidal cross-sections, with a separate texture coordinate along
 * each ring. Smooth anatomical bulges are independent of photograph depth. */
function ringGeometry(rings: Ring[], segments: number, shirt = false) {
  if (shirt) {
    const dense: Ring[] = [];
    for (let i = 0; i < rings.length - 1; i++) {
      for (let step = 0; step < 4; step++) {
        const t = step / 4;
        dense.push([
          THREE.MathUtils.lerp(rings[i][0], rings[i + 1][0], t),
          THREE.MathUtils.lerp(rings[i][1], rings[i + 1][1], t),
          THREE.MathUtils.lerp(rings[i][2], rings[i + 1][2], t),
          THREE.MathUtils.lerp(rings[i][3] ?? 0, rings[i + 1][3] ?? 0, t),
        ]);
      }
    }
    dense.push(rings[rings.length - 1]);
    rings = dense;
  }
  const position: number[] = [];
  const uv: number[] = [];
  const index: number[] = [];
  const y0 = rings[0][0];
  const height = rings[rings.length - 1][0] - y0;
  for (let i = 0; i < rings.length; i++) {
    const [y, rx, rz, centerX = 0] = rings[i];
    for (let j = 0; j <= segments; j++) {
      const u = j / segments;
      const angle = u * Math.PI * 2 - Math.PI;
      const v = (y - y0) / height;
      const fabric = fabricFold(angle, v, shirt && rx > 0);
      const sinAngle = j === 0 || j === segments ? 0 : Math.sin(angle);
      position.push(centerX + sinAngle * rx * fabric, y, Math.cos(angle) * rz * fabric);
      uv.push(u, v);
      if (i < rings.length - 1 && j < segments) {
        const a = i * (segments + 1) + j;
        const b = a + 1;
        const c = a + segments + 1;
        const d = c + 1;
        index.push(a, b, c, b, d, c);
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.userData.surfaceAt = (u: number, v: number) => {
    const y = y0 + v * height;
    let row = rings.findIndex((r) => r[0] >= y);
    row = Math.max(1, row < 0 ? rings.length - 1 : row);
    const a = rings[row - 1], b = rings[row];
    const t = THREE.MathUtils.clamp((y - a[0]) / Math.max(0.00001, b[0] - a[0]), 0, 1);
    const angle = u * Math.PI * 2 - Math.PI;
    const fold = fabricFold(angle, v, shirt);
    return new THREE.Vector3(
      THREE.MathUtils.lerp(a[3] ?? 0, b[3] ?? 0, t) + Math.sin(angle) * THREE.MathUtils.lerp(a[1], b[1], t) * fold,
      y, Math.cos(angle) * THREE.MathUtils.lerp(a[2], b[2], t) * fold,
    );
  };
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(position, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  geometry.setIndex(index);
  geometry.computeVertexNormals();
  // Matching duplicated seam normals avoids a visible vertical lighting seam.
  const normals = geometry.getAttribute("normal");
  for (let i = 0; i < rings.length; i++) {
    const first = i * (segments + 1);
    const last = first + segments;
    const normal = new THREE.Vector3().fromBufferAttribute(normals, first)
      .add(new THREE.Vector3().fromBufferAttribute(normals, last)).normalize();
    normals.setXYZ(first, normal.x, normal.y, normal.z);
    normals.setXYZ(last, normal.x, normal.y, normal.z);
  }
  return geometry;
}

function fabricFold(angle: number, v: number, enabled: boolean) {
  if (!enabled) return 1;
  const side = Math.pow(Math.abs(Math.sin(angle)), 2);
  const hem = Math.exp(-Math.pow((v - 0.12) * 8, 2));
  return 1 + 0.012 * Math.sin(angle * 9 + v * 11)
    + side * 0.019 * Math.sin(v * 45 + angle * 2)
    + hem * 0.026 * Math.sin(angle * 6 + v * 12);
}

function photographicMaterial(map: THREE.Texture, roughness: number) {
  // Flash-lit source photographs already contain their illumination. A small
  // diffuse term adds shape under scene lights without bleaching their colors.
  return new THREE.MeshStandardMaterial({
    map, color: new THREE.Color().setRGB(0.055, 0.055, 0.055),
    emissiveMap: map, emissive: 0xffffff, emissiveIntensity: 0.88,
    roughness, metalness: 0,
  });
}

function dataTexture(data: Uint8Array, width: number, height: number) {
  const texture = new THREE.DataTexture(data, width, height, THREE.RGBAFormat, THREE.UnsignedByteType);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = 8;
  texture.needsUpdate = true;
  return texture;
}

function rgbOf(color: string) {
  const hex = new THREE.Color(color).getHexString();
  return [0, 2, 4].map((offset) => parseInt(hex.slice(offset, offset + 2), 16));
}

function rgbaSample(pixels: VolumePixels, x: number, y: number) {
  const px = THREE.MathUtils.clamp(x, 0, 1) * (pixels.width - 1);
  const py = THREE.MathUtils.clamp(y, 0, 1) * (pixels.height - 1);
  const x0 = Math.floor(px), x1 = Math.min(pixels.width - 1, x0 + 1);
  const y0 = Math.floor(py), y1 = Math.min(pixels.height - 1, y0 + 1);
  return [0, 1, 2].map((channel) => THREE.MathUtils.lerp(
    THREE.MathUtils.lerp(Number(pixels.data[(y0 * pixels.width + x0) * 4 + channel]),
      Number(pixels.data[(y0 * pixels.width + x1) * 4 + channel]), px - x0),
    THREE.MathUtils.lerp(Number(pixels.data[(y1 * pixels.width + x0) * 4 + channel]),
      Number(pixels.data[(y1 * pixels.width + x1) * 4 + channel]), px - x0), py - y0));
}

function maskAt(mask: VolumePixels, x: number, y: number) {
  if (x < 0 || x > 1 || y < 0 || y > 1) return false;
  const px = Math.round(x * (mask.width - 1)), py = Math.round(y * (mask.height - 1));
  return Number(mask.data[(py * mask.width + px) * 4]) > 90;
}

function makeDetailTexture(color: string, cloth: boolean) {
  const size = 96, data = new Uint8Array(size * size * 4), base = rgbOf(color);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const grain = Math.sin(x * 73.137 + y * 39.23) * Math.sin(x * 5.13 - y * 11.7);
    const weave = cloth ? Math.sin(x * Math.PI * 0.97) * Math.sin(y * Math.PI * 0.98) * 0.015 : 0;
    const variation = 1 + grain * (cloth ? 0.035 : 0.012) + weave;
    const offset = (y * size + x) * 4;
    for (let c = 0; c < 3; c++) data[offset + c] = Math.round(base[c] * variation);
    data[offset + 3] = 255;
  }
  const map = dataTexture(data, size, size);
  map.wrapT = THREE.RepeatWrapping;
  return map;
}

function expandedTorsoBox(chest: Box, subject: Box): Box {
  const center = (chest[1] + chest[3]) / 2;
  const half = (chest[3] - chest[1]) * 0.69;
  return [chest[0], Math.max(subject[1], center - half), chest[2], Math.min(subject[3], center + half)];
}

function photoHead(source: VolumePixels, mask: VolumePixels, box: Box, appearance: HumanAppearance,
  atlas?: HumanBodyInput["photographicBody"]) {
  const rows = 40;
  const [top, left, bottom, right] = box;
  const height = 0.272 * THREE.MathUtils.clamp(appearance.headHeightScale ?? 1, 0.9, 1.12);
  const aspect = (right - left) * source.width / Math.max(1, (bottom - top) * source.height);
  const width = THREE.MathUtils.clamp(height * aspect, 0.145, 0.285);
  const rowSpan = (v: number) => {
    const y = THREE.MathUtils.lerp(bottom, top, v);
    const py = Math.round(y * (mask.height - 1));
    const l = Math.round(left * (mask.width - 1)), r = Math.round(right * (mask.width - 1));
    let first = r, last = l;
    for (let x = l; x <= r; x++) if (Number(mask.data[(py * mask.width + x) * 4]) > 90) {
      first = Math.min(first, x); last = Math.max(last, x);
    }
    if (last <= first) return { center: 0.5, half: 0.12 };
    return {
      center: (((first + last) / 2) / (mask.width - 1) - left) / (right - left),
      half: Math.max(0.06, ((last - first) / (mask.width - 1)) / (right - left) / 2),
    };
  };
  const spans = Array.from({ length: rows + 1 }, (_, i) => rowSpan(i / rows));
  const smoothSpan = (i: number) => {
    const nearby = spans.slice(Math.max(0, i - 1), Math.min(spans.length, i + 2));
    return {
      center: nearby.reduce((n, p) => n + p.center, 0) / nearby.length,
      half: nearby.reduce((n, p) => n + p.half, 0) / nearby.length,
    };
  };
  const rings: Ring[] = [];
  for (let i = 0; i <= rows; i++) {
    const v = i / rows, span = smoothSpan(i);
    const close = i === 0 || i === rows ? 0 : 1;
    const skull = Math.sqrt(Math.max(0, 1 - Math.pow((v - 0.53) / 0.54, 2)));
    rings.push([1.766 - height + v * height, span.half * width * close,
      (0.082 + 0.018 * (appearance.hairVolume ?? 0.3)) * skull * close,
      (span.center - 0.5) * width]);
  }
  const size = 512, data = new Uint8Array(size * size * 4);
  const skin = rgbOf(appearance.skinColor), hair = rgbOf(appearance.hairColor);
  for (let y = 0; y < size; y++) {
    const v = y / (size - 1), span = rowSpan(v);
    const hairMix = THREE.MathUtils.smoothstep(v, 0.42, 0.68);
    const rearBase = skin.map((n, c) => THREE.MathUtils.lerp(n, hair[c], hairMix));
    for (let x = 0; x < size; x++) {
      const angle = x / (size - 1) * Math.PI * 2 - Math.PI;
      const front = THREE.MathUtils.smoothstep(Math.cos(angle), -0.04, 0.32);
      const sx = left + (span.center + Math.sin(angle) * span.half) * (right - left);
      const sy = THREE.MathUtils.lerp(bottom, top, v);
      const original = rgbaSample(source, sx, sy);
      const blend = maskAt(mask, sx, sy) ? front : 0;
      let rear = rearBase;
      if (atlas) {
        const seenFromBack = appearance.sourceView === "back";
        const image = seenFromBack ? atlas.front : atlas.back;
        const crop = (seenFromBack ? atlas.frontBox : atlas.backBox) ?? [0, 0, 1, 1];
        const px = (span.center - 0.5 + Math.sin(angle) * span.half) * width;
        const py = 1.766 - height + v * height;
        rear = rgbaSample(image, THREE.MathUtils.lerp(crop[1], crop[3], 0.5 - px / 0.74),
          THREE.MathUtils.lerp(crop[2], crop[0], py / 1.766));
      }
      const offset = (y * size + x) * 4;
      for (let c = 0; c < 3; c++) data[offset + c] = Math.round(THREE.MathUtils.lerp(rear[c], original[c], blend));
      data[offset + 3] = 255;
    }
  }
  return { geometry: ringGeometry(rings, 72), texture: dataTexture(data, size, size) };
}

function applyBodyPhotographs(input: HumanBodyInput, group: THREE.Group, appearance: HumanAppearance,
  torsoBox: Box, textures: Set<THREE.Texture>, materials: Set<THREE.Material>) {
  const atlas = input.photographicBody;
  const originalWidth = 0.426 * THREE.MathUtils.clamp(appearance.torsoWidthScale ?? 1, 0.8, 1.28);
  const observedShirtHeight = 0.49 * THREE.MathUtils.clamp(appearance.torsoSourceBottom ?? 1, 0.78, 1);
  const skinRGB = rgbOf(appearance.skinColor);
  const shirtRGB = rgbOf(appearance.shirtColor);
  const colorDistance = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const yaw = new THREE.Matrix4().makeRotationY(appearance.yaw ?? 0);
  group.updateMatrixWorld(true);
  const inverseRoot = group.matrixWorld.clone().invert();
  const surfaces: { geometry: THREE.BufferGeometry; matrix: THREE.Matrix4 }[] = [];
  group.traverse((child) => {
    if (child instanceof THREE.Mesh) surfaces.push({ geometry: child.geometry,
      matrix: new THREE.Matrix4().multiplyMatrices(inverseRoot, child.matrixWorld) });
  });
  const observedBottom = 1.445 - observedShirtHeight;
  const sourceCamera = orthographicPhotoProjection({ left: -originalWidth / 2,
    right: originalWidth / 2, bottom: observedBottom, top: 1.445 }, appearance.yaw ?? 0);
  const sourceVisibility = rasterizePhotoVisibility(surfaces, sourceCamera, 192, 192);
  const atlasViews = atlas ? [true, false].map((front) => {
    const image = front ? atlas.front : atlas.back;
    const box: Box = (front ? atlas.frontBox : atlas.backBox) ?? [0, 0, 1, 1];
    const camera = orthographicPhotoProjection({ left: -0.37, right: 0.37, bottom: 0, top: 1.766 }, front ? 0 : Math.PI);
    const visibility = rasterizePhotoVisibility(surfaces, camera);
    const foreground = turnaroundForeground(image, box);
    return { image, box, camera, visibility, register: registerTurnaroundSilhouette(visibility, foreground) };
  }) : [];
  const atlasSample = (point: THREE.Vector3, normal: THREE.Vector3, index: number) => {
    const view = atlasViews[index];
    if (!view) return undefined;
    const confidence = projectionConfidence(point, normal, view.camera, view.visibility);
    if (confidence <= 0) return undefined;
    const projection = view.camera.project(point);
    const uv = view.register(projection.u, projection.v);
    if (!uv) return undefined;
    return {
      color: rgbaSample(view.image, THREE.MathUtils.lerp(view.box[1], view.box[3], uv.u),
        THREE.MathUtils.lerp(view.box[0], view.box[2], uv.v)), confidence,
    };
  };
  for (const child of group.children) {
    if (!(child instanceof THREE.Mesh)) continue;
    const upper = /^(shirt-torso|.*-(sleeve|upper-arm|forearm))$/.test(child.name);
    const lower = /^(pelvis|.*-(thigh|knee|calf|shoe))$/.test(child.name);
    if (!upper && !(lower && atlas)) continue;
    const sampleSurface = child.geometry.userData.surfaceAt as ((u: number, v: number) => THREE.Vector3) | undefined;
    if (!sampleSurface) continue;
    child.updateMatrix();
    const normalMatrix = new THREE.Matrix3().getNormalMatrix(child.matrix);
    const fallback = child.name === "shirt-torso" || child.name.endsWith("sleeve") ||
      appearance.sleeves === "long" && upper ? appearance.shirtColor : lower
        ? child.name.endsWith("shoe") ? appearance.shoeColor : appearance.pantsColor : appearance.skinColor;
    const base = rgbOf(fallback);
    const size = child.name === "shirt-torso" ? 512 : 128;
    const data = new Uint8Array(size * size * 4);
    for (let row = 0; row < size; row++) for (let col = 0; col < size; col++) {
      const u = col / (size - 1), v = row / (size - 1);
      const local = sampleSurface(u, v);
      const p = local.clone().applyMatrix4(child.matrix);
      // Compare a neighboring surface sample to find its front/back normal,
      // including the tilt of sleeves and bent limbs.
      const du = sampleSurface((u + 0.002) % 1, v).sub(local);
      const dv = sampleSurface(u, Math.min(1, v + 0.002))
        .sub(sampleSurface(u, Math.max(0, v - 0.002)));
      const n = du.cross(dv).applyMatrix3(normalMatrix).normalize();
      const color = [...base];
      for (let view = 0; view < atlasViews.length; view++) {
        const sample = atlasSample(p, n, view);
        if (sample) for (let c = 0; c < 3; c++)
          color[c] = THREE.MathUtils.lerp(color[c], sample.color[c], sample.confidence);
      }
      const observed = p.clone().applyMatrix4(yaw);
      const sourceNormal = n.clone().transformDirection(yaw);
      const sourceBlend = projectionConfidence(p, n, sourceCamera, sourceVisibility);
      const garment = child.name === "shirt-torso" || child.name.endsWith("sleeve") || appearance.sleeves === "long" && upper;
      // Use one print on the observed shirt. A second, slightly shifted atlas
      // print must not show through occluded edges of the original garment.
      if (garment && sourceNormal.z > 0) {
        const cleanObserved = THREE.MathUtils.smoothstep(sourceNormal.z, 0, 0.2);
        for (let c = 0; c < 3; c++) color[c] = THREE.MathUtils.lerp(color[c], shirtRGB[c], cleanObserved);
      }
      if (upper && observed.y >= observedBottom && observed.y <= 1.445 && sourceBlend > 0) {
        const projected = sourceCamera.project(p);
        const sx = THREE.MathUtils.lerp(torsoBox[1], torsoBox[3], projected.u);
        const sy = THREE.MathUtils.lerp(torsoBox[0], torsoBox[2], projected.v);
        const inset = 1.5 / Math.max(input.mask.width, input.mask.height);
        if (maskAt(input.mask, sx, sy) && maskAt(input.mask, sx - inset, sy) && maskAt(input.mask, sx + inset, sy)) {
          const photo = rgbaSample(input.source, sx, sy);
          // Bare forearms may be inside a person's silhouette but are not shirt
          // fabric. Keep their photographic color on arm geometry only.
          const warmSkin = photo[0] > photo[1] * 1.08 && photo[0] - photo[2] > 15;
          const skinOnClothing = garment && observed.y < 1.37 && warmSkin
            && colorDistance(photo, skinRGB) + 18 < colorDistance(photo, shirtRGB);
          if (!skinOnClothing)
            for (let c = 0; c < 3; c++) color[c] = THREE.MathUtils.lerp(color[c], photo[c], sourceBlend);
        }
      }
      const offset = (row * size + col) * 4;
      for (let c = 0; c < 3; c++) data[offset + c] = Math.round(color[c]);
      data[offset + 3] = 255;
    }
    const map = dataTexture(data, size, size);
    textures.add(map);
    const material = photographicMaterial(map, 0.98);
    materials.add(material);
    child.material = material;
    child.userData.photoProjection = atlas ? "visibility-weighted-registered-turnaround" : "visible-source-projection";
  }
  group.userData.textureBaking = "occlusion-aware-multiview";
}

function makeBodyTexture(source: VolumePixels, mask: VolumePixels, box: Box,
  fallback: string, face: boolean, sourceBack: boolean) {
  const size = face ? 256 : 384;
  const output = new Uint8Array(size * size * 4);
  const color = new THREE.Color(fallback).getHexString();
  const base = [0, 2, 4].map((offset) => parseInt(color.slice(offset, offset + 2), 16));
  const [top, left, bottom, right] = box;
  const sample = (x: number, y: number) => {
    const sx = Math.max(0, Math.min(source.width - 1, Math.round(x * (source.width - 1))));
    const sy = Math.max(0, Math.min(source.height - 1, Math.round(y * (source.height - 1))));
    const mx = Math.max(0, Math.min(mask.width - 1, Math.round(x * (mask.width - 1))));
    const my = Math.max(0, Math.min(mask.height - 1, Math.round(y * (mask.height - 1))));
    if (Number(mask.data[(my * mask.width + mx) * 4]) < 90) return null;
    const index = (sy * source.width + sx) * 4;
    return [0, 1, 2].map((channel) => Number(source.data[index + channel]));
  };
  for (let row = 0; row < size; row++) {
    const v = row / (size - 1);
    for (let col = 0; col < size; col++) {
      const angle = (col / (size - 1)) * Math.PI * 2 - Math.PI;
      const facing = Math.cos(angle) * (sourceBack ? -1 : 1);
      const blend = THREE.MathUtils.smoothstep(facing, face ? 0.05 : 0.03, face ? 0.65 : 0.55);
      const x = THREE.MathUtils.lerp(left, right,
        ((sourceBack ? -1 : 1) * Math.sin(angle) + 1) / 2);
      // Typed textures use their first row at v=0, the bottom of the model.
      const y = THREE.MathUtils.lerp(bottom, top, v);
      const rgb = blend > 0 ? sample(x, y) : null;
      const index = (row * size + col) * 4;
      for (let channel = 0; channel < 3; channel++)
        output[index + channel] = rgb ? Math.round(base[channel] * (1 - blend) + rgb[channel] * blend) : base[channel];
      output[index + 3] = 255;
    }
  }
  const texture = new THREE.DataTexture(output, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = 4;
  texture.needsUpdate = true;
  return texture;
}
