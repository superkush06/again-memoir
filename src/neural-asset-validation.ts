export const HUMAN_BODY_SHAPES = ['slim', 'average', 'broad'] as const;
export type HumanBodyShape = typeof HUMAN_BODY_SHAPES[number];

/** Metadata for a self-contained reconstruction or an explicitly authored template. */
export interface NeuralAssetDescriptor {
  url: string;
  model: 'triposr' | 'hunyuan3d-2.1' | 'trellis-2' | 'makehuman' | 'blender-studio';
  upAxis: 'y' | 'z';
  /** Radians after the up-axis conversion. */
  frontYaw: number;
  appearance: 'vertex-color' | 'pbr';
  inputKind: 'source-photo' | 'inferred-full-body' | 'anatomical-template';
  /** The manifest's selected template. All variants share the orientation and appearance metadata. */
  shape?: HumanBodyShape;
  shapeVariants?: Record<HumanBodyShape, string>;
  /** Reviewed template head pose in radians, applied before photographic fitting. */
  headYaw?: number;
  /** Reviewed source crops in normalized [top,left,bottom,right] image coordinates. */
  sourceFaceBox?: [number, number, number, number];
  sourceNeckBox?: [number, number, number, number];
}

export const NEURAL_ASSET_LIMITS = {
  bytes: 32 * 1024 * 1024,
  vertices: 200_000,
  triangles: 500_000,
  meshes: 128,
  nodes: 512,
} as const;

export function isNeuralAssetDescriptor(value: unknown): value is NeuralAssetDescriptor {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  const allowed = new Set(['url', 'model', 'upAxis', 'frontYaw', 'appearance', 'inputKind', 'shape', 'shapeVariants', 'headYaw', 'sourceFaceBox', 'sourceNeckBox']);
  const assetUrl = (url: unknown): url is string => typeof url === 'string'
    && /^\/uploads\/reconstructions\/[A-Za-z0-9_-]{1,160}\.glb$/.test(url);
  const authored = ['makehuman', 'blender-studio'].includes(String(item.model));
  if ((item.inputKind === 'anatomical-template') !== authored) return false;
  if (item.headYaw !== undefined && (!authored || typeof item.headYaw !== 'number'
    || !Number.isFinite(item.headYaw) || Math.abs(item.headYaw) > Math.PI / 2)) return false;
  for (const box of [item.sourceFaceBox, item.sourceNeckBox]) {
    if (box === undefined) continue;
    if (!authored || !Array.isArray(box) || box.length !== 4
      || !box.every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1)
      || box[2] - box[0] < .005 || box[3] - box[1] < .005) return false;
  }
  if (item.shape !== undefined || item.shapeVariants !== undefined) {
    if (!authored || !HUMAN_BODY_SHAPES.includes(item.shape as HumanBodyShape)
      || !item.shapeVariants || typeof item.shapeVariants !== 'object' || Array.isArray(item.shapeVariants)) return false;
    const variants = item.shapeVariants as Record<string, unknown>;
    if (Object.keys(variants).length !== 3 || !HUMAN_BODY_SHAPES.every(shape => assetUrl(variants[shape]))
      || new Set(Object.values(variants)).size !== 3 || item.url !== variants[item.shape as HumanBodyShape]) return false;
  }
  return Object.keys(item).every(key => allowed.has(key))
    && assetUrl(item.url)
    && ['triposr', 'hunyuan3d-2.1', 'trellis-2', 'makehuman', 'blender-studio'].includes(String(item.model))
    && ['y', 'z'].includes(String(item.upAxis))
    && typeof item.frontYaw === 'number' && Number.isFinite(item.frontYaw) && Math.abs(item.frontYaw) <= Math.PI * 2
    && ['vertex-color', 'pbr'].includes(String(item.appearance))
    && ['source-photo', 'inferred-full-body', 'anatomical-template'].includes(String(item.inputKind));
}

/** Select another actual mesh while leaving the manifest's default untouched. */
export function selectNeuralAssetShape(descriptor: NeuralAssetDescriptor, shape: HumanBodyShape): NeuralAssetDescriptor {
  if (!isNeuralAssetDescriptor(descriptor) || !HUMAN_BODY_SHAPES.includes(shape)) throw new Error('Invalid human body shape selection');
  if (!descriptor.shapeVariants) return descriptor;
  return { ...descriptor, shape, url: descriptor.shapeVariants[shape] };
}

type RecordValue = Record<string, any>;
const integer = (value: unknown, min = 0): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= min;
const record = (value: unknown): value is RecordValue => !!value && typeof value === 'object' && !Array.isArray(value);
const fail = (message: string): never => { throw new Error(`Invalid neural GLB: ${message}`); };

/** Validate before GLTFLoader sees the file. No network resources or decoders are accepted. */
export function validateNeuralGlb(buffer: ArrayBuffer): { vertices: number; triangles: number } {
  if (buffer.byteLength < 28 || buffer.byteLength > NEURAL_ASSET_LIMITS.bytes) fail('file size is outside the allowed range');
  const view = new DataView(buffer);
  if (view.getUint32(0, true) !== 0x46546c67 || view.getUint32(4, true) !== 2 || view.getUint32(8, true) !== buffer.byteLength) fail('expected a complete GLB 2 file');
  let offset = 12;
  let json: RecordValue | undefined;
  let binaryOffset = 0;
  let binaryLength = 0;
  while (offset < buffer.byteLength) {
    if (offset + 8 > buffer.byteLength) fail('truncated chunk header');
    const length = view.getUint32(offset, true);
    const type = view.getUint32(offset + 4, true);
    if (length % 4 || offset + 8 + length > buffer.byteLength) fail('invalid chunk range');
    if (type === 0x4e4f534a && offset === 12 && !json) {
      if (length > 4 * 1024 * 1024) fail('JSON metadata is too large');
      try { json = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, offset + 8, length))); }
      catch { fail('invalid JSON metadata'); }
    } else if (type === 0x004e4942 && json && !binaryOffset) {
      binaryOffset = offset + 8;
      binaryLength = length;
    } else fail('unexpected or duplicate chunk');
    offset += length + 8;
  }
  if (!record(json) || json.asset?.version !== '2.0' || !binaryOffset) fail('missing glTF asset or binary data');
  const document = json!;
  // Extensions can contain alternate image/buffer URIs too; reject these recursively.
  const checkMetadata = (value: unknown, depth = 0) => {
    if (depth > 48) fail('metadata nesting is too deep');
    if (typeof value === 'number' && !Number.isFinite(value)) fail('non-finite metadata');
    if (Array.isArray(value)) value.forEach(child => checkMetadata(child, depth + 1));
    else if (record(value)) for (const [key, child] of Object.entries(value)) {
      if (key === 'uri') fail('external and data-URI resources are not allowed');
      checkMetadata(child, depth + 1);
    }
  };
  checkMetadata(document);
  const extensions = [...(document.extensionsUsed ?? []), ...(document.extensionsRequired ?? [])];
  if (!extensions.every(name => typeof name === 'string') || extensions.some(name => /draco|meshopt|basisu/i.test(name))) fail('compressed resources require an unsupported decoder');
  if (!Array.isArray(document.buffers) || document.buffers.length !== 1 || !integer(document.buffers[0]?.byteLength, 1)
    || document.buffers[0].byteLength > binaryLength || binaryLength - document.buffers[0].byteLength > 3) fail('invalid embedded buffer');
  const views = document.bufferViews;
  if (!Array.isArray(views) || !views.length || views.length > 2048) fail('invalid buffer views');
  for (const item of views) {
    if (!record(item) || item.buffer !== 0 || !integer(item.byteOffset ?? 0) || !integer(item.byteLength, 1)
      || (item.byteOffset ?? 0) + item.byteLength > document.buffers[0].byteLength) fail('buffer view exceeds its buffer');
    if (item.byteStride !== undefined && (!integer(item.byteStride, 4) || item.byteStride > 252 || item.byteStride % 4)) fail('invalid byte stride');
  }
  const accessors = document.accessors;
  if (!Array.isArray(accessors) || !accessors.length || accessors.length > 2048) fail('invalid accessors');
  const componentBytes: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
  const components: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
  let totalComponents = 0;
  for (const accessor of accessors) {
    if (!record(accessor) || accessor.sparse !== undefined || !integer(accessor.bufferView) || !views[accessor.bufferView]
      || !integer(accessor.byteOffset ?? 0) || !integer(accessor.count, 1) || accessor.count > NEURAL_ASSET_LIMITS.triangles * 3
      || !componentBytes[accessor.componentType] || !components[accessor.type]) fail('unsupported accessor');
    const bytes = componentBytes[accessor.componentType];
    const size = components[accessor.type];
    const item = views[accessor.bufferView];
    const stride = item.byteStride ?? bytes * size;
    if (stride < bytes * size || stride % bytes || (accessor.byteOffset ?? 0) % bytes
      || ((item.byteOffset ?? 0) + (accessor.byteOffset ?? 0)) % bytes
      || (accessor.byteOffset ?? 0) + (accessor.count - 1) * stride + bytes * size > item.byteLength) fail('accessor exceeds its buffer view');
    totalComponents += accessor.count * size;
    if (totalComponents > 16_000_000) fail('too many attribute components');
    if (accessor.componentType === 5126) {
      const start = binaryOffset + (item.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
      for (let row = 0; row < accessor.count; row++) for (let component = 0; component < size; component++) {
        const value = view.getFloat32(start + row * stride + component * bytes, true);
        if (!Number.isFinite(value) || Math.abs(value) > 1e8) fail('non-finite or excessive geometry values');
      }
    }
  }
  if (!Array.isArray(document.meshes) || !document.meshes.length || document.meshes.length > NEURAL_ASSET_LIMITS.meshes) fail('invalid meshes');
  let vertices = 0;
  let triangles = 0;
  for (const mesh of document.meshes) {
    if (!Array.isArray(mesh?.primitives) || !mesh.primitives.length || mesh.primitives.length > 128) fail('invalid mesh primitives');
    for (const primitive of mesh.primitives) {
      const position = accessors[primitive?.attributes?.POSITION];
      if (!position || position.type !== 'VEC3' || position.componentType !== 5126 || (primitive.mode ?? 4) !== 4) fail('expected triangle geometry with float positions');
      for (const index of Object.values(primitive.attributes)) if (!integer(index) || !accessors[index] || accessors[index].count !== position.count) fail('inconsistent vertex attributes');
      vertices += position.count;
      let count = position.count;
      if (primitive.indices !== undefined) {
        const indices = accessors[primitive.indices];
        if (!integer(primitive.indices) || !indices || indices.type !== 'SCALAR' || ![5121, 5123, 5125].includes(indices.componentType)) fail('invalid triangle indices');
        count = indices.count;
        const item = views[indices.bufferView];
        const bytes = componentBytes[indices.componentType];
        const start = binaryOffset + (item.byteOffset ?? 0) + (indices.byteOffset ?? 0);
        for (let index = 0; index < indices.count; index++) {
          const at = start + index * (item.byteStride ?? bytes);
          const value = bytes === 1 ? view.getUint8(at) : bytes === 2 ? view.getUint16(at, true) : view.getUint32(at, true);
          if (value >= position.count) fail('triangle index exceeds its positions');
        }
      }
      if (count % 3) fail('incomplete triangle');
      triangles += count / 3;
      if (vertices > NEURAL_ASSET_LIMITS.vertices || triangles > NEURAL_ASSET_LIMITS.triangles) fail('mesh budget exceeded');
    }
  }
  if (document.images !== undefined) {
    if (!Array.isArray(document.images) || document.images.length > 32) fail('too many images');
    for (const image of document.images) if (!integer(image?.bufferView) || !views[image.bufferView]
      || !['image/png', 'image/jpeg', 'image/webp'].includes(image.mimeType)) fail('images must be embedded PNG, JPEG, or WebP');
  }
  const nodes = document.nodes;
  if (!Array.isArray(nodes) || !nodes.length || nodes.length > NEURAL_ASSET_LIMITS.nodes) fail('invalid nodes');
  const active = new Set<number>();
  const visited = new Set<number>();
  const parents = new Map<number, number>();
  const visit = (index: number) => {
    if (!integer(index) || !record(nodes[index])) fail('invalid node reference');
    if (active.has(index)) fail('cyclic node hierarchy');
    if (visited.has(index)) return;
    const node = nodes[index];
    if (node.mesh !== undefined && (!integer(node.mesh) || !document.meshes[node.mesh])) fail('invalid node mesh');
    for (const [key, length] of [['matrix', 16], ['translation', 3], ['rotation', 4], ['scale', 3]] as const) {
      if (node[key] !== undefined && (!Array.isArray(node[key]) || node[key].length !== length || !node[key].every((v: unknown) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) < 1e8))) fail('invalid node transform');
    }
    if (node.children !== undefined && !Array.isArray(node.children)) fail('invalid child nodes');
    active.add(index);
    for (const child of node.children ?? []) {
      if (parents.has(child)) fail('nodes must have a single parent');
      parents.set(child, index);
      visit(child);
    }
    active.delete(index);
    visited.add(index);
  };
  nodes.forEach((_: unknown, index: number) => visit(index));
  if (!Array.isArray(document.scenes) || !document.scenes.length || document.scenes.length > 16
    || !integer(document.scene ?? 0) || !document.scenes[document.scene ?? 0]) fail('invalid scene');
  for (const scene of document.scenes) {
    if (!Array.isArray(scene?.nodes)) fail('invalid scene nodes');
    if (new Set(scene.nodes).size !== scene.nodes.length) fail('duplicate scene nodes');
    scene.nodes.forEach((index: number) => { if (!integer(index) || !nodes[index] || parents.has(index)) fail('invalid scene node'); });
  }
  return { vertices, triangles };
}
