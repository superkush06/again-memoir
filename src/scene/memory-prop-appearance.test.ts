import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import {
  completeConvexSilhouette,
  prepareMemoryPropAppearance,
} from "./memory-prop-appearance";
import { buildMemoryProp } from "./memory-props";
import type { VolumePixels } from "./volume";

const pixels = (width: number, height: number): VolumePixels => ({
  width,
  height,
  data: new Uint8Array(width * height * 4),
});

test("hands occluding a can are completed as a solid body rather than sculpted into dents", () => {
  const visible = {
    occupancy: 0.6,
    rows: [0.6, 0.9, 1, 0.35, 0.3, 0.9, 0.75].map((width) => ({
      width,
      center: 0.5,
    })),
  };
  const completed = completeConvexSilhouette(visible);
  assert.ok(completed.rows[3].width > 0.9);
  assert.ok(completed.rows[4].width > 0.9);
  assert.ok(
    Math.abs(completed.rows[0].width - 0.6) < 1e-9,
    "visible shoulders retain their source width",
  );
  assert.equal(
    visible.rows[3].width,
    0.35,
    "the photographic mask stays unchanged for occlusion rejection",
  );
});

test("source projection excludes occluders using a differently sized mask while preserving visible RGB", () => {
  const source = pixels(20, 20),
    mask = pixels(10, 10);
  for (let y = 0; y < 20; y++)
    for (let x = 0; x < 20; x++) {
      (source.data as Uint8Array).set(
        x < 10 ? [240, 50, 220, 255] : [215, 210, 201, 255],
        (y * 20 + x) * 4,
      );
    }
  for (let y = 0; y < 10; y++)
    for (let x = 5; x < 10; x++)
      (mask.data as Uint8Array)[(y * 10 + x) * 4] = 255;
  const { texture } = prepareMemoryPropAppearance(source, [0, 0, 1, 1], mask);
  const rgba = texture.image.data;
  assert.equal(
    rgba[(10 * 20 + 4) * 4 + 3],
    0,
    "a hand/background pixel is not projected on the solid body",
  );
  assert.deepEqual(
    Array.from(rgba.slice((10 * 20 + 4) * 4, (10 * 20 + 4) * 4 + 3)),
    [215, 210, 201],
    "an occluded patch borrows the object's own row color, never the magenta background or a repeated logo",
  );
  assert.deepEqual(
    Array.from(rgba.slice((10 * 20 + 15) * 4, (10 * 20 + 15) * 4 + 4)),
    [215, 210, 201, 255],
  );
  texture.dispose();
});

test("actual silhouette narrows shoulders but a detection rectangle is not treated as a measured contour", () => {
  const source = pixels(64, 64),
    mask = pixels(64, 64);
  const rectangle = pixels(64, 64);
  (rectangle.data as Uint8Array).fill(255);
  for (let y = 0; y < 64; y++) {
    const halfWidth = y < 14 ? 12 : y > 54 ? 21 : 28;
    for (let x = 32 - halfWidth; x <= 32 + halfWidth; x++)
      (mask.data as Uint8Array)[(y * 64 + x) * 4] = 255;
  }
  const appearance = prepareMemoryPropAppearance(source, [0, 0, 1, 1], mask);
  assert.ok(appearance.silhouette);
  assert.ok(
    appearance.silhouette.rows[1].width <
      appearance.silhouette.rows[16].width * 0.6,
  );
  const plain = prepareMemoryPropAppearance(source, [0, 0, 1, 1], rectangle);
  assert.equal(plain.silhouette, undefined);
  const prop = buildMemoryProp({
    id: "specific-can",
    label: "short white can",
    source,
    mask,
    box: [0, 0, 1, 1],
    object: {
      category: "drink-can",
      confidence: 0.95,
      color: "#d7d2c9",
      dimensions: [0.1, 0.123, 0.1],
    },
  });
  assert.equal(prop.group.userData.memoryAppearance.silhouette, true);
  const size = new THREE.Box3()
    .setFromObject(prop.group)
    .getSize(new THREE.Vector3());
  assert.ok(size.distanceTo(new THREE.Vector3(0.1, 0.123, 0.1)) < 1e-6);
  let maximum = 0,
    shoulder = 0,
    rearVertices = 0;
  prop.group.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) return;
    const p = node.geometry.getAttribute("position"),
      weights = node.geometry.getAttribute("memoryPhotoWeight");
    for (let i = 0; i < p.count; i++) {
      maximum = Math.max(maximum, Math.abs(p.getX(i)));
      if (p.getY(i) > 0.44 && p.getY(i) < 0.479)
        shoulder = Math.max(shoulder, Math.abs(p.getX(i)));
      if (p.getZ(i) < -0.1 && weights.getX(i) === 0) rearVertices++;
    }
  });
  assert.ok(
    shoulder < maximum * 0.75,
    "geometry follows the source shoulders instead of the generic cylinder",
  );
  assert.ok(
    rearVertices > 20,
    "the object has solid unseen rear geometry without a repeated front photograph",
  );
  prop.dispose();
  appearance.texture.dispose();
  plain.texture.dispose();
});

test("screen and chassis share a single photograph projection instead of stretching the whole crop onto each part", () => {
  const prop = buildMemoryProp({
    id: "phone",
    label: "source phone",
    source: pixels(20, 40),
    box: [0, 0, 1, 1],
    object: {
      category: "phone",
      confidence: 0.9,
      color: "#b8a8c0",
      dimensions: [0.075, 0.15, 0.009],
    },
  });
  const screen = prop.group.getObjectByName(
    "Photographic screen",
  ) as THREE.Mesh;
  assert.ok(screen);
  const uvs = screen.geometry.getAttribute("uv");
  let minimum = 1,
    maximum = 0;
  for (let i = 0; i < uvs.count; i++) {
    minimum = Math.min(minimum, uvs.getX(i));
    maximum = Math.max(maximum, uvs.getX(i));
  }
  assert.ok(
    minimum > 0.03 && maximum < 0.97,
    "screen samples its corresponding subsection; body edge pixels stay on the chassis",
  );
  assert.equal(
    (screen.material as THREE.MeshStandardMaterial).transparent,
    false,
    "missing pixels retain a closed solid body",
  );
  prop.dispose();
});
