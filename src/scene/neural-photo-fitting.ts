import * as THREE from "three";
import type { HumanAppearance, PhotoBox } from "./human-appearance";
import type { VolumePixels } from "./volume";
import { registeredFaceOf } from "./registered-face";
import { mirroredFaceView } from "./mirrored-face";
import { orthographicPhotoProjection, overlayPhotographsOnVertexColors,
  turnaroundForeground, projectionConfidence, rasterizePhotoVisibility,
  registerTurnaroundSilhouette, cropEdgeConfidence, type VertexPhotoView } from "./texture-projection";

export interface NeuralHumanPhotographs {
  source: VolumePixels;
  mask: VolumePixels;
  appearance: HumanAppearance;
  /** A reviewed pose estimate, relative to the canonical body front. */
  fittedHeadYaw?: number;
  photographicBody?: {
    front: VolumePixels;
    back: VolumePixels;
    frontBox?: PhotoBox;
    backBox?: PhotoBox;
  };
}

export interface HumanPhotoFitResult {
  updatedVertices: number;
  viewCount: number;
  uvMaps?: number;
  dispose?: () => void;
}

const quantile = (values: number[], fraction: number) => {
  values.sort((a, b) => a - b);
  return values[Math.round((values.length - 1) * fraction)];
};
const rgb = (hex: string) => {
  const color = new THREE.Color(hex).getHexString();
  return [0, 2, 4].map((i) => parseInt(color.slice(i, i + 2), 16));
};
const distance = (a: number[], b: number[]) => Math.hypot(...a.map((n, i) => n - b[i]));
const originalPosePositions = new WeakMap<THREE.BufferGeometry, Float32Array>();
const preservesPhotoHair = (mesh: THREE.Mesh) => /hair/i.test(mesh.name)
  && mesh.userData.sourceHair === true && mesh.userData.preserveVertexColors === true;

/** Unobserved template surfaces inherit the source palette, including strictly
 * monochrome memories. Neutral asset skin and cloth colors never leak through. */
export function seedAnatomicalAppearance(group: THREE.Group, appearance: HumanAppearance) {
  const color = new THREE.Color(); let meshes = 0;
  group.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    const name = mesh.name.toLowerCase();
    // Subject-specific learned caps already carry the photographed hair color.
    if (preservesPhotoHair(mesh)) return;
    const hex = /hair|brow|lash/.test(name) ? appearance.hairColor
      : /shirt|jacket/.test(name) ? appearance.shirtColor
        : /pants|trouser/.test(name) ? appearance.pantsColor
          : /shoe|boot|sole/.test(name) ? appearance.shoeColor
            : /eye/.test(name) ? "#d6d6d6" : appearance.skinColor;
    color.set(hex);
    const count = mesh.geometry.getAttribute("position").count;
    const values = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) values.set([color.r, color.g, color.b], i * 3);
    mesh.geometry.setAttribute("color", new THREE.Float32BufferAttribute(values, 3));
    mesh.userData.photoAppearanceSeeded = true; meshes++;
  });
  return meshes;
}

type AnatomicalFit = { headPivot: number[]; headFadeStartY: number; headFadeEndY: number; headChinY: number; referenceHeight: number;
  garmentPhotoChinY?: number; garmentPhotoCrownY?: number };
function anatomicalFitOf(group: THREE.Group): AnatomicalFit | undefined {
  let result: AnatomicalFit | undefined;
  group.updateMatrixWorld(true);
  const inverseRoot = group.matrixWorld.clone().invert();
  group.traverse((object) => {
    const value = object.userData.anatomicalFit;
    if (result || !value || !Array.isArray(value.headPivot) || value.headPivot.length !== 3) return;
    if (![...value.headPivot, value.headFadeStartY, value.headFadeEndY, value.headChinY, value.referenceHeight].every(Number.isFinite)) return;
    if (value.referenceHeight < 0.5 || value.referenceHeight > 3 || value.headFadeStartY < 0
      || value.headFadeEndY <= value.headFadeStartY || value.headFadeEndY > value.referenceHeight
      || value.headChinY < value.headFadeStartY || value.headChinY > value.referenceHeight) return;
    // Metadata is authored in this scene's coordinates. The loader normalizes
    // and recenters that scene, so body-height ratios alone lose the Z offset.
    const matrix = new THREE.Matrix4().multiplyMatrices(inverseRoot, object.matrixWorld);
    const heightAt = (y: number) => new THREE.Vector3(0, y, 0).applyMatrix4(matrix).y;
    result = { headPivot: new THREE.Vector3(...value.headPivot as [number, number, number]).applyMatrix4(matrix).toArray(),
      headFadeStartY: heightAt(value.headFadeStartY), headFadeEndY: heightAt(value.headFadeEndY),
      headChinY: heightAt(value.headChinY), referenceHeight: heightAt(value.referenceHeight) - heightAt(0) };
    if (Number.isFinite(value.garmentPhotoChinY) && Number.isFinite(value.garmentPhotoCrownY)
      && value.garmentPhotoChinY > 0 && value.garmentPhotoCrownY > value.garmentPhotoChinY && value.garmentPhotoCrownY < 3) {
      result.garmentPhotoChinY = heightAt(value.garmentPhotoChinY);
      result.garmentPhotoCrownY = heightAt(value.garmentPhotoCrownY);
    }
  });
  return result;
}

/** Pose authored head/neck vertices before photographic projection. Smooth
 * neck weights keep the seam attached; repeating the fit never compounds yaw. */
export function poseAnatomicalHead(group: THREE.Group, yaw: number, fit: AnatomicalFit) {
  if (!Number.isFinite(yaw) || Math.abs(yaw) > Math.PI / 2) return 0;
  group.updateMatrixWorld(true);
  const inverseRoot = group.matrixWorld.clone().invert();
  const meshes: THREE.Mesh[] = [];
  group.traverse((object) => { const mesh = object as THREE.Mesh; if (mesh.isMesh) meshes.push(mesh); });
  const pivot = new THREE.Vector3(...fit.headPivot as [number, number, number]);
  const start = fit.headFadeStartY, end = fit.headFadeEndY;
  const point = new THREE.Vector3(); let updated = 0;
  for (const mesh of meshes) {
    if (!/head|hair|eye|brow|lash/i.test(mesh.name)) continue;
    const positions = mesh.geometry.getAttribute("position");
    let original = originalPosePositions.get(mesh.geometry);
    if (!original) {
      original = new Float32Array(positions.count * 3);
      for (let i = 0; i < positions.count; i++) original.set([positions.getX(i), positions.getY(i), positions.getZ(i)], i * 3);
      originalPosePositions.set(mesh.geometry, original);
    }
    const matrix = new THREE.Matrix4().multiplyMatrices(inverseRoot, mesh.matrixWorld), inverse = matrix.clone().invert();
    for (let i = 0; i < positions.count; i++) {
      point.fromArray(original, i * 3).applyMatrix4(matrix);
      const angle = yaw * THREE.MathUtils.smoothstep(point.y, start, end), c = Math.cos(angle), s = Math.sin(angle);
      const x = point.x - pivot.x, z = point.z - pivot.z;
      point.x = pivot.x + c * x + s * z; point.z = pivot.z - s * x + c * z;
      point.applyMatrix4(inverse); positions.setXYZ(i, point.x, point.y, point.z); updated++;
    }
    positions.needsUpdate = true; mesh.geometry.computeVertexNormals();
    mesh.geometry.computeBoundingBox(); mesh.geometry.computeBoundingSphere();
  }
  group.userData.appliedHeadYaw = yaw;
  return updated;
}

/** Retexture a reviewed, canonical +Z-facing neural body using its actual mesh
 * silhouette. Geometry stays learned; inferred views cover the complete body,
 * then fitted original crops restore the observed clothes and head.
 *
 * Fitting assumes a complete standing adult. The neck is measured in a bounded
 * anatomical band; it does not assume that a waist-cropped photo includes feet.
 * A back-view source projects from -Z, leaving the inferred front face alone. */
export async function fitNeuralHumanPhotographs(group: THREE.Group, input: NeuralHumanPhotographs): Promise<HumanPhotoFitResult> {
  const anatomical = group.userData.inputKind === "anatomical-template" || group.userData.kind === "anatomical-human";
  if (group.userData.appearance === "pbr" && !anatomical) return { updatedVertices: 0, viewCount: 0 };
  if (anatomical) seedAnatomicalAppearance(group, input.appearance);
  const anatomicalFit = anatomical ? anatomicalFitOf(group) : undefined;
  const registeredFace = anatomical ? registeredFaceOf(group) : undefined;
  const headYaw = input.fittedHeadYaw ?? group.userData.templateHeadYaw ?? input.appearance.headYaw;
  // Landmark assets already contain one rigid pitch/yaw/roll pose. Applying
  // the old yaw a second time would twist the calibrated face away from its image.
  if (!registeredFace && anatomicalFit && Number.isFinite(headYaw)) poseAnatomicalHead(group, headYaw, anatomicalFit);
  group.updateMatrixWorld(true);
  const inverse = group.matrixWorld.clone().invert();
  const points: THREE.Vector3[] = [];
  const bounds = new THREE.Box3();
  group.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    const positions = mesh.geometry.getAttribute("position");
    const matrix = new THREE.Matrix4().multiplyMatrices(inverse, mesh.matrixWorld);
    for (let i = 0; i < positions.count; i++) {
      const point = new THREE.Vector3().fromBufferAttribute(positions, i).applyMatrix4(matrix);
      points.push(point); bounds.expandByPoint(point);
    }
  });
  if (!points.length || bounds.isEmpty()) return { updatedVertices: 0, viewCount: 0 };
  const height = bounds.max.y - bounds.min.y;
  const width = bounds.max.x - bounds.min.x;
  if (height < 0.1 || width < 0.01) return { updatedVertices: 0, viewCount: 0 };
  const floor = bounds.min.y, crown = bounds.max.y;
  const span = (bottom: number, top: number) => {
    const values = points.filter((p) => p.y >= bottom && p.y <= top).map((p) => p.x);
    if (values.length < 4) return [bounds.min.x, bounds.max.x] as [number, number];
    return [quantile([...values], 0.015), quantile(values, 0.985)] as [number, number];
  };
  let neck = floor + height * 0.84;
  let narrowest = Infinity;
  for (let i = 0; i <= 12; i++) {
    const y = floor + height * (0.80 + i * 0.005);
    const [left, right] = span(y - height * 0.012, y + height * 0.012);
    if (right - left < narrowest) { narrowest = right - left; neck = y; }
  }
  const chin = anatomicalFit ? anatomicalFit.headChinY
    : Math.min(crown - height * 0.12, neck + height * 0.008);
  const [headLeft, headRight] = span(chin, crown - height * 0.015);
  const sourceBack = input.appearance.sourceView === "back";
  const sourceYaw = sourceBack ? Math.PI : 0;
  const observedHeadLeft = sourceBack ? -headRight : headLeft;
  const observedHeadRight = sourceBack ? -headLeft : headRight;
  const views: VertexPhotoView[] = [];

  if (input.photographicBody) {
    for (const front of [true, false]) {
      const image = front ? input.photographicBody.front : input.photographicBody.back;
      const box = (front ? input.photographicBody.frontBox : input.photographicBody.backBox) ?? [0, 0, 1, 1];
      views.push({ image, box, foreground: turnaroundForeground(image, box), fitSilhouette: true,
        // The atlas has different head-to-body proportions. Mapping that face
        // onto an authored neck creates a second mouth; source crops own skin.
        meshFilter: anatomical ? (mesh) => !/head|neck|hair|eye|brow|lash/i.test(mesh.name) : undefined,
        camera: orthographicPhotoProjection({ left: bounds.min.x, right: bounds.max.x,
          bottom: floor, top: crown }, front ? 0 : Math.PI) });
    }
  }

  const face: PhotoBox | undefined = anatomical && group.userData.templateSourceFaceBox
    ? group.userData.templateSourceFaceBox : input.appearance.faceBox;
  const sourceNeck: PhotoBox | undefined = anatomical && group.userData.templateSourceNeckBox
    ? group.userData.templateSourceNeckBox : input.appearance.neckBox;
  const torso = input.appearance.torsoBox ?? input.appearance.chestBox;
  if (face && face[2] > face[0] && face[3] > face[1]) {
    const scaleY = (crown - chin) / (face[2] - face[0]);
    // Standard heads keep the photograph's pixel aspect ratio. Independently
    // expanding a profile crop to a frontal skull width makes faces too broad.
    const scaleX = anatomical ? scaleY * input.source.width / input.source.height
      : (headRight - headLeft) / (face[3] - face[1]);
    const faceCenter = (face[1] + face[3]) / 2;
    const modelCenter = (observedHeadLeft + observedHeadRight) / 2;
    if (torso) {
      const garmentChin = anatomicalFit?.garmentPhotoChinY ?? chin;
      const garmentScaleY = ((anatomicalFit?.garmentPhotoCrownY ?? crown) - garmentChin) / (face[2] - face[0]);
      const garmentScaleX = anatomical ? garmentScaleY * input.source.width / input.source.height : scaleX;
      const top = garmentChin - (torso[0] - face[2]) * garmentScaleY;
      // Keep the crop at the head-fitted image scale. A cropped shirt must
      // not be extended to the model waist simply because the body is complete.
      const bottom = Math.max(floor + height * 0.45, garmentChin - (torso[2] - face[2]) * garmentScaleY);
      const fittedWidth = THREE.MathUtils.clamp((torso[3] - torso[1]) * garmentScaleX, width * 0.55, width * 1.25);
      const center = modelCenter + ((torso[1] + torso[3]) / 2 - faceCenter) * garmentScaleX;
      const skin = rgb(input.appearance.skinColor), shirt = rgb(input.appearance.shirtColor);
      if (top > bottom) views.push({ image: input.source, mask: input.mask, box: torso,
        meshFilter: anatomical ? (mesh) => /shirt|jacket/i.test(mesh.name) : undefined,
        camera: orthographicPhotoProjection({ left: center - fittedWidth / 2,
          right: center + fittedWidth / 2, bottom, top }, sourceYaw),
        region: new THREE.Box3(new THREE.Vector3(bounds.min.x, bottom, bounds.min.z),
          new THREE.Vector3(bounds.max.x, top, bounds.max.z)),
        acceptSample: (color, point, previous) => {
          // The complete-body atlas already separates sleeves from bare arms.
          // Keep that high-confidence material boundary when the source pose
          // differs; a shirt pixel must not paint over an atlas-colored arm.
          const previousSkin = previous[0] > previous[1] * 1.08 && previous[0] - previous[2] > 15
            && distance(previous, skin) + 24 < distance(previous, shirt);
          const sampledClothing = distance(color, shirt) + 12 < distance(color, skin);
          if (previousSkin && sampledClothing) return false;
          const warmSkin = color[0] > color[1] * 1.08 && color[0] - color[2] > 15;
          return point.y > top - height * 0.035 || !warmSkin || distance(color, skin) + 18 >= distance(color, shirt);
        },
      });
    }
    if (anatomical && sourceNeck) {
      const neck = sourceNeck;
      const top = Math.min(chin, chin - (neck[0] - face[2]) * scaleY), bottom = chin - (neck[2] - face[2]) * scaleY;
      const center = modelCenter + ((neck[1] + neck[3]) / 2 - faceCenter) * scaleX;
      const halfWidth = (neck[3] - neck[1]) * scaleX / 2;
      views.push({ image: input.source, mask: input.mask, box: neck, edgeFeather: 0.05,
        meshFilter: (mesh) => /head|skin/i.test(mesh.name),
        camera: registeredFace?.camera(neck) ?? orthographicPhotoProjection({ left: center - halfWidth, right: center + halfWidth, bottom, top }, sourceYaw),
        region: registeredFace ? undefined : new THREE.Box3(new THREE.Vector3(bounds.min.x, bottom, bounds.min.z), new THREE.Vector3(bounds.max.x, top, bounds.max.z)) });
    }
    const faceWidth = anatomical ? (face[3] - face[1]) * scaleX : observedHeadRight - observedHeadLeft;
    const inferredFace = registeredFace ? mirroredFaceView(group, input.source, input.mask) : undefined;
    if (inferredFace) views.push(inferredFace);
    const headBox = registeredFace?.sourceBox ?? face;
    views.push({ image: input.source, mask: input.mask, box: headBox, edgeFeather: anatomical ? 0.05 : undefined,
      meshFilter: anatomical ? (mesh) => /head|hair|eye|brow|lash/i.test(mesh.name) && !preservesPhotoHair(mesh) : undefined,
      camera: registeredFace?.camera(headBox) ?? orthographicPhotoProjection({ left: modelCenter - faceWidth / 2, right: modelCenter + faceWidth / 2,
        bottom: chin, top: crown }, sourceYaw),
      region: registeredFace ? undefined : new THREE.Box3(new THREE.Vector3(headLeft - height * 0.015, chin, bounds.min.z),
        new THREE.Vector3(headRight + height * 0.015, crown, bounds.max.z)),
    });
  }
  const result = overlayPhotographsOnVertexColors(group, views);
  const uv = anatomical ? await bakePhotographsToUv(group, views) : undefined;
  group.userData.photoFit = { method: registeredFace?.strategy ?? "visibility-weighted-source-and-turnaround",
    originalView: sourceBack ? "back" : "front", chin, crown, headLeft, headRight,
    ...result, uvMaps: uv?.uvMaps ?? 0, headYaw: group.userData.appliedHeadYaw,
    sourceFaceBox: registeredFace?.sourceBox ?? face, sourceNeckBox: sourceNeck,
    landmarkErrorPixels: registeredFace?.landmarkErrorPixels };
  return { ...result, ...uv };
}

/** Bake at texel resolution on authored UVs. A face on a low-poly base retains
 * source image detail instead of being limited to its vertex-color density. */
export async function bakePhotographsToUv(group: THREE.Group, views: VertexPhotoView[], resolution?: number | ((mesh: THREE.Mesh) => number)) {
  group.updateMatrixWorld(true);
  const inverse = group.matrixWorld.clone().invert();
  const surfaces: { mesh: THREE.Mesh; geometry: THREE.BufferGeometry; matrix: THREE.Matrix4 }[] = [];
  group.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    if (!mesh.geometry.getAttribute("normal")) mesh.geometry.computeVertexNormals();
    surfaces.push({ mesh, geometry: mesh.geometry,
      matrix: new THREE.Matrix4().multiplyMatrices(inverse, mesh.matrixWorld) });
  });
  const prepared = views.map((view) => {
    const visibility = rasterizePhotoVisibility(surfaces, view.camera, 256, 256);
    return { ...view, visibility, register: view.foreground && view.fitSilhouette
      ? registerTurnaroundSilhouette(visibility, view.foreground) : undefined };
  });
  const textures: THREE.DataTexture[] = [];
  const materials: THREE.Material[] = [];
  const replaced: { mesh: THREE.Mesh; original: THREE.Material | THREE.Material[] }[] = [];
  const color = new THREE.Color(), point = new THREE.Vector3(), normal = new THREE.Vector3();
  let lastYield = performance.now();
  const yieldWork = async () => {
    if (performance.now() - lastYield < 16) return;
    // Timers can be clamped to a second in background tabs. A posted task still
    // lets input/rendering run without making hundreds of bake batches wait.
    await new Promise<void>((resolve) => {
      if (typeof window === "undefined" || typeof MessageChannel === "undefined") {
        setTimeout(resolve, 0);
        return;
      }
      const channel = new MessageChannel();
      channel.port1.onmessage = () => {
        channel.port1.close(); channel.port2.close(); resolve();
      };
      channel.port2.postMessage(null);
    });
    lastYield = performance.now();
  };
  const sourceCache = new Map<THREE.Texture, VolumePixels | undefined>();
  const texturePixels = (texture?: THREE.Texture | null) => {
    if (!texture) return undefined;
    if (sourceCache.has(texture)) return sourceCache.get(texture);
    const image = texture.image;
    let pixels: VolumePixels | undefined;
    if (image?.data && image.width && image.height && image.data.length >= image.width * image.height * 4)
      pixels = { width: image.width, height: image.height, data: image.data };
    else if (image && typeof document !== "undefined") {
      const width = image.naturalWidth ?? image.width, height = image.naturalHeight ?? image.height;
      if (width && height) {
        const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (context) { context.drawImage(image, 0, 0); pixels = context.getImageData(0, 0, width, height); }
      }
    }
    sourceCache.set(texture, pixels); return pixels;
  };
  const sample = (image: VolumePixels, u: number, v: number, channel: number) => {
    const x = THREE.MathUtils.clamp(u, 0, 1) * (image.width - 1);
    const y = THREE.MathUtils.clamp(v, 0, 1) * (image.height - 1);
    const x0 = Math.floor(x), y0 = Math.floor(y), x1 = Math.min(x0 + 1, image.width - 1), y1 = Math.min(y0 + 1, image.height - 1);
    const at = (px: number, py: number) => Number(image.data[(py * image.width + px) * 4 + channel]);
    return THREE.MathUtils.lerp(THREE.MathUtils.lerp(at(x0, y0), at(x1, y0), x - x0),
      THREE.MathUtils.lerp(at(x0, y1), at(x1, y1), x - x0), y - y0);
  };
  for (const surface of surfaces) {
    await yieldWork();
    const geometry = surface.geometry, uv = geometry.getAttribute("uv");
    if (!uv) continue;
    const positions = geometry.getAttribute("position"), normals = geometry.getAttribute("normal");
    const colors = geometry.getAttribute("color"), index = geometry.index;
    const normalMatrix = new THREE.Matrix3().getNormalMatrix(surface.matrix);
    const vertices = Array.from({ length: positions.count }, (_, i) => ({
      point: new THREE.Vector3().fromBufferAttribute(positions, i).applyMatrix4(surface.matrix),
      normal: new THREE.Vector3().fromBufferAttribute(normals, i).applyMatrix3(normalMatrix).normalize(),
      u: uv.getX(i), v: uv.getY(i),
      color: colors ? [colors.getX(i), colors.getY(i), colors.getZ(i)] : [1, 1, 1],
    }));
    const original = surface.mesh.material;
    const originalList = Array.isArray(original) ? original : [original];
    const count = index?.count ?? positions.count;
    const nextMaterials: THREE.Material[] = [];
    for (let materialIndex = 0; materialIndex < originalList.length; materialIndex++) {
      const originalMaterial = originalList[materialIndex];
      const original = originalMaterial as THREE.MeshBasicMaterial;
      const sourceDetail = prepared.filter((view) => view.mask && (!view.meshFilter || view.meshFilter(surface.mesh)))
        .reduce((largest, view) => Math.max(largest, view.image.height * ((view.box?.[2] ?? 1) - (view.box?.[0] ?? 0))), 0);
      const size = (typeof resolution === "function" ? resolution(surface.mesh) : resolution) ?? (/head|face/i.test(surface.mesh.name) && sourceDetail > 350 ? 1024 : 512);
      const data = new Uint8Array(size * size * 4), coverage = new Uint8Array(size * size);
      const baseMap = texturePixels(original.map);
      const ranges = geometry.groups.length ? geometry.groups.filter((g) => (g.materialIndex ?? 0) === materialIndex)
        : [{ start: 0, count }];
      let minU = Infinity, minV = Infinity, maxU = -Infinity, maxV = -Infinity;
      for (const range of ranges) for (let i = range.start; i < Math.min(count, range.start + range.count); i++) {
        const vertex = vertices[index ? index.getX(i) : i];
        minU = Math.min(minU, vertex.u); maxU = Math.max(maxU, vertex.u);
        minV = Math.min(minV, vertex.v); maxV = Math.max(maxV, vertex.v);
      }
      if (!Number.isFinite(minU) || maxU - minU < 1e-6 || maxV - minV < 1e-6) {
        minU = minV = 0; maxU = maxV = 1;
      }
      const extentU = maxU - minU, extentV = maxV - minV;
      for (const range of ranges) for (let i = range.start; i < Math.min(count, range.start + range.count); i += 3) {
        const a = vertices[index ? index.getX(i) : i], b = vertices[index ? index.getX(i + 1) : i + 1], c = vertices[index ? index.getX(i + 2) : i + 2];
        const ax = (a.u - minU) / extentU * (size - 1), ay = (a.v - minV) / extentV * (size - 1);
        const bx = (b.u - minU) / extentU * (size - 1), by = (b.v - minV) / extentV * (size - 1);
        const cx = (c.u - minU) / extentU * (size - 1), cy = (c.v - minV) / extentV * (size - 1);
        const area = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
        if (!Number.isFinite(area) || Math.abs(area) < 1e-7) continue;
        const minX = Math.max(0, Math.floor(Math.min(ax, bx, cx))), maxX = Math.min(size - 1, Math.ceil(Math.max(ax, bx, cx)));
        const minY = Math.max(0, Math.floor(Math.min(ay, by, cy))), maxY = Math.min(size - 1, Math.ceil(Math.max(ay, by, cy)));
        for (let y = minY; y <= maxY; y++) {
          if ((y & 15) === 0) await yieldWork();
          for (let x = minX; x <= maxX; x++) {
          const wa = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / area;
          const wb = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / area, wc = 1 - wa - wb;
          if (Math.min(wa, wb, wc) < -0.0001) continue;
          point.set(a.point.x * wa + b.point.x * wb + c.point.x * wc,
            a.point.y * wa + b.point.y * wb + c.point.y * wc, a.point.z * wa + b.point.z * wb + c.point.z * wc);
          normal.set(a.normal.x * wa + b.normal.x * wb + c.normal.x * wc,
            a.normal.y * wa + b.normal.y * wb + c.normal.y * wc, a.normal.z * wa + b.normal.z * wb + c.normal.z * wc).normalize();
          color.setRGB(a.color[0] * wa + b.color[0] * wb + c.color[0] * wc,
            a.color[1] * wa + b.color[1] * wb + c.color[1] * wc, a.color[2] * wa + b.color[2] * wb + c.color[2] * wc);
          if (original.color && !surface.mesh.userData.photoAppearanceSeeded) color.multiply(original.color);
          color.convertLinearToSRGB();
          const rgb = [color.r * 255, color.g * 255, color.b * 255];
          const originalU = minU + x / (size - 1) * extentU, originalV = minV + y / (size - 1) * extentV;
          const textureY = original.map?.flipY ? 1 - originalV : originalV;
          const alpha = baseMap ? sample(baseMap, originalU, textureY, 3) : 255;
          if (baseMap && !surface.mesh.userData.photoAppearanceSeeded)
            for (let channel = 0; channel < 3; channel++) rgb[channel] *= sample(baseMap, originalU, textureY, channel) / 255;
          for (const view of prepared) {
            if (view.meshFilter && !view.meshFilter(surface.mesh)) continue;
            if (view.region && !view.region.containsPoint(point)) continue;
            let weight = projectionConfidence(point, normal, view.camera, view.visibility) * (view.strength ?? 1);
            if (weight <= 0) continue;
            const p = view.camera.project(point), registered = view.register ? view.register(p.u, p.v) : p;
            if (!registered || view.foreground && !view.foreground.contains(registered.u, registered.v)) continue;
            weight *= cropEdgeConfidence(registered.u, registered.v, view.edgeFeather);
            if (weight <= 0) continue;
            const box = view.box ?? [0, 0, 1, 1], u = THREE.MathUtils.lerp(box[1], box[3], registered.u), v = THREE.MathUtils.lerp(box[0], box[2], registered.v);
            if (view.mask) {
              const du = 1.5 / view.mask.width, dv = 1.5 / view.mask.height;
              if (u - du < 0 || u + du > 1 || v - dv < 0 || v + dv > 1
                || sample(view.mask, u, v, 0) < 100 || sample(view.mask, u - du, v, 0) < 100
                || sample(view.mask, u + du, v, 0) < 100 || sample(view.mask, u, v - dv, 0) < 100
                || sample(view.mask, u, v + dv, 0) < 100) continue;
            }
            const photo = [0, 1, 2].map((channel) => sample(view.image, u, v, channel));
            if (view.acceptSample && !view.acceptSample(photo, point, rgb)) continue;
            for (let channel = 0; channel < 3; channel++) rgb[channel] = THREE.MathUtils.lerp(rgb[channel], photo[channel], weight);
          }
          const offset = (y * size + x) * 4;
          for (let channel = 0; channel < 3; channel++) data[offset + channel] = Math.round(rgb[channel]);
          data[offset + 3] = Math.round(alpha); coverage[y * size + x] = 1;
          }
        }
      }
      // A small gutter around UV islands avoids black mipmap seams.
      for (let pass = 0; pass < 3; pass++) {
        const next = coverage.slice();
        for (let y = 0; y < size; y++) {
          if ((y & 15) === 0) await yieldWork();
          for (let x = 0; x < size; x++) {
          const i = y * size + x;
          if (coverage[i]) continue;
          const adjacent = x > 0 && coverage[i - 1] ? i - 1 : x < size - 1 && coverage[i + 1] ? i + 1
            : y > 0 && coverage[i - size] ? i - size : y < size - 1 && coverage[i + size] ? i + size : -1;
          if (adjacent < 0) continue;
          data.set(data.subarray(adjacent * 4, adjacent * 4 + 4), i * 4); next[i] = 1;
          }
        }
        coverage.set(next);
      }
      const map = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
      map.colorSpace = THREE.SRGBColorSpace; map.generateMipmaps = true;
      map.minFilter = THREE.LinearMipmapLinearFilter; map.magFilter = THREE.LinearFilter;
      // Spend this map on this mesh's UV island. The texture transform preserves
      // authored UVs and geometry while giving a small head island full detail.
      map.repeat.set(1 / extentU, 1 / extentV); map.offset.set(-minU / extentU, -minV / extentV);
      map.updateMatrix();
      map.anisotropy = 8; map.needsUpdate = true; textures.push(map);
      const material = new THREE.MeshBasicMaterial({ map, color: 0xffffff, vertexColors: false,
        side: original.side, transparent: original.transparent, alphaTest: original.alphaTest,
        opacity: original.opacity, toneMapped: false });
      materials.push(material); nextMaterials.push(material);
    }
    replaced.push({ mesh: surface.mesh, original });
    surface.mesh.material = Array.isArray(original) ? nextMaterials : nextMaterials[0];
  }
  let disposed = false;
  return { uvMaps: textures.length, dispose() {
    if (disposed) return; disposed = true;
    replaced.forEach(({ mesh, original }) => { mesh.material = original; });
    textures.forEach((texture) => texture.dispose()); materials.forEach((material) => material.dispose());
  } };
}
