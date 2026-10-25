import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import {
  buildPhotoEnvironment,
  environmentPanoramaUv,
  projectEnvironmentPoint,
} from "./photo-environment";
import type { VolumePixels } from "./volume";

function photograph(gray = false): VolumePixels {
  const width = 72,
    height = 48;
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const red = 20 + x,
        green = gray ? red : 10 + y,
        blue = gray ? red : 15;
      data.set([red, green, blue, 255], (y * width + x) * 4);
    }
  return { width, height, data };
}

test("source features project along the same camera ray across walls and floor", () => {
  const projection = {
    origin: [0, 1.6, 0] as [number, number, number],
    aspect: 1.5,
    fov: 60,
    horizon: 0.69,
  };
  const close = projectEnvironmentPoint([1, 2.1, -4], projection);
  const distant = projectEnvironmentPoint([3, 3.1, -12], projection);
  assert.ok(close.visible && distant.visible);
  close.uv.forEach((value, i) =>
    assert.ok(Math.abs(value - distant.uv[i]) < 1e-12),
  );
  assert.deepEqual(
    projectEnvironmentPoint([0, 1.6, -10], projection).uv,
    [0.5, 0.31000000000000005],
  );
  assert.equal(
    projectEnvironmentPoint([0, 1.6, 10], projection).visible,
    false,
  );
  assert.equal(
    projectEnvironmentPoint([12, 1.6, -2], projection).visible,
    false,
  );
});

test("the 360 image covers unseen directions without repeating a narrow photograph", () => {
  assert.deepEqual(environmentPanoramaUv([0, 0, -1]), [0.5, 0.5]);
  assert.deepEqual(environmentPanoramaUv([1, 0, 0]), [0.75, 0.5]);
  assert.deepEqual(environmentPanoramaUv([-1, 0, 0]), [0.25, 0.5]);
  assert.equal(environmentPanoramaUv([0, 1, 0])[1], 1);
  assert.equal(environmentPanoramaUv([0, -1, 0])[1], 0);
  assert.equal(environmentPanoramaUv([0, 0, 1])[0], 1);
});

test("high-resolution photo pixels and their original color space are retained", () => {
  const source = photograph();
  const result = buildPhotoEnvironment({
    source,
    environment: "outdoor",
    sceneEnvironment: "city",
  });
  const floor = result.group.getObjectByName(
    "Photographic ground with metre-scale detail",
  ) as THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  const photo = floor.material.uniforms.photograph.value as THREE.DataTexture;
  assert.equal(photo.image.width, source.width);
  assert.equal(photo.image.height, source.height);
  assert.deepEqual(photo.image.data, source.data);
  assert.equal(photo.colorSpace, THREE.SRGBColorSpace);
  assert.equal(photo.flipY, true);
  assert.equal(
    floor.geometry.parameters.width /
      floor.material.uniforms.repeatScale.value.x,
    2,
  );
  assert.equal(floor.material.uniforms.hasPanorama.value, 0);
  assert.ok(result.group.children.length < 30);
  result.dispose();
});

test("room walls retain full depth, ordinary dimensions, and a corridor around the people", () => {
  const result = buildPhotoEnvironment({
    source: photograph(true),
    environment: "indoor",
  });
  assert.equal(result.group.userData.environmentKind, "interior");
  const ceiling = result.group.getObjectByName(
    "Photographic ceiling",
  ) as THREE.Mesh<THREE.BoxGeometry>;
  assert.ok(ceiling.position.y < 4);
  assert.equal(ceiling.geometry.parameters.depth, 17.5);
  for (const wall of result.obstacles) {
    const intersectsPeople =
      wall.x + wall.radiusX > -4 &&
      wall.x - wall.radiusX < 4 &&
      wall.z + wall.radiusZ > -9 &&
      wall.z - wall.radiusZ < 2;
    assert.equal(intersectsPeople, false);
    assert.ok(wall.radiusX > 0 && wall.radiusZ > 0);
  }
  result.group.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    for (const value of object.geometry.getAttribute("position").array)
      assert.ok(Number.isFinite(value));
    const surface = object.material as THREE.ShaderMaterial | THREE.ShadowMaterial;
    const color = surface instanceof THREE.ShadowMaterial
      ? surface.color : surface.uniforms.fallbackColor.value as THREE.Color;
    assert.ok(
      Math.abs(color.r - color.g) < 1e-12 &&
        Math.abs(color.r - color.b) < 1e-12,
    );
  });
  result.dispose();
});

test("body shadows darken photographic ground without relighting it or being blocked by an inferred ceiling", () => {
  for (const environment of ["indoor", "outdoor"] as const) {
    const result = buildPhotoEnvironment({ source: photograph(), environment, sceneEnvironment: "street" });
    const receivers: THREE.Mesh[] = [];
    result.group.traverse(object => {
      if (object instanceof THREE.Mesh && object.userData.bodyShadowReceiver) receivers.push(object);
    });
    assert.equal(receivers.length, environment === "indoor" ? 1 : 3);
    const floor = result.group.getObjectByName("Photographic ground with metre-scale detail") as THREE.Mesh;
    const receiver = receivers[0];
    assert.equal(receiver.geometry, floor.geometry);
    assert.ok(receiver.position.y > floor.position.y && receiver.position.y < 0);
    for (const mesh of receivers) {
      const material = mesh.material as THREE.ShadowMaterial;
      assert.ok(material instanceof THREE.ShadowMaterial);
      assert.equal(mesh.receiveShadow, true);
      assert.equal(mesh.castShadow, false);
      assert.equal(material.transparent, true);
      assert.equal(material.depthWrite, false);
      assert.ok(material.opacity > 0 && material.opacity < 1);
    }
    const ceiling = result.group.getObjectByName("Photographic ceiling") as THREE.Mesh | undefined;
    if (ceiling) assert.equal(ceiling.castShadow, false);
    let geometryDisposals = 0, materialDisposals = 0;
    receiver.geometry.addEventListener("dispose", () => geometryDisposals++);
    (receiver.material as THREE.Material).addEventListener("dispose", () => materialDisposals++);
    result.dispose(); result.dispose();
    assert.equal(geometryDisposals, 1);
    assert.equal(materialDisposals, 1);
  }
});

test("disposing the scene does not dispose caller-owned photo or panorama textures", () => {
  const photo = new THREE.Texture();
  const panorama = new THREE.Texture();
  let photoDisposals = 0,
    panoramaDisposals = 0;
  photo.addEventListener("dispose", () => photoDisposals++);
  panorama.addEventListener("dispose", () => panoramaDisposals++);
  const result = buildPhotoEnvironment({
    source: photograph(),
    photoTexture: photo,
    panoramaTexture: panorama,
  });
  const sky = result.group.getObjectByName(
    "Continuous photographed and extrapolated panorama",
  ) as THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial>;
  assert.equal(sky.material.uniforms.panorama.value, panorama);
  assert.equal(sky.material.uniforms.hasPanorama.value, 1);
  result.dispose();
  result.dispose();
  assert.equal(photoDisposals, 0);
  assert.equal(panoramaDisposals, 0);
  assert.equal(result.group.children.length, 0);
});

test("a completed room does not reproject secondary crowd silhouettes onto walls", () => {
  const panorama = new THREE.Texture();
  const result = buildPhotoEnvironment({
    source: photograph(true),
    panoramaTexture: panorama,
    environment: "indoor",
  });
  result.group.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    if (object.material instanceof THREE.ShadowMaterial) return;
    const material = object.material as THREE.ShaderMaterial;
    assert.equal(material.uniforms.photoWeight.value, 0);
    if (material.uniforms.groundDetail.value === 1) {
      assert.equal(material.uniforms.hasPanorama.value, 0);
      assert.equal(material.uniforms.panoramaGroundTile.value, 1);
      const region = material.uniforms.panoramaGroundRegion
        .value as THREE.Vector4;
      assert.ok(
        region.y >= 0.05 && region.w <= 0.16,
        "sample clean floor near the panorama nadir",
      );
      assert.ok(
        region.z - region.x < 0.1,
        "use a small material patch instead of the entire room",
      );
    } else {
      assert.equal(material.uniforms.hasPanorama.value, 1);
      assert.equal(material.uniforms.panoramaGroundTile.value, 0);
    }
  });
  result.dispose();
});

test("street reconstruction avoids invented near branches and oversized foreground facades", () => {
  const result = buildPhotoEnvironment({
    source: photograph(),
    panoramaTexture: new THREE.Texture(),
    environment: "outdoor",
    sceneEnvironment: "street",
  });
  assert.equal(
    result.group.getObjectByName("Photographed tree branch"),
    undefined,
  );
  const facade = result.group.getObjectByName(
    "Original right storefront volume",
  ) as THREE.Mesh<THREE.BoxGeometry>;
  assert.ok(facade.position.z + facade.geometry.parameters.depth / 2 <= -12);
  const ground = result.group.getObjectByName(
    "Photographic ground with metre-scale detail",
  ) as THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  assert.ok(ground.material.uniforms.hasPanorama.value < 0.25);
  result.dispose();
});
