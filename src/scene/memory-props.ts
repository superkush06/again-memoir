import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import type { MemoryObjectSpec } from "../memory-objects";
import type { VolumePixels } from "./volume";
import {
  completeConvexSilhouette,
  prepareMemoryPropAppearance,
  projectMemoryPropPhotograph,
  silhouetteRow,
} from "./memory-prop-appearance";

type Box = [number, number, number, number];
type Vector = [number, number, number];

export interface MemoryPropInput {
  id: string;
  label: string;
  object: MemoryObjectSpec;
  source: VolumePixels;
  /** Normalized [top, left, bottom, right] in the source image. */
  box: Box;
  /** Full-image foreground mask; may have a different resolution from source. */
  mask?: VolumePixels;
}

/** Complete, closed category geometry. The group's origin is the center of its
 * complete bounds (including stand/straps/lid); +Y is up and +Z is the source
 * facing side. Dimensions are metres before the optional source orientation.
 * All geometry/materials/textures belong to this instance. A controller may
 * attach and move the group without rebuilding it or affecting another prop. */
export function buildMemoryProp(input: MemoryPropInput) {
  const { object } = input;
  const group = new THREE.Group();
  group.name = input.label;
  group.userData.memoryObject = {
    id: input.id,
    category: object.category,
    confidence: object.confidence,
  };
  const model = new THREE.Group();
  group.add(model);
  const { texture, silhouette: visibleSilhouette } =
    prepareMemoryPropAppearance(input.source, input.box, input.mask);
  const silhouette =
    visibleSilhouette && object.category === "drink-can"
      ? completeConvexSilhouette(visibleSilhouette)
      : visibleSilhouette;
  group.userData.memoryAppearance = {
    projection: "masked-source",
    silhouette: Boolean(silhouette),
    hiddenSurfaces: "inferred",
  };
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const material = (params: THREE.MeshStandardMaterialParameters = {}) => {
    const result = new THREE.MeshStandardMaterial({
      roughness: 0.72,
      metalness: 0,
      ...params,
    });
    materials.add(result);
    return result;
  };
  const base = material({ color: object.color });
  const photo = material({ color: object.color, roughness: 0.67 });
  const dark = material({ color: "#22262a", roughness: 0.6 });
  const metal = material({ color: "#c9cdd0", metalness: 0.7, roughness: 0.32 });
  const seam = material({
    color: new THREE.Color(object.color).multiplyScalar(0.6),
  });
  const mesh = (
    name: string,
    geometry: THREE.BufferGeometry,
    mat: THREE.Material | THREE.Material[],
    position: Vector = [0, 0, 0],
    parent: THREE.Object3D = model,
  ) => {
    geometries.add(geometry);
    const item = new THREE.Mesh(geometry, mat);
    item.name = name;
    item.position.fromArray(position);
    item.castShadow = true;
    item.receiveShadow = true;
    parent.add(item);
    return item;
  };
  const rounded = (
    name: string,
    width: number,
    height: number,
    depth: number,
    mat: THREE.Material | THREE.Material[],
    position: Vector = [0, 0, 0],
    radius = Math.min(width, height, depth) * 0.2,
  ) =>
    mesh(
      name,
      new RoundedBoxGeometry(width, height, depth, 2, radius),
      mat,
      position,
    );
  const frontMaterials = [base, base, base, base, photo, base];
  const cylinder = (
    name: string,
    top: number,
    bottom: number,
    height: number,
    mat: THREE.Material | THREE.Material[],
    position: Vector = [0, 0, 0],
  ) =>
    mesh(
      name,
      new THREE.CylinderGeometry(top, bottom, height, 32),
      mat,
      position,
    );
  const loop = (
    name: string,
    points: Vector[],
    radius: number,
    mat: THREE.Material,
  ) =>
    mesh(
      name,
      new THREE.TubeGeometry(
        new THREE.CatmullRomCurve3(
          points.map((point) => new THREE.Vector3(...point)),
        ),
        24,
        radius,
        8,
        false,
      ),
      mat,
    );
  const silhouetteBody = (
    name: string,
    radius: number,
    height: number,
    mat: THREE.Material | THREE.Material[],
  ) => {
    const maximum = Math.max(...silhouette!.rows.map((row) => row.width));
    const rows = silhouette!.rows.slice().reverse();
    const points = rows.map(
      (row, i) =>
        new THREE.Vector2(
          (radius * row.width) / maximum,
          (i / (rows.length - 1) - 0.5) * height,
        ),
    );
    points.unshift(new THREE.Vector2(0, -height / 2));
    points.push(new THREE.Vector2(0, height / 2));
    const geometry = new THREE.LatheGeometry(points, 48);
    const position = geometry.getAttribute("position");
    for (let i = 0; i < position.count; i++) {
      const row = silhouetteRow(silhouette!, 0.5 - position.getY(i) / height);
      position.setX(i, position.getX(i) + (row.center - 0.5) * radius * 2);
    }
    geometry.computeVertexNormals();
    return mesh(name, geometry, mat);
  };
  switch (object.category) {
    case "laptop": {
      rounded("Solid laptop chassis", 1, 0.065, 0.7, base, [0, -0.32, 0.04]);
      const lid = rounded(
        "Hinged display lid",
        1,
        0.64,
        0.045,
        base,
        [0, 0.03, -0.28],
      );
      lid.rotation.x = -0.12;
      const screen = rounded(
        "Photographic display",
        0.9,
        0.53,
        0.007,
        photo,
        [0, 0.03, -0.248],
      );
      screen.rotation.x = lid.rotation.x;
      cylinder(
        "Hinge",
        0.025,
        0.025,
        0.9,
        metal,
        [0, -0.29, -0.275],
      ).rotation.z = Math.PI / 2;
      for (let row = 0; row < 4; row++)
        for (let col = 0; col < 12; col++)
          rounded(
            "Keyboard key",
            0.062,
            0.009,
            0.057,
            dark,
            [(col - 5.5) * 0.072, -0.282, -0.13 + row * 0.073],
            0.003,
          );
      rounded("Trackpad", 0.28, 0.004, 0.12, seam, [0, -0.284, 0.235]);
      break;
    }
    case "computer": {
      rounded("Monitor housing", 0.79, 0.52, 0.065, base, [-0.09, 0.12, -0.05]);
      rounded(
        "Photographic monitor display",
        0.72,
        0.45,
        0.009,
        photo,
        [-0.09, 0.12, -0.012],
      );
      rounded("Monitor neck", 0.075, 0.2, 0.07, metal, [-0.09, -0.22, -0.08]);
      rounded("Monitor foot", 0.34, 0.025, 0.25, base, [-0.09, -0.325, -0.02]);
      // A detected monitor does not imply an extra computer tower beside it.
      if (!input.mask) {
        rounded("Computer tower", 0.19, 0.55, 0.33, base, [0.44, -0.06, -0.04]);
        rounded("Front panel", 0.16, 0.48, 0.009, dark, [0.44, -0.06, 0.13]);
        for (let y = 0; y < 8; y++)
          rounded("Cooling vent", 0.12, 0.006, 0.012, seam, [
            0.44,
            -0.12 + y * 0.02,
            0.14,
          ]);
        mesh(
          "Power button",
          new THREE.SphereGeometry(0.012, 12, 8),
          metal,
          [0.44, 0.13, 0.14],
        );
      }
      break;
    }
    case "phone": {
      rounded("Solid phone body", 0.48, 1, 0.065, base, [0, 0, 0], 0.025);
      rounded(
        "Photographic screen",
        0.425,
        0.905,
        0.005,
        photo,
        [0, 0, 0.034],
        0.002,
      );
      rounded("Earpiece", 0.1, 0.012, 0.006, dark, [0, 0.46, 0.036]);
      // Lens count/layout cannot be recovered from an unseen phone side.
      if (!input.mask) {
        rounded(
          "Rear camera island",
          0.16,
          0.22,
          0.016,
          seam,
          [-0.125, 0.34, -0.04],
        );
        for (const y of [0.29, 0.39]) {
          const lens = cylinder("Rear camera lens", 0.04, 0.04, 0.012, dark, [
            -0.125,
            y,
            -0.053,
          ]);
          lens.rotation.x = Math.PI / 2;
        }
      }
      rounded("Side button", 0.012, 0.15, 0.03, metal, [0.243, 0.12, 0]);
      break;
    }
    case "drink-can": {
      if (silhouette)
        silhouetteBody("Source-contoured closed can", 0.265, 0.96, base);
      else
        cylinder("Closed aluminum can", 0.265, 0.265, 0.96, [
          base,
          metal,
          metal,
        ]);
      // A measured outline already closes the ends. Do not add a floating
      // stock pull-tab or rim when the source cap angle/style is unknown.
      if (!silhouette) {
        for (const y of [-0.48, 0.48]) {
          const rim = mesh(
            "Rolled metal rim",
            new THREE.TorusGeometry(0.254, 0.009, 8, 32),
            metal,
            [0, y, 0],
          );
          rim.rotation.x = Math.PI / 2;
        }
        rounded("Pull tab", 0.1, 0.008, 0.19, metal, [0, 0.491, 0.015]);
        rounded(
          "Opening under tab",
          0.105,
          0.006,
          0.12,
          dark,
          [0, 0.488, -0.105],
        );
      }
      break;
    }
    case "water-bottle": {
      const profile: [number, number][] = [
        [0, -0.5],
        [0.18, -0.5],
        [0.23, -0.47],
        [0.24, -0.39],
        [0.23, 0.17],
        [0.22, 0.25],
        [0.13, 0.36],
        [0.09, 0.39],
        [0.09, 0.46],
        [0, 0.46],
      ];
      const plastic = material({
        color: new THREE.Color(object.color).lerp(
          new THREE.Color("#d9edf1"),
          0.2,
        ),
        roughness: 0.27,
        metalness: 0.05,
      });
      if (silhouette) {
        silhouetteBody("Source-contoured closed bottle", 0.24, 1, plastic);
      } else {
        mesh(
          "Closed contoured bottle",
          new THREE.LatheGeometry(
            profile.map(([x, y]) => new THREE.Vector2(x, y)),
            40,
          ),
          plastic,
        );
        cylinder("Bottle cap", 0.106, 0.106, 0.09, base, [0, 0.46, 0]);
        for (const y of [-0.36, -0.29, 0.18]) {
          const ridge = mesh(
            "Moulded bottle ridge",
            new THREE.TorusGeometry(0.232, 0.007, 6, 40),
            plastic,
            [0, y, 0],
          );
          ridge.rotation.x = Math.PI / 2;
        }
      }
      break;
    }
    case "chip-bag": {
      const geometry = new THREE.BoxGeometry(0.72, 1, 0.25, 16, 20, 4);
      const position = geometry.getAttribute("position");
      for (let i = 0; i < position.count; i++) {
        const x = position.getX(i),
          y = position.getY(i),
          z = position.getZ(i);
        const fill = Math.pow(
          Math.max(0, 1 - Math.pow(Math.abs(y) * 2, 4)),
          0.6,
        );
        position.setXYZ(
          i,
          silhouette
            ? (x * silhouetteRow(silhouette, 0.5 - y).width) /
                Math.max(...silhouette.rows.map((row) => row.width)) +
                (silhouetteRow(silhouette, 0.5 - y).center - 0.5) * 0.72
            : x * (0.89 + 0.11 * fill),
          y,
          z * (0.17 + 0.83 * fill) + Math.sin(x * 55 + y * 17) * 0.007 * fill,
        );
      }
      geometry.computeVertexNormals();
      mesh("Inflated closed snack bag", geometry, frontMaterials);
      for (const y of [-0.49, 0.49])
        rounded(
          "Crimped sealed edge",
          silhouette
            ? (0.72 * silhouetteRow(silhouette, 0.5 - y).width) /
                Math.max(...silhouette.rows.map((row) => row.width))
            : 0.65,
          0.022,
          0.025,
          seam,
          [
            silhouette
              ? (silhouetteRow(silhouette, 0.5 - y).center - 0.5) * 0.72
              : 0,
            y,
            0,
          ],
        );
      break;
    }
    case "box": {
      rounded(
        "Closed cardboard carton",
        1,
        1,
        1,
        frontMaterials,
        [0, 0, 0],
        0.012,
      );
      const tape = material({
        color: new THREE.Color(object.color).lerp(
          new THREE.Color("#b89159"),
          0.35,
        ),
        roughness: 0.6,
      });
      rounded("Top packing tape", 0.13, 0.005, 1, tape, [0, 0.502, 0], 0.001);
      rounded(
        "Rear tape continuation",
        0.13,
        0.29,
        0.005,
        tape,
        [0, 0.355, -0.503],
        0.001,
      );
      break;
    }
    case "backpack": {
      if (silhouette) {
        const body = new THREE.BoxGeometry(0.72, 1, 0.35, 16, 32, 8);
        const positions = body.getAttribute("position");
        const maximum = Math.max(...silhouette.rows.map((row) => row.width));
        for (let i = 0; i < positions.count; i++) {
          const x = positions.getX(i),
            y = positions.getY(i),
            z = positions.getZ(i);
          const row = silhouetteRow(silhouette, 0.5 - y);
          const cushion =
            Math.sqrt(Math.max(0.08, 1 - Math.pow(y * 1.8, 4))) *
            Math.sqrt(Math.max(0.15, 1 - Math.pow(x / 0.4, 4)));
          positions.setXYZ(
            i,
            (x * row.width) / maximum + (row.center - 0.5) * 0.72,
            y,
            z * cushion,
          );
        }
        body.computeVertexNormals();
        mesh("Source-contoured closed backpack", body, base);
      } else
        rounded(
          "Soft full backpack body",
          0.72,
          1,
          0.35,
          base,
          [0, 0, 0],
          0.13,
        );
      if (!silhouette) {
        rounded(
          "Photographic front pocket",
          0.59,
          0.57,
          0.15,
          frontMaterials,
          [0, -0.13, 0.2],
          0.055,
        );
        rounded(
          "Front pocket zipper",
          0.49,
          0.015,
          0.016,
          metal,
          [0, 0.11, 0.281],
        );
        rounded("Zipper pull", 0.023, 0.07, 0.013, metal, [0.23, 0.08, 0.293]);
      }
      loop(
        "Carry handle",
        [
          [-0.12, 0.45, -0.03],
          [-0.1, 0.59, -0.03],
          [0.1, 0.59, -0.03],
          [0.12, 0.45, -0.03],
        ],
        0.028,
        seam,
      );
      for (const x of [-0.21, 0.21])
        loop(
          "Padded rear shoulder strap",
          [
            [x, 0.38, -0.15],
            [x * 1.28, 0.13, -0.36],
            [x * 1.15, -0.23, -0.36],
            [x, -0.39, -0.15],
          ],
          0.043,
          seam,
        );
      for (const x of [-0.37, 0.37])
        rounded(
          "Side bottle pocket",
          0.08,
          0.35,
          0.25,
          seam,
          [x, -0.21, 0],
          0.025,
        );
      break;
    }
  }
  // A keyboard still has individual key geometry, but its keys render in one
  // draw call. Props are rigid, so sharing a material can be batched safely for
  // Quest without removing the detail that makes each category recognizable.
  model.updateMatrixWorld(true);
  const batches = new Map<THREE.Material, THREE.Mesh[]>();
  for (const child of model.children) {
    if (!(child instanceof THREE.Mesh) || Array.isArray(child.material))
      continue;
    const batch = batches.get(child.material) ?? [];
    batch.push(child);
    batches.set(child.material, batch);
  }
  for (const [mat, batch] of batches) {
    if (batch.length < 2) continue;
    const pieces = batch.map((item) => {
      const geometry = item.geometry.index
        ? item.geometry.toNonIndexed()
        : item.geometry.clone();
      return geometry.applyMatrix4(item.matrix);
    });
    const merged = mergeGeometries(pieces);
    pieces.forEach((piece) => piece.dispose());
    if (!merged) continue;
    batch.forEach((item) => {
      model.remove(item);
      geometries.delete(item.geometry);
      item.geometry.dispose();
    });
    mesh("Combined rigid prop details", merged, mat);
  }
  model.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(model);
  const size = bounds.getSize(new THREE.Vector3());
  const center = bounds.getCenter(new THREE.Vector3());
  // Keep the outer grab pivot centered and scale in the model's coordinate frame.
  model.scale.set(
    object.dimensions[0] / size.x,
    object.dimensions[1] / size.y,
    object.dimensions[2] / size.z,
  );
  model.position.copy(center).multiply(model.scale).negate();
  if (object.rotation) group.rotation.set(...object.rotation);
  group.updateMatrixWorld(true);
  projectMemoryPropPhotograph(group, materials, texture);
  let disposed = false;
  return {
    group,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      group.removeFromParent();
      geometries.forEach((geometry) => geometry.dispose());
      materials.forEach((mat) => mat.dispose());
      texture.dispose();
    },
  };
}

/** Retain the image center and approximate visible size, using the inverse-depth
 * samples as a weak cue and category dimensions as a bounded physical prior.
 * This avoids turning a hand-held can into a metre-wide can when monocular depth
 * assigns its small mask to a distant wall. Hidden dimensions remain inferred. */
export function placeMemoryProp(input: {
  box: Box;
  depth: VolumePixels;
  object: MemoryObjectSpec;
  mask?: VolumePixels;
  fov?: number;
  aspect?: number;
  strength?: number;
  near?: number;
  far?: number;
  cameraHeight?: number;
}): { position: Vector; scale: number } {
  const { box, depth, object } = input;
  const [top, left, bottom, right] = box;
  const halfHeight = Math.tan(((input.fov ?? 60) * Math.PI) / 360);
  const aspect = input.aspect ?? depth.width / depth.height;
  const samples: number[] = [];
  for (
    let y = Math.max(0, Math.floor(top * depth.height));
    y < Math.min(depth.height, Math.ceil(bottom * depth.height));
    y++
  )
    for (
      let x = Math.max(0, Math.floor(left * depth.width));
      x < Math.min(depth.width, Math.ceil(right * depth.width));
      x++
    ) {
      const index = (y * depth.width + x) * 4;
      if (input.mask && Number(input.mask.data[index]) < 90) continue;
      const value = Number(depth.data[index]);
      if (Number.isFinite(value))
        samples.push(Math.max(0, Math.min(1, value / 255)));
    }
  samples.sort((a, b) => a - b);
  const inverseDepth = samples.length
    ? samples[Math.floor(samples.length / 2)]
    : 0.5;
  const near = input.near ?? 2,
    far = input.far ?? 12;
  const learnedDistance =
    near +
    (1 / (inverseDepth / near + (1 - inverseDepth) / far) - near) *
      (input.strength ?? 1.25);
  const localBounds = new THREE.Box3(
    new THREE.Vector3(...object.dimensions).multiplyScalar(-0.5),
    new THREE.Vector3(...object.dimensions).multiplyScalar(0.5),
  );
  if (object.rotation)
    localBounds.applyMatrix4(
      new THREE.Matrix4().makeRotationFromEuler(
        new THREE.Euler(...object.rotation),
      ),
    );
  const size = localBounds.getSize(new THREE.Vector3());
  const distanceForSize = Math.max(
    size.x / (Math.max(0.005, right - left) * 2 * halfHeight * aspect),
    size.y / (Math.max(0.005, bottom - top) * 2 * halfHeight),
  );
  const distance = Math.max(
    0.3,
    Math.min(
      15,
      THREE.MathUtils.clamp(
        distanceForSize * 0.8 + learnedDistance * 0.2,
        distanceForSize * 0.75,
        distanceForSize * 1.5,
      ),
    ),
  );
  const scale = THREE.MathUtils.clamp(distance / distanceForSize, 0.5, 1.5);
  const u = (left + right) / 2,
    v = (top + bottom) / 2;
  return {
    position: [
      (2 * u - 1) * halfHeight * aspect * distance,
      (1 - 2 * v) * halfHeight * distance + (input.cameraHeight ?? 1.6),
      -distance,
    ],
    scale,
  };
}
