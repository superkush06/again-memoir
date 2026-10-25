import assert from "node:assert/strict";
import test from "node:test";
import { analyzeHumanAppearance, type PhotoBox } from "./human-appearance";
import type { VolumePixels } from "./volume";

const image = (
  width: number,
  height: number,
  pixel: (x: number, y: number) => number[],
): VolumePixels => ({
  width,
  height,
  data: Uint8Array.from(
    Array.from({ length: width * height }, (_, i) =>
      pixel(i % width, Math.floor(i / width)),
    ).flat(),
  ),
});
const box: PhotoBox = [0.1, 0.2, 1, 0.8];
const silhouette = (x: number, y: number) =>
  (y >= 20 && y < 65 && ((x - 100) / 23) ** 2 + ((y - 42) / 23) ** 2 <= 1) ||
  (y >= 65 && y < 76 && x > 88 && x < 112) ||
  (y >= 76 && x >= 45 && x < 155);
const mask = image(200, 200, (x, y) => [silhouette(x, y) ? 255 : 0, 0, 0, 255]);
const photo = (shirt: number[], gray = false, back = false) =>
  image(200, 200, (x, y) => {
    if (!silhouette(x, y)) return [8, 50, 90, 255];
    if (y < 37 || (back && y < 63)) return [17, 17, 17, 255];
    if (y < 76) return gray ? [130, 130, 130, 255] : [192, 126, 81, 255];
    // A small white print should survive in the chest texture, without whitening
    // the color used on the entire back and the extrapolated sleeves.
    if (x >= 96 && x <= 105 && y > 95 && y < 165) return [240, 240, 240, 255];
    return [...shirt, 255];
  });

test("source clothing colors survive, instead of averaging a white graphic into the whole shirt", () => {
  for (const [rgb, expected] of [
    [[240, 219, 232], "#f0dbe8"],
    [[98, 102, 108], "#62666c"],
    [[15, 16, 18], "#0f1012"],
  ] as const) {
    const appearance = analyzeHumanAppearance({
      source: photo([...rgb]),
      mask,
      box,
      label: "person",
    });
    assert.equal(appearance.shirtColor, expected);
    assert.equal(appearance.skinColor, "#c07e51");
    assert.equal(appearance.hairColor, "#111111");
    assert.equal(appearance.pantsColor, "#262b31");
  }
});

test("monochrome memories keep inferred skin, clothes, hair, and shoes monochrome", () => {
  const appearance = analyzeHumanAppearance({
    source: photo([55, 55, 55], true),
    mask,
    box,
    label: "person",
  });
  for (const name of [
    "shirtColor",
    "pantsColor",
    "skinColor",
    "hairColor",
    "shoeColor",
  ] as const) {
    const color = appearance[name];
    assert.equal(color.slice(1, 3), color.slice(3, 5));
    assert.equal(color.slice(3, 5), color.slice(5, 7));
  }
  assert.equal(appearance.yaw, 0);
});

test("skin and hair distribution recognizes a photographed back without painting a face onto it", () => {
  const appearance = analyzeHumanAppearance({
    source: photo([240, 219, 232], false, true),
    mask,
    box,
    label: "person",
  });
  assert.equal(appearance.sourceView, "back");
  assert.equal(appearance.yaw, Math.PI);
  assert.equal(appearance.headYaw, 0);
});

test("head and chest crops ignore an arm extending across another person's shoulders", () => {
  const armMask = image(200, 200, (x, y) => [
    silhouette(x, y) || (y >= 80 && y < 95 && x > 5) ? 255 : 0,
    0,
    0,
    255,
  ]);
  const appearance = analyzeHumanAppearance({
    source: photo([20, 20, 20]),
    mask: armMask,
    box: [0.1, 0.025, 1, 1],
    label: "person in black graphic shirt",
  });
  const [top, left, bottom, right] = appearance.faceBox!;
  assert.ok(
    left > 0.32 && right < 0.68,
    `Head crop must exclude outstretched arms: ${appearance.faceBox}`,
  );
  assert.ok(top < 0.15 && bottom < 0.4);
  assert.ok(appearance.chestBox![1] > 0.25 && appearance.chestBox![3] < 0.8);
  assert.equal(appearance.shirtColor, "#141414");
});

test("different source and mask resolutions produce the same source sRGB colors", () => {
  const small = photo([240, 219, 232]);
  const smallData = Array.from(small.data);
  const enlarged = image(400, 400, (x, y) => {
    const i = (Math.floor(y / 2) * 200 + Math.floor(x / 2)) * 4;
    return smallData.slice(i, i + 4);
  });
  const a = analyzeHumanAppearance({
    source: small,
    mask,
    box,
    label: "person",
  });
  const b = analyzeHumanAppearance({
    source: enlarged,
    mask,
    box,
    label: "person",
  });
  assert.equal(b.shirtColor, a.shirtColor);
  assert.equal(b.skinColor, a.skinColor);
  assert.deepEqual(b.faceBox, a.faceBox);
});

test("invalid pixel arrays fail clearly and empty silhouettes have a stable complete-body fallback", () => {
  assert.throws(
    () =>
      analyzeHumanAppearance({
        source: { ...mask, data: [] },
        mask,
        box,
        label: "person",
      }),
    /RGBA/,
  );
  assert.throws(
    () =>
      analyzeHumanAppearance({
        source: photo([20, 20, 20]),
        mask,
        box: [0.2, 0.5, 0.1, 0.8],
        label: "person",
      }),
    /nonempty/,
  );
  const empty = image(4, 4, () => [0, 0, 0, 255]);
  const a = analyzeHumanAppearance({
    source: photo([20, 20, 20]),
    mask: empty,
    box,
    label: "person",
  });
  assert.equal(a.height, 1.76);
  assert.match(a.skinColor, /^#[\da-f]{6}$/);
  assert.match(a.pantsColor, /^#[\da-f]{6}$/);
});

test("photographic garment bounds preserve a small printed graphic at its source scale", () => {
  const appearance = analyzeHumanAppearance({
    source: photo([20, 20, 20]), mask, box, label: "person in a graphic shirt",
  });
  const torso = appearance.torsoBox!;
  const palette = appearance.chestBox!;
  assert.ok(torso[1] < palette[1] && torso[3] > palette[3],
    "rendering uses the observed garment width, not its small color sampling crop");
  const photographicWidth = (torso[3] - torso[1]) * 199;
  assert.ok(photographicWidth >= 95 && photographicWidth <= 125,
    `the 110-pixel shirt should stay near its source width: ${photographicWidth}`);
  assert.ok(10 / photographicWidth < 0.11,
    "a 10-pixel graphic stays about one tenth of the shirt instead of filling it");
  assert.ok(torso[0] < palette[0], "necklaces and the collar above the old crop survive");
  assert.ok(appearance.neckBox![0] < appearance.faceBox![2]);
  assert.ok(appearance.neckBox![2] > appearance.faceBox![2]);
});

test("an arm crossing the photograph does not inflate torso shape or garment projection", () => {
  const crossingArm = image(200, 200, (x, y) => [
    silhouette(x, y) || (y >= 76 && y < 110 && x >= 5) ? 255 : 0, 0, 0, 255,
  ]);
  const appearance = analyzeHumanAppearance({
    source: photo([20, 20, 20]), mask: crossingArm,
    box: [0.1, 0.025, 1, 1], label: "person in a graphic shirt",
  });
  const torso = appearance.torsoBox!;
  assert.ok(torso[3] - torso[1] < 0.7,
    "a whole-image arm span must not become the projected shirt width");
  assert.ok(appearance.torsoWidthScale! >= 0.88 && appearance.torsoWidthScale! <= 1.22);
  assert.ok(Math.abs((torso[1] + torso[3]) / 2 - 0.5) < 0.08,
    "the garment remains underneath the actual head");
});

test("a hand over a neighbor's shoulder does not truncate the photographed chin", () => {
  const anatomy = (x: number, y: number) =>
    (y >= 20 && y < 88 && x >= 77 && x <= 123) ||
    (y >= 88 && y < 95 && x >= 88 && x <= 112) ||
    (y >= 95 && x >= 45 && x <= 155);
  const oneSidedArm = image(200, 200, (x, y) => [
    anatomy(x, y) || (y >= 80 && y < 99 && x >= 100) ? 255 : 0, 0, 0, 255,
  ]);
  const appearance = analyzeHumanAppearance({
    source: photo([20, 20, 20]), mask: oneSidedArm,
    box: [0.1, 0.2, 1, 1], label: "person with an arm around a friend",
  });
  assert.ok(appearance.faceBox![2] > 0.44,
    `the chin must stay below the one-sided arm at 0.40: ${appearance.faceBox}`);
  assert.ok(appearance.faceBox![3] - appearance.faceBox![1] < 0.35,
    "the arm does not widen the head texture");
});

test("anatomical fit accounts for source pixel aspect and crop fractions stay finite", () => {
  const appearance = analyzeHumanAppearance({
    source: photo([98, 102, 108]), mask, box, label: "person",
  });
  for (const value of [appearance.headWidthScale, appearance.headHeightScale,
    appearance.torsoWidthScale, appearance.torsoSourceBottom]) {
    assert.ok(Number.isFinite(value));
    assert.ok(value! > 0 && value! <= 1.22);
  }
  for (const area of [appearance.faceBox, appearance.neckBox, appearance.torsoBox]) {
    assert.ok(area!.every((value) => value >= 0 && value <= 1));
    assert.ok(area![0] < area![2] && area![1] < area![3]);
  }
  const sourceData = photo([98, 102, 108]).data;
  const widePhoto = image(400, 200, (x, y) => {
    const offset = (y * 200 + Math.floor(x / 2)) * 4;
    return [0, 1, 2, 3].map((channel) => Number(sourceData[offset + channel]));
  });
  const wider = analyzeHumanAppearance({ source: widePhoto, mask, box, label: "person" });
  assert.ok(wider.headWidthScale! > appearance.headWidthScale!,
    "an equal normalized crop in a wider source represents a wider observed head");
});
