import assert from "node:assert/strict";
import test from "node:test";
import { isWorldCompletion } from "../world-completion-validation";
import type { WorldCompletion } from "../types";

const completion: WorldCompletion = {
  version: 1,
  generatedBy: "gemini",
  textureSource: "source-inpaint",
  backgroundUrl: "/uploads/reconstructions/photo-background.jpg",
  subjects: [
    {
      id: "person-1",
      label: "person in blue",
      kind: "person",
      box: [0.1, 0.2, 0.9, 0.5],
      maskUrl: "/uploads/reconstructions/person-mask.png",
      thickness: 0.5,
    },
  ],
};

test("world completion accepts local source-aligned masks and optional inferred rear textures", () => {
  assert.ok(isWorldCompletion(completion));
  assert.ok(
    isWorldCompletion({
      ...completion,
      rearAtlasUrl: "/uploads/reconstructions/photo-rear.jpg",
    }),
  );
});

test("completion cannot fetch remote textures or traverse local media storage", () => {
  for (const backgroundUrl of [
    "https://example.com/photo.jpg",
    "/uploads/reconstructions/../private.jpg",
    "/uploads/reconstructions/photo.jpg?key=secret",
  ]) {
    assert.equal(isWorldCompletion({ ...completion, backgroundUrl }), false);
  }
  assert.equal(
    isWorldCompletion({
      ...completion,
      subjects: [
        { ...completion.subjects[0], rearUrl: "data:image/png;base64,AAAA" },
      ],
    }),
    false,
  );
});

test("completion bounds masks, instances and finite geometry before allocation", () => {
  assert.equal(
    isWorldCompletion({
      ...completion,
      subjects: Array(13).fill(completion.subjects[0]),
    }),
    false,
  );
  for (const overrides of [
    { box: [0, 1, 1, 0] },
    { box: [0, 0, Infinity, 1] },
    { thickness: Infinity },
    { thickness: -1 },
    { script: "arbitrary" },
  ]) {
    assert.equal(
      isWorldCompletion({
        ...completion,
        subjects: [{ ...completion.subjects[0], ...overrides }],
      }),
      false,
    );
  }
  assert.equal(
    isWorldCompletion({
      ...completion,
      subjects: [completion.subjects[0], completion.subjects[0]],
    }),
    false,
  );
});

const bodyViews = {
  bodyAtlasUrl: "/uploads/reconstructions/photo-person-1-body.jpg",
  bodyFrontBox: [0.02, 0.03, 0.98, 0.46],
  bodyBackBox: [0.02, 0.53, 0.98, 0.96],
};
const withSubject = (overrides: Record<string, unknown>) => ({
  ...completion,
  subjects: [{ ...completion.subjects[0], ...overrides }],
});

test("optional full-body views accept one local atlas with both bounded person crops", () => {
  assert.ok(isWorldCompletion(withSubject(bodyViews)));
  assert.ok(
    isWorldCompletion(completion),
    "existing completions need no generated body views",
  );
  assert.ok(
    isWorldCompletion(
      withSubject({
        ...bodyViews,
        bodyFrontBox: [0, 0, 1, 0.5],
        bodyBackBox: [0, 0.5, 1, 1],
      }),
    ),
  );
});

test("body views must be complete and restricted to people and local raster assets", () => {
  for (const field of ["bodyAtlasUrl", "bodyFrontBox", "bodyBackBox"]) {
    const incomplete = { ...bodyViews, [field]: undefined };
    assert.equal(
      isWorldCompletion(withSubject(incomplete)),
      false,
      `missing ${field}`,
    );
  }
  for (const bodyAtlasUrl of [
    "https://example.com/person.jpg",
    "/uploads/reconstructions/../person.jpg",
    "/uploads/reconstructions/person.jpg?token=secret",
    "data:image/png;base64,AAAA",
    "/uploads/reconstructions/person.svg",
    null,
  ])
    assert.equal(
      isWorldCompletion(withSubject({ ...bodyViews, bodyAtlasUrl })),
      false,
    );
  assert.equal(
    isWorldCompletion(withSubject({ ...bodyViews, kind: "object" })),
    false,
  );
});

test("body view crops reject nonfinite, reversed, empty or out-of-bounds coordinates", () => {
  for (const invalid of [
    [0, 0, Infinity, 1],
    [0, 0, NaN, 1],
    [-0.01, 0, 1, 1],
    [0, 0, 1, 1.01],
    [1, 0, 0, 1],
    [0, 0.5, 1, 0.5],
    [0, 0, 1],
    [0, "0", 1, 1],
    null,
  ]) {
    for (const field of ["bodyFrontBox", "bodyBackBox"])
      assert.equal(
        isWorldCompletion(withSubject({ ...bodyViews, [field]: invalid })),
        false,
      );
  }
});

test("reviewed neural bodies coexist with photographic fallback and reject untrusted model descriptors", () => {
  const neuralAsset = {
    url: "/uploads/reconstructions/photo-person-1-triposr.glb",
    model: "triposr",
    upAxis: "z",
    frontYaw: 0,
    appearance: "vertex-color",
    inputKind: "inferred-full-body",
  };
  assert.ok(isWorldCompletion(withSubject({ ...bodyViews, neuralAsset })));
  assert.equal(
    isWorldCompletion(
      withSubject({
        neuralAsset: { ...neuralAsset, url: "https://outside.test/model.glb" },
      }),
    ),
    false,
  );
  assert.equal(
    isWorldCompletion(withSubject({ kind: "object", neuralAsset })),
    false,
  );
  assert.equal(
    isWorldCompletion(
      withSubject({ neuralAsset: { ...neuralAsset, frontYaw: NaN } }),
    ),
    false,
  );
});
