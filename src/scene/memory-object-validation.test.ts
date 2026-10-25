import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyMemoryObject,
  isMemoryObjectSpec,
  MEMORY_OBJECT_CATEGORIES,
} from "../memory-objects";

test("supported object labels resolve without treating arbitrary blobs as objects", () => {
  const labels = [
    "open laptop",
    "desktop computer",
    "cell phone",
    "red soda can",
    "bag of chips",
    "water bottle",
    "cardboard box",
    "black backpack",
  ];
  labels.forEach((label, index) =>
    assert.equal(classifyMemoryObject(label), MEMORY_OBJECT_CATEGORIES[index]),
  );
  assert.equal(classifyMemoryObject("Depth-isolated foreground"), undefined);
  assert.equal(classifyMemoryObject("can see a person"), undefined);
});

test("only bounded finite category geometry and source colors enter the renderer", () => {
  const phone = {
    category: "phone",
    confidence: 0.8,
    color: "#203040",
    dimensions: [0.075, 0.15, 0.009],
  };
  assert.ok(isMemoryObjectSpec(phone));
  for (const change of [
    { dimensions: [0, 1, 1] },
    { dimensions: [1, 2, Infinity] },
    { category: "human" },
    { confidence: -1 },
    { color: "url(http://example.com)" },
    { rotation: [0, 0, 100] },
    { script: "bad" },
  ])
    assert.equal(isMemoryObjectSpec({ ...phone, ...change }), false);
});
