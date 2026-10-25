import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import type { ReconstructionSpec, WorldCompletion } from "../src/types.js";
import type { ObjectDetection } from "./object-recognition.js";
import { polygonMask, WorldCompleter } from "./world-completion.js";

type Box = [number, number, number, number];
const oldBox: Box = [0.1, 0.1, 0.3, 0.3];
const shiftedBox: Box = [0.6, 0.6, 0.8, 0.8];
function detection(box: Box): ObjectDetection {
  const [top, left, bottom, right] = box.map((n) => n * 1000);
  return {
    category: "phone",
    label: "light-colored phone",
    confidence: 0.81,
    box_2d: [top, left, bottom, right],
    polygon: [
      [left, top],
      [right, top],
      [right, bottom],
      [left, bottom],
    ],
  };
}

async function fixture() {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "memoir-object-upgrade-"),
  );
  const uploads = path.join(directory, "uploads");
  const artifacts = path.join(uploads, "reconstructions");
  await mkdir(artifacts, { recursive: true });
  const key = "e".repeat(32);
  const prefix = `/uploads/reconstructions/${key}`;
  const worldFile = path.join(artifacts, `${key}-world.json`);
  await sharp({
    create: { width: 128, height: 128, channels: 3, background: "#fa1414" },
  })
    .jpeg({ quality: 100 })
    .toFile(path.join(artifacts, `${key}-source.jpg`));
  await sharp({
    create: { width: 128, height: 128, channels: 3, background: "#141414" },
  })
    .jpeg({ quality: 100 })
    .toFile(path.join(artifacts, `${key}-background.jpg`));
  await sharp({
    create: { width: 128, height: 128, channels: 3, background: "#555555" },
  })
    .grayscale()
    .png()
    .toFile(path.join(artifacts, `${key}-depth.png`));
  const reconstruction: ReconstructionSpec = {
    version: 1,
    kind: "depth-mesh",
    sourceUrl: `${prefix}-source.jpg`,
    depthUrl: `${prefix}-depth.png`,
    width: 128,
    height: 128,
    depthSource: "depth-anything-v2",
    near: 2,
    far: 12,
    fov: 60,
  };
  const world: WorldCompletion = {
    version: 1,
    generatedBy: "local-segmentation",
    backgroundUrl: `${prefix}-background.jpg`,
    subjects: [],
    objectRecognition: {
      version: 1,
      status: "complete",
      source: "local-grounding-dino",
      modelVersion: "old-model",
      detected: 0,
    },
  };
  const subject = async (
    id: string,
    box: Box,
    classified = true,
  ): Promise<WorldCompletion["subjects"][number]> => {
    const filename = `${key}-${id}-local-mask.png`;
    const mask = polygonMask(128, 128, detection(box).polygon);
    await sharp(mask, { raw: { width: 128, height: 128, channels: 1 } })
      .png()
      .toFile(path.join(artifacts, filename));
    return {
      id,
      label: classified ? "old phone" : "foreground object",
      kind: "object",
      box,
      maskUrl: `/uploads/reconstructions/${filename}`,
      ...(classified
        ? {
            object: {
              category: "phone" as const,
              confidence: 0.9,
              color: "#fa1414",
              dimensions: [0.075, 0.15, 0.009] as [number, number, number],
            },
          }
        : {}),
    };
  };
  const upgrade = async (objects: ObjectDetection[]) => {
    await writeFile(worldFile, JSON.stringify(world));
    const completer = new WorldCompleter(uploads, {
      localSegmenter: false,
      poseEstimator: false,
      localObjectModelVersion: "new-model",
      localObjectRecognizer: async () => objects,
    });
    await completer.complete(reconstruction);
    return JSON.parse(await readFile(worldFile, "utf8")) as WorldCompletion;
  };
  const pixel = async (result: WorldCompletion, x: number, y: number) => {
    const pixels = await sharp(
      path.join(uploads, result.backgroundUrl.slice("/uploads/".length)),
    )
      .removeAlpha()
      .raw()
      .toBuffer();
    return Array.from(pixels.slice((y * 128 + x) * 3, (y * 128 + x) * 3 + 3));
  };
  return {
    uploads,
    reconstruction,
    readWorld: async () =>
      JSON.parse(await readFile(worldFile, "utf8")) as WorldCompletion,
    world,
    subject,
    upgrade,
    pixel,
    cleanup: async () => {
      const target = path.resolve(directory);
      assert.equal(path.dirname(target), path.resolve(os.tmpdir()));
      assert.match(path.basename(target), /^memoir-object-upgrade-/);
      await rm(target, { recursive: true, force: true });
    },
  };
}

test("a model revision restores the old object location before writing a shifted replacement mask", async () => {
  const f = await fixture();
  try {
    const previous = await f.subject("recognized-object-0", oldBox);
    f.world.subjects = [previous];
    const result = await f.upgrade([detection(shiftedBox)]);
    assert.equal(result.subjects.filter((s) => s.object).length, 1);
    assert.notEqual(
      result.subjects[0].maskUrl,
      previous.maskUrl,
      "An upgrade must not clobber the mask required for restoration.",
    );
    const restored = await f.pixel(result, 25, 25);
    assert.ok(
      restored[0] > 230 && restored[1] < 35 && restored[2] < 35,
      `The old location must recover original photo pixels, received ${restored}.`,
    );
  } finally {
    await f.cleanup();
  }
});

test("a new detector returning no objects retires old automatic descriptors attached to generic subject IDs", async () => {
  const f = await fixture();
  try {
    f.world.subjects = [await f.subject("subject-4", oldBox)];
    const result = await f.upgrade([]);
    assert.equal(result.subjects.filter((s) => s.object).length, 0);
    assert.equal(result.objectRecognition?.detected, 0);
    assert.equal(result.objectRecognition?.status, "complete");
    assert.ok(
      (await f.pixel(result, 25, 25))[0] > 230,
      "Retiring the old classification must recover its visible photograph.",
    );
  } finally {
    await f.cleanup();
  }
});

test("retiring an object held by a retained person does not paint that person back into the cleaned background", async () => {
  const f = await fixture();
  try {
    const person: WorldCompletion["subjects"][number] = {
      ...(await f.subject("retained-person", [0.05, 0.05, 0.4, 0.4], false)),
      kind: "person",
      label: "Reviewed person",
    };
    f.world.subjects = [person, await f.subject("recognized-object-0", oldBox)];
    const result = await f.upgrade([]);
    assert.deepEqual(
      result.subjects.find((s) => s.kind === "person"),
      person,
    );
    const background = await f.pixel(result, 25, 25);
    assert.ok(
      background.every((channel) => Math.abs(channel - 20) < 5),
      `A retained person should still cover this background region; received ${background}.`,
    );
  } finally {
    await f.cleanup();
  }
});

test("refining a generic object mask restores photographic detail outside the new contour", async () => {
  const f = await fixture();
  try {
    const generic = await f.subject("subject-7", [0.1, 0.1, 0.4, 0.4], false);
    f.world.subjects = [generic];
    const result = await f.upgrade([detection([0.1, 0.1, 0.3, 0.4])]);
    assert.equal(result.subjects.filter((s) => s.object).length, 1);
    assert.equal(result.subjects[0].id, generic.id);
    const restored = await f.pixel(result, 25, 45);
    assert.ok(
      restored[0] > 230 && restored[1] < 35 && restored[2] < 35,
      `The rejected part of the old broad mask should return to the photograph; received ${restored}.`,
    );
  } finally {
    await f.cleanup();
  }
});

test("a full crowded world prioritizes a confirmed prop over an unclassified volume without dropping people", async () => {
  const f = await fixture();
  try {
    const people: WorldCompletion["subjects"] = [];
    const generic: WorldCompletion["subjects"] = [];
    for (let i = 0; i < 12; i++) {
      people.push({
        ...(await f.subject(`person-${i}`, [0.4, 0.01, 0.5, 0.05], false)),
        kind: "person",
        label: `Reviewed person ${i}`,
      });
      const left = 0.02 + i * 0.025;
      generic.push(
        await f.subject(`generic-${i}`, [0.02, left, 0.1, left + 0.02], false),
      );
    }
    f.world.subjects = [...people, ...generic];
    const result = await f.upgrade([detection(shiftedBox)]);
    assert.equal(result.subjects.length, 24);
    assert.deepEqual(
      result.subjects.filter((subject) => subject.kind === "person"),
      people,
    );
    assert.equal(result.subjects.filter((subject) => subject.object).length, 1);
    assert.equal(
      result.subjects.filter(
        (subject) => subject.kind === "object" && !subject.object,
      ).length,
      11,
    );
    assert.equal(result.objectRecognition?.detected, 1);
  } finally {
    await f.cleanup();
  }
});

test("original photo bytes upgrade a prepared-image cache, preserve native texture resolution and honor EXIF orientation", async () => {
  const f = await fixture();
  let detectorCalls = 0;
  let cloudCalls = 0;
  try {
    const prepared = await f.upgrade([detection(oldBox)]);
    assert.equal(prepared.objectRecognition?.modelVersion, "new-model");
    assert.equal(prepared.objectSourceUrl, undefined);
    const rgb = Buffer.alloc(80 * 160 * 3);
    for (let y = 0; y < 160; y++) {
      for (let x = 0; x < 80; x++) {
        rgb.set(x < 40 ? [240, 20, 20] : [20, 20, 240], (y * 80 + x) * 3);
      }
    }
    const original = await sharp(rgb, {
      raw: { width: 80, height: 160, channels: 3 },
    })
      .withMetadata({ orientation: 6 })
      .jpeg({ quality: 100 })
      .toBuffer();
    const completer = new WorldCompleter(f.uploads, {
      localSegmenter: false,
      poseEstimator: false,
      localObjectModelVersion: "new-model",
      localObjectRecognizer: async (image) => {
        detectorCalls++;
        assert.deepEqual(
          image,
          original,
          "Native bytes must reach the detector without prepared-image resampling.",
        );
        // EXIF orientation 6 rotates the blue half to the bottom of the image.
        return [detection([0.6, 0.1, 0.8, 0.3])];
      },
      provider: {
        segment: async () => {
          cloudCalls++;
          throw new Error("Local upgrade must not segment through the cloud.");
        },
        objects: async () => {
          cloudCalls++;
          throw new Error("Local upgrade must not detect through the cloud.");
        },
        textures: async () => {
          cloudCalls++;
          throw new Error("Local upgrade must not generate a cloud image.");
        },
      },
    });
    await completer.complete(f.reconstruction, { originalImage: original });
    await completer.complete(f.reconstruction, { originalImage: original });
    const result = await f.readWorld();
    assert.equal(
      detectorCalls,
      1,
      "Native completion should reuse its own successful cache on reopen.",
    );
    assert.equal(cloudCalls, 0);
    assert.equal(result.objectRecognition?.modelVersion, "new-model-original-v2");
    assert.ok(result.objectSourceUrl);
    const texture = await sharp(
      path.join(f.uploads, result.objectSourceUrl.slice("/uploads/".length)),
    ).metadata();
    assert.equal(texture.format, "png");
    assert.equal(texture.width, 160);
    assert.equal(texture.height, 80);
    const color = result.subjects.find((subject) => subject.object)?.object
      ?.color;
    assert.ok(color);
    assert.ok(
      parseInt(color.slice(1, 3), 16) < 40 &&
        parseInt(color.slice(5, 7), 16) > 200,
      `Object color sampling must use the same EXIF orientation as detection and texture, received ${color}.`,
    );
  } finally {
    await f.cleanup();
  }
});
