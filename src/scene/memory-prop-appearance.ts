import * as THREE from "three";
import type { VolumePixels } from "./volume";

type Box = [number, number, number, number];

export interface ObjectSilhouette {
  /** Top-to-bottom visible width and horizontal center, in crop coordinates. */
  rows: { width: number; center: number }[];
  occupancy: number;
}

/** Keep original RGB for visible object pixels. A mask is confidence in the
 * photograph, not material transparency: masked-out hands/background should
 * reveal the inferred solid material, never leave holes in the model. */
export function prepareMemoryPropAppearance(
  source: VolumePixels,
  box: Box,
  mask?: VolumePixels,
) {
  const [top, left, bottom, right] = box;
  const cropWidth = Math.max(1, (right - left) * source.width);
  const cropHeight = Math.max(1, (bottom - top) * source.height);
  const reduction = Math.min(1, 512 / Math.max(cropWidth, cropHeight));
  const width = Math.max(2, Math.round(cropWidth * reduction));
  const height = Math.max(2, Math.round(cropHeight * reduction));
  const data = new Uint8Array(width * height * 4);
  const rowEdges: { width: number; center: number }[] = [];
  const rowColors: (number[] | undefined)[] = [];
  let visiblePixels = 0;
  for (let y = 0; y < height; y++) {
    const v = top + ((bottom - top) * y) / (height - 1);
    const sy = THREE.MathUtils.clamp(
      Math.round(v * (source.height - 1)),
      0,
      source.height - 1,
    );
    const visible: number[] = [];
    const colors: number[][] = [[], [], []];
    for (let x = 0; x < width; x++) {
      const u = left + ((right - left) * x) / (width - 1);
      const sx = THREE.MathUtils.clamp(
        Math.round(u * (source.width - 1)),
        0,
        source.width - 1,
      );
      const from = (sy * source.width + sx) * 4;
      const to = ((height - y - 1) * width + x) * 4;
      let confidence = 255;
      if (mask) {
        // A one-crop-pixel inset rejects mixed skin/background boundary pixels
        // from segmentation without reducing the source photograph resolution.
        for (let oy = -1; oy <= 1 && confidence; oy++)
          for (let ox = -1; ox <= 1 && confidence; ox++) {
            const mx = THREE.MathUtils.clamp(
              Math.round(
                (u + (ox * (right - left)) / (width - 1)) * (mask.width - 1),
              ),
              0,
              mask.width - 1,
            );
            const my = THREE.MathUtils.clamp(
              Math.round(
                (v + (oy * (bottom - top)) / (height - 1)) * (mask.height - 1),
              ),
              0,
              mask.height - 1,
            );
            if (Number(mask.data[(my * mask.width + mx) * 4]) < 128)
              confidence = 0;
          }
      }
      for (let c = 0; c < 3; c++) data[to + c] = Number(source.data[from + c]);
      data[to + 3] = confidence;
      if (confidence) {
        visible.push(x / (width - 1));
        visiblePixels++;
        for (let c = 0; c < 3; c++) colors[c].push(data[to + c]);
      }
    }
    // Outer valid pixels preserve the outline when a hand obscures the middle.
    // A one-pixel island is not enough evidence for a narrow neck or strap.
    rowEdges.push(
      visible.length >= Math.max(2, width * 0.06)
        ? {
            width: Math.max(0.03, visible.at(-1)! - visible[0]),
            center: (visible[0] + visible.at(-1)!) / 2,
          }
        : { width: 0, center: 0.5 },
    );
    rowColors.push(
      visible.length
        ? colors.map((channel) => {
            channel.sort((a, b) => a - b);
            return channel[Math.floor(channel.length / 2)];
          })
        : undefined,
    );
  }
  // Missing front surfaces borrow a robust material color from the same
  // object's neighboring rows. This fills hand-shaped holes without stretching
  // fingers/background across the body, or cloning logos onto unseen areas.
  for (let y = 0; y < height; y++) {
    let color = rowColors[y];
    if (!color)
      for (let distance = 1; distance < height && !color; distance++)
        color = rowColors[y - distance] ?? rowColors[y + distance];
    if (!color) continue;
    for (let x = 0; x < width; x++) {
      const to = ((height - y - 1) * width + x) * 4;
      if (data[to + 3]) continue;
      for (let c = 0; c < 3; c++) data[to + c] = color[c];
    }
  }
  const occupancy = visiblePixels / (width * height);
  const goodRows = rowEdges.filter((row) => row.width > 0).length;
  let silhouette: ObjectSilhouette | undefined;
  // Rectangular detection masks are useful for color but are not measured
  // silhouettes. Never turn their box edge into a purported object contour.
  if (
    mask &&
    occupancy > 0.15 &&
    occupancy < 0.94 &&
    goodRows > height * 0.65
  ) {
    const rows = Array.from({ length: 33 }, (_, i) => {
      const position = (i / 32) * (height - 1);
      const neighbours = rowEdges.filter(
        (row, j) =>
          row.width > 0 &&
          Math.abs(j - position) <= Math.max(2, height * 0.045),
      );
      if (!neighbours.length) {
        let nearest = rowEdges.find((row) => row.width > 0)!;
        let distance = height;
        rowEdges.forEach((row, j) => {
          if (row.width > 0 && Math.abs(j - position) < distance) {
            nearest = row;
            distance = Math.abs(j - position);
          }
        });
        return { ...nearest };
      }
      // A high quantile avoids carving fingers/occlusion into the hidden body.
      const widths = neighbours.map((row) => row.width).sort((a, b) => a - b);
      const centers = neighbours.map((row) => row.center).sort((a, b) => a - b);
      return {
        width: widths[Math.floor((widths.length - 1) * 0.8)],
        center: centers[Math.floor(centers.length / 2)],
      };
    });
    silhouette = { rows, occupancy };
  }
  const texture = new THREE.DataTexture(data, width, height);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  texture.userData.hasPhotographicPixels = visiblePixels > 0;
  return { texture, silhouette };
}

export function silhouetteRow(silhouette: ObjectSilhouette, topDown: number) {
  const at =
    THREE.MathUtils.clamp(topDown, 0, 1) * (silhouette.rows.length - 1);
  const lo = Math.floor(at),
    hi = Math.min(silhouette.rows.length - 1, lo + 1);
  return {
    width: THREE.MathUtils.lerp(
      silhouette.rows[lo].width,
      silhouette.rows[hi].width,
      at - lo,
    ),
    center: THREE.MathUtils.lerp(
      silhouette.rows[lo].center,
      silhouette.rows[hi].center,
      at - lo,
    ),
  };
}

/** A solid can does not acquire finger-shaped dents when someone holds it.
 * Complete the convex outer body from the visible contour; the texture mask
 * remains untouched so those same fingers are never painted onto the object. */
export function completeConvexSilhouette(
  silhouette: ObjectSilhouette,
): ObjectSilhouette {
  type Point = { x: number; y: number };
  const points = silhouette.rows
    .flatMap((row, i) => [
      { x: row.center - row.width / 2, y: i },
      { x: row.center + row.width / 2, y: i },
    ])
    .sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (o: Point, a: Point, b: Point) =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Point[] = [],
    upper: Point[] = [];
  for (const point of points) {
    while (lower.length > 1 && cross(lower.at(-2)!, lower.at(-1)!, point) <= 0)
      lower.pop();
    lower.push(point);
  }
  for (const point of points.slice().reverse()) {
    while (upper.length > 1 && cross(upper.at(-2)!, upper.at(-1)!, point) <= 0)
      upper.pop();
    upper.push(point);
  }
  const hull = lower.slice(0, -1).concat(upper.slice(0, -1));
  const rows = silhouette.rows.map((row, y) => {
    const intersections: number[] = [];
    hull.forEach((a, i) => {
      const b = hull[(i + 1) % hull.length];
      if (y < Math.min(a.y, b.y) || y > Math.max(a.y, b.y)) return;
      if (a.y === b.y) intersections.push(a.x, b.x);
      else intersections.push(a.x + ((b.x - a.x) * (y - a.y)) / (b.y - a.y));
    });
    if (intersections.length < 2) return row;
    const left = Math.min(...intersections),
      right = Math.max(...intersections);
    return { width: right - left, center: (left + right) / 2 };
  });
  const roundedRows = rows.map((row, i) => {
    if (i === 0 || i === rows.length - 1) return row;
    const kernel = [1, 4, 6, 4, 1];
    return {
      width:
        kernel.reduce(
          (sum, weight, offset) =>
            sum +
            rows[THREE.MathUtils.clamp(i + offset - 2, 0, rows.length - 1)]
              .width *
              weight,
          0,
        ) / 16,
      center:
        kernel.reduce(
          (sum, weight, offset) =>
            sum +
            rows[THREE.MathUtils.clamp(i + offset - 2, 0, rows.length - 1)]
              .center *
              weight,
          0,
        ) / 16,
    };
  });
  return { ...silhouette, rows: roundedRows };
}

/** One projection across the complete model: the cap samples the cap pixels,
 * the label samples the label pixels, and no part repeats the entire crop.
 * Side/back surfaces retain their inferred physical material. */
export function projectMemoryPropPhotograph(
  group: THREE.Group,
  materials: Iterable<THREE.Material>,
  texture: THREE.Texture,
) {
  group.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(group);
  const size = bounds.getSize(new THREE.Vector3());
  const position = new THREE.Vector3(),
    normal = new THREE.Vector3();
  group.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) return;
    const geometry = node.geometry as THREE.BufferGeometry;
    const positions = geometry.getAttribute("position");
    const normals = geometry.getAttribute("normal");
    const normalMatrix = new THREE.Matrix3().getNormalMatrix(node.matrixWorld);
    const uvs = new Float32Array(positions.count * 2);
    const weights = new Float32Array(positions.count);
    for (let i = 0; i < positions.count; i++) {
      position.fromBufferAttribute(positions, i).applyMatrix4(node.matrixWorld);
      normal
        .fromBufferAttribute(normals, i)
        .applyMatrix3(normalMatrix)
        .normalize();
      uvs[i * 2] = (position.x - bounds.min.x) / Math.max(size.x, 1e-5);
      uvs[i * 2 + 1] = (position.y - bounds.min.y) / Math.max(size.y, 1e-5);
      weights[i] = THREE.MathUtils.smoothstep(normal.z, 0.03, 0.5);
    }
    geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
    geometry.setAttribute(
      "memoryPhotoWeight",
      new THREE.BufferAttribute(weights, 1),
    );
  });
  for (const candidate of materials) {
    if (!(candidate instanceof THREE.MeshStandardMaterial)) continue;
    candidate.map = texture;
    candidate.transparent = false;
    candidate.onBeforeCompile = (shader) => {
      shader.uniforms.memoryPhotoAvailable = {
        value: texture.userData.hasPhotographicPixels === false ? 0 : 1,
      };
      shader.vertexShader = shader.vertexShader
        .replace(
          "#include <common>",
          "#include <common>\nattribute float memoryPhotoWeight;\nvarying float vMemoryPhotoWeight;",
        )
        .replace(
          "#include <begin_vertex>",
          "#include <begin_vertex>\nvMemoryPhotoWeight = memoryPhotoWeight;",
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          "#include <common>",
          "#include <common>\nvarying float vMemoryPhotoWeight;\nuniform float memoryPhotoAvailable;",
        )
        .replace(
          "#include <map_fragment>",
          `
          #ifdef USE_MAP
            vec4 memorySample = texture2D(map, vMapUv);
            // Masked RGB was filled with the object's own local material color.
            // Alpha records measured vs inferred pixels, not transparency.
            diffuseColor.rgb = mix(diffuseColor.rgb, memorySample.rgb, vMemoryPhotoWeight * memoryPhotoAvailable);
          #endif
        `,
        );
    };
    candidate.customProgramCacheKey = () => "memory-prop-projection-v2";
    candidate.needsUpdate = true;
  }
}
