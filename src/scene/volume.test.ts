import assert from "node:assert/strict";
import test from "node:test";
import { createDepthGeometry } from "./reconstruction";
import {
  createClosedVolume,
  depthSilhouettes,
  type VolumePixels,
} from "./volume";

function image(
  width: number,
  height: number,
  pixel: (x: number, y: number) => number[],
): VolumePixels {
  return {
    width,
    height,
    data: Array.from({ length: width * height }, (_, i) =>
      pixel(i % width, Math.floor(i / width)),
    ).flat(),
  };
}
const depth = image(9, 9, () => [205, 205, 205, 255]);
const source = image(9, 9, (x, y) => [200, x * 18, y * 20, 255]);
const mask = image(9, 9, (x, y) => [
  x > 0 && x < 8 && y > 0 && y < 8 ? 255 : 0,
  0,
  0,
  255,
]);
const projected = createDepthGeometry(depth);

test("a silhouette becomes a closed two-manifold volume with every edge paired", () => {
  const volume = createClosedVolume(projected, mask, source, 0.8);
  const edges = new Map<string, number>();
  for (let i = 0; i < volume.indices.length; i += 3) {
    const triangle = Array.from(volume.indices.slice(i, i + 3));
    for (let j = 0; j < 3; j++) {
      const a = triangle[j];
      const b = triangle[(j + 1) % 3];
      const key = `${Math.min(a, b)}:${Math.max(a, b)}`;
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
  }
  assert.ok(edges.size > 50);
  assert.ok(Array.from(edges.values()).every((count) => count === 2));
  assert.ok(volume.indices.length > volume.frontIndexCount * 2);
});

test("the inferred back encloses nonzero space and rounds away from the silhouette", () => {
  const volume = createClosedVolume(projected, mask, source, 0.8);
  const offsets = Array.from(
    { length: volume.vertexCount },
    (_, i) =>
      volume.positions[i * 3 + 2] -
      volume.positions[(i + volume.vertexCount) * 3 + 2],
  );
  assert.ok(Math.min(...offsets) > 0.1);
  assert.ok(Math.max(...offsets) > 0.7);
  assert.ok(Math.max(...offsets) > Math.min(...offsets) * 3);
  assert.ok(volume.bounds.max[2] - volume.bounds.min[2] > 0.7);
});

test("original photographic color and UV survive on the front; rear color has no mirrored face detail", () => {
  const volume = createClosedVolume(projected, mask, source);
  const srgbToLinear = (v: number) => ((v + 0.055) / 1.055) ** 2.4;
  assert.ok(Math.abs(volume.colors[0] - srgbToLinear(200 / 255)) < 1e-6);
  assert.ok(volume.colors[volume.vertexCount * 3] > 0.4);
  const rearGreens = Array.from(
    { length: 7 },
    (_, i) => volume.colors[(volume.vertexCount + i) * 3 + 1],
  );
  const frontGreens = Array.from(
    { length: 7 },
    (_, i) => volume.colors[i * 3 + 1],
  );
  assert.ok(
    Math.max(...rearGreens) - Math.min(...rearGreens) <
      (Math.max(...frontGreens) - Math.min(...frontGreens)) / 3,
  );
  for (let i = 0; i < volume.vertexCount; i++) {
    assert.equal(volume.uvs[i * 2], volume.uvs[(i + volume.vertexCount) * 2]);
    assert.equal(
      volume.uvs[i * 2 + 1],
      volume.uvs[(i + volume.vertexCount) * 2 + 1],
    );
  }
});

test("holes between limbs are also closed along their inner edges", () => {
  const holeMask = image(9, 9, (x, y) => [
    x > 0 && x < 8 && y > 0 && y < 8 && !(x > 3 && x < 6 && y > 3 && y < 6)
      ? 255
      : 0,
    0,
    0,
    255,
  ]);
  const volume = createClosedVolume(projected, holeMask, source);
  const signedEdges = new Map<string, number>();
  for (let i = 0; i < volume.indices.length; i += 3) {
    for (let j = 0; j < 3; j++) {
      const a = volume.indices[i + j];
      const b = volume.indices[i + ((j + 1) % 3)];
      const key = `${Math.min(a, b)}:${Math.max(a, b)}`;
      signedEdges.set(key, (signedEdges.get(key) ?? 0) + (a < b ? 1 : -1));
    }
  }
  assert.ok(Array.from(signedEdges.values()).every((sum) => sum === 0));
});

test("fallback identifies disconnected foreground regions without generic object substitution", () => {
  const regions = image(20, 20, (x, y) => [
    ((x > 2 && x < 7) || (x > 12 && x < 17)) && y > 3 && y < 16 ? 230 : 25,
    0,
    0,
    255,
  ]);
  const masks = depthSilhouettes(regions);
  assert.equal(masks.length, 2);
  assert.ok(
    masks.every((candidate) =>
      Array.from(candidate.data).some((value) => value === 255),
    ),
  );
});

test("isolated depth outliers cannot make a subject stretch into the background", () => {
  const noisy = createDepthGeometry(
    image(9, 9, (x, y) => [x === 2 && y === 2 ? 0 : 205, 0, 0, 255]),
  );
  const volume = createClosedVolume(noisy, mask, source, 0.8);
  assert.ok(volume.bounds.max[2] - volume.bounds.min[2] < 2);
});
