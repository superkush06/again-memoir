import test from "node:test";
import assert from "node:assert/strict";
import { silhouettePrompts, selectObjectSilhouette, type SilhouetteBox } from "./object-silhouette.js";

test("SlimSAM prompts use supported foreground/background labels and scaled crop coordinates", () => {
  const box: SilhouetteBox = [120, 160, 200, 240];
  const crop = { left: 100, top: 100, width: 200, height: 120 };
  const result = silhouettePrompts(box, crop, { width: 100, height: 60 });
  assert.deepEqual(result.input_points[0].slice(0, 3), [[50, 20], [50, 30], [50, 40]]);
  assert.deepEqual(result.input_labels[0], [1, 1, 1, 0, 0, 0, 0]);
  for (const [i, [x, y]] of result.input_points[0].entries()) {
    const sourceX = crop.left + x * 2, sourceY = crop.top + y * 2;
    const inside = sourceX >= box[1] && sourceX < box[3] && sourceY >= box[0] && sourceY < box[2];
    assert.equal(inside, result.input_labels[0][i] === 1);
  }
});

test("crop-edge objects never receive clamped negative points inside their box", () => {
  const result = silhouettePrompts([0, 0, 30, 20], { left: 0, top: 0, width: 20, height: 30 }, { width: 20, height: 30 }, "laptop");
  assert.deepEqual(result.input_labels, [[1, 1, 1, 1]]);
  assert.ok(result.input_points[0].every(([x, y]) => x >= 0 && x < 20 && y >= 0 && y < 30));
  const tiny = silhouettePrompts([0, 0, 1, 1], { left: 0, top: 0, width: 1, height: 1 }, { width: 1, height: 1 });
  assert.deepEqual(tiny, { input_points: [[[0, 0]]], input_labels: [[1]] });
  const downscaled = silhouettePrompts([40, 40, 90, 90], { left: 0, top: 0, width: 100, height: 100 }, { width: 2, height: 2 });
  for (const [i, [x, y]] of downscaled.input_points[0].entries()) {
    if (downscaled.input_labels[0][i] === 0) assert.ok(x * 50 < 40 || x * 50 >= 90 || y * 50 < 40 || y * 50 >= 90);
  }
  assert.throws(() => silhouettePrompts([0, 0, 0, 10], { left: 0, top: 0, width: 10, height: 10 }, { width: 10, height: 10 }), RangeError);
});

const width = 60, height = 80;
const crop = { left: 0, top: 0, width, height };
const box: SilhouetteBox = [10, 10, 70, 50];
function maskWhere(predicate: (x: number, y: number) => boolean) {
  return Uint8Array.from({ length: width * height }, (_, i) => predicate(i % width, Math.floor(i / width)) ? 1 : 0);
}
const full = maskWhere((x, y) => x >= 12 && x < 48 && y >= 12 && y < 68);

test("whole-laptop silhouette wins over a higher-IoU screen-only mask without adding pixels", () => {
  const screen = maskWhere((x, y) => x >= 12 && x < 48 && y >= 12 && y < 42);
  const result = selectObjectSilhouette({ channels: [{ score: 0.98, data: screen }, { score: 0.84, data: full }], width, height, box, crop, category: "laptop" });
  assert.equal(result.channel, 1);
  assert.equal(result.audit[0].reason, "partial");
  assert.equal(result.audit[1].selected, true);
  assert.deepEqual(result.mask, full);
});

test("silhouette selection rejects empty, low-quality and spilled foreground masks with audit reasons", () => {
  const result = selectObjectSilhouette({ channels: [{ score: 0.9, data: new Uint8Array(width * height) }, { score: 0.69, data: full }, { score: 0.99, data: new Uint8Array(width * height).fill(1) }], width, height, box, crop });
  assert.equal(result.mask, undefined);
  assert.deepEqual(result.audit.map(entry => entry.reason), ["empty", "quality", "spill"]);
});

test("a connected can silhouette with a finger occlusion stays usable and keeps its notch", () => {
  const occluded = maskWhere((x, y) => x >= 12 && x < 48 && y >= 12 && y < 68 && !(x < 30 && y >= 30 && y < 45));
  const result = selectObjectSilhouette({ channels: [{ score: 0.82, data: occluded }], width, height, box, crop, category: "drink-can" });
  assert.equal(result.channel, 0);
  assert.deepEqual(result.mask, occluded);
  assert.equal(result.mask![35 * width + 20], 0);
});

test("disconnected edge noise cannot make a small part mask satisfy whole-object coverage", () => {
  const part = maskWhere((x, y) => (x >= 20 && x < 40 && y >= 20 && y < 45) || (x === 10 && y === 10) || (x === 49 && y === 69));
  const result = selectObjectSilhouette({ channels: [{ score: 0.95, data: part }, { score: 0.83, data: full }], width, height, box, crop, category: "laptop" });
  assert.equal(result.audit[0].reason, "partial");
  assert.equal(result.channel, 1);
});
