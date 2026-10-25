import * as THREE from "three";
import {
  extractEnvironmentPalette,
  type EnvironmentObstacle,
} from "./memory-environment";
import type { VolumePixels } from "./volume";
import { selectGroundPatch } from "./environment-patch";

type Vector = [number, number, number];
type Region = [number, number, number, number];

export interface PhotoEnvironmentInput {
  /** High-resolution background with the reconstructed foreground removed. */
  source: VolumePixels;
  /** Textures supplied by the caller remain owned by the caller. */
  photoTexture?: THREE.Texture;
  panoramaTexture?: THREE.Texture;
  environment?: "indoor" | "outdoor";
  sceneEnvironment?: string;
  fov?: number;
  /** Normalized image row of the horizon, measured from the top. */
  horizon?: number;
  /** Excludes foreground/inpainted pixels when choosing repeatable materials. */
  excludedMask?: VolumePixels;
  textureSource?: "gemini" | "imagegen" | "source-inpaint";
}

export interface PhotoProjection {
  origin: Vector;
  aspect: number;
  fov: number;
  horizon: number;
}

/** A planar wall or ground uses camera projection, rather than stretching its
 * entire rectangular source over that surface. This is also used by the shader. */
export function projectEnvironmentPoint(
  point: Vector,
  projection: PhotoProjection,
): { uv: [number, number]; visible: boolean } {
  const x = point[0] - projection.origin[0];
  const y = point[1] - projection.origin[1];
  const depth = projection.origin[2] - point[2];
  const scale = 2 * depth * Math.tan((projection.fov * Math.PI) / 360);
  const uv: [number, number] = [
    0.5 + x / (scale * projection.aspect),
    1 - projection.horizon + y / scale,
  ];
  return {
    uv,
    visible:
      depth > 0 &&
      uv.every((value) => Number.isFinite(value) && value >= 0 && value <= 1),
  };
}

/** An equirectangular image's center is the photographed forward view (-Z). */
export function environmentPanoramaUv(direction: Vector): [number, number] {
  const length = Math.hypot(...direction);
  if (!length) return [0.5, 0.5];
  return [
    0.5 + Math.atan2(direction[0], -direction[2]) / (Math.PI * 2),
    0.5 + Math.asin(Math.max(-1, Math.min(1, direction[1] / length))) / Math.PI,
  ];
}

function photoPixels(source: VolumePixels, region: Region = [0, 0, 1, 1]) {
  const [left, top, right, bottom] = region;
  const x0 = Math.max(0, Math.floor(left * source.width));
  const y0 = Math.max(0, Math.floor(top * source.height));
  const width = Math.max(
    1,
    Math.min(source.width - x0, Math.ceil((right - left) * source.width)),
  );
  const height = Math.max(
    1,
    Math.min(source.height - y0, Math.ceil((bottom - top) * source.height)),
  );
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      for (let c = 0; c < 4; c++)
        data[(y * width + x) * 4 + c] = Number(
          source.data[((y0 + y) * source.width + x0 + x) * 4 + c],
        );
  const texture = new THREE.DataTexture(data, width, height, THREE.RGBAFormat);
  texture.flipY = true;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = 8;
  texture.needsUpdate = true;
  return texture;
}

const vertexShader = `
varying vec3 memoryPosition;
varying vec2 materialUv;
void main() {
  vec4 worldPosition = modelMatrix * vec4(position, 1.0);
  memoryPosition = worldPosition.xyz;
  materialUv = uv;
  gl_Position = projectionMatrix * viewMatrix * worldPosition;
}`;

const fragmentShader = `
uniform sampler2D photograph;
uniform sampler2D panorama;
uniform sampler2D detail;
uniform sampler2D foregroundMask;
uniform float excludeForeground;
uniform vec3 captureOrigin;
uniform vec3 fallbackColor;
uniform vec2 repeatScale;
uniform float tangentHalfFov;
uniform float imageAspect;
uniform float horizon;
uniform float hasPanorama;
uniform float photoWeight;
uniform float detailWeight;
uniform vec2 sourceLowerFade;
uniform float groundDetail;
uniform float panoramaGroundTile;
uniform vec4 panoramaGroundRegion;
varying vec3 memoryPosition;
varying vec2 materialUv;
const float PI = 3.141592653589793;
void main() {
  vec3 ray = memoryPosition - captureOrigin;
  float rayLength = max(0.001, length(ray));
  vec3 direction = ray / rayLength;
  vec2 panoramaUv = vec2(
    0.5 + atan(direction.x, -direction.z) / (2.0 * PI),
    0.5 + asin(clamp(direction.y, -1.0, 1.0)) / PI
  );
  vec2 repeatUv = materialUv * repeatScale;
  vec3 tileSample = texture2D(detail, repeatUv).rgb;
  // Two differently oriented samples keep a small material patch from making
  // conspicuous checkerboard seams while retaining the source's fine detail.
  vec2 rotatedUv = vec2(repeatUv.x * 0.8 + repeatUv.y * 0.6, repeatUv.y * 0.8 - repeatUv.x * 0.6);
  tileSample = mix(tileSample, texture2D(detail, rotatedUv * 1.27 + vec2(0.31, 0.67)).rgb, groundDetail * 0.5);
  // A small clean wood patch from the completed panorama is a material, not
  // another spherical projection. Mirror it at ordinary two-metre intervals
  // so walking behind the people cannot drag walls/reflections across the floor.
  vec2 mirroredUv = 1.0 - abs(mod(repeatUv, 2.0) - 1.0);
  vec2 woodUv = mix(panoramaGroundRegion.xy, panoramaGroundRegion.zw, mirroredUv);
  tileSample = mix(tileSample, texture2D(panorama, woodUv).rgb, panoramaGroundTile);
  vec3 tile = mix(fallbackColor, tileSample, detailWeight);
  vec3 surround = mix(tile, texture2D(panorama, panoramaUv).rgb, hasPanorama);
  float depth = -ray.z;
  float safeDepth = max(0.01, depth);
  vec2 photoUv = vec2(
    0.5 + ray.x / (2.0 * safeDepth * tangentHalfFov * imageAspect),
    1.0 - horizon + ray.y / (2.0 * safeDepth * tangentHalfFov)
  );
  float edge = min(min(photoUv.x, 1.0 - photoUv.x), min(photoUv.y, 1.0 - photoUv.y));
  float photographed = smoothstep(0.012, 0.075, edge) * smoothstep(0.2, 0.8, depth) * photoWeight;
  photographed *= 1.0 - smoothstep(sourceLowerFade.x, sourceLowerFade.y, 1.0 - photoUv.y);
  // Locally filled holes are uncertain. Do not enlarge their copied clothing
  // and skin pixels into a second crowd on the surrounding architecture.
  photographed *= 1.0 - excludeForeground * smoothstep(0.02, 0.15,
    texture2D(foregroundMask, clamp(photoUv, vec2(0.0), vec2(1.0))).r);
  vec3 observed = texture2D(photograph, clamp(photoUv, vec2(0.0), vec2(1.0))).rgb;
  // Photographed light and exposure are already baked into both image sources.
  // Relighting them makes a night scene olive or washes out original colors.
  gl_FragColor = vec4(mix(surround, observed, photographed), 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export function buildPhotoEnvironment(input: PhotoEnvironmentInput): {
  group: THREE.Group;
  obstacles: EnvironmentObstacle[];
  dispose(): void;
} {
  if (
    input.source.width < 1 ||
    input.source.height < 1 ||
    input.source.data.length < input.source.width * input.source.height * 4
  )
    throw new Error("A complete background photograph is required.");
  const group = new THREE.Group();
  group.name = "Photograph-matched surroundings";
  const hint = (input.sceneEnvironment ?? "").toLowerCase();
  const indoor =
    input.environment === "indoor" ||
    (input.environment !== "outdoor" &&
      /indoor|interior|kitchen|living room/.test(hint));
  const landscape =
    !indoor &&
    !/street|city|urban|storefront|sidewalk/.test(hint) &&
    /forest|woodland|mountain|alpine|beach|coast|shore|garden/.test(hint);
  const palette = extractEnvironmentPalette(input.source);
  const projection: PhotoProjection = {
    origin: [0, 1.6, 0],
    aspect: input.source.width / input.source.height,
    fov: Math.max(30, Math.min(95, input.fov ?? 60)),
    horizon: Math.max(
      0.2,
      Math.min(0.85, input.horizon ?? (indoor ? 0.61 : 0.69)),
    ),
  };
  group.userData.environmentKind = indoor
    ? "interior"
    : landscape
      ? "landscape"
      : "street";
  group.userData.projection = projection;
  group.userData.sourceResolution = [input.source.width, input.source.height];
  group.userData.hasPanorama = !!input.panoramaTexture;
  group.userData.originalPhotoColors = true;
  const obstacles: EnvironmentObstacle[] = [];
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  const photograph = input.photoTexture ?? photoPixels(input.source);
  if (!input.photoTexture) textures.add(photograph);
  const panorama = input.panoramaTexture ?? photograph;
  const groundEvidence = selectGroundPatch(input.source, input.excludedMask);
  const uncertainGround =
    input.textureSource === "source-inpaint" && !input.panoramaTexture;
  const foregroundMask = input.excludedMask
    ? photoPixels(input.excludedMask)
    : photograph;
  if (input.excludedMask) textures.add(foregroundMask);
  const groundPatch = photoPixels(input.source, groundEvidence.region);
  group.userData.groundEvidence = groundEvidence.reliable
    ? "visible-material"
    : "source-color-only";
  groundPatch.wrapS = groundPatch.wrapT = THREE.MirroredRepeatWrapping;
  textures.add(groundPatch);
  const wallPatch = photoPixels(
    input.source,
    indoor ? [0.15, 0.06, 0.34, 0.18] : [0.82, 0.45, 0.91, 0.54],
  );
  wallPatch.wrapS = wallPatch.wrapT = THREE.MirroredRepeatWrapping;
  textures.add(wallPatch);
  const rgb = (value: number[]) =>
    new THREE.Color().setRGB(
      value[0] / 255,
      value[1] / 255,
      value[2] / 255,
      THREE.SRGBColorSpace,
    );
  const material = (
    kind: "ground" | "wall" | "sky",
    repeat: [number, number] = [1, 1],
    photoWeight = 1,
  ) => {
    const surface = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      side: THREE.DoubleSide,
      uniforms: {
        photograph: { value: photograph },
        panorama: { value: panorama },
        detail: { value: kind === "ground" ? groundPatch : wallPatch },
        foregroundMask: { value: foregroundMask },
        excludeForeground: {
          value: uncertainGround && input.excludedMask ? 1 : 0,
        },
        captureOrigin: { value: new THREE.Vector3(...projection.origin) },
        fallbackColor: {
          value: rgb(
            kind === "ground"
              ? groundEvidence.color
              : kind === "sky"
                ? palette.sky
                : palette.masonry,
          ),
        },
        repeatScale: { value: new THREE.Vector2(...repeat) },
        tangentHalfFov: { value: Math.tan((projection.fov * Math.PI) / 360) },
        imageAspect: { value: projection.aspect },
        horizon: { value: projection.horizon },
        // Near asphalt needs physical grain, rather than an enlarged portion
        // of a panoramic floor. Keep a little captured illumination in it.
        hasPanorama: {
          value: input.panoramaTexture
            ? kind === "ground"
              ? indoor
                ? 0
                : 0.18
              : 1
            : 0,
        },
        // The source room photograph contains other partygoers behind the
        // selected people. Projecting it on walls duplicates giant bodies.
        photoWeight: {
          value:
            (indoor && input.panoramaTexture) ||
            (kind === "ground" && uncertainGround)
              ? 0
              : photoWeight,
        },
        detailWeight: {
          value:
            kind === "sky"
              ? 0
              : kind === "ground"
                ? groundEvidence.reliable
                  ? uncertainGround
                    ? 0.25
                    : 1
                  : 0
                : uncertainGround
                  ? 0.15
                  : 1,
        },
        sourceLowerFade: {
          value: new THREE.Vector2(indoor ? 0.3 : 0.72, indoor ? 0.36 : 0.84),
        },
        groundDetail: { value: kind === "ground" ? 1 : 0 },
        panoramaGroundTile: {
          value: kind === "ground" && indoor && input.panoramaTexture ? 1 : 0,
        },
        panoramaGroundRegion: {
          value: new THREE.Vector4(0.45, 0.055, 0.5, 0.155),
        },
      },
    });
    surface.name = `Source-color ${kind}`;
    surface.userData.projectedSource = true;
    surface.userData.physicalRepeat = repeat;
    materials.add(surface);
    return surface;
  };
  const addMesh = (
    name: string,
    geometry: THREE.BufferGeometry,
    surface: THREE.Material,
  ) => {
    geometries.add(geometry);
    const mesh = new THREE.Mesh(geometry, surface);
    mesh.name = name;
    group.add(mesh);
    return mesh;
  };
  // Keep the photographed floor's exposure and hue intact. This transparent
  // receiver only darkens pixels occluded by actual 3D bodies in the shadow map.
  const groundShadowMaterial = new THREE.ShadowMaterial({
    color: 0x000000,
    opacity: 0.38,
    depthWrite: false,
    toneMapped: false,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });
  groundShadowMaterial.name = "Photographic floor shadow receiver";
  materials.add(groundShadowMaterial);
  const receiveGroundShadows = (ground: THREE.Mesh) => {
    const receiver = addMesh(
      `${ground.name} — body shadows`,
      ground.geometry,
      groundShadowMaterial,
    );
    receiver.position.copy(ground.position);
    receiver.position.y += 0.004;
    receiver.quaternion.copy(ground.quaternion);
    receiver.receiveShadow = true;
    receiver.renderOrder = 1;
    receiver.userData.bodyShadowReceiver = true;
  };
  const box = (
    name: string,
    position: Vector,
    size: Vector,
    collide = false,
    photoWeight = 1,
  ) => {
    const mesh = addMesh(
      name,
      new THREE.BoxGeometry(...size),
      material("wall", [size[0] / 1.5, size[1] / 1.5], photoWeight),
    );
    mesh.position.set(...position);
    // Lighting is already captured in the architectural photographs. In
    // particular, the inferred roof must not eclipse every body-ground shadow.
    mesh.castShadow = false;
    if (collide)
      obstacles.push({
        kind: "box",
        x: position[0],
        z: position[2],
        radiusX: size[0] / 2,
        radiusZ: size[2] / 2,
        minY: position[1] - size[1] / 2,
        maxY: position[1] + size[1] / 2,
      });
    return mesh;
  };
  const floor = addMesh(
    "Photographic ground with metre-scale detail",
    new THREE.PlaneGeometry(58, 58, 1, 1),
    material("ground", [29, 29]),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(0, -0.012, -8);
  floor.userData.metresPerTextureRepeat = 2;
  receiveGroundShadows(floor);

  if (indoor) {
    // A house-sized interior with a usable corridor behind the reconstructed
    // people. The source photographs supply doors, wall detail and LED strips.
    const roomHeight = 3.5;
    box(
      "Photographed rear room wall",
      [0, roomHeight / 2, -12.5],
      [16, roomHeight, 0.22],
      true,
    );
    box(
      "Extrapolated room wall behind camera",
      [0, roomHeight / 2, 5],
      [16, roomHeight, 0.22],
      true,
    );
    box(
      "Left room wall",
      [-8, roomHeight / 2, -3.75],
      [0.22, roomHeight, 17.5],
      true,
    );
    box(
      "Right room wall",
      [8, roomHeight / 2, -3.75],
      [0.22, roomHeight, 17.5],
      true,
    );
    box("Photographic ceiling", [0, roomHeight + 0.1, -3.75], [16, 0.2, 17.5]);
    // One actual architectural column is visible on the photograph's left.
    box(
      "Left room column",
      [-5.6, roomHeight / 2, -5.6],
      [0.32, roomHeight, 0.32],
      true,
    );
    box("Column capital", [-5.6, roomHeight - 0.12, -5.6], [0.46, 0.22, 0.46]);
    box("Column foot", [-5.6, 0.1, -5.6], [0.4, 0.2, 0.4]);
  } else {
    const sky = addMesh(
      "Continuous photographed and extrapolated panorama",
      new THREE.SphereGeometry(65, 64, 32),
      material("sky"),
    );
    sky.position.set(...projection.origin);
    sky.material.side = THREE.BackSide;
    sky.material.depthWrite = false;
    sky.renderOrder = -10;
    if (!landscape) {
      // One continuous row retains the real red storefronts/signs from the
      // photograph. Breaking it into invented repeated windows loses the place.
      box(
        "Original right storefront volume",
        [10.1, 2.8, -23],
        [3.2, 5.6, 22],
        true,
      );
      box(
        "Original left street-edge volume",
        [-8.7, 2.0, -23.5],
        [3.4, 4.0, 15],
        true,
      );
      // Low curb and pavement occupy normal world units; no image is copied
      // across an entire 50-metre facade or used as a repeated window pattern.
      for (const side of [-1, 1]) {
        const sidewalk = addMesh(
          "Photographic sidewalk",
          new THREE.PlaneGeometry(2.25, 36),
          material("ground", [1.125, 18]),
        );
        sidewalk.rotation.x = -Math.PI / 2;
        sidewalk.position.set(side * 5.3, 0.085, -14);
        receiveGroundShadows(sidewalk);
        box("Stone curb", [side * 4.14, 0.04, -14], [0.1, 0.08, 36]);
      }
      // Branch shape and placement cannot be recovered from the occluded
      // photograph. Preserve detailed photographic trees in the panorama
      // instead of inserting disconnected opaque Y-shaped trunk guesses.
    }
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
      group.clear();
    },
  };
}
