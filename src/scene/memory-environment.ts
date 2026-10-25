import * as THREE from "three";
import type { VolumePixels } from "./volume";

type RGB = [number, number, number];
export interface EnvironmentPalette {
  ground: RGB;
  masonry: RGB;
  trim: RGB;
  foliage: RGB;
  sky: RGB;
  light: RGB;
  monochrome: boolean;
  night: boolean;
}

export interface EnvironmentObstacle {
  kind: "box";
  x: number;
  z: number;
  radiusX: number;
  radiusZ: number;
  minY: number;
  maxY: number;
}

const luminance = (c: RGB) => c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722;
const saturation = (c: RGB) => Math.max(...c) - Math.min(...c);
const multiply = (c: RGB, factor: number): RGB =>
  c.map((v) => Math.max(0, Math.min(255, v * factor))) as RGB;
const blend = (a: RGB, b: RGB, t: number): RGB =>
  a.map((v, i) => v * (1 - t) + b[i] * t) as RGB;
const color = (c: RGB) =>
  new THREE.Color().setRGB(
    c[0] / 255,
    c[1] / 255,
    c[2] / 255,
    THREE.SRGBColorSpace,
  );

/** Background colors come from the photograph's perimeter, so a foreground
 * person's bright shirt does not tint every building or pavement slab. */
export function extractEnvironmentPalette(
  source: VolumePixels,
): EnvironmentPalette {
  if (
    source.width < 1 ||
    source.height < 1 ||
    source.data.length < source.width * source.height * 4
  )
    throw new Error("Environment colors require a complete RGBA photograph.");
  const perimeter: RGB[] = [];
  const upper: RGB[] = [];
  const lower: RGB[] = [];
  const green: RGB[] = [];
  let chroma = 0;
  let sampleCount = 0;
  const stride = Math.max(
    1,
    Math.floor(Math.min(source.width, source.height) / 64),
  );
  for (let y = 0; y < source.height; y += stride) {
    for (let x = 0; x < source.width; x += stride) {
      const i = (y * source.width + x) * 4;
      if (Number(source.data[i + 3]) < 128) continue;
      const c: RGB = [
        Number(source.data[i]),
        Number(source.data[i + 1]),
        Number(source.data[i + 2]),
      ];
      chroma += saturation(c);
      sampleCount++;
      if (y < source.height * 0.28) upper.push(c);
      if (
        x < source.width * 0.2 ||
        x > source.width * 0.82 ||
        y < source.height * 0.35
      ) {
        perimeter.push(c);
        if (y > source.height * 0.65) lower.push(c);
        if (c[1] > c[0] * 1.06 && c[1] > c[2] * 1.08) green.push(c);
      }
    }
  }
  const mean = (samples: RGB[], fallback: RGB): RGB =>
    samples.length
      ? samples.reduce<RGB>(
          (out, c) => out.map((v, i) => v + c[i] / samples.length) as RGB,
          [0, 0, 0],
        )
      : fallback;
  const neutral = perimeter.filter(
    (c) => saturation(c) < 35 && luminance(c) > 12,
  );
  const sorted = (neutral.length > 8 ? neutral : perimeter).sort(
    (a, b) => luminance(a) - luminance(b),
  );
  const quantile = (fraction: number, fallback: RGB): RGB =>
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ??
    fallback;
  const sky = mean(upper, [100, 100, 100]);
  const monochrome = sampleCount === 0 || chroma / sampleCount < 4;
  const neutralLower = lower.filter((c) => saturation(c) < 40);
  const ground = blend(
    mean(neutralLower, quantile(0.38, [90, 90, 90])),
    quantile(0.38, [90, 90, 90]),
    0.55,
  );
  const palette: EnvironmentPalette = {
    ground,
    masonry: quantile(0.76, [145, 145, 145]),
    trim: quantile(0.2, [45, 45, 45]),
    foliage: mean(green, multiply(ground, 0.75)),
    sky,
    light: quantile(0.96, [220, 220, 220]),
    monochrome,
    night: luminance(sky) < 62,
  };
  if (monochrome) {
    for (const key of [
      "ground",
      "masonry",
      "trim",
      "foliage",
      "sky",
      "light",
    ] as const) {
      const value = luminance(palette[key]);
      palette[key] = [value, value, value];
    }
  }
  return palette;
}

/** A repeat represents one real-world metre. Fine noise and joints supply
 * material detail without smearing the photograph over unrelated geometry. */
function surfaceTexture(
  base: RGB,
  kind: "stone" | "asphalt" | "plaster" | "timber",
): THREE.DataTexture {
  const size = 128;
  const data = new Uint8Array(size * size * 4);
  let seed = 16453;
  const random = () =>
    (seed = (1664525 * seed + 1013904223) >>> 0) / 0xffffffff;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      let value = 1 + (random() - 0.5) * (kind === "asphalt" ? 0.24 : 0.09);
      if (kind === "stone" && (x < 1 || y < 1)) value *= 0.66;
      if (kind === "timber")
        value *= 0.91 + 0.09 * Math.sin(x * 0.28 + Math.sin(y * 0.05));
      for (let channel = 0; channel < 3; channel++)
        data[i + channel] = Math.max(
          0,
          Math.min(255, Math.round(base[channel] * value)),
        );
      data[i + 3] = 255;
    }
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = 4;
  texture.needsUpdate = true;
  texture.userData.metresPerRepeat = 1;
  return texture;
}

function crownGeometry() {
  const geometry = new THREE.SphereGeometry(1, 28, 20);
  const positions = geometry.getAttribute("position");
  const colors = new Float32Array(positions.count * 3);
  for (let i = 0; i < positions.count; i++) {
    const x = positions.getX(i),
      y = positions.getY(i),
      z = positions.getZ(i);
    const ripple =
      0.09 * Math.sin(x * 18 + z * 11) * Math.cos(y * 16 - z * 7) +
      0.07 * Math.sin(y * 21 + x * 13) +
      0.04 * Math.cos(z * 31 - x * 17);
    positions.setXYZ(
      i,
      x * (1 + ripple),
      y * (1 + ripple * 0.8),
      z * (1 + ripple),
    );
    const shade = 0.8 + 0.15 * (0.5 + 0.5 * Math.sin(x * 23 + y * 19 + z * 17));
    colors.set([shade, shade, shade], i * 3);
  }
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geometry.computeVertexNormals();
  return geometry;
}

export function buildMemoryEnvironment(input: {
  source: VolumePixels;
  environment?: "indoor" | "outdoor";
  sceneEnvironment?: string;
}): { group: THREE.Group; obstacles: EnvironmentObstacle[]; dispose(): void } {
  const group = new THREE.Group();
  group.name = "inferred-surroundings";
  const obstacles: EnvironmentObstacle[] = [];
  const observed = extractEnvironmentPalette(input.source);
  // A dark night-time pixel includes the original exposure. Reusing it as an
  // equally dark albedo and lighting it again hides all inferred architecture.
  // Recover plausible material reflectance while retaining each sampled hue.
  const reflectance = (c: RGB, minimum: number): RGB => {
    const factor = Math.min(
      255 / Math.max(1, ...c),
      Math.max(1, minimum / Math.max(1, luminance(c))),
    );
    return multiply(c, factor);
  };
  const palette: EnvironmentPalette = {
    ...observed,
    ground: reflectance(observed.ground, 58),
    masonry: reflectance(observed.masonry, 100),
    trim: reflectance(observed.trim, 28),
    foliage: reflectance(observed.foliage, 42),
    light: reflectance(observed.light, 180),
  };
  const hint = (input.sceneEnvironment ?? "").toLowerCase();
  const beach = /\bbeach|coast|shore|ocean\b/.test(hint);
  const mountain = /\bmountain|alpine|summit\b/.test(hint);
  const city =
    /\bstreet|city|urban|storefront|sidewalk|downtown|roadway\b/.test(hint);
  const kind =
    input.environment === "indoor" ||
    (!input.environment && /\bindoor|interior|kitchen|living room\b/.test(hint))
      ? "interior"
      : !city &&
          /\bforest|woodland|garden|mountain|alpine|summit|beach|coast|shore|ocean\b/.test(
            hint,
          )
        ? "landscape"
        : "street";
  group.userData.environmentKind = kind;
  group.userData.materialPalette = palette;
  group.userData.sourcePalette = observed;
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  const material = (c: RGB, roughness = 0.9) => {
    const result = new THREE.MeshStandardMaterial({
      color: color(c),
      roughness,
    });
    materials.add(result);
    return result;
  };
  const boxGeometry = new THREE.BoxGeometry(1, 1, 1);
  geometries.add(boxGeometry);
  const mesh = (
    geometry: THREE.BufferGeometry,
    surface: THREE.Material,
    name: string,
  ) => {
    geometries.add(geometry);
    const result = new THREE.Mesh(geometry, surface);
    result.name = name;
    result.castShadow = result.receiveShadow = true;
    group.add(result);
    return result;
  };
  const box = (
    name: string,
    position: [number, number, number],
    scale: [number, number, number],
    surface: THREE.Material,
  ) => {
    const result = mesh(boxGeometry, surface, name);
    result.position.set(...position);
    result.scale.set(...scale);
    if (
      /^(building|interior-column|west-wall|east-wall|front-wall|rear-wall)$/.test(
        name,
      )
    ) {
      obstacles.push({
        kind: "box",
        x: position[0],
        z: position[2],
        radiusX: scale[0] / 2,
        radiusZ: scale[2] / 2,
        minY: position[1] - scale[1] / 2,
        maxY: position[1] + scale[1] / 2,
      });
    }
    return result;
  };
  const tile = (
    name: string,
    width: number,
    depth: number,
    x: number,
    y: number,
    z: number,
    base: RGB,
    style: "stone" | "asphalt" | "plaster" | "timber",
  ) => {
    const map = surfaceTexture(base, style);
    map.repeat.set(width, depth);
    textures.add(map);
    const surface = new THREE.MeshStandardMaterial({
      map,
      roughness: style === "stone" ? 0.84 : 0.97,
    });
    materials.add(surface);
    const result = mesh(new THREE.PlaneGeometry(width, depth), surface, name);
    result.rotation.x = -Math.PI / 2;
    result.position.set(x, y, z);
    result.castShadow = false;
    result.userData.metresPerTextureRepeat = 1;
    return result;
  };

  // A color gradient is deliberately untextured: a narrow camera view does not
  // contain a panorama, and spreading it over a sphere produces huge streaks.
  const skyGeometry = new THREE.SphereGeometry(58, 48, 24);
  const skyPositions = skyGeometry.getAttribute("position");
  const skyColors = new Float32Array(skyPositions.count * 3);
  const skyTop = color(multiply(palette.sky, 0.76));
  const skyHorizon = color(blend(palette.sky, palette.masonry, 0.24));
  for (let i = 0; i < skyPositions.count; i++) {
    const c = skyHorizon
      .clone()
      .lerp(skyTop, Math.max(0, skyPositions.getY(i) / 58));
    c.toArray(skyColors, i * 3);
  }
  skyGeometry.setAttribute("color", new THREE.BufferAttribute(skyColors, 3));
  const skyMaterial = new THREE.MeshBasicMaterial({
    vertexColors: true,
    side: THREE.BackSide,
    depthWrite: false,
  });
  materials.add(skyMaterial);
  const sky = mesh(skyGeometry, skyMaterial, "source-palette-sky");
  sky.position.set(0, 0, -8);
  sky.renderOrder = -10;
  sky.castShadow = sky.receiveShadow = false;

  const stone = material(palette.masonry);
  const trim = material(palette.trim);
  const trimLight = material(blend(palette.masonry, palette.light, 0.3));
  const metal = material(multiply(palette.trim, 0.7), 0.47);
  const glass = material(blend(palette.sky, palette.trim, 0.6), 0.25);
  glass.metalness = 0.15;
  const glow = material(palette.light, 0.6);
  glow.emissive.copy(color(palette.light));
  glow.emissiveIntensity = palette.night ? 0.8 : 0.1;

  if (kind === "interior") {
    tile("interior-floor", 54, 54, 0, 0, -8, palette.ground, "stone");
    // The enclosing walls sit beyond walking bounds. Repeated architectural
    // details have ordinary dimensions instead of enlarged photo pixels.
    box("west-wall", [-25, 3.6, -8], [0.3, 7.2, 50], stone);
    box("east-wall", [25, 3.6, -8], [0.3, 7.2, 50], stone);
    box("rear-wall", [0, 3.6, -33], [50, 7.2, 0.3], stone);
    box("front-wall", [0, 3.6, 17], [50, 7.2, 0.3], stone);
    box(
      "ceiling",
      [0, 7.3, -8],
      [50, 0.15, 50],
      material(blend(palette.masonry, palette.light, 0.6)),
    );
    for (const x of [-24.78, 24.78]) {
      for (let z = -29; z < 15; z += 5.2) {
        box("window-recess", [x, 3.3, z], [0.09, 3.2, 2.6], trim);
        box(
          "window-glazing",
          [x + (x < 0 ? 0.06 : -0.06), 3.3, z],
          [0.035, 2.94, 2.34],
          glass,
        );
        box(
          "window-mullion",
          [x + (x < 0 ? 0.09 : -0.09), 3.3, z],
          [0.05, 3.05, 0.06],
          trimLight,
        );
        box(
          "wall-pier",
          [x + (x < 0 ? 0.12 : -0.12), 3.6, z + 2.55],
          [0.32, 7.1, 0.5],
          trimLight,
        );
      }
    }
    for (const x of [-8, 8]) {
      for (const z of [-19, -8, 4]) {
        box("interior-column", [x, 3.6, z], [0.48, 7.2, 0.48], stone);
        box("column-foot", [x, 0.12, z], [0.65, 0.24, 0.65], trimLight);
        box("ceiling-light", [x, 7.14, z + 1.7], [2.1, 0.05, 0.15], glow);
      }
    }
    for (const x of [-12, 0, 12]) {
      box("door-frame", [x, 1.25, -32.76], [1.7, 2.5, 0.18], trim);
      box(
        "door-panel",
        [x, 1.18, -32.64],
        [1.48, 2.34, 0.08],
        material(blend(palette.ground, palette.trim, 0.3)),
      );
      box(
        "door-handle",
        [x + 0.52, 1.05, -32.56],
        [0.04, 0.22, 0.08],
        trimLight,
      );
    }
  } else if (kind === "street") {
    tile(
      "street-ground",
      58,
      58,
      0,
      0,
      -8,
      multiply(palette.ground, 0.72),
      "asphalt",
    );
    for (const side of [-1, 1]) {
      tile(
        "sidewalk",
        3.5,
        47,
        side * 7.55,
        0.15,
        -8,
        blend(palette.ground, palette.masonry, 0.35),
        "stone",
      );
      box("curb", [side * 5.83, 0.075, -8], [0.18, 0.15, 47], trimLight);
      for (let i = 0; i < 5; i++) {
        const z = -28 + i * 9.4;
        const height = 5.5 + ((i * 7 + (side + 1)) % 4) * 1.3;
        const facade = material(multiply(palette.masonry, 0.84 + i * 0.055));
        box("building", [side * 14, height / 2, z], [9.2, height, 8.6], facade);
        box(
          "building-plinth",
          [side * 9.36, 0.27, z],
          [0.18, 0.54, 8.65],
          trim,
        );
        box(
          "roof-coping",
          [side * 13.8, height + 0.09, z],
          [9.65, 0.18, 8.8],
          trimLight,
        );
        for (let floor = 0; floor < Math.floor(height / 2.6); floor++) {
          for (let w = 0; w < 3; w++) {
            const wx = side * 9.32;
            const wz = z - 2.8 + w * 2.8;
            const wy = 1.6 + floor * 2.5;
            box("window-frame", [wx, wy, wz], [0.12, 1.55, 1.4], trimLight);
            box(
              "window-pane",
              [wx - side * 0.075, wy, wz],
              [0.04, 1.38, 1.23],
              glass,
            );
            box(
              "window-sill",
              [wx - side * 0.09, wy - 0.81, wz],
              [0.31, 0.1, 1.55],
              trimLight,
            );
            box(
              "window-divider",
              [wx - side * 0.105, wy, wz],
              [0.05, 1.43, 0.045],
              trim,
            );
          }
        }
        box("shop-door", [side * 9.27, 1.16, z], [0.1, 2.32, 1.15], trim);
        box("door-glass", [side * 9.19, 1.35, z], [0.03, 1.7, 0.94], glass);
      }
      for (const z of [-24, -12, 1, 13]) {
        const x = side * 6.3;
        const pole = mesh(
          new THREE.CylinderGeometry(0.045, 0.085, 4.2, 16),
          metal,
          "street-lamp-pole",
        );
        pole.position.set(x, 2.25, z);
        box("lamp-foot", [x, 0.28, z], [0.2, 0.26, 0.2], metal);
        box("lamp-arm", [x - side * 0.36, 4.29, z], [0.82, 0.06, 0.07], metal);
        box(
          "lamp-housing",
          [x - side * 0.72, 4.24, z],
          [0.45, 0.12, 0.23],
          metal,
        );
        box(
          "lamp-panel",
          [x - side * 0.72, 4.17, z],
          [0.36, 0.016, 0.18],
          glow,
        );
        if (palette.night && (z === -12 || z === 1)) {
          const light = new THREE.PointLight(color(palette.light), 5, 9, 2);
          light.position.set(x - side * 0.72, 4.05, z);
          group.add(light);
        }
      }
      // Street furniture has physical depth, with a clear pedestrian corridor.
      for (const z of [-17, 7]) {
        box(
          "bench-seat",
          [side * 8.2, 0.62, z],
          [0.55, 0.08, 1.8],
          material(blend(palette.ground, palette.trim, 0.4)),
        );
        box("bench-back", [side * 8.43, 0.92, z], [0.07, 0.62, 1.8], trim);
        for (const offset of [-0.65, 0.65])
          box(
            "bench-leg",
            [side * 8.2, 0.38, z + offset],
            [0.38, 0.45, 0.06],
            metal,
          );
      }
      const streetBark = material(blend(palette.trim, palette.ground, 0.25));
      const streetLeaves = material(palette.foliage);
      streetLeaves.vertexColors = true;
      const streetTrunk = new THREE.CylinderGeometry(0.09, 0.16, 2.9, 16);
      const streetCrown = crownGeometry();
      for (const z of [-19, -5, 10]) {
        const x = side * 7.7;
        box("tree-planter", [x, 0.28, z], [1.25, 0.27, 1.25], stone);
        box("planter-soil", [x, 0.42, z], [1.06, 0.02, 1.06], trim);
        const trunk = mesh(streetTrunk, streetBark, "street-tree-trunk");
        trunk.position.set(x, 1.87, z);
        for (let branch = 0; branch < 12; branch++) {
          const crown = mesh(streetCrown, streetLeaves, "street-tree-canopy");
          const angle = branch * 2.39996 + z * 0.23;
          const spread = 0.3 + (branch % 3) * 0.2;
          crown.position.set(
            x + Math.sin(angle) * spread,
            3.1 + (branch % 4) * 0.3,
            z + Math.cos(angle) * spread,
          );
          crown.scale.set(
            0.45 + (branch % 4) * 0.08,
            0.6 + ((branch + 1) % 3) * 0.12,
            0.42 + ((branch + 2) % 3) * 0.1,
          );
          crown.rotation.set(
            Math.sin(angle) * 0.3,
            angle,
            Math.cos(angle) * 0.2,
          );
        }
      }
    }
  } else {
    tile(
      "landscape-ground",
      58,
      58,
      0,
      0,
      -8,
      beach ? palette.ground : blend(palette.ground, palette.foliage, 0.2),
      "plaster",
    );
    const bark = material(blend(palette.trim, palette.ground, 0.25));
    const leaves = [0.7, 0.88, 1.05].map((shade) =>
      material(multiply(palette.foliage, shade)),
    );
    leaves.forEach((surface) => {
      surface.vertexColors = true;
    });
    const foliageGeometry = crownGeometry();
    const trunkGeometry = new THREE.CylinderGeometry(0.12, 0.22, 3.6, 18);
    for (let i = 0; i < 14; i++) {
      const angle = i * 2.39996;
      const radius = 14 + (i % 4) * 3;
      const x = Math.sin(angle) * radius;
      const z = -8 + Math.cos(angle) * radius;
      const trunk = mesh(trunkGeometry, bark, "tree-trunk");
      trunk.position.set(x, 1.8, z);
      if (beach) {
        const rock = mesh(
          foliageGeometry,
          leaves[i % leaves.length],
          "coastal-rock",
        );
        rock.position.set(x, 0.45, z);
        rock.scale.set(1.3, 0.7, 1);
        trunk.visible = false;
      } else {
        for (let branch = 0; branch < 4; branch++) {
          const crown = mesh(
            foliageGeometry,
            leaves[(i + branch) % leaves.length],
            "tree-canopy",
          );
          crown.position.set(
            x + Math.sin(branch * 2.1) * 0.8,
            3.6 + (branch % 2) * 0.75,
            z + Math.cos(branch * 2.1) * 0.8,
          );
          crown.scale.set(1.5, 1.7, 1.4);
        }
      }
    }
    if (mountain) {
      for (let i = 0; i < 9; i++) {
        const hill = mesh(
          new THREE.SphereGeometry(1, 32, 20),
          material(multiply(palette.masonry, 0.72 + (i % 3) * 0.1)),
          "distant-hill",
        );
        const angle = (i * Math.PI * 2) / 9;
        hill.position.set(Math.sin(angle) * 35, -1, -8 + Math.cos(angle) * 35);
        hill.scale.set(9, 5 + (i % 4) * 2, 9);
      }
    }
  }

  // Repeated window frames, curbs, trunks and foliage share draw calls. This
  // keeps the dimensional surroundings practical in the headset renderer.
  const batches = new Map<string, THREE.Mesh[]>();
  for (const child of group.children) {
    if (
      !(child instanceof THREE.Mesh) ||
      Array.isArray(child.material) ||
      !child.visible
    )
      continue;
    const key = `${child.geometry.id}:${child.material.id}`;
    const members = batches.get(key) ?? [];
    members.push(child);
    batches.set(key, members);
  }
  for (const members of batches.values()) {
    if (members.length < 3) continue;
    const first = members[0];
    const batched = new THREE.InstancedMesh(
      first.geometry,
      first.material,
      members.length,
    );
    batched.name = `${first.name}-instances`;
    batched.castShadow = first.castShadow;
    batched.receiveShadow = first.receiveShadow;
    batched.userData.features = members.map((member, i) => {
      member.updateMatrix();
      batched.setMatrixAt(i, member.matrix);
      group.remove(member);
      return {
        name: member.name,
        position: member.position.toArray(),
        scale: member.scale.toArray(),
      };
    });
    batched.instanceMatrix.needsUpdate = true;
    batched.computeBoundingSphere();
    group.add(batched);
  }

  let disposed = false;
  return {
    group,
    obstacles,
    dispose() {
      if (disposed) return;
      disposed = true;
      geometries.forEach((geometry) => geometry.dispose());
      materials.forEach((surface) => surface.dispose());
      textures.forEach((texture) => texture.dispose());
      group.children.forEach((child) => {
        if (child instanceof THREE.InstancedMesh) child.dispose();
      });
      group.clear();
    },
  };
}
