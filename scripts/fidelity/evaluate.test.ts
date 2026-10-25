import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import sharp from "sharp";
import {
  evaluateManifest,
  evaluateRgb,
  parseManifest,
  type RgbImage,
} from "./evaluate.js";

const rgb = (
  samples: number[],
  width = samples.length / 3,
  height = 1,
): RgbImage => ({ width, height, data: Uint8Array.from(samples) });
const closeTo = (actual: number, expected: number) =>
  assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`);
const cli = fileURLToPath(new URL("./evaluate.ts", import.meta.url));

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "memoir-fidelity-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const save = async (
    name: string,
    data: number[],
    width: number,
    height: number,
    channels: 1 | 3 | 4 = 3,
    orientation?: number,
  ) => {
    let image = sharp(Buffer.from(data), { raw: { width, height, channels } });
    if (orientation) image = image.withMetadata({ orientation });
    await image.png().toFile(join(directory, name));
  };
  const manifest = {
    view: "source-camera",
    alignmentVerified: true,
    reference: "reference.png",
    baseline: "baseline.png",
    candidate: "candidate.png",
  };
  const manifestPath = join(directory, "manifest.json");
  await Promise.all([
    save("reference.png", [0, 0, 0, 0, 0, 0], 2, 1),
    save("baseline.png", [255, 255, 255, 0, 0, 0], 2, 1),
    save("candidate.png", [255, 0, 0, 0, 0, 0], 2, 1),
    writeFile(manifestPath, JSON.stringify(manifest)),
  ]);
  return { directory, save, manifest, manifestPath };
}

test("analytic global RGB errors and candidate-minus-baseline deltas", () => {
  const result = evaluateRgb(
    rgb([0, 0, 0, 0, 0, 0]),
    rgb([255, 255, 255, 0, 0, 0]),
    rgb([255, 0, 0, 0, 0, 0]),
  );
  assert.equal(result.global.baseline.mae, 0.5);
  closeTo(result.global.baseline.rmse, Math.sqrt(0.5));
  closeTo(result.global.baseline.psnrDb!, 10 * Math.log10(2));
  closeTo(result.global.candidate.mae, 1 / 6);
  closeTo(result.global.candidate.rmse, Math.sqrt(1 / 6));
  closeTo(result.global.candidate.psnrDb!, 10 * Math.log10(6));
  closeTo(result.global.candidateMinusBaseline.mae, -1 / 3);
  closeTo(
    result.global.candidateMinusBaseline.rmse,
    Math.sqrt(1 / 6) - Math.sqrt(0.5),
  );
  closeTo(result.global.candidateMinusBaseline.psnrDb!, 10 * Math.log10(3));
  assert.equal(result.global.candidate.changedPixelFraction, 0.5);
  assert.equal(result.global.candidateMinusBaseline.changedPixelFraction, 0);
  assert.equal(result.global.candidate.exactMatch, false);
});

test("exact-match PSNR and deltas remain JSON-safe and explicit", () => {
  const image = rgb([0, 128, 255]);
  const result = evaluateRgb(image, image, image);
  assert.deepEqual(result.global.candidate, {
    pixelCount: 1,
    exactMatch: true,
    mae: 0,
    rmse: 0,
    psnrDb: null,
    changedPixelFraction: 0,
  });
  assert.equal(result.global.candidateMinusBaseline.psnrDb, null);
  assert.equal(result.global.candidateMinusBaseline.psnrDeltaDefined, false);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
  const improvement = evaluateRgb(image, rgb([255, 128, 255]), image);
  assert.equal(improvement.global.candidateMinusBaseline.psnrDb, null);
  assert.equal(improvement.global.candidate.exactMatch, true);
  assert.equal(improvement.global.baseline.exactMatch, false);
});

test("mask threshold includes 128 and excludes 127; errors use selected pixels only", () => {
  const result = evaluateRgb(
    rgb([0, 0, 0, 0, 0, 0]),
    rgb([255, 255, 255, 0, 0, 0]),
    rgb([255, 0, 0, 255, 255, 255]),
    [
      {
        name: "person",
        width: 2,
        height: 1,
        data: Uint8Array.from([128, 127]),
      },
    ],
  );
  assert.equal(result.regions[0].baseline.pixelCount, 1);
  assert.equal(result.regions[0].baseline.mae, 1);
  closeTo(result.regions[0].candidate.mae, 1 / 3);
  closeTo(result.regions[0].candidate.rmse, Math.sqrt(1 / 3));
  assert.equal(result.regions[0].candidate.changedPixelFraction, 1);
  closeTo(result.regions[0].candidateMinusBaseline.mae, -2 / 3);
});

test("changed-pixel test is strictly greater than 10 in any RGB channel", () => {
  const reference = rgb([0, 0, 0, 0, 0, 0]);
  const result = evaluateRgb(reference, reference, rgb([10, 10, 10, 0, 11, 0]));
  assert.equal(result.global.candidate.changedPixelFraction, 0.5);
  assert.equal(result.global.candidateMinusBaseline.changedPixelFraction, 0.5);
});

test("invalid dimensions, buffers, duplicate regions and empty masks fail", () => {
  const image = rgb([0, 0, 0, 1, 1, 1]);
  assert.throws(
    () => evaluateRgb(image, { ...image, width: 1, height: 2 }, image),
    /dimensions must exactly match/,
  );
  assert.throws(
    () => evaluateRgb(image, { ...image, data: new Uint8Array(1) }, image),
    /sample buffer/,
  );
  assert.throws(
    () =>
      evaluateRgb(image, image, image, [
        { name: "empty", width: 2, height: 1, data: Uint8Array.from([0, 127]) },
      ]),
    /selects no pixels/,
  );
  assert.throws(
    () =>
      evaluateRgb(image, image, image, [
        {
          name: "wrong",
          width: 1,
          height: 2,
          data: Uint8Array.from([255, 255]),
        },
      ]),
    /dimensions must exactly match/,
  );
  const mask = {
    name: "duplicate",
    width: 2,
    height: 1,
    data: Uint8Array.from([255, 255]),
  };
  assert.throws(() => evaluateRgb(image, image, image, [mask, mask]), /unique/);
});

test("manifest refuses off-axis views, unverified alignment and ambiguous fields", () => {
  const valid = {
    view: "source-camera",
    alignmentVerified: true,
    reference: "r.png",
    baseline: "b.png",
    candidate: "c.png",
  };
  assert.deepEqual(parseManifest(valid), valid);
  assert.throws(() => parseManifest({ ...valid, view: "side" }), /off-axis/);
  assert.throws(
    () => parseManifest({ ...valid, alignmentVerified: false }),
    /alignmentVerified/,
  );
  assert.throws(() => parseManifest({ ...valid, resize: true }), /unsupported/);
  assert.throws(
    () => parseManifest({ ...valid, capture: "camera" }),
    /JSON object/,
  );
  assert.throws(
    () => parseManifest({ ...valid, regions: [{ name: "x", mask: "" }] }),
    /mask file path/,
  );
});

test("PNG manifest compares relative paths, mask selection, hashes and provenance", async (t) => {
  const f = await fixture(t);
  await f.save("mask.png", [128, 127], 2, 1, 1);
  await writeFile(
    f.manifestPath,
    JSON.stringify({
      ...f.manifest,
      regions: [{ name: "face", mask: "mask.png" }],
      capture: { camera: "source", canvasOnly: true },
      provenance: { candidateRevision: "example" },
    }),
  );
  const report = await evaluateManifest(f.manifestPath);
  assert.equal(report.regions[0].candidate.pixelCount, 1);
  closeTo(report.regions[0].candidate.mae, 1 / 3);
  assert.equal(
    report.inputs.reference.path,
    join(f.directory, "reference.png"),
  );
  const expectedHash = createHash("sha256")
    .update(await readFile(join(f.directory, "reference.png")))
    .digest("hex");
  assert.equal(report.inputs.reference.sha256, expectedHash);
  assert.match(report.inputs.masks[0].sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(report.capture, { camera: "source", canvasOnly: true });
  assert.deepEqual(report.provenance, { candidateRevision: "example" });
});

test("file decoding rejects dimensions, transparent images and transparent masks", async (t) => {
  const f = await fixture(t);
  await f.save("candidate.png", [0, 0, 0], 1, 1);
  await assert.rejects(
    evaluateManifest(f.manifestPath),
    /dimensions must exactly match/,
  );
  await f.save("candidate.png", [0, 0, 0, 255, 0, 0, 0, 254], 2, 1, 4);
  await assert.rejects(evaluateManifest(f.manifestPath), /fully opaque/);
  await f.save("candidate.png", [0, 0, 0, 255, 0, 0, 0, 255], 2, 1, 4);
  assert.equal(
    (await evaluateManifest(f.manifestPath)).global.candidate.exactMatch,
    true,
  );
  await f.save("mask.png", [255, 255, 255, 255, 0, 0, 0, 0], 2, 1, 4);
  await writeFile(
    f.manifestPath,
    JSON.stringify({
      ...f.manifest,
      regions: [{ name: "mask", mask: "mask.png" }],
    }),
  );
  await assert.rejects(evaluateManifest(f.manifestPath), /fully opaque/);
});

test("color masks and empty file masks fail instead of silently selecting a region", async (t) => {
  const f = await fixture(t);
  await writeFile(
    f.manifestPath,
    JSON.stringify({
      ...f.manifest,
      regions: [{ name: "mask", mask: "mask.png" }],
    }),
  );
  await f.save("mask.png", [255, 0, 0, 0, 0, 0], 2, 1);
  await assert.rejects(evaluateManifest(f.manifestPath), /grayscale/);
  await f.save("mask.png", [0, 127], 2, 1, 1);
  await assert.rejects(evaluateManifest(f.manifestPath), /selects no pixels/);
});

test("EXIF orientation is applied before dimensions and RGB comparison", async (t) => {
  const f = await fixture(t);
  await f.save("reference.png", [255, 0, 0, 0, 0, 255], 1, 2);
  await f.save("baseline.png", [255, 0, 0, 0, 0, 255], 1, 2);
  await f.save("candidate.png", [255, 0, 0, 0, 0, 255], 2, 1, 3, 6);
  const report = await evaluateManifest(f.manifestPath);
  assert.deepEqual(report.dimensions, { width: 1, height: 2 });
  assert.equal(report.global.candidate.exactMatch, true);
});

test("CLI emits JSON, writes only explicit report, and rejects input overwrite", async (t) => {
  const f = await fixture(t);
  const outputPath = join(f.directory, "report.json");
  const run = (args: string[]) =>
    spawnSync(process.execPath, ["--import", "tsx", cli, ...args], {
      encoding: "utf8",
    });
  const success = run([f.manifestPath, "--output", outputPath]);
  assert.equal(success.status, 0, success.stderr);
  assert.equal(success.stderr, "");
  const report = JSON.parse(success.stdout);
  closeTo(report.global.candidate.mae, 1 / 6);
  assert.equal(await readFile(outputPath, "utf8"), success.stdout);
  const original = await readFile(f.manifestPath, "utf8");
  const refused = run([f.manifestPath, "--output", f.manifestPath]);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /must not overwrite/);
  assert.equal(refused.stdout, "");
  assert.equal(await readFile(f.manifestPath, "utf8"), original);
  await writeFile(
    f.manifestPath,
    JSON.stringify({ ...f.manifest, alignmentVerified: false }),
  );
  const invalid = run([f.manifestPath]);
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /alignmentVerified/);
  assert.equal(invalid.stdout, "");
});
