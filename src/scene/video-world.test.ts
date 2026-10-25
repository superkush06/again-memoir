import test from "node:test";
import assert from "node:assert/strict";
import { interpolateVideoPositions, videoFrameBlend } from "./video-world";

test("video playback, reverse scrubbing and looping select the correct depth samples", () => {
  const times = [0, 2, 4, 5.9];
  assert.deepEqual(videoFrameBlend(times, 1), {
    from: 0,
    to: 1,
    amount: 0.5,
    nearest: 1,
  });
  assert.deepEqual(videoFrameBlend(times, 3), {
    from: 1,
    to: 2,
    amount: 0.5,
    nearest: 2,
  });
  assert.equal(videoFrameBlend(times, 1.2).nearest, 1);
  assert.equal(videoFrameBlend(times, 0.2).nearest, 0);
  assert.deepEqual(videoFrameBlend(times, 10), {
    from: 3,
    to: 3,
    amount: 0,
    nearest: 3,
  });
  for (const time of [0, -10, NaN])
    assert.deepEqual(videoFrameBlend(times, time), {
      from: 0,
      to: 0,
      amount: 0,
      nearest: 0,
    });
});

test("moving geometry interpolates nearby surfaces while cutting depth discontinuities", () => {
  const a = Float32Array.of(1, 2, -3, 1, 2, -3);
  const b = Float32Array.of(2, 3, -3.3, 8, 9, -12);
  const output = new Float32Array(a.length);
  interpolateVideoPositions(a, b, 0.25, output);
  assert.equal(output[0], 1.25);
  assert.equal(output[1], 2.25);
  assert.ok(Math.abs(output[2] - -3.075) < 1e-6);
  assert.deepEqual(Array.from(output.slice(3)), [1, 2, -3]);
  interpolateVideoPositions(a, b, 0.75, output);
  assert.deepEqual(Array.from(output.slice(3)), [8, 9, -12]);
  assert.notDeepEqual(
    Array.from(output),
    Array.from(a),
    "time must actually change geometry",
  );
  interpolateVideoPositions(a, b, 0, output);
  assert.deepEqual(output, a);
  interpolateVideoPositions(a, b, 1, output);
  assert.deepEqual(output, b);
  assert.throws(
    () => interpolateVideoPositions(a, b.slice(0, 3), 0.5, output),
    /must match/,
  );
});
