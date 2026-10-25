import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createBackend } from "./app";
import type { ReconstructionSpec } from "../src/types";

test("opening a scene returns depth immediately and background enrichment reuses cached geometry", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "memoir-pose-cache-"));
  let depths = 0, completions = 0;
  const geometry: ReconstructionSpec = { version: 1, kind: "depth-mesh", sourceUrl: "/uploads/photo.jpg", depthUrl: "/uploads/depth.png", width: 640, height: 480, depthSource: "depth-anything-v2", near: 2, far: 12, fov: 60 };
  const backend = await createBackend({ dataDir: directory, env: {}, reconstruction: { reconstruct: async () => { depths++; return geometry; } },
    worldCompletion: { complete: async input => { completions++; return { ...input, completionUrl: `/uploads/reconstructions/pose-${completions}-world.json` }; } },
  });
  await new Promise<void>(resolve => backend.server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (backend.server.address() as { port: number }).port;
    const load = async () => {
      const response = await fetch(`http://127.0.0.1:${port}/api/memories/demo-coast/scene`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      assert.equal(response.status, 200);
      return response.json();
    };
    const first = await load(), second = await load();
    assert.equal(depths, 1);
    assert.equal(completions, 1);
    assert.equal(second.reconstruction.completionUrl, "/uploads/reconstructions/pose-1-world.json");
    assert.equal(first.description, second.description);
  } finally {
    await new Promise<void>((resolve, reject) => backend.server.close(error => error ? reject(error) : resolve()));
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith("memoir-pose-cache-"));
    await rm(resolved, { recursive: true, force: true });
  }
});
