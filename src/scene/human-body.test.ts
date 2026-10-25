import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { buildHumanBody, type HumanAppearance } from "./human-body";
import type { VolumePixels } from "./volume";

const pixels = (fn: (x: number, y: number) => number[]): VolumePixels => ({
  width: 64,
  height: 80,
  data: Array.from({ length: 64 * 80 }, (_, i) => fn(i % 64, Math.floor(i / 64))).flat(),
});
const source = pixels((x, y) => y < 24 ? [131, 87, 63, 255] : [215, 78 + x, 123, 255]);
const mask = pixels(() => [255, 255, 255, 255]);
const appearance: HumanAppearance = {
  shirtColor: "#d74e7b", pantsColor: "#292c31", skinColor: "#83573f",
  hairColor: "#211b18", shoeColor: "#323236", height: 1.76,
  faceBox: [0, 0.2, 0.3, 0.8], chestBox: [0.3, 0.2, 0.8, 0.8],
  sleeves: "short", yaw: 0,
};
const build = (override: Partial<HumanAppearance> = {}) => buildHumanBody({
  source, mask, box: [0, 0, 1, 1], label: "waist-cropped photograph",
  appearance: { ...appearance, ...override },
});

test("a cropped portrait produces a complete adult body with two grounded feet", () => {
  const human = build();
  assert.ok(Math.abs(human.bounds.min.y) < 0.00001);
  assert.ok(human.bounds.max.y > 1.70 && human.bounds.max.y < 1.80);
  for (const side of ["left", "right"]) {
    for (const part of ["upper-arm", "forearm", "hand", "thumb", "thigh", "knee", "calf", "shoe"]) {
      const mesh = human.group.getObjectByName(`${side}-${part}`) as THREE.Mesh;
      assert.ok(mesh?.isMesh, `${side} ${part} must exist even though it was not photographed`);
      const size = new THREE.Box3().setFromObject(mesh).getSize(new THREE.Vector3());
      assert.ok(size.x > 0 && size.y > 0 && size.z > 0.01, `${part} must enclose depth`);
    }
    const foot = new THREE.Box3().setFromObject(human.group.getObjectByName(`${side}-sole`)!);
    assert.ok(Math.abs(foot.min.y) < 0.00001);
  }
  const left = new THREE.Box3().setFromObject(human.group.getObjectByName("left-shoe")!);
  const right = new THREE.Box3().setFromObject(human.group.getObjectByName("right-shoe")!);
  assert.ok(left.max.x < right.min.x, "the feet remain separate, with a walkable gap between the legs");
  human.dispose();
});

test("torso has independently visible front and rear surfaces and finite smooth normals", () => {
  const human = build();
  const torso = human.group.getObjectByName("shirt-torso") as THREE.Mesh;
  for (const z of [-2, 2]) {
    const ray = new THREE.Raycaster(new THREE.Vector3(0, 1.22, z), new THREE.Vector3(0, 0, -Math.sign(z)));
    assert.ok(ray.intersectObject(torso).length > 0, `the ${z > 0 ? "front" : "back"} must be solid`);
  }
  human.group.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    for (const name of ["position", "normal"]) {
      const attribute = object.geometry.getAttribute(name);
      assert.ok(Array.from(attribute.array).every(Number.isFinite), `${object.name} ${name} contains only finite values`);
    }
  });
  human.dispose();
});

test("original shirt RGB remains in the front albedo and sampled color wraps the back", () => {
  const human = build();
  const material = (human.group.getObjectByName("shirt-torso") as THREE.Mesh).material as THREE.MeshStandardMaterial;
  const map = material.map! as THREE.DataTexture;
  assert.equal(map.colorSpace, THREE.SRGBColorSpace);
  const { data, width, height } = map.image;
  const front = ((Math.floor(height / 2) * width) + Math.floor(width / 2)) * 4;
  assert.equal(data[front], 215);
  assert.equal(data[front + 2], 123);
  const back = (Math.floor(height / 2) * width) * 4;
  assert.deepEqual(Array.from(data.slice(back, back + 3)), [215, 78, 123]);
  human.dispose();
});

test("a source back view projects onto the back without becoming a flattened body", () => {
  const human = build({ sourceView: "back", yaw: Math.PI, headYaw: 0.4 });
  const material = (human.group.getObjectByName("shirt-torso") as THREE.Mesh).material as THREE.MeshStandardMaterial;
  const { data, width, height } = (material.map as THREE.DataTexture).image;
  const sourceBack = (Math.floor(height / 2) * width) * 4;
  assert.ok(data[sourceBack + 1] > 100, "source shirt variation is visible on the local back");
  const inferredFront = (Math.floor(height / 2) * width + Math.floor(width / 2)) * 4;
  assert.equal(data[inferredFront + 1], 78);
  const observedNormal = new THREE.Vector3(0, 0, 1).applyQuaternion(
    human.group.getObjectByName("head")!.getWorldQuaternion(new THREE.Quaternion()));
  assert.ok(observedNormal.z > 0.999, "the photographed head view still faces the reference camera");
  assert.ok(human.bounds.max.z - human.bounds.min.z > 0.25);
  assert.ok(Math.abs(human.bounds.min.y) < 0.00001);
  human.dispose();
});

test("heads remain solid from every side even when rear skin matches a grayscale wall", () => {
  const human = build({ skinColor: "#535353", hairColor: "#212121", headYaw: 0.45 });
  const head = human.group.getObjectByName("head") as THREE.Mesh;
  for (const [x, z] of [[0, 2], [0, -2], [2, 0], [-2, 0]]) {
    const ray = new THREE.Raycaster(new THREE.Vector3(x, 1.6, z), new THREE.Vector3(-x, 0, -z).normalize());
    assert.ok(ray.intersectObject(head).length > 0, `head must remain visible from x=${x}, z=${z}`);
  }
  const { data, width, height } = ((head.material as THREE.MeshStandardMaterial).map as THREE.DataTexture).image;
  const back = (Math.floor(height / 2) * width) * 4;
  assert.equal(data[back], data[back + 1], "the inferred rear retains the photograph's monochrome palette");
  assert.equal(data[back + 1], data[back + 2]);
  assert.equal(data[back + 3], 255, "the rear remains fully opaque");
  human.dispose();
});

test("a profile photograph retains its face and hair without a generic overlay or a second head turn", () => {
  const human = build({ headYaw: 0.78 });
  const head = human.group.getObjectByName("head") as THREE.Mesh;
  const material = head.material as THREE.MeshStandardMaterial;
  const { data, width, height } = (material.map as THREE.DataTexture).image;
  const face = (Math.floor(height * 0.4) * width + Math.floor(width / 2)) * 4;
  assert.deepEqual(Array.from(data.slice(face, face + 3)), [131, 87, 63]);
  assert.equal(material.emissiveMap, material.map, "photo illumination is preserved in the albedo");
  assert.ok(material.emissiveIntensity > 0.8);
  for (const overlay of ["hair", "nose-bridge", "nose-tip", "face-mouth", "left-ear", "right-ear"])
    assert.equal(human.group.getObjectByName(overlay), undefined, `${overlay} must not obscure photographed details`);
  const direction = new THREE.Vector3(0, 0, 1).applyQuaternion(head.getWorldQuaternion(new THREE.Quaternion()));
  assert.ok(direction.z > 0.999, "the already-turned source face remains visible from the original camera");
  human.dispose();
});

test("head silhouette follows the source mask while enclosing a rounded skull", () => {
  const asymmetricalMask = pixels((x, y) => {
    const left = y < 12 ? 19 : 27;
    const right = y < 12 ? 48 : 50;
    return x >= left && x <= right ? [255, 255, 255, 255] : [0, 0, 0, 255];
  });
  const human = buildHumanBody({ source, mask: asymmetricalMask, box: [0, 0, 1, 1],
    label: "observed profile", appearance });
  const geometry = (human.group.getObjectByName("head") as THREE.Mesh).geometry;
  const pos = geometry.getAttribute("position");
  let left = Infinity, right = -Infinity, front = -Infinity, rear = Infinity;
  for (let i = 0; i < pos.count; i++) {
    left = Math.min(left, pos.getX(i)); right = Math.max(right, pos.getX(i));
    front = Math.max(front, pos.getZ(i)); rear = Math.min(rear, pos.getZ(i));
  }
  assert.ok(right + left > 0.01, "the actual asymmetric profile controls its horizontal outline");
  assert.ok(front - rear > 0.16, "the head is a full rounded volume rather than an extruded card");
  human.dispose();
});

test("photographic turnaround textures cover inferred legs on both sides while source identity wins", () => {
  const front = pixels(() => [41, 77, 123, 255]);
  const back = pixels(() => [88, 55, 33, 255]);
  const human = buildHumanBody({ source, mask, box: [0, 0, 1, 1], label: "completed clothing",
    appearance, photographicBody: { front, back } });
  const thigh = human.group.getObjectByName("left-thigh") as THREE.Mesh;
  const thighMap = (thigh.material as THREE.MeshStandardMaterial).map as THREE.DataTexture;
  const { data, width, height } = thighMap.image;
  // The limb's local UV seam is rolled relative to the world camera. Look for
  // both observed colors around the actual ring, not two arbitrary seam texels.
  const ring = Array.from({ length: width }, (_, x) => {
    const offset = (Math.floor(height / 2) * width + x) * 4;
    return Array.from(data.slice(offset, offset + 3)).join();
  });
  assert.ok(ring.includes("41,77,123"), "camera-facing leg retains the inferred front RGB");
  assert.ok(ring.includes("88,55,33"), "rear-facing leg retains the inferred back RGB");
  const head = human.group.getObjectByName("head") as THREE.Mesh;
  const photo = ((head.material as THREE.MeshStandardMaterial).map as THREE.DataTexture).image;
  const observed = (Math.floor(photo.height * 0.4) * photo.width + Math.floor(photo.width / 2)) * 4;
  assert.deepEqual(Array.from(photo.data.slice(observed, observed + 3)), [131, 87, 63],
    "a generated turnaround must never replace the source person's visible face");
  human.dispose();
});

test("bare arms inside a person mask cannot become orange stripes on a black shirt", () => {
  const photograph = pixels((x) => x > 37 ? [232, 154, 89, 255]
    : x >= 30 && x <= 33 ? [249, 249, 249, 255] : [22, 19, 18, 255]);
  const human = buildHumanBody({ source: photograph, mask, box: [0, 0, 1, 1], label: "shirt beside bare arms",
    appearance: { ...appearance, skinColor: "#e89a59", shirtColor: "#161312", torsoBox: [.3, .2, .8, .8] } });
  const torso = human.group.getObjectByName("shirt-torso") as THREE.Mesh;
  const { data, width, height } = ((torso.material as THREE.MeshStandardMaterial).map as THREE.DataTexture).image;
  const stripe = (Math.floor(height * .4) * width + Math.floor(width * .62)) * 4;
  assert.deepEqual(Array.from(data.slice(stripe, stripe + 3)), [22, 19, 18]);
  const graphic = (Math.floor(height * .4) * width + Math.floor(width * .5)) * 4;
  assert.deepEqual(Array.from(data.slice(graphic, graphic + 3)), [249, 249, 249],
    "high-contrast printed fabric must remain visible");
  human.dispose();
});
