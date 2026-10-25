import assert from "node:assert/strict";
import test from "node:test";
import { parseCaptureManifest } from "./capture.js";

const valid = {
  source: "source.jpg",
  baselineDepth: "old.png",
  candidateDepth: "new.png",
  baselineRoot: "frozen",
  views: [
    { name: "source-camera", offset: [0, 0, 0] },
    { name: "right-8cm", offset: [0.08, 0, 0] },
  ],
};

test("capture contract preserves fixed source-camera translation and rejects unsafe names", () => {
  assert.deepEqual(parseCaptureManifest(valid), valid);
  assert.throws(
    () =>
      parseCaptureManifest({
        ...valid,
        views: [{ name: "source-camera", offset: [0.08, 0, 0] }],
      }),
    /source-camera/,
  );
  assert.throws(
    () =>
      parseCaptureManifest({
        ...valid,
        views: [...valid.views, { name: "../image", offset: [0, 0, 0] }],
      }),
    /filename-safe/,
  );
  assert.throws(
    () =>
      parseCaptureManifest({
        ...valid,
        views: [valid.views[0], valid.views[0]],
      }),
    /unique/,
  );
});

test("capture contract rejects depth strength changes and silently ignored settings", () => {
  assert.throws(
    () => parseCaptureManifest({ ...valid, projection: { strength: 2 } }),
    /fixed strength/,
  );
  assert.throws(
    () => parseCaptureManifest({ ...valid, rotateCamera: true }),
    /Unknown/,
  );
  assert.throws(
    () => parseCaptureManifest({ ...valid, candidateMeshMaxEdge: 0 }),
    /integer/,
  );
  assert.throws(
    () => parseCaptureManifest({ ...valid, projection: { fov: NaN } }),
    /projection/,
  );
});
