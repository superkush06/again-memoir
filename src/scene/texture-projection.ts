import * as THREE from "three";
import type { VolumePixels } from "./volume";

type Box = [top: number, left: number, bottom: number, right: number];
export interface PhotoProjection {
  /** Surface coordinates in the camera image, with image rows increasing down. */
  project(point: THREE.Vector3): { u: number; v: number; depth: number };
  direction: THREE.Vector3;
}

/** An orthographic camera fit in model coordinates. This is a fitted image
 * projection, not a neural texture field or a guessed normal map. */
export function orthographicPhotoProjection(
  bounds: { left: number; right: number; bottom: number; top: number },
  yaw = 0,
): PhotoProjection {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  return {
    direction: new THREE.Vector3(-s, 0, c),
    project: (point) => ({
      u: (point.x * c + point.z * s - bounds.left) / (bounds.right - bounds.left),
      v: (bounds.top - point.y) / (bounds.top - bounds.bottom),
      depth: -point.x * s + point.z * c,
    }),
  };
}

export interface VisibilityBuffer {
  width: number;
  height: number;
  depth: Float32Array;
  visible(point: THREE.Vector3, tolerance?: number): boolean;
}

/** Bake the nearest triangle depth once per photograph. A front-facing torso
 * behind an arm is still occluded: a normal test alone cannot detect this. */
export function rasterizePhotoVisibility(
  surfaces: { geometry: THREE.BufferGeometry; matrix?: THREE.Matrix4 }[],
  camera: PhotoProjection,
  width = 192,
  height = 256,
): VisibilityBuffer {
  const depth = new Float32Array(width * height).fill(-Infinity);
  const point = new THREE.Vector3();
  for (const surface of surfaces) {
    const position = surface.geometry.getAttribute("position");
    const index = surface.geometry.getIndex();
    const vertices = Array.from({ length: position.count }, (_, i) => {
      point.fromBufferAttribute(position, i);
      if (surface.matrix) point.applyMatrix4(surface.matrix);
      const p = camera.project(point);
      return { x: p.u * (width - 1), y: p.v * (height - 1), z: p.depth };
    });
    const count = index?.count ?? position.count;
    for (let i = 0; i < count; i += 3) {
      const a = vertices[index ? index.getX(i) : i];
      const b = vertices[index ? index.getX(i + 1) : i + 1];
      const c = vertices[index ? index.getX(i + 2) : i + 2];
      const area = (b.y - c.y) * (a.x - c.x) + (c.x - b.x) * (a.y - c.y);
      if (!Number.isFinite(area) || Math.abs(area) < 1e-8) continue;
      const minX = Math.max(0, Math.floor(Math.min(a.x, b.x, c.x)));
      const maxX = Math.min(width - 1, Math.ceil(Math.max(a.x, b.x, c.x)));
      const minY = Math.max(0, Math.floor(Math.min(a.y, b.y, c.y)));
      const maxY = Math.min(height - 1, Math.ceil(Math.max(a.y, b.y, c.y)));
      for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
        const wa = ((b.y - c.y) * (x - c.x) + (c.x - b.x) * (y - c.y)) / area;
        const wb = ((c.y - a.y) * (x - c.x) + (a.x - c.x) * (y - c.y)) / area;
        const wc = 1 - wa - wb;
        if (wa < -0.0001 || wb < -0.0001 || wc < -0.0001) continue;
        const offset = y * width + x;
        depth[offset] = Math.max(depth[offset], wa * a.z + wb * b.z + wc * c.z);
      }
    }
  }
  return {
    width, height, depth,
    visible(point, tolerance = 0.012) {
      const p = camera.project(point);
      if (p.u < 0 || p.u > 1 || p.v < 0 || p.v > 1) return false;
      const x = Math.round(p.u * (width - 1));
      const y = Math.round(p.v * (height - 1));
      const nearest = depth[y * width + x];
      return Number.isFinite(nearest) && p.depth >= nearest - tolerance;
    },
  };
}

export function projectionConfidence(
  point: THREE.Vector3, normal: THREE.Vector3, camera: PhotoProjection,
  visibility?: VisibilityBuffer,
) {
  const facing = normal.dot(camera.direction);
  if (facing <= 0.04 || visibility && !visibility.visible(point)) return 0;
  return THREE.MathUtils.smoothstep(facing, 0.04, 0.5);
}

/** Feather only a narrow crop border; central photograph pixels remain exact. */
export function cropEdgeConfidence(u: number, v: number, feather = 0) {
  if (feather <= 0) return 1;
  return THREE.MathUtils.smoothstep(Math.min(u, v, 1 - u, 1 - v), 0, Math.min(feather, 0.15));
}

export interface VertexPhotoView {
  image: VolumePixels;
  mask?: VolumePixels;
  box?: Box;
  camera: PhotoProjection;
  /** An optional model-space region, e.g. head only or the observed torso. */
  region?: THREE.Box3;
  strength?: number;
  /** Fraction of crop width/height blended at its border, usually 0.05. */
  edgeFeather?: number;
  /** Register an inferred view against this foreground silhouette. */
  foreground?: ForegroundField;
  fitSilhouette?: boolean;
  /** Optional semantic rejection, e.g. do not bake a bare arm onto a shirt. */
  acceptSample?: (rgb: number[], point: THREE.Vector3, previousRGB: number[]) => boolean;
  /** Authored anatomy can keep a shirt projection on the Shirt mesh only. */
  meshFilter?: (mesh: THREE.Mesh) => boolean;
}

/** Overlay fitted original-photo samples on an imported neural mesh. View
 * order is priority order: a later original face view can overwrite an inferred
 * full-body view. Unseen or occluded vertices keep their learned colors. Meshes
 * retain all geometry and UVs; callers choose a vertex-color material. */
export function overlayPhotographsOnVertexColors(group: THREE.Object3D, views: VertexPhotoView[]) {
  group.updateMatrixWorld(true);
  const inverse = group.matrixWorld.clone().invert();
  const surfaces: { geometry: THREE.BufferGeometry; matrix: THREE.Matrix4; mesh: THREE.Mesh }[] = [];
  group.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    if (!mesh.geometry.getAttribute("normal")) mesh.geometry.computeVertexNormals();
    surfaces.push({ geometry: mesh.geometry,
      matrix: new THREE.Matrix4().multiplyMatrices(inverse, mesh.matrixWorld), mesh });
  });
  const prepared = views.map((view) => {
    const visibility = rasterizePhotoVisibility(surfaces, view.camera, 256, 256);
    return { ...view, visibility, register: view.foreground && view.fitSilhouette
      ? registerTurnaroundSilhouette(visibility, view.foreground) : undefined };
  });
  const point = new THREE.Vector3(), normal = new THREE.Vector3(), sampled = new THREE.Color();
  let updatedVertices = 0;
  for (const surface of surfaces) {
    const position = surface.geometry.getAttribute("position");
    const normals = surface.geometry.getAttribute("normal");
    let colors = surface.geometry.getAttribute("color");
    if (!colors) {
      colors = new THREE.Float32BufferAttribute(new Float32Array(position.count * 3).fill(1), 3);
      surface.geometry.setAttribute("color", colors);
    }
    const normalMatrix = new THREE.Matrix3().getNormalMatrix(surface.matrix);
    for (let i = 0; i < position.count; i++) {
      point.fromBufferAttribute(position, i).applyMatrix4(surface.matrix);
      normal.fromBufferAttribute(normals, i).applyMatrix3(normalMatrix).normalize();
      let updated = false;
      for (const view of prepared) {
        if (view.meshFilter && !view.meshFilter(surface.mesh)) continue;
        if (view.region && !view.region.containsPoint(point)) continue;
        let weight = projectionConfidence(point, normal, view.camera, view.visibility) * (view.strength ?? 1);
        if (weight <= 0) continue;
        const projected = view.camera.project(point);
        const registered = view.register ? view.register(projected.u, projected.v) : projected;
        if (!registered || view.foreground && !view.foreground.contains(registered.u, registered.v)) continue;
        weight *= cropEdgeConfidence(registered.u, registered.v, view.edgeFeather);
        if (weight <= 0) continue;
        const box = view.box ?? [0, 0, 1, 1];
        const u = THREE.MathUtils.lerp(box[1], box[3], registered.u);
        const v = THREE.MathUtils.lerp(box[0], box[2], registered.v);
        if (view.mask) {
          const du = 1.5 / view.mask.width, dv = 1.5 / view.mask.height;
          if ([[u, v], [u - du, v], [u + du, v], [u, v - dv], [u, v + dv]]
            .some(([x, y]) => x < 0 || x > 1 || y < 0 || y > 1 || pixel(view.mask!, x, y)[0] < 100)) continue;
        }
        const rgb = pixel(view.image, u, v);
        if (view.acceptSample) {
          sampled.setRGB(colors.getX(i), colors.getY(i), colors.getZ(i)).convertLinearToSRGB();
          const previousRGB = [sampled.r * 255, sampled.g * 255, sampled.b * 255];
          if (!view.acceptSample(rgb, point, previousRGB)) continue;
        }
        // Vertex colors are linear, whereas the original photograph is sRGB.
        sampled.setRGB(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, THREE.SRGBColorSpace);
        colors.setXYZ(i, THREE.MathUtils.lerp(colors.getX(i), sampled.r, weight),
          THREE.MathUtils.lerp(colors.getY(i), sampled.g, weight),
          THREE.MathUtils.lerp(colors.getZ(i), sampled.b, weight));
        updated = true;
      }
      if (updated) updatedVertices++;
    }
    colors.needsUpdate = true;
  }
  return { updatedVertices, viewCount: prepared.length };
}

const pixel = (image: VolumePixels, x: number, y: number) => {
  const ix = THREE.MathUtils.clamp(Math.round(x * (image.width - 1)), 0, image.width - 1);
  const iy = THREE.MathUtils.clamp(Math.round(y * (image.height - 1)), 0, image.height - 1);
  const offset = (iy * image.width + ix) * 4;
  return [Number(image.data[offset]), Number(image.data[offset + 1]), Number(image.data[offset + 2])];
};

export interface ForegroundField {
  width: number;
  height: number;
  foreground: Uint8Array;
  /** Returns false for the neutral backdrop and the gaps between legs/arms. */
  contains(u: number, v: number): boolean;
}

type Interval = [number, number];
function rowIntervals(width: number, contains: (x: number) => boolean): Interval[] {
  const intervals: Interval[] = [];
  let start = -1;
  for (let x = 0; x <= width; x++) {
    if (x < width && contains(x)) { if (start < 0) start = x; }
    else if (start >= 0) {
      if (x - start >= 2) intervals.push([start / (width - 1), (x - 1) / (width - 1)]);
      start = -1;
    }
  }
  return intervals;
}

/** Fit a projected body silhouette to an inferred view, per image row. Separate
 * runs retain the gap between two legs instead of stretching one trouser leg
 * over both. This is a piecewise camera registration, not image synthesis. */
export function registerTurnaroundSilhouette(visibility: VisibilityBuffer, field: ForegroundField) {
  const rows = Array.from({ length: field.height }, (_, y) => {
    const modelY = Math.round(y / (field.height - 1) * (visibility.height - 1));
    const model = rowIntervals(visibility.width, (x) => Number.isFinite(visibility.depth[modelY * visibility.width + x]));
    const photo = rowIntervals(field.width, (x) => Boolean(field.foreground[y * field.width + x]));
    return { model, photo };
  });
  return (u: number, v: number) => {
    if (u < 0 || u > 1 || v < 0 || v > 1) return undefined;
    const { model, photo } = rows[Math.round(v * (field.height - 1))];
    if (!model.length || !photo.length) return undefined;
    let a: Interval = [model[0][0], model.at(-1)![1]];
    let b: Interval = [photo[0][0], photo.at(-1)![1]];
    if (model.length === photo.length) {
      const index = model.findIndex(([left, right]) => u >= left - 0.012 && u <= right + 0.012);
      if (index >= 0) { a = model[index]; b = photo[index]; }
    }
    const t = THREE.MathUtils.clamp((u - a[0]) / Math.max(0.0001, a[1] - a[0]), 0.015, 0.985);
    const mapped = THREE.MathUtils.lerp(b[0], b[1], t);
    return field.contains(mapped, v) ? { u: mapped, v } : undefined;
  };
}

/** Remove only border-connected studio backdrop from inferred turnaround views.
 * Its color is estimated independently on each row, preserving a grayscale
 * garment and a colored garment alike. It never changes photographed RGB. */
export function turnaroundForeground(image: VolumePixels, box: Box): ForegroundField {
  const width = 128, height = 256;
  const candidate = new Uint8Array(width * height);
  const outside = new Uint8Array(width * height);
  const queue = new Int32Array(width * height);
  let tail = 0;
  let contrast = 0;
  const pad = (box[3] - box[1]) * 0.06;
  for (let y = 0; y < height; y++) {
    const sy = THREE.MathUtils.lerp(box[0], box[2], y / (height - 1));
    const left = pixel(image, box[1] - pad, sy), right = pixel(image, box[3] + pad, sy);
    for (let x = 0; x < width; x++) {
      const u = x / (width - 1);
      const rgb = pixel(image, THREE.MathUtils.lerp(box[1], box[3], u), sy);
      const distance = Math.hypot(...rgb.map((n, c) => n - THREE.MathUtils.lerp(left[c], right[c], u)));
      candidate[y * width + x] = distance < 25 ? 1 : 0;
      if (x > width * 0.3 && x < width * 0.7 && distance > 35) contrast++;
    }
  }
  // Constant-color inputs carry no evidence of a studio backdrop. Treat them as
  // an ordinary texture, not as an empty person.
  if (contrast > width * height * 0.025) {
    const visit = (i: number) => {
      if (i >= 0 && i < outside.length && !outside[i] && candidate[i]) {
        outside[i] = 1; queue[tail++] = i;
      }
    };
    for (let x = 0; x < width; x++) { visit(x); visit((height - 1) * width + x); }
    for (let y = 0; y < height; y++) { visit(y * width); visit(y * width + width - 1); }
    for (let head = 0; head < tail; head++) {
      const i = queue[head], x = i % width;
      if (x > 0) visit(i - 1);
      if (x < width - 1) visit(i + 1);
      visit(i - width); visit(i + width);
    }
  }
  const foreground = outside.map((n) => 1 - n);
  return {
    width, height, foreground,
    contains(u, v) {
      if (u < 0 || u > 1 || v < 0 || v > 1) return false;
      const x = Math.round(u * (width - 1)), y = Math.round(v * (height - 1));
      return Boolean(foreground[y * width + x]);
    },
  };
}
