import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  confirmObjectProposal,
  confirmationCrop,
  localObjectRecognizer,
  mayConfirmCategory,
  maskToPolygon,
  selectObjectProposals,
} from "./local-object-detector.js";

const prediction = (
  label: string,
  score: number,
  box = { xmin: 100, ymin: 150, xmax: 200, ymax: 300 },
) => ({ label, score, box });
test("local proposals preserve OWL scores, require finite bounds, and allow negative categories to win", () => {
  const raw = [
    prediction("a photo of an aluminum drink can", 0.25),
    prediction("a photo of a cup", 0.22),
    prediction("a photo of a book", 0.8, {
      xmin: 300,
      ymin: 100,
      xmax: 500,
      ymax: 200,
    }),
    prediction("a photo of a laptop", 0.6, {
      xmin: 300,
      ymin: 100,
      xmax: 500,
      ymax: 200,
    }),
    prediction("a photo of a cell phone", NaN),
  ];
  assert.deepEqual(selectObjectProposals(raw, 1000, 1000), [
    { category: "drink-can", score: 0.25, box: [150, 100, 300, 200] },
  ]);
  assert.equal(
    selectObjectProposals(
      [
        prediction("a photo of a laptop", 0.9, {
          xmin: 0,
          ymin: 0,
          xmax: 1000,
          ymax: 1000,
        }),
      ],
      1000,
      1000,
    ).length,
    0,
  );
});
test("independent DINO confirmation must match both position and threshold", () => {
  const proposal = {
    category: "drink-can" as const,
    score: 0.25,
    box: [150, 100, 300, 200] as [number, number, number, number],
  };
  assert.equal(
    confirmObjectProposal(proposal, [prediction("a can", 0.39)]),
    undefined,
  );
  assert.equal(
    confirmObjectProposal(proposal, [
      prediction("a can", 0.9, { xmin: 700, ymin: 700, xmax: 900, ymax: 900 }),
    ]),
    undefined,
  );
  assert.equal(
    confirmObjectProposal(proposal, [prediction("a can", 0.65)])?.score,
    0.65,
  );
});
test("thermos aliases recover water bottles while competing cup predictions can still win", () => {
  assert.deepEqual(
    selectObjectProposals([
      prediction("a photo of a water bottle", 0.24),
      prediction("a photo of a cup", 0.39),
      prediction("a photo of a thermos", 0.52),
    ], 1000, 1000),
    [{ category: "water-bottle", score: 0.52, box: [150, 100, 300, 200] }],
  );
  assert.deepEqual(
    selectObjectProposals([
      prediction("a photo of a thermos", 0.52),
      prediction("a photo of a reusable bottle", 0.45),
      prediction("a photo of a cup", 0.61),
    ], 1000, 1000),
    [],
  );
});
test("a confident bottle cannot flip to a can while ambiguous containers can change class", () => {
  const bottle = { category: "water-bottle" as const, score: 0.54, box: [20, 40, 100, 80] as [number, number, number, number] };
  assert.equal(mayConfirmCategory(bottle, "drink-can"), false);
  assert.equal(mayConfirmCategory(bottle, "water-bottle"), true);
  assert.equal(mayConfirmCategory({ ...bottle, score: 0.35 }, "drink-can"), true);
  assert.equal(mayConfirmCategory({ ...bottle, category: "drink-can", score: 0.35 }, "water-bottle"), true);
  assert.equal(mayConfirmCategory({ ...bottle, score: 0.45 }, "drink-can"), false);
});
test("class changes are limited to ambiguous cans and bottles", () => {
  const proposal = { category: "laptop" as const, score: 0.35, box: [20, 40, 100, 80] as [number, number, number, number] };
  assert.equal(mayConfirmCategory(proposal, "computer"), false);
  assert.equal(mayConfirmCategory(proposal, "water-bottle"), false);
  assert.equal(mayConfirmCategory(proposal, "laptop"), true);
  assert.equal(mayConfirmCategory({ ...proposal, category: "water-bottle" }, "laptop"), false);
});
test("confirmation crops add 15 percent context using x/left and y/top coordinates", () => {
  // An asymmetric object makes accidentally swapping width/height or x/y visible.
  assert.deepEqual(confirmationCrop([80, 120, 200, 180], 500, 400), {
    left: 111, top: 62, width: 78, height: 156,
  });
  assert.deepEqual(confirmationCrop([0, 0, 40, 60], 200, 100), {
    left: 0, top: 0, width: 69, height: 46,
  });
  assert.deepEqual(confirmationCrop([60, 150, 100, 200], 200, 100), {
    left: 142, top: 54, width: 58, height: 46,
  });
});
test("bottle aliases leave a stronger book prediction able to suppress a laptop", () => {
  const bookBox = { xmin: 300, ymin: 100, xmax: 500, ymax: 250 };
  assert.deepEqual(
    selectObjectProposals([
      prediction("a photo of a laptop", 0.78, bookBox),
      prediction("a photo of a book", 0.81, bookBox),
      prediction("a photo of an insulated bottle", 0.49),
    ], 1000, 1000),
    [{ category: "water-bottle", score: 0.49, box: [150, 100, 300, 200] }],
  );
});
test("equal-scoring overlapping bottle aliases deduplicate without merging separate bottles", () => {
  const nearbyBox = { xmin: 105, ymin: 155, xmax: 205, ymax: 305 };
  const separateBox = { xmin: 400, ymin: 150, xmax: 500, ymax: 300 };
  const selected = selectObjectProposals([
    prediction("a photo of a thermos", 0.55),
    prediction("a photo of a reusable bottle", 0.55, nearbyBox),
    prediction("a photo of an insulated bottle", 0.55),
    prediction("a photo of a water bottle", 0.47, separateBox),
  ], 1000, 1000);
  assert.deepEqual(selected, [
    { category: "water-bottle", score: 0.55, box: [150, 100, 300, 200] },
    { category: "water-bottle", score: 0.47, box: [150, 400, 300, 500] },
  ]);
});
test("learned mask contour keeps finger-shaped concavity and excludes disconnected noise", () => {
  const width = 30,
    height = 30,
    mask = new Uint8Array(width * height);
  for (let y = 4; y < 26; y++)
    for (let x = 5; x < 25; x++)
      if (!(x < 12 && y > 10 && y < 18)) mask[y * width + x] = 1;
  mask[0] = mask[1] = 1;
  const polygon = maskToPolygon(mask, width, height);
  assert.ok(polygon.length >= 8 && polygon.length <= 96);
  assert.ok(polygon.some(([x, y]) => x === 12 && y >= 10 && y <= 18));
  assert.ok(polygon.every(([x, y]) => x >= 5 && y >= 4));
  assert.deepEqual(maskToPolygon(new Uint8Array(4), 2, 2), []);
});
test("local results cache by image contents, serialize inference, and retry failures without remote calls", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "memoir-local-object-"),
  );
  let count = 0,
    active = 0,
    peak = 0;
  const runtime = {
    async detect(image: Buffer) {
      count++;
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      if (image.toString() === "failure" && count === 4)
        throw new Error("inference failed");
      return { objects: [], proposals: [], confirmed: [] };
    },
  };
  try {
    const detect = localObjectRecognizer(directory, { runtime });
    await Promise.all([
      detect(Buffer.from("one")),
      detect(Buffer.from("two")),
      detect(Buffer.from("one")),
    ]);
    assert.equal(count, 2);
    assert.equal(peak, 1);
    const cacheDir = path.join(directory, "object-detections"),
      cache = await readdir(cacheDir);
    assert.equal(cache.length, 2);
    const cacheFile = path.join(cacheDir, cache[0]);
    const data = JSON.parse(await readFile(cacheFile, "utf8"));
    assert.ok(data.version && data.digest && data.models);
    await writeFile(cacheFile, "{broken");
    await Promise.all([detect(Buffer.from("one")), detect(Buffer.from("two"))]);
    assert.equal(count, 3);
    await assert.rejects(detect(Buffer.from("failure")), /inference failed/);
    await detect(Buffer.from("failure"));
    assert.equal(count, 5);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
