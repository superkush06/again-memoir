import * as THREE from "three";
import { buildHumanBody } from "./human-body";
import { analyzeHumanAppearance } from "./human-appearance";
import {
  layoutHumanBodies,
  humanPoseScales,
  estimateCaptureHeight,
} from "./human-layout";
import { fitHumanPose } from "./human-pose";
import {
  poseAppearance,
  fitPosedHumanPhotographs,
  capturePosePhotographs,
} from "./posed-human-photographs";
import type { HumanPose } from "../types";
import type { MemoryObjectSpec } from "../memory-objects";
import { buildMemoryProp, placeMemoryProp } from "./memory-props";
import { buildPhotoEnvironment } from "./photo-environment";
import {
  selectNeuralAssetShape,
  type NeuralAssetDescriptor,
} from "../neural-asset-validation";
import {
  createBodyShapeController,
  type BodyShapeChoice,
} from "./body-shape-controller";
import type { WorldObstacle } from "./world-collisions";
import { isWorldCompletion } from "../world-completion-validation";
import { createDepthGeometry, type ProjectionOptions } from "./reconstruction";
import {
  createClosedVolume,
  depthSilhouettes,
  type VolumePixels,
} from "./volume";

type Vector = [number, number, number];
export interface ReconstructionInput extends ProjectionOptions {
  sourceUrl: string;
  depthUrl: string;
  completionUrl?: string;
  sceneEnvironment?: string;
  mediaType?: "image" | "video";
}
export interface Reconstruction {
  group: THREE.Group;
  surface: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  props: { id: string; label: string; group: THREE.Group; movable: boolean }[];
  navigation: {
    target: Vector;
    front: Vector;
    frontTarget?: Vector;
    side: Vector;
    behind: Vector;
    bounds: { min: Vector; max: Vector };
    obstacles?: WorldObstacle[];
  };
  setStrength: (value: number) => void;
  setPointMode: (enabled: boolean) => void;
  setTexture: (texture: THREE.Texture) => void;
  hasBodyShapes: boolean;
  setBodyShape: (choice: BodyShapeChoice) => Promise<boolean>;
  dispose: () => void;
}

async function loadImage(url: string) {
  // Completion can replace masks and textures under the same local asset name.
  // Explicit revalidation also repairs older clients holding the former 1h cache.
  const response = await fetch(url, { cache: "no-cache" });
  if (!response.ok)
    throw new Error("The memory world texture could not be loaded.");
  const objectUrl = URL.createObjectURL(await response.blob());
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => {
      URL.revokeObjectURL(objectUrl);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error("The memory world texture could not be loaded."));
    };
    image.src = objectUrl;
  });
}
function pixels(
  image: HTMLImageElement,
  width: number,
  height: number,
): ImageData {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("This browser could not read the photo.");
  context.drawImage(image, 0, 0, width, height);
  return context.getImageData(0, 0, width, height);
}
function textureOf(image: HTMLImageElement | HTMLCanvasElement) {
  const texture = new THREE.Texture(image);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.needsUpdate = true;
  return texture;
}
function canvasOf(data: VolumePixels) {
  const canvas = document.createElement("canvas");
  canvas.width = data.width;
  canvas.height = data.height;
  const context = canvas.getContext("2d")!;
  context.putImageData(
    new ImageData(
      new Uint8ClampedArray(Array.from(data.data)),
      data.width,
      data.height,
    ),
    0,
    0,
  );
  return canvas;
}
function fillHiddenPixels(source: VolumePixels, masks: VolumePixels[]) {
  const { width: w, height: h } = source;
  const data = new Uint8ClampedArray(Array.from(source.data));
  const filled = new Uint8Array(w * h);
  const queue: number[] = [];
  for (let i = 0; i < w * h; i++)
    if (!masks.some((mask) => Number(mask.data[i * 4]) > 60)) {
      filled[i] = 1;
      queue.push(i);
    }
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const i = queue[cursor];
    const x = i % w;
    const y = Math.floor(i / w);
    for (const n of [
      x ? i - 1 : -1,
      x < w - 1 ? i + 1 : -1,
      y ? i - w : -1,
      y < h - 1 ? i + w : -1,
    ]) {
      if (n < 0 || filled[n]) continue;
      filled[n] = 1;
      queue.push(n);
      for (let c = 0; c < 4; c++) data[n * 4 + c] = data[i * 4 + c];
    }
  }
  return { width: w, height: h, data };
}

function pointMaterial(texture: THREE.Texture) {
  return new THREE.ShaderMaterial({
    uniforms: { image: { value: texture } },
    vertexShader:
      "varying vec2 imageUv; void main() { imageUv = uv; vec4 p = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * p; gl_PointSize = clamp(14.0 / max(.2, -p.z), 1.5, 8.0); }",
    fragmentShader:
      "uniform sampler2D image; varying vec2 imageUv; void main() { if (length(gl_PointCoord - .5) > .5) discard; gl_FragColor = texture2D(image, imageUv);\n#include <tonemapping_fragment>\n#include <colorspace_fragment>\n}",
  });
}

export async function buildReconstruction(
  input: ReconstructionInput,
): Promise<Reconstruction> {
  const completionPromise = input.completionUrl
    ? fetch(input.completionUrl, { cache: "no-cache" })
        .then(async (response) => {
          if (!response.ok) return undefined;
          const value: unknown = await response.json();
          return isWorldCompletion(value) ? value : undefined;
        })
        .catch(() => undefined)
    : Promise.resolve(undefined);
  const [sourceImage, depthImage, completion] = await Promise.all([
    loadImage(input.sourceUrl),
    loadImage(input.depthUrl),
    completionPromise,
  ]);
  const aspect = sourceImage.naturalWidth / sourceImage.naturalHeight;
  const width = Math.min(256, Math.round(220 * Math.min(1.2, aspect)));
  const height = Math.max(32, Math.min(320, Math.round(width / aspect)));
  const depth = pixels(depthImage, width, height);
  const source = pixels(sourceImage, width, height);
  // People can share one photographic atlas; decode it only once per world.
  const atlasImages = new Map<string, Promise<HTMLImageElement | undefined>>();
  const loadAtlas = (url: string) => {
    if (!atlasImages.has(url))
      atlasImages.set(
        url,
        loadImage(url).catch(() => undefined),
      );
    return atlasImages.get(url)!;
  };
  const resources = await Promise.all([
    completion?.backgroundUrl
      ? loadImage(completion.backgroundUrl).catch(() => undefined)
      : undefined,
    completion?.rearAtlasUrl
      ? loadImage(completion.rearAtlasUrl).catch(() => undefined)
      : undefined,
    completion?.panoramaUrl
      ? loadImage(completion.panoramaUrl).catch(() => undefined)
      : undefined,
    Promise.all(
      (completion?.subjects ?? []).map(async (subject) => ({
        subject,
        image: await loadImage(subject.maskUrl).catch(() => undefined),
        bodyImage: subject.bodyAtlasUrl
          ? await loadAtlas(subject.bodyAtlasUrl)
          : undefined,
      })),
    ),
    completion?.objectSourceUrl ? loadImage(completion.objectSourceUrl).catch(() => undefined) : undefined,
  ]);
  const [backgroundImage, rearImage, panoramaImage, subjectImages, objectSourceImage] = resources;
  type Subject = {
    id: string;
    label: string;
    kind: "person" | "object";
    box: [number, number, number, number];
    mask: VolumePixels;
    detailMask?: VolumePixels;
    objectMask?: VolumePixels;
    photographicBody?: Parameters<typeof buildHumanBody>[0]["photographicBody"];
    neuralAsset?: NeuralAssetDescriptor;
    humanPose?: HumanPose;
    object?: MemoryObjectSpec;
    thickness: number;
  };
  // Body details need the original photo's resolution; depth tessellation does not.
  const detailScale = Math.min(
    1,
    1200 / Math.max(sourceImage.naturalWidth, sourceImage.naturalHeight),
  );
  const detailWidth = Math.round(sourceImage.naturalWidth * detailScale);
  const detailHeight = Math.round(sourceImage.naturalHeight * detailScale);
  const detailSource = pixels(sourceImage, detailWidth, detailHeight);
  const subjects: Subject[] = [];
  const atlasPixels = new Map<HTMLImageElement, VolumePixels>();
  for (const { subject, image, bodyImage } of subjectImages) {
    if (!image) continue;
    if (bodyImage && !atlasPixels.has(bodyImage)) {
      atlasPixels.set(
        bodyImage,
        pixels(bodyImage, bodyImage.naturalWidth, bodyImage.naturalHeight),
      );
    }
    subjects.push({
      id: subject.id,
      label: subject.label,
      kind: subject.kind,
      box: subject.box,
      mask: pixels(image, width, height),
      detailMask:
        subject.kind === "person" || subject.object
          ? pixels(image, detailWidth, detailHeight)
          : undefined,
      // Object texture boundaries need the learned mask's original resolution;
      // the separate body-analysis budget must not blur fingers into labels.
      objectMask: subject.object
        ? pixels(image, image.naturalWidth, image.naturalHeight)
        : undefined,
      thickness: subject.thickness ?? 0.7,
      neuralAsset: subject.neuralAsset,
      humanPose: subject.humanPose,
      object: subject.object,
      photographicBody: bodyImage
        ? {
            front: atlasPixels.get(bodyImage)!,
            back: atlasPixels.get(bodyImage)!,
            frontBox: subject.bodyFrontBox,
            backBox: subject.bodyBackBox,
          }
        : undefined,
    });
  }
  if (!subjects.length) {
    depthSilhouettes(depth).forEach((mask, i) =>
      subjects.push({
        id: `depth-object-${i + 1}`,
        label: `Inferred object ${i + 1}`,
        kind: "object",
        box: [0, 0, 1, 1],
        mask,
        thickness: 0.8,
      }),
    );
  }
  const propMasks = subjects.filter(subject => subject.object && subject.detailMask).map(subject => subject.detailMask!);
  // Small label details should use every available reconstruction-source pixel;
  // the lower body-analysis resolution is a separate CPU/memory budget.
  const propImage = objectSourceImage ?? sourceImage;
  const propSource = propMasks.length ? pixels(propImage, propImage.naturalWidth, propImage.naturalHeight) : detailSource;
  // A held prop is now independent geometry. Remove only its learned pixels
  // from body textures, otherwise a second painted can stays on the shirt when
  // the real prop is picked up. Fingers excluded by the mask remain visible.
  const personSource = propMasks.length ? fillHiddenPixels(detailSource, propMasks) : detailSource;
  const people = subjects.filter((subject) => subject.kind === "person");
  const poseRigs = people.map((subject) =>
    subject.neuralAsset
      ? undefined
      : fitHumanPose(subject.humanPose, personSource),
  );
  const appearances = people.map((subject) =>
    analyzeHumanAppearance({
      source: personSource,
      mask: subject.detailMask!,
      box: subject.box,
      label: subject.label,
    }),
  );
  poseRigs.forEach((rig, i) => {
    if (rig) appearances[i] = poseAppearance(appearances[i], rig, personSource);
  });
  const personScales = humanPoseScales(
    poseRigs.map((poseRig) => ({ poseRig })),
  );
  const posePhotographs: (
    ReturnType<typeof capturePosePhotographs> | undefined
  )[] = [];
  const buildPerson = async (
    i: number,
    choice: BodyShapeChoice = "photo-fit",
    allowFallback = false,
  ) => {
    const subject = people[i];
    const asset =
      subject.neuralAsset && choice !== "photo-fit"
        ? selectNeuralAssetShape(subject.neuralAsset, choice)
        : subject.neuralAsset;
    if (asset) {
      try {
        const { loadNeuralAsset } = await import("./neural-asset");
        const body = await loadNeuralAsset(
          asset,
          appearances[i].height ?? 1.76,
        );
        try {
          if (
            asset.appearance === "vertex-color" &&
            ["inferred-full-body", "anatomical-template"].includes(
              asset.inputKind,
            )
          ) {
            const { fitNeuralHumanPhotographs } =
              await import("./neural-photo-fitting");
            const fitted = await fitNeuralHumanPhotographs(body.group, {
              source: personSource,
              mask: subject.detailMask!,
              appearance: appearances[i],
              photographicBody: subject.photographicBody,
            });
            const releaseModel = body.dispose;
            body.dispose = () => {
              fitted.dispose?.();
              releaseModel();
            };
            // Reference atlases face +Z. Restore the photographed body's
            // direction only after baking its front and rear references.
            body.group.rotation.y = appearances[i].yaw ?? 0;
            body.group.updateMatrixWorld(true);
            body.bounds.setFromObject(body.group, true);
          }
          return body;
        } catch (error) {
          body.dispose();
          throw error;
        }
      } catch (error) {
        if (!allowFallback) throw error;
        // A failed optional model must not prevent the archived photo from opening.
        // Keep the source-grounded complete-body fallback and record its use.
      }
    }
    const rig = poseRigs[i];
    if (rig) {
      try {
        const {
          loadHumanPoseTemplate,
          deformHumanTemplate,
          choosePoseTemplateShape,
        } = await import("./posed-template");
        const shape =
          choice !== "photo-fit" ? choice : choosePoseTemplateShape(rig);
        const body = await loadHumanPoseTemplate(shape);
        try {
          deformHumanTemplate(body.group, rig);
          const fitted = posePhotographs[i]
            ? posePhotographs[i]!(body.group)
            : await fitPosedHumanPhotographs(body.group, rig, {
                source: personSource,
                mask: subject.detailMask!,
                appearance: appearances[i],
              });
          posePhotographs[i] ??= capturePosePhotographs(body.group);
          const dispose = body.dispose;
          body.dispose = () => {
            fitted.dispose();
            dispose();
          };
          body.group.scale.setScalar(personScales[i]);
          body.group.updateMatrixWorld(true);
          body.bounds.setFromObject(body.group, true);
          return body;
        } catch (error) {
          body.dispose();
          throw error;
        }
      } catch {
        // A missing optional template still has a closed, articulated fallback.
      }
    }
    const body = buildHumanBody({
      source: personSource,
      mask: subject.detailMask!,
      box: subject.box,
      label: subject.label,
      appearance: appearances[i],
      photographicBody: subject.photographicBody,
      poseRig: rig,
    });
    if (rig) {
      body.group.scale.setScalar(personScales[i]);
      body.group.updateMatrixWorld(true);
      body.bounds.setFromObject(body.group, true);
      body.group.userData.poseTemplateFallback = true;
    }
    if (subject.neuralAsset) body.group.userData.neuralAssetFallback = true;
    return body;
  };
  const humans = await Promise.all(
    people.map((_, i) => buildPerson(i, "photo-fit", true)),
  );
  const groundingOffsets = humans.map((human) => human.group.position.y);
  const masks = subjects.map((subject) => subject.mask);
  const excludedPixels = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const value = masks.reduce(
      (max, mask) => Math.max(max, Number(mask.data[i * 4])),
      0,
    );
    excludedPixels.set([value, value, value, 255], i * 4);
  }
  const hiddenSource =
    backgroundImage ?? canvasOf(fillHiddenPixels(source, masks));
  const texture = textureOf(sourceImage);
  const backgroundTexture = textureOf(hiddenSource);
  const rearTexture = rearImage ? textureOf(rearImage) : undefined;
  const panoramaTexture = panoramaImage ? textureOf(panoramaImage) : undefined;
  const group = new THREE.Group();
  group.name = "Full-body memory world";
  const surfaceGeometry = new THREE.BufferGeometry();
  const backgroundMaterial = new THREE.MeshBasicMaterial({
    map: backgroundTexture,
    side: THREE.FrontSide,
  });
  const surface = new THREE.Mesh(surfaceGeometry, backgroundMaterial);
  surface.name = "Original landscape depth surface";
  // Portrait scenes are rebuilt from actual objects. No giant source-photo wall
  // remains behind the bodies or gets wrapped onto the ground or sky.
  surface.visible = people.length === 0;
  group.add(surface);
  const environment = buildPhotoEnvironment({
    source: pixels(
      hiddenSource instanceof HTMLImageElement ? hiddenSource : sourceImage,
      detailWidth,
      detailHeight,
    ),
    photoTexture: backgroundTexture,
    panoramaTexture,
    environment: completion?.environment,
    sceneEnvironment: input.sceneEnvironment,
    fov: input.fov,
    horizon: completion?.horizon,
    excludedMask: { width, height, data: excludedPixels },
    textureSource: completion?.textureSource,
  });
  group.add(environment.group);
  humans.forEach((human) => group.add(human.group));
  // Retain these independent groups for controller grabs. Slider changes only
  // update their original layout, never replace held geometry or its materials.
  const recognizedProps = subjects
    .filter((subject) => subject.kind === "object" && subject.object)
    .map((subject) => ({
      subject,
      ...buildMemoryProp({
        id: subject.id,
        label: subject.label,
        object: subject.object!,
        source: propSource,
        mask: subject.objectMask,
        box: subject.box,
      }),
    }));
  recognizedProps.forEach((prop) => group.add(prop.group));
  const props: Reconstruction["props"] = recognizedProps.map((prop) => ({
    id: prop.subject.id,
    label: prop.subject.label,
    group: prop.group,
    movable: input.mediaType !== "video",
  }));
  const shadowPixels = new Uint8Array(64 * 64 * 4);
  for (let y = 0; y < 64; y++)
    for (let x = 0; x < 64; x++) {
      const radius = Math.hypot((x - 31.5) / 31.5, (y - 31.5) / 31.5);
      shadowPixels[(y * 64 + x) * 4 + 3] = Math.round(
        70 * Math.pow(Math.max(0, 1 - radius), 2),
      );
    }
  const shadowTexture = new THREE.DataTexture(shadowPixels, 64, 64);
  shadowTexture.needsUpdate = true;
  const shadowMaterial = new THREE.MeshBasicMaterial({
    map: shadowTexture,
    transparent: true,
    depthWrite: false,
    toneMapped: false,
  });
  const shadowGeometry = new THREE.PlaneGeometry(1.1, 0.8);
  const contactShadows = humans.map(() => {
    const shadow = new THREE.Mesh(shadowGeometry, shadowMaterial);
    shadow.name = "Soft contact shadow beneath completed feet";
    shadow.rotation.x = -Math.PI / 2;
    group.add(shadow);
    return shadow;
  });
  const frontMaterial = new THREE.MeshBasicMaterial({
    map: texture,
    side: THREE.FrontSide,
  });
  const backMaterial = new THREE.MeshStandardMaterial({
    map: rearTexture ?? null,
    vertexColors: !rearTexture,
    color: 0xffffff,
    roughness: 0.92,
    side: THREE.FrontSide,
  });
  const volumeMeshes: THREE.Mesh<THREE.BufferGeometry, THREE.Material[]>[] = [];
  const cloudGeometry = new THREE.BufferGeometry();
  const cloudMaterial = pointMaterial(texture);
  const cloud = new THREE.Points(cloudGeometry, cloudMaterial);
  cloud.visible = false;
  group.add(cloud);
  const navigation: Reconstruction["navigation"] = {
    target: [0, 1, -3.8],
    front: [0, 1.6, 0.5],
    side: [4, 1.6, -3.8],
    behind: [0, 1.6, -7.2],
    bounds: { min: [-20, 0.45, -29], max: [20, 12, 12] },
  };
  let pointMode = false;
  const addObstacle = (bounds: THREE.Box3) => {
    if (bounds.isEmpty()) return;
    const center = bounds.getCenter(new THREE.Vector3());
    navigation.obstacles!.push({
      x: center.x,
      z: center.z,
      radiusX: Math.max(0.12, (bounds.max.x - bounds.min.x) / 2),
      radiusZ: Math.max(0.12, (bounds.max.z - bounds.min.z) / 2),
      minY: bounds.min.y,
      maxY: bounds.max.y,
    });
  };
  let currentStrength = input.strength ?? 1.25;
  const setStrength = (strength: number) => {
    currentStrength = strength;
    const projected = createDepthGeometry(depth, {
      ...input,
      aspect,
      strength,
    });
    surfaceGeometry.dispose();
    surfaceGeometry.setAttribute(
      "position",
      new THREE.BufferAttribute(projected.positions, 3),
    );
    surfaceGeometry.setAttribute(
      "uv",
      new THREE.BufferAttribute(projected.uvs, 2),
    );
    surfaceGeometry.setIndex(new THREE.BufferAttribute(projected.indices, 1));
    surfaceGeometry.computeBoundingSphere();
    cloudGeometry.dispose();
    cloudGeometry.setAttribute(
      "position",
      new THREE.BufferAttribute(projected.positions, 3),
    );
    cloudGeometry.setAttribute(
      "uv",
      new THREE.BufferAttribute(projected.uvs, 2),
    );
    cloudGeometry.computeBoundingSphere();
    for (const mesh of volumeMeshes) {
      group.remove(mesh);
      mesh.geometry.dispose();
    }
    volumeMeshes.length = 0;
    navigation.obstacles = [...environment.obstacles];
    const bounds = new THREE.Box3();
    const positions = layoutHumanBodies(
      people.map((person, i) => ({
        box: person.box,
        faceBox: appearances[i].faceBox,
        mask: person.mask,
        poseRig: poseRigs[i],
        bodyMinY: humans[i].bounds.min.y / personScales[i],
        bodyScale: personScales[i],
      })),
      depth,
      strength,
      { fov: input.fov },
    );
    humans.forEach((human, i) => {
      human.group.position.fromArray(positions[i]);
      human.group.position.y += groundingOffsets[i];
      human.group.visible = !pointMode;
      human.group.updateMatrixWorld(true);
      contactShadows[i].position.set(
        positions[i][0],
        0.008,
        positions[i][2] + 0.04,
      );
      contactShadows[i].visible = !pointMode;
      // Builder bounds include body scale/yaw and its grounding correction.
      const bodyBounds = human.bounds
        .clone()
        .translate(new THREE.Vector3(...positions[i]));
      bounds.union(bodyBounds);
      addObstacle(bodyBounds);
    });
    const captureHeight = estimateCaptureHeight(
      poseRigs.flatMap((rig, i) => {
        const face = appearances[i].faceBox;
        if (!rig || !face) return [];
        const head = rig.joints.head
          .clone()
          .multiplyScalar(personScales[i])
          .add(humans[i].group.position);
        return [
          {
            worldY: head.y,
            depth: -head.z,
            photoV: (face[0] + face[2]) / 2,
            confidence: rig.confidenceByJoint.head,
          },
        ];
      }),
      input.fov ?? 60,
    );
    recognizedProps.forEach((prop) => {
      // An object that has been picked up must not snap out of a controller or
      // back to its original photograph when another scene setting changes.
      if (
        prop.group.parent === group &&
        prop.group.userData.memoryPropMoved !== true
      ) {
        const placement = placeMemoryProp({
          ...input,
          box: prop.subject.box,
          object: prop.subject.object!,
          depth,
          mask: prop.subject.mask,
          aspect,
          strength,
          cameraHeight: captureHeight,
        });
        prop.group.position.fromArray(placement.position);
        prop.group.scale.setScalar(placement.scale);
      }
      prop.group.visible = !pointMode;
      prop.group.updateMatrixWorld(true);
      bounds.union(new THREE.Box3().setFromObject(prop.group));
      // Movable small props cannot leave stale navigation collision cylinders.
      // Their complete geometry remains available for controller ray hits.
    });
    for (const subject of subjects.filter(
      (subject) => subject.kind !== "person" && !subject.object,
    )) {
      try {
        const volume = createClosedVolume(
          projected,
          subject.mask,
          source,
          subject.thickness * Math.max(0.65, Math.sqrt(strength)),
        );
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute(
          "position",
          new THREE.BufferAttribute(volume.positions, 3),
        );
        geometry.setAttribute("uv", new THREE.BufferAttribute(volume.uvs, 2));
        geometry.setAttribute(
          "color",
          new THREE.BufferAttribute(volume.colors, 3),
        );
        geometry.setIndex(new THREE.BufferAttribute(volume.indices, 1));
        geometry.addGroup(0, volume.frontIndexCount, 0);
        geometry.addGroup(
          volume.frontIndexCount,
          volume.indices.length - volume.frontIndexCount,
          1,
        );
        geometry.computeVertexNormals();
        geometry.computeBoundingSphere();
        const mesh = new THREE.Mesh(geometry, [frontMaterial, backMaterial]);
        mesh.name = `${subject.label} — colored object reconstruction`;
        mesh.visible = !pointMode;
        group.add(mesh);
        volumeMeshes.push(mesh);
        const objectBounds = new THREE.Box3(
          new THREE.Vector3(...volume.bounds.min),
          new THREE.Vector3(...volume.bounds.max),
        );
        bounds.union(objectBounds);
        addObstacle(objectBounds);
      } catch {
        /* Subpixel silhouettes remain in the landscape depth surface. */
      }
    }
    if (!bounds.isEmpty()) {
      const center = bounds.getCenter(new THREE.Vector3());
      navigation.target = [
        center.x,
        people.length ? 1 : Math.max(1.2, Math.min(2.2, center.y)),
        center.z,
      ];
      const framing = Math.max(2.7, (bounds.max.x - bounds.min.x) * 0.9);
      navigation.front = [center.x, 1.6, Math.min(10, bounds.max.z + framing)];
      if (poseRigs.some(Boolean)) {
        // Automatic placement uses rays from the source camera. Reframing from
        // the bounding-box center adds parallax and opens gaps in a close group.
        navigation.front = [0, captureHeight, 0];
        navigation.frontTarget = [0, captureHeight, -4];
      }
      navigation.side = [
        Math.min(18, bounds.max.x + framing),
        1.6,
        center.z + 0.4,
      ];
      navigation.behind = [
        center.x,
        1.6,
        Math.max(-27, bounds.min.z - framing),
      ];
    }
    group.userData.completedBodies = humans.length;
    group.userData.poseFittedBodies = humans.filter(
      (human) => human.group.userData.humanPoseFitted === true,
    ).length;
    group.userData.poseEstimatedBodies = humans.length;
    group.userData.completedVolumes = volumeMeshes.length + props.length;
    group.userData.completedProps = props.length;
    group.userData.semanticSource = completion?.generatedBy ?? "depth-fallback";
  };
  setStrength(input.strength ?? 1.25);
  const bodyShapes = createBodyShapeController(
    humans,
    buildPerson,
    (next, previous) => {
      previous.forEach((human) => group.remove(human.group));
      humans.splice(0, humans.length, ...next);
      groundingOffsets.splice(
        0,
        groundingOffsets.length,
        ...next.map((human) => human.group.position.y),
      );
      next.forEach((human) => group.add(human.group));
      setStrength(currentStrength);
    },
  );
  return {
    group,
    surface,
    props,
    navigation,
    setStrength,
    hasBodyShapes:
      poseRigs.some(Boolean) ||
      people.some((subject) => Boolean(subject.neuralAsset?.shapeVariants)),
    setBodyShape: bodyShapes.select,
    setPointMode: (enabled) => {
      pointMode = enabled;
      surface.visible = !enabled && people.length === 0;
      cloud.visible = enabled;
      environment.group.visible = !enabled;
      humans.forEach((human) => {
        human.group.visible = !enabled;
      });
      contactShadows.forEach((shadow) => {
        shadow.visible = !enabled;
      });
      volumeMeshes.forEach((mesh) => {
        mesh.visible = !enabled;
      });
      recognizedProps.forEach((prop) => {
        prop.group.visible = !enabled;
      });
    },
    setTexture: (next) => {
      // Human bodies use the reconstruction frame's inferred clothing/face atlas.
      // Video still updates the landscape surface and diagnostic point view.
      frontMaterial.map = next;
      frontMaterial.needsUpdate = true;
      backgroundMaterial.map = next;
      backgroundMaterial.needsUpdate = true;
      cloudMaterial.uniforms.image.value = next;
    },
    dispose: () => {
      surfaceGeometry.dispose();
      cloudGeometry.dispose();
      volumeMeshes.forEach((mesh) => mesh.geometry.dispose());
      recognizedProps.forEach((prop) => prop.dispose());
      bodyShapes.dispose();
      posePhotographs.length = 0;
      backgroundMaterial.dispose();
      frontMaterial.dispose();
      backMaterial.dispose();
      cloudMaterial.dispose();
      texture.dispose();
      backgroundTexture.dispose();
      rearTexture?.dispose();
      panoramaTexture?.dispose();
      shadowTexture.dispose();
      shadowMaterial.dispose();
      shadowGeometry.dispose();
      environment.dispose();
    },
  };
}
