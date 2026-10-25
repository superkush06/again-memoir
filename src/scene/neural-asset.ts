import * as THREE from 'three';
import { isNeuralAssetDescriptor, NEURAL_ASSET_LIMITS, validateNeuralGlb, type NeuralAssetDescriptor } from '../neural-asset-validation';

async function readBoundedResponse(response: Response): Promise<ArrayBuffer> {
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Neural model download failed (${response.status})`);
  }
  const declared = Number(response.headers.get('content-length'));
  if (declared > NEURAL_ASSET_LIMITS.bytes) {
    await response.body?.cancel();
    throw new Error('Neural model exceeds the file size limit');
  }
  if (!response.body) throw new Error('Neural model response is empty');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > NEURAL_ASSET_LIMITS.bytes) {
        await reader.cancel();
        throw new Error('Neural model exceeds the file size limit');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const buffer = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength; }
  return buffer.buffer;
}

export async function loadNeuralAsset(descriptor: NeuralAssetDescriptor, appearanceHeight = 1.76) {
  if (!isNeuralAssetDescriptor(descriptor)) throw new Error('Invalid neural asset descriptor');
  const response = await fetch(descriptor.url, { cache: 'no-cache', redirect: 'error', signal: AbortSignal.timeout(45_000) });
  return parseNeuralAsset(await readBoundedResponse(response), descriptor, appearanceHeight);
}

/** Real model geometry is kept intact; only orientation, size and its ground anchor change. */
export async function parseNeuralAsset(buffer: ArrayBuffer, descriptor: NeuralAssetDescriptor, appearanceHeight = 1.76) {
  if (!isNeuralAssetDescriptor(descriptor)) throw new Error('Invalid neural asset descriptor');
  if (!Number.isFinite(appearanceHeight) || appearanceHeight < .3 || appearanceHeight > 3) throw new Error('Invalid model height');
  validateNeuralGlb(buffer);
  // Most memories use the photo-fitted renderer. Fetch the GLB implementation
  // only when an actual neural artifact has passed validation.
  const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
  const manager = new THREE.LoadingManager();
  manager.setURLModifier(url => {
    // Embedded GLB images become temporary blob URLs inside GLTFLoader. All input URIs
    // have already been rejected, so no remote/data/file URL can reach the loader.
    if (!url.startsWith('blob:')) throw new Error('Neural models must contain all their resources');
    return url;
  });
  const gltf = await new GLTFLoader(manager).parseAsync(buffer, '');
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  const trackMaterial = (material: THREE.Material) => {
    materials.add(material);
    for (const value of Object.values(material)) if (value?.isTexture === true) textures.add(value);
  };
  // Track every scene, including resources not used by the selected scene.
  for (const scene of gltf.scenes) scene.traverse(object => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    geometries.add(mesh.geometry);
    (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).forEach(trackMaterial);
  });
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    textures.forEach(texture => {
      texture.dispose();
      const image = texture.source?.data;
      if (typeof ImageBitmap !== 'undefined' && image instanceof ImageBitmap) image.close();
    });
    materials.forEach(material => material.dispose());
    geometries.forEach(geometry => geometry.dispose());
  };
  try {
    let vertices = 0;
    let triangles = 0;
    let meshCount = 0;
    gltf.scene.traverse(node => {
      const object = node as THREE.Mesh;
      if (!object.isMesh) return;
      meshCount++;
      const position = object.geometry.getAttribute('position');
      vertices += position.count;
      triangles += (object.geometry.index?.count ?? position.count) / 3;
      if (vertices > NEURAL_ASSET_LIMITS.vertices || triangles > NEURAL_ASSET_LIMITS.triangles || meshCount > NEURAL_ASSET_LIMITS.meshes) throw new Error('Neural model scene exceeds the geometry budget');
      object.castShadow = true;
      object.receiveShadow = true;
      if (descriptor.appearance === 'vertex-color') {
        if (!object.geometry.getAttribute('color')) throw new Error('Neural model declares vertex colors but has no color attribute');
        const convert = (original: THREE.Material) => {
          const source = original as THREE.MeshStandardMaterial;
          const material = new THREE.MeshBasicMaterial({
            vertexColors: true,
            color: source.color ?? 0xffffff,
            map: source.map ?? null,
            side: source.side,
            transparent: source.transparent,
            opacity: source.opacity,
            alphaTest: source.alphaTest,
            toneMapped: false,
          });
          trackMaterial(material);
          return material;
        };
        object.material = Array.isArray(object.material) ? object.material.map(convert) : convert(object.material);
      } else {
        // GLTFLoader already assigns color-space-correct maps and PBR channels.
        // Preserve them rather than inventing material maps from baked lighting.
        const list = Array.isArray(object.material) ? object.material : [object.material];
        list.forEach(material => { material.toneMapped = false; });
      }
    });
    if (!meshCount) throw new Error('Neural model has no visible mesh');
    const oriented = new THREE.Group();
    oriented.name = 'neural-model-orientation';
    oriented.rotation.y = descriptor.frontYaw;
    const upright = new THREE.Group();
    if (descriptor.upAxis === 'z') upright.rotation.x = -Math.PI / 2;
    upright.add(gltf.scene);
    oriented.add(upright);
    oriented.updateMatrixWorld(true);
    const originalBounds = new THREE.Box3().setFromObject(oriented, true);
    const size = originalBounds.getSize(new THREE.Vector3());
    if (![...originalBounds.min.toArray(), ...originalBounds.max.toArray()].every(Number.isFinite)
      || size.y < 1e-5 || size.x < 1e-5 || size.z < 1e-5 || size.x / size.y > 5 || size.z / size.y > 5) throw new Error('Neural model has invalid or flat body bounds');
    const scale = appearanceHeight / size.y;
    oriented.scale.setScalar(scale);
    const center = originalBounds.getCenter(new THREE.Vector3());
    oriented.position.set(-center.x * scale, -originalBounds.min.y * scale, -center.z * scale);
    const group = new THREE.Group();
    const authored = descriptor.inputKind === 'anatomical-template';
    group.name = `${descriptor.model} ${authored ? 'anatomical template' : 'reconstruction'}`;
    group.userData.kind = authored ? 'anatomical-human' : 'neural-human';
    group.userData.model = descriptor.model;
    group.userData.inputKind = descriptor.inputKind;
    group.userData.appearance = descriptor.appearance;
    if (descriptor.shape) group.userData.shape = descriptor.shape;
    if (descriptor.headYaw !== undefined) group.userData.templateHeadYaw = descriptor.headYaw;
    if (descriptor.sourceFaceBox) group.userData.templateSourceFaceBox = [...descriptor.sourceFaceBox];
    if (descriptor.sourceNeckBox) group.userData.templateSourceNeckBox = [...descriptor.sourceNeckBox];
    group.add(oriented);
    group.updateMatrixWorld(true);
    const bounds = new THREE.Box3().setFromObject(group, true);
    return { group, bounds, dispose };
  } catch (error) {
    dispose();
    throw error;
  }
}
