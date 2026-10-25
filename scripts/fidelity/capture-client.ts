import * as THREE from "three";
// The capture runner resolves these imports to the same immutable baseline tree.
// @ts-expect-error Resolved by the capture runner's esbuild plugin.
import { createPhotoSurface } from "fidelity-frozen-surface";
// @ts-expect-error Resolved by the capture runner's esbuild plugin.
import { cleanPhotoDepth } from "fidelity-frozen-clean";
import { capDepthNearest } from "./capture-math.js";

interface BrowserConfig {
  width: number;
  height: number;
  baselineMeshMaxEdge: number;
  candidateMeshMaxEdge: number;
  projection: {
    near: number;
    far: number;
    fov: number;
    strength: number;
    cameraHeight: number;
  };
  views: { name: string; offset: [number, number, number] }[];
}

const loadImage = (src: string) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`Image decode failed: ${src}`));
    image.src = src;
  });

function pixels(image: HTMLImageElement) {
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("2D canvas unavailable");
  context.drawImage(image, 0, 0);
  return context.getImageData(0, 0, canvas.width, canvas.height);
}

function texture(image: HTMLImageElement) {
  const result = new THREE.Texture(image);
  result.colorSpace = THREE.SRGBColorSpace;
  result.anisotropy = 8;
  result.minFilter = THREE.LinearMipmapLinearFilter;
  result.needsUpdate = true;
  return result;
}

function geometry(data: {
  positions: Float32Array;
  uvs: Float32Array;
  indices: Uint32Array;
}) {
  const result = new THREE.BufferGeometry();
  result.setAttribute("position", new THREE.BufferAttribute(data.positions, 3));
  result.setAttribute("uv", new THREE.BufferAttribute(data.uvs, 2));
  result.setIndex(new THREE.BufferAttribute(data.indices, 1));
  result.computeBoundingSphere();
  return result;
}

async function start() {
  const config: BrowserConfig = await (await fetch("/config.json")).json();
  const [source, background, oldDepth, newDepth] = await Promise.all([
    loadImage("/source-image"),
    loadImage("/background-image"),
    loadImage("/baseline-depth"),
    loadImage("/candidate-depth"),
  ]);
  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: false,
    preserveDrawingBuffer: true,
  });
  renderer.setPixelRatio(1);
  renderer.setSize(config.width, config.height);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.setClearColor(0x000000, 1);
  document.body.appendChild(renderer.domElement);
  const gl = renderer.getContext();
  const debug = gl.getExtension("WEBGL_debug_renderer_info");
  const sourceTexture = texture(source);
  const backgroundTexture = texture(background);
  const options = {
    ...config.projection,
    aspect: source.naturalWidth / source.naturalHeight,
  };
  const camera = new THREE.PerspectiveCamera(
    options.fov,
    options.aspect,
    0.04,
    100,
  );
  const frontMaterial = new THREE.MeshBasicMaterial({
    map: sourceTexture,
    side: THREE.FrontSide,
  });
  const backgroundMaterial = new THREE.MeshBasicMaterial({
    map: backgroundTexture,
    side: THREE.FrontSide,
  });
  const whiteMaterial = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    side: THREE.FrontSide,
  });
  const variants: Record<
    string,
    {
      scene: THREE.Scene;
      foreground: THREE.Mesh;
      backing?: THREE.Mesh;
      metadata: object;
    }
  > = {};
  for (const [name, image, cap] of [
    ["baseline", oldDepth, config.baselineMeshMaxEdge],
    ["candidate", newDepth, config.candidateMeshMaxEdge],
  ] as const) {
    const raw = pixels(image);
    const depth = cleanPhotoDepth(capDepthNearest(raw, cap));
    const data = createPhotoSurface(depth, options);
    const foreground = new THREE.Mesh(geometry(data.foreground), frontMaterial);
    const backing = new THREE.Mesh(
      geometry(data.background),
      backgroundMaterial,
    );
    const scene = new THREE.Scene();
    scene.add(backing, foreground);
    variants[name] = {
      scene,
      foreground,
      backing,
      metadata: {
        inputDepthDimensions: {
          width: image.naturalWidth,
          height: image.naturalHeight,
        },
        meshDepthDimensions: { width: depth.width, height: depth.height },
        vertices: data.foreground.positions.length / 3,
        triangles: data.foreground.indices.length / 3,
        rejectedTriangles:
          (depth.width - 1) * (depth.height - 1) * 2 -
          data.foreground.indices.length / 3,
        edgeVertices: data.foreground.edgeVertexIndices.length,
      },
    };
  }
  const distance = 2 / (1 / options.near + 1 / options.far);
  const height =
    2 * Math.tan(THREE.MathUtils.degToRad(options.fov / 2)) * distance;
  const plane = new THREE.Mesh(
    new THREE.PlaneGeometry(height * options.aspect, height),
    frontMaterial,
  );
  plane.position.set(0, options.cameraHeight, -distance);
  const planeScene = new THREE.Scene();
  planeScene.add(plane);
  variants.plane = {
    scene: planeScene,
    foreground: plane,
    metadata: { triangles: 2, distance },
  };

  const capture = (variant: string, viewName: string, coverage = false) => {
    const item = variants[variant];
    const view = config.views.find((entry) => entry.name === viewName);
    if (!item || !view) throw new Error("Unknown variant or view");
    camera.position.set(
      view.offset[0],
      options.cameraHeight + view.offset[1],
      view.offset[2],
    );
    camera.rotation.set(0, 0, 0); // Fixed orientation, pure translation; no look-at recentering.
    camera.updateMatrixWorld(true);
    camera.updateProjectionMatrix();
    item.foreground.material = coverage ? whiteMaterial : frontMaterial;
    if (item.backing) item.backing.visible = !coverage;
    // Warm shaders and uploads before timing a steady render and completion fence.
    renderer.render(item.scene, camera);
    gl.finish();
    const before = performance.now();
    renderer.render(item.scene, camera);
    gl.finish();
    const renderMs = performance.now() - before;
    const image = renderer.domElement.toDataURL("image/png");
    return {
      image,
      metadata: {
        variant,
        view: view.name,
        coverage,
        renderMs,
        cameraPosition: camera.position.toArray(),
        cameraWorldMatrix: camera.matrixWorld.toArray(),
        cameraViewMatrix: camera.matrixWorldInverse.toArray(),
        cameraProjectionMatrix: camera.projectionMatrix.toArray(),
        renderedTriangles: renderer.info.render.triangles,
      },
    };
  };
  Object.assign(window, {
    fidelityCapture: {
      capture,
      metadata: {
        width: config.width,
        height: config.height,
        sourceDimensions: {
          width: source.naturalWidth,
          height: source.naturalHeight,
        },
        projection: options,
        variants: Object.fromEntries(
          Object.entries(variants).map(([name, value]) => [
            name,
            value.metadata,
          ]),
        ),
        renderer: {
          version: THREE.REVISION,
          antialias: gl.getContextAttributes()?.antialias,
          alpha: false,
          pixelRatio: 1,
          toneMapping: "NoToneMapping",
          outputColorSpace: "srgb",
          vendor: debug
            ? gl.getParameter(debug.UNMASKED_VENDOR_WEBGL)
            : gl.getParameter(gl.VENDOR),
          renderer: debug
            ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)
            : gl.getParameter(gl.RENDERER),
        },
      },
    },
  });
}

start().catch((error: unknown) =>
  Object.assign(window, {
    fidelityCaptureError: error instanceof Error ? error.stack : String(error),
  }),
);
