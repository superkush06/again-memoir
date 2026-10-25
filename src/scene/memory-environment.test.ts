import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import {
  buildMemoryEnvironment,
  extractEnvironmentPalette,
} from "./memory-environment";
import type { VolumePixels } from "./volume";

function photo(
  pixel: (x: number, y: number) => [number, number, number],
): VolumePixels {
  const width = 32,
    height = 32;
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      data.set([...pixel(x, y), 255], (y * width + x) * 4);
  return { width, height, data };
}

test("source color survives material generation and a colored shirt does not tint the ground", () => {
  const source = photo((x, y) =>
    x > 7 && x < 25 && y > 12 ? [230, 30, 160] : [100, 112, 120],
  );
  const palette = extractEnvironmentPalette(source);
  assert.equal(palette.monochrome, false);
  assert.ok(palette.ground[2] > palette.ground[0]);
  assert.ok(palette.ground[0] < 120);
  assert.ok(palette.ground[1] > 95);
});

test("monochrome memories retain neutral materials, including the sky and generated textures", () => {
  const result = buildMemoryEnvironment({
    source: photo((x, y) => {
      const v = 40 + x * 3 + y;
      return [v, v, v];
    }),
    environment: "outdoor",
  });
  const palette = result.group.userData.materialPalette;
  for (const key of ["ground", "masonry", "trim", "foliage", "sky", "light"])
    assert.deepEqual(palette[key], [
      palette[key][0],
      palette[key][0],
      palette[key][0],
    ]);
  result.group.traverse((object) => {
    if (!(object instanceof THREE.Mesh) || Array.isArray(object.material))
      return;
    const surface = object.material as THREE.MeshStandardMaterial;
    if (surface.color) {
      assert.ok(Math.abs(surface.color.r - surface.color.g) < 1e-9);
      assert.ok(Math.abs(surface.color.r - surface.color.b) < 1e-9);
    }
    if (surface.map instanceof THREE.DataTexture) {
      const data = surface.map.image.data;
      for (let i = 0; i < data.length; i += 4)
        assert.ok(data[i] === data[i + 1] && data[i + 1] === data[i + 2]);
    }
  });
  result.dispose();
});

test("pavement repeats at metre scale and no source photograph is projected onto scenery", () => {
  const result = buildMemoryEnvironment({
    source: photo(() => [92, 100, 104]),
    environment: "outdoor",
    sceneEnvironment: "city",
  });
  const ground = result.group.getObjectByName("street-ground") as THREE.Mesh<
    THREE.PlaneGeometry,
    THREE.MeshStandardMaterial
  >;
  assert.equal(ground.position.y, 0);
  assert.ok(ground.material.map instanceof THREE.DataTexture);
  assert.equal(
    ground.geometry.parameters.width / ground.material.map.repeat.x,
    1,
  );
  assert.equal(
    ground.geometry.parameters.height / ground.material.map.repeat.y,
    1,
  );
  assert.ok(
    result.group.children.length < 40,
    "repeated architecture should be batched for VR",
  );
  result.group.traverse((object) => {
    if (!(object instanceof THREE.Mesh) || Array.isArray(object.material))
      return;
    const surface = object.material as THREE.MeshStandardMaterial;
    assert.ok(!surface.map || surface.map instanceof THREE.DataTexture);
  });
  result.dispose();
});

test("architectural objects leave the people and rear-inspection corridor open", () => {
  for (const environment of ["indoor", "outdoor"] as const) {
    const result = buildMemoryEnvironment({
      source: photo(() => [120, 110, 100]),
      environment,
    });
    for (const child of result.group.children) {
      if (!(child instanceof THREE.Mesh)) continue;
      const features: Array<{
        name: string;
        position: number[];
        scale: number[];
      }> = child.userData.features ?? [
        {
          name: child.name,
          position: child.position.toArray(),
          scale: child.scale.toArray(),
        },
      ];
      for (const feature of features) {
        if (!/column|building|bench|lamp-pole|wall|curb/.test(feature.name))
          continue;
        const [x, , z] = feature.position;
        const [width, , depth] = feature.scale;
        const overlapsX = x + width / 2 > -4 && x - width / 2 < 4;
        const overlapsZ = z + depth / 2 > -9 && z - depth / 2 < 2;
        assert.ok(
          !(overlapsX && overlapsZ),
          `${feature.name} blocks the people zone`,
        );
      }
    }
    result.dispose();
    assert.equal(result.group.children.length, 0);
    result.dispose();
  }
});

test("combined memory captions and scene hints select the matching surroundings", () => {
  for (const [hint, expected] of [
    ["gallery nighttime street photo city night", "street"],
    [
      "forest nighttime street photo with foliage and illuminated storefronts city night",
      "street",
    ],
    ["gallery indoor black white", "interior"],
    ["outdoor forest woodland hiking", "landscape"],
    ["outdoor alpine mountain trip", "landscape"],
  ]) {
    const result = buildMemoryEnvironment({
      source: photo(() => [92, 102, 99]),
      sceneEnvironment: hint,
    });
    assert.equal(result.group.userData.environmentKind, expected);
    result.dispose();
  }
});

test("dark source colors remain recognizable and readable as inferred material reflectance", () => {
  const result = buildMemoryEnvironment({
    source: photo(() => [30, 24, 18]),
    sceneEnvironment: "city night",
  });
  const { sourcePalette, materialPalette } = result.group.userData;
  for (const key of ["ground", "masonry", "trim", "foliage", "light"]) {
    const observed = sourcePalette[key],
      surface = materialPalette[key];
    assert.ok(surface[0] >= observed[0]);
    assert.ok(
      Math.abs(surface[0] / surface[1] - observed[0] / observed[1]) < 1e-9,
    );
    assert.ok(
      Math.abs(surface[1] / surface[2] - observed[1] / observed[2]) < 1e-9,
    );
  }
  assert.deepEqual(
    materialPalette.sky,
    sourcePalette.sky,
    "the original nighttime sky stays dark",
  );
  result.dispose();
});

test("solid architecture supplies matching box collision bounds without blocking the people zone", () => {
  for (const environment of ["indoor", "outdoor"] as const) {
    const result = buildMemoryEnvironment({
      source: photo(() => [92, 102, 99]),
      environment,
    });
    assert.equal(
      result.obstacles.length,
      10,
      "include all buildings or all enclosing walls and structural columns",
    );
    for (const obstacle of result.obstacles) {
      assert.equal(obstacle.kind, "box");
      assert.ok(obstacle.radiusX > 0 && obstacle.radiusZ > 0);
      assert.ok(Math.abs(obstacle.minY) < 1e-12);
      assert.ok(obstacle.maxY > 2);
      const overlapsPeopleX =
        obstacle.x + obstacle.radiusX > -4 && obstacle.x - obstacle.radiusX < 4;
      const overlapsPeopleZ =
        obstacle.z + obstacle.radiusZ > -9 && obstacle.z - obstacle.radiusZ < 2;
      assert.equal(overlapsPeopleX && overlapsPeopleZ, false);
    }
    if (environment === "outdoor") {
      const building = result.obstacles.find((obstacle) => obstacle.x > 0)!;
      assert.equal(
        building.x - building.radiusX,
        9.4,
        "collision reaches the actual building facade",
      );
    }
    result.dispose();
  }
});
