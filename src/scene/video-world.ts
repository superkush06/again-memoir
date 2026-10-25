import * as THREE from "three";
import type { VideoReconstructionSpec, WorldCompletion } from "../types";
import { isWorldCompletion } from "../world-completion-validation";
import { createDepthGeometry } from "./reconstruction";
import type { Reconstruction, ReconstructionInput } from "./volume-world";
import { buildMemoryProp, placeMemoryProp } from "./memory-props";
import type { VolumePixels } from "./volume";

/** Binary interval lookup is deterministic for scrubbing, reverse seeks and looping. */
export function videoFrameBlend(times: readonly number[], time: number) {
  if (!times.length) throw new Error("A video needs depth frames.");
  const current = Number.isFinite(time) ? time : 0;
  if (current <= times[0]) return { from: 0, to: 0, amount: 0, nearest: 0 };
  const last = times.length - 1;
  if (current >= times[last])
    return { from: last, to: last, amount: 0, nearest: last };
  let low = 0,
    high = last;
  while (high - low > 1) {
    const middle = (low + high) >> 1;
    if (times[middle] <= current) low = middle;
    else high = middle;
  }
  const amount = (current - times[low]) / (times[high] - times[low]);
  return { from: low, to: high, amount, nearest: amount < 0.5 ? low : high };
}

/** Large depth jumps are occlusions/cuts, not a surface to stretch across time. */
export function interpolateVideoPositions(
  a: Float32Array,
  b: Float32Array,
  amount: number,
  output: Float32Array,
) {
  if (a.length !== b.length || output.length !== a.length || a.length % 3)
    throw new Error("Video depth grids must match.");
  const mix = THREE.MathUtils.clamp(amount, 0, 1);
  for (let i = 0; i < a.length; i += 3) {
    const stable =
      Math.abs(a[i + 2] - b[i + 2]) <=
      Math.max(0.4, Math.min(Math.abs(a[i + 2]), Math.abs(b[i + 2])) * 0.22);
    const weight = stable ? mix : mix < 0.5 ? 0 : 1;
    for (let j = 0; j < 3; j++)
      output[i + j] = a[i + j] * (1 - weight) + b[i + j] * weight;
  }
}

async function loadImage(url: string) {
  const response = await fetch(url, { cache: "no-cache" });
  if (!response.ok)
    throw new Error(
      "A video depth frame could not be loaded. Reopen this video to rebuild it.",
    );
  const objectUrl = URL.createObjectURL(await response.blob());
  try {
    return await new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () =>
        reject(new Error("A video frame could not be decoded."));
      image.src = objectUrl;
    });
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function pixels(
  image: HTMLImageElement,
  width: number,
  height: number,
): VolumePixels {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context)
    throw new Error("This browser could not read a video depth frame.");
  context.drawImage(image, 0, 0, width, height);
  const data = context.getImageData(0, 0, width, height);
  return { width, height, data: data.data };
}

/** Video remains a sampled moving depth surface, with closed category meshes for
 * recognized props. It does not claim to recover a volumetric performance or
 * unseen moving people from a single camera. All geometry is bounded for Quest. */
export async function buildVideoReconstruction(
  input: ReconstructionInput & { video: VideoReconstructionSpec },
): Promise<Reconstruction & { updateTime(time: number): void }> {
  const firstImage = await loadImage(input.sourceUrl);
  const aspect = input.aspect ?? firstImage.width / firstImage.height;
  const width = aspect >= 1 ? 128 : Math.max(16, Math.round(128 * aspect));
  const height = aspect >= 1 ? Math.max(16, Math.round(128 / aspect)) : 128;
  let strength = input.strength ?? 1.25;
  const group = new THREE.Group();
  group.name = "Moving video memory";
  const ownedProps: ReturnType<typeof buildMemoryProp>[] = [];
  const props: Reconstruction["props"] = [];
  const ownedTexture = new THREE.Texture(firstImage);
  ownedTexture.colorSpace = THREE.SRGBColorSpace;
  ownedTexture.needsUpdate = true;
  const material = new THREE.MeshBasicMaterial({
    map: ownedTexture,
    side: THREE.DoubleSide,
  });
  const geometry = new THREE.BufferGeometry();
  const surface = new THREE.Mesh(geometry, material);
  group.add(surface);
  const pointGeometry = new THREE.BufferGeometry();
  const pointMaterial = new THREE.ShaderMaterial({
    uniforms: { image: { value: ownedTexture } },
    vertexShader:
      "varying vec2 imageUv; void main() { imageUv = uv; vec4 p = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * p; gl_PointSize = clamp(14.0 / max(.2, -p.z), 1.5, 8.0); }",
    fragmentShader:
      "uniform sampler2D image; varying vec2 imageUv; void main() { if (length(gl_PointCoord - .5) > .5) discard; gl_FragColor = texture2D(image, imageUv);\n#include <tonemapping_fragment>\n#include <colorspace_fragment>\n}",
  });
  const points = new THREE.Points(pointGeometry, pointMaterial);
  points.visible = false;
  group.add(points);
  const frames: {
    depth: VolumePixels;
    projection: ReturnType<typeof createDepthGeometry>;
    props: THREE.Group;
    objectMask: Uint8Array;
    placements: {
      item: ReturnType<typeof buildMemoryProp>;
      subject: WorldCompletion["subjects"][number];
      mask: VolumePixels;
    }[];
  }[] = [];
  const projectionOptions = () => ({ ...input, aspect, strength });
  const maskedProjection = (depth: VolumePixels, mask: Uint8Array) => {
    const projection = createDepthGeometry(depth, projectionOptions());
    const indices: number[] = [];
    for (let i = 0; i < projection.indices.length; i += 3) {
      const a = projection.indices[i],
        b = projection.indices[i + 1],
        c = projection.indices[i + 2];
      if (!mask[a] && !mask[b] && !mask[c]) indices.push(a, b, c);
    }
    return { ...projection, indices: new Uint32Array(indices) };
  };
  const dispose = () => {
    group.removeFromParent();
    ownedProps.forEach((prop) => prop.dispose());
    geometry.dispose();
    pointGeometry.dispose();
    material.dispose();
    pointMaterial.dispose();
    ownedTexture.dispose();
    // VideoTexture ownership belongs to MemoryWorld so switching memories is safe.
  };
  try {
    for (const [index, frame] of input.video.frames.entries()) {
      const depthImage = await loadImage(frame.depthUrl);
      const depth = pixels(depthImage, width, height);
      const objectMask = new Uint8Array(width * height);
      const frameProps = new THREE.Group();
      frameProps.visible = !index;
      group.add(frameProps);
      const placements: (typeof frames)[number]["placements"] = [];
      if (frame.completionUrl) {
        const response = await fetch(frame.completionUrl, {
          cache: "no-cache",
        });
        if (!response.ok)
          throw new Error("The video object metadata could not be loaded.");
        const completion: unknown = await response.json();
        if (!isWorldCompletion(completion))
          throw new Error(
            "The video object metadata is invalid. Rebuild this video.",
          );
        const sourceImage = index
          ? await loadImage(frame.sourceUrl)
          : firstImage;
        const source = pixels(
          sourceImage,
          sourceImage.width,
          sourceImage.height,
        );
        for (const subject of completion.subjects) {
          if (subject.kind !== "object" || !subject.object) continue;
          const maskImage = await loadImage(subject.maskUrl);
          const mask = pixels(maskImage, width, height);
          for (let i = 0; i < objectMask.length; i++)
            if (Number(mask.data[i * 4]) >= 128) objectMask[i] = 1;
          const item = buildMemoryProp({
            id: `${index}:${subject.id}`,
            label: subject.label,
            object: subject.object,
            source,
            mask: pixels(maskImage, source.width, source.height),
            box: subject.box,
          });
          ownedProps.push(item);
          frameProps.add(item.group);
          const placement = placeMemoryProp({
            ...projectionOptions(),
            object: subject.object,
            box: subject.box,
            depth,
            mask,
          });
          item.group.position.fromArray(placement.position);
          item.group.scale.setScalar(placement.scale);
          props.push({
            id: `${index}:${subject.id}`,
            label: subject.label,
            group: item.group,
            movable: false,
          });
          placements.push({ item, subject, mask });
        }
      }
      frames.push({
        depth,
        props: frameProps,
        objectMask,
        placements,
        projection: maskedProjection(depth, objectMask),
      });
    }
    const currentPositions = frames[0].projection.positions.slice();
    geometry.setAttribute(
      "position",
      new THREE.BufferAttribute(currentPositions, 3).setUsage(
        THREE.DynamicDrawUsage,
      ),
    );
    geometry.setAttribute(
      "uv",
      new THREE.BufferAttribute(frames[0].projection.uvs, 2),
    );
    pointGeometry.setAttribute("position", geometry.getAttribute("position"));
    pointGeometry.setAttribute("uv", geometry.getAttribute("uv"));
    let previousNearest = -1,
      lastTime = -1;
    const times = input.video.frames.map((frame) => frame.time);
    const updateTime = (time: number) => {
      if (time === lastTime) return;
      lastTime = time;
      const blend = videoFrameBlend(times, time);
      interpolateVideoPositions(
        frames[blend.from].projection.positions,
        frames[blend.to].projection.positions,
        blend.amount,
        currentPositions,
      );
      geometry.getAttribute("position").needsUpdate = true;
      if (previousNearest !== blend.nearest) {
        previousNearest = blend.nearest;
        geometry.setIndex(
          new THREE.BufferAttribute(
            frames[blend.nearest].projection.indices,
            1,
          ),
        );
        const pointIndices = Array.from(
          frames[blend.nearest].objectMask,
          (_, i) => i,
        ).filter((i) => !frames[blend.nearest].objectMask[i]);
        pointGeometry.setIndex(pointIndices);
        frames.forEach((frame, i) => {
          frame.props.visible = i === blend.nearest;
        });
      }
      geometry.computeBoundingSphere();
      pointGeometry.boundingSphere = geometry.boundingSphere;
    };
    updateTime(0);
    return {
      group,
      surface,
      props,
      navigation: {
        target: [0, 1.6, -4],
        front: [0, 1.6, 0],
        frontTarget: [0, 1.6, -4],
        side: [4, 1.6, -4],
        behind: [0, 1.6, -8],
        bounds: { min: [-10, 0, -18], max: [10, 5, 4] },
        obstacles: [],
      },
      updateTime,
      setStrength(value) {
        strength = THREE.MathUtils.clamp(value, 0.1, 3);
        for (const frame of frames) {
          frame.projection = maskedProjection(frame.depth, frame.objectMask);
          for (const { item, subject, mask } of frame.placements) {
            const placement = placeMemoryProp({
              ...projectionOptions(),
              object: subject.object!,
              box: subject.box,
              depth: frame.depth,
              mask,
            });
            item.group.position.fromArray(placement.position);
            item.group.scale.setScalar(placement.scale);
          }
        }
        const time = lastTime;
        lastTime = -1;
        previousNearest = -1;
        updateTime(time);
      },
      setPointMode(enabled) {
        surface.visible = !enabled;
        points.visible = enabled;
      },
      setTexture(texture) {
        material.map = texture;
        material.needsUpdate = true;
        pointMaterial.uniforms.image.value = texture;
      },
      hasBodyShapes: false,
      setBodyShape: async () => false,
      dispose,
    };
  } catch (error) {
    dispose();
    throw error;
  }
}
