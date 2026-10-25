import assert from "node:assert/strict";
import test from "node:test";
import { capDepthNearest, cappedDimensions } from "./capture-math.js";

test("depth cap preserves aspect, does not upscale, and bounds the longest edge", () => {
  assert.deepEqual(cappedDimensions(518, 392, 384), {
    width: 384,
    height: 291,
  });
  assert.deepEqual(cappedDimensions(256, 192, 256), {
    width: 256,
    height: 192,
  });
  assert.deepEqual(cappedDimensions(10, 8, 384), { width: 10, height: 8 });
  assert.deepEqual(cappedDimensions(4032, 3024, 960), {
    width: 960,
    height: 720,
  });
  assert.throws(() => cappedDimensions(0, 8, 384), /integers/);
});

test("nearest cap selects source pixel centres without averaging silhouette depths", () => {
  const data = new Uint8ClampedArray(4 * 4 * 4);
  for (let i = 0; i < 16; i++) data.set([i, i, i, 255], i * 4);
  const result = capDepthNearest({ width: 4, height: 4, data }, 2);
  assert.deepEqual(
    Array.from(result.data),
    [5, 5, 5, 255, 7, 7, 7, 255, 13, 13, 13, 255, 15, 15, 15, 255],
  );
  assert.deepEqual(Array.from(data.slice(0, 4)), [0, 0, 0, 255]);
  assert.throws(
    () => capDepthNearest({ width: 4, height: 4, data: data.slice(1) }, 2),
    /four channels/,
  );
});
