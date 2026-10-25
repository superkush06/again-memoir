import * as THREE from "three";
import type { Reconstruction } from "./volume-world";

type Navigation = Reconstruction["navigation"];

const PAPER_COLOR = new THREE.Color("#f5f3ef");
const RULE_COLOR = new THREE.Color("#62c9ed");

function paperTexture(size = 128) {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const offset = (y * size + x) * 4;
      const edge = Math.min(x, y, size - 1 - x, size - 1 - y);
      const feather = THREE.MathUtils.smoothstep(edge, 0, size * 0.16);
      const torn = ((x * 17 + y * 31 + ((x * y) % 19)) % 23) / 23;
      const ruled = y % 17 === 0 && edge > size * 0.12;
      const fiber = ((x * 11 + y * 7) % 9) - 4;
      const color = ruled ? RULE_COLOR : PAPER_COLOR;
      data[offset] = THREE.MathUtils.clamp(color.r * 255 + fiber, 0, 255);
      data[offset + 1] = THREE.MathUtils.clamp(color.g * 255 + fiber, 0, 255);
      data[offset + 2] = THREE.MathUtils.clamp(color.b * 255 + fiber, 0, 255);
      data[offset + 3] = Math.round(255 * feather * (0.9 + torn * 0.1));
    }
  }
  const texture = new THREE.DataTexture(
    data,
    size,
    size,
    THREE.RGBAFormat,
    THREE.UnsignedByteType,
  );
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.needsUpdate = true;
  return texture;
}

function panel(
  name: string,
  texture: THREE.Texture,
  width: number,
  height: number,
) {
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(width, height, 1, 1),
    new THREE.MeshBasicMaterial({
      color: "#f5f3ef",
      map: texture,
      alphaMap: texture,
      transparent: true,
      opacity: 0.28,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
      toneMapped: false,
    }),
  );
  mesh.name = name;
  mesh.renderOrder = -20;
  return mesh;
}

/**
 * World-locked paper framing for XR. Panels remain outside the reconstructed
 * bounds and leave the front and center open for people, props, and movement.
 */
export function buildPaperAtmosphere(navigation: Navigation) {
  const group = new THREE.Group();
  group.name = "translucent-paper-atmosphere";
  group.visible = false;
  group.userData = {
    kind: "paper-atmosphere",
    worldLocked: true,
    opacity: 0.28,
  };

  const texture = paperTexture();
  const { min, max } = navigation.bounds;
  const centerX = (min[0] + max[0]) / 2;
  const centerZ = (min[2] + max[2]) / 2;
  const width = THREE.MathUtils.clamp(max[0] - min[0], 7, 22);
  const depth = THREE.MathUtils.clamp(max[2] - min[2], 9, 30);
  const height = THREE.MathUtils.clamp(max[1] + 1.8, 5, 9);

  const left = panel("paper-left", texture, depth * 0.7, height);
  left.position.set(min[0] - 1.2, height * 0.52, centerZ);
  left.rotation.y = Math.PI / 2;

  const right = panel("paper-right", texture, depth * 0.7, height);
  right.position.set(max[0] + 1.2, height * 0.52, centerZ);
  right.rotation.y = -Math.PI / 2;

  const backWidth = Math.max(3, width * 0.43);
  const backLeft = panel("paper-back-left", texture, backWidth, height);
  backLeft.position.set(centerX - width * 0.28, height * 0.52, min[2] - 1.2);

  const backRight = panel("paper-back-right", texture, backWidth, height);
  backRight.position.set(centerX + width * 0.28, height * 0.52, min[2] - 1.2);

  const canopy = panel("paper-canopy", texture, width * 0.64, depth * 0.42);
  canopy.position.set(centerX, height + 0.8, centerZ - depth * 0.08);
  canopy.rotation.x = Math.PI / 2;

  group.add(left, right, backLeft, backRight, canopy);
  return group;
}
