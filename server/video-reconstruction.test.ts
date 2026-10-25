import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import type { Memory, ReconstructionSpec } from "../src/types.js";
import { isReconstructionSpec } from "../src/reconstruction-validation.js";
import { SceneReconstructor } from "./reconstruction.js";
import {
  completeVideoReconstruction,
  videoSampleTimes,
  videoStreamDuration,
  type VideoSampler,
} from "./video-reconstruction.js";

const video: Memory = {
  id: "video-test",
  title: "A moving memory",
  description: "",
  date: "",
  location: "",
  tags: [],
  source: "upload",
  mediaType: "video",
  url: "/uploads/clip.mp4",
  thumbnailUrl: "",
};
const still: ReconstructionSpec = {
  version: 1,
  kind: "depth-mesh",
  sourceUrl: "/uploads/reconstructions/abc-source.jpg",
  depthUrl: "/uploads/reconstructions/abc-depth.png",
  width: 512,
  height: 384,
  depthSource: "depth-anything-v2",
  near: 2,
  far: 12,
  fov: 60,
};

test("video samples span the entire clip and bound work even for long recordings", () => {
  assert.equal(
    videoStreamDuration({
      streams: [{ duration: "21.86" }],
      format: { duration: "21.96" },
    }),
    21.86,
  );
  assert.equal(
    videoStreamDuration({
      streams: [{ duration: "N/A" }],
      format: { duration: "8" },
    }),
    8,
  );
  for (const duration of [0.05, 1, 20, 3600]) {
    const times = videoSampleTimes(duration);
    assert.ok(times.length >= 2 && times.length <= 8);
    assert.equal(times[0], 0);
    assert.ok(times.at(-1)! >= duration * 0.9 && times.at(-1)! < duration);
    assert.ok(times.every((time, i) => !i || time > times[i - 1]));
  }
  for (const duration of [0, -1, Infinity, NaN, 3601])
    assert.throws(() => videoSampleTimes(duration));
});

test("video reconstruction caches all frame artifacts and hashes the video beyond its opening frame", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "memoir-video-"));
  const uploads = path.join(directory, "uploads");
  await mkdir(uploads);
  let inferenceCalls = 0,
    samples = 0;
  const sampler: VideoSampler = {
    duration: async () => 5,
    frame: async (_file, time) => {
      samples++;
      return sharp({
        create: {
          width: 640,
          height: 400,
          channels: 3,
          background: time ? "#225588" : "#dd8833",
        },
      })
        .jpeg()
        .toBuffer();
    },
  };
  const reconstructor = new SceneReconstructor(uploads, {
    videoSampler: sampler,
    estimator: async (input) => {
      inferenceCalls++;
      assert.equal(input.width, 512);
      assert.equal(input.height, 320);
      return {
        data: Uint8Array.of(0, 64, 128, 255),
        width: 2,
        height: 2,
        channels: 1,
      };
    },
  });
  try {
    await writeFile(
      path.join(uploads, "clip.mp4"),
      "same first frame; motion A",
    );
    const first = await reconstructor.reconstruct(video);
    assert.equal(first.mediaBasis, "video-sequence");
    assert.equal(first.video?.frames.length, 4);
    assert.equal(inferenceCalls, 4);
    assert.ok(isReconstructionSpec(first));
    assert.deepEqual(await reconstructor.reconstruct(video), first);
    assert.equal(inferenceCalls, 4);
    assert.equal(samples, 4);
    for (const frame of first.video!.frames) {
      assert.ok(
        (
          await readFile(
            path.join(uploads, frame.sourceUrl.slice("/uploads/".length)),
          )
        ).length,
      );
      assert.ok(
        (
          await readFile(
            path.join(uploads, frame.depthUrl.slice("/uploads/".length)),
          )
        ).length,
      );
    }
    await writeFile(
      path.join(uploads, "clip.mp4"),
      "same first frame; motion B",
    );
    const changed = await reconstructor.reconstruct(video);
    assert.notEqual(changed.sourceUrl, first.sourceUrl);
    assert.equal(inferenceCalls, 8);
    // Missing later geometry invalidates a manifest, rather than silently freezing playback.
    await rm(
      path.join(
        uploads,
        changed.video!.frames[2].depthUrl.slice("/uploads/".length),
      ),
    );
    await reconstructor.reconstruct(video);
    assert.equal(inferenceCalls, 12);
    const metadata = (await readdir(reconstructor.artifactDir)).find((name) =>
      name.endsWith(".json"),
    )!;
    const saved = JSON.parse(
      await readFile(path.join(reconstructor.artifactDir, metadata), "utf8"),
    );
    saved.reconstruction.video.frames[1].time = -1;
    await writeFile(
      path.join(reconstructor.artifactDir, metadata),
      JSON.stringify(saved),
    );
    await reconstructor.reconstruct(video);
    assert.equal(inferenceCalls, 16);
    for (const url of [
      "/uploads/../clip.mp4",
      "/uploads/nested/clip.mp4",
      "https://example.com/clip.mp4",
    ])
      await assert.rejects(
        reconstructor.reconstruct({ ...video, url }),
        /Upload or archive/,
      );
  } finally {
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.match(path.basename(resolved), /^memoir-video-/);
    await rm(resolved, { recursive: true, force: true });
  }
});

test("video manifests reject unsafe paths, inconsistent origins, timestamps and unbounded frames", () => {
  const manifest: ReconstructionSpec = {
    ...still,
    mediaBasis: "video-sequence",
    video: {
      version: 1,
      duration: 5,
      frames: [
        { time: 0, sourceUrl: still.sourceUrl, depthUrl: still.depthUrl },
        {
          time: 4.9,
          sourceUrl: "/uploads/second.jpg",
          depthUrl: "/uploads/second.png",
        },
      ],
    },
  };
  assert.ok(isReconstructionSpec(manifest));
  for (const mutate of [
    (x: typeof manifest) => {
      x.video!.frames[1].sourceUrl = "https://evil.test/frame.jpg";
    },
    (x: typeof manifest) => {
      x.video!.frames[1].depthUrl = "/uploads/../secret.png";
    },
    (x: typeof manifest) => {
      x.video!.frames[1].time = 0;
    },
    (x: typeof manifest) => {
      x.video!.frames[1].time = 6;
    },
    (x: typeof manifest) => {
      x.video!.frames[0].sourceUrl = "/uploads/wrong.jpg";
    },
    (x: typeof manifest) => {
      x.video!.frames = Array(9).fill(x.video!.frames[0]);
    },
    (x: typeof manifest) => {
      x.mediaBasis = "image";
    },
  ]) {
    const copy = structuredClone(manifest);
    mutate(copy);
    assert.equal(isReconstructionSpec(copy), false);
  }
  assert.equal(
    isReconstructionSpec({ ...still, mediaBasis: "video-sequence" }),
    false,
  );
});

test("completion recognizes every video keyframe serially while preserving timing and source assets", async () => {
  const input: ReconstructionSpec = {
    ...still,
    mediaBasis: "video-sequence",
    video: {
      version: 1,
      duration: 3,
      frames: [
        { time: 0, sourceUrl: still.sourceUrl, depthUrl: still.depthUrl },
        {
          time: 2.9,
          sourceUrl: "/uploads/reconstructions/def-source.jpg",
          depthUrl: "/uploads/reconstructions/def-depth.png",
        },
      ],
    },
  };
  let active = 0,
    calls = 0;
  const output = await completeVideoReconstruction(input, async (frame) => {
    assert.equal(++active, 1);
    assert.equal(frame.mediaBasis, "video-frame");
    assert.equal(frame.video, undefined);
    calls++;
    await new Promise((resolve) => setTimeout(resolve, 5));
    active--;
    return {
      ...frame,
      completionUrl: frame.sourceUrl.replace("-source.jpg", "-world.json"),
    };
  });
  assert.equal(calls, 2);
  assert.equal(output.completionUrl, "/uploads/reconstructions/abc-world.json");
  assert.deepEqual(
    output.video?.frames.map((frame) => frame.time),
    [0, 2.9],
  );
  assert.equal(
    output.video?.frames[1].completionUrl,
    "/uploads/reconstructions/def-world.json",
  );
});
