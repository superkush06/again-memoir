import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { HUMAN_BODY_SHAPES, isNeuralAssetDescriptor, NEURAL_ASSET_LIMITS, selectNeuralAssetShape, validateNeuralGlb, type NeuralAssetDescriptor } from '../neural-asset-validation';
import { loadNeuralAsset, parseNeuralAsset } from './neural-asset';

const descriptor: NeuralAssetDescriptor = {
  url: '/uploads/reconstructions/test-triposr.glb', model: 'triposr',
  upAxis: 'y', frontYaw: 0, appearance: 'vertex-color', inputKind: 'source-photo',
};
const template: NeuralAssetDescriptor = {
  ...descriptor, model: 'makehuman', inputKind: 'anatomical-template', shape: 'average',
  url: '/uploads/reconstructions/template-average.glb',
  shapeVariants: {
    slim: '/uploads/reconstructions/template-slim.glb',
    average: '/uploads/reconstructions/template-average.glb',
    broad: '/uploads/reconstructions/template-broad.glb',
  },
};

function fixture(change?: (json: any, data: DataView) => void): ArrayBuffer {
  const positions = new Float32Array([
    2, 3, 4, 4, 3, 4, 4, 7, 4, 2, 7, 4,
    2, 3, 6, 4, 3, 6, 4, 7, 6, 2, 7, 6,
  ]);
  const colors = new Float32Array(Array.from({ length: 24 }, (_, i) => i % 3 === 0 ? .8 : i % 3 === 1 ? .2 : .1));
  const indices = new Uint16Array([0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6, 0, 4, 5, 0, 5, 1, 3, 2, 6, 3, 6, 7, 1, 5, 6, 1, 6, 2, 0, 3, 7, 0, 7, 4]);
  const binary = new Uint8Array(positions.byteLength + colors.byteLength + indices.byteLength);
  binary.set(new Uint8Array(positions.buffer));
  binary.set(new Uint8Array(colors.buffer), positions.byteLength);
  binary.set(new Uint8Array(indices.buffer), positions.byteLength + colors.byteLength);
  const json = {
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    buffers: [{ byteLength: binary.byteLength }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: positions.byteLength },
      { buffer: 0, byteOffset: positions.byteLength, byteLength: colors.byteLength },
      { buffer: 0, byteOffset: positions.byteLength + colors.byteLength, byteLength: indices.byteLength },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 8, type: 'VEC3', min: [2, 3, 4], max: [4, 7, 6] },
      { bufferView: 1, componentType: 5126, count: 8, type: 'VEC3' },
      { bufferView: 2, componentType: 5123, count: 36, type: 'SCALAR' },
    ],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: .82 } }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, COLOR_0: 1 }, indices: 2, material: 0 }] }],
  };
  change?.(json, new DataView(binary.buffer));
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jsonLength = Math.ceil(jsonBytes.byteLength / 4) * 4;
  const binaryLength = Math.ceil(binary.byteLength / 4) * 4;
  const result = new ArrayBuffer(12 + 8 + jsonLength + 8 + binaryLength);
  const view = new DataView(result);
  view.setUint32(0, 0x46546c67, true); view.setUint32(4, 2, true); view.setUint32(8, result.byteLength, true);
  view.setUint32(12, jsonLength, true); view.setUint32(16, 0x4e4f534a, true);
  new Uint8Array(result, 20, jsonLength).fill(32);
  new Uint8Array(result, 20, jsonBytes.byteLength).set(jsonBytes);
  view.setUint32(20 + jsonLength, binaryLength, true); view.setUint32(24 + jsonLength, 0x004e4942, true);
  new Uint8Array(result, 28 + jsonLength, binary.byteLength).set(binary);
  return result;
}

test('neural descriptors only allow named local GLB reconstructions', () => {
  assert.equal(isNeuralAssetDescriptor(descriptor), true);
  for (const url of ['https://example.com/a.glb', '/uploads/reconstructions/../a.glb', '/uploads/reconstructions/a.gltf', '/uploads/reconstructions/a.glb?x=1']) {
    assert.equal(isNeuralAssetDescriptor({ ...descriptor, url }), false);
  }
  assert.equal(isNeuralAssetDescriptor({ ...descriptor, frontYaw: NaN }), false);
  assert.equal(isNeuralAssetDescriptor({ ...descriptor, model: 'unknown' }), false);
  assert.equal(isNeuralAssetDescriptor({ ...descriptor, sourceUrl: 'https://example.com/' }), false);
});

test('authored body variants require honest provenance, a complete local model set and a matching default', () => {
  assert.equal(isNeuralAssetDescriptor(template), true);
  assert.equal(isNeuralAssetDescriptor({ ...template, model: 'blender-studio' }), true);
  assert.equal(isNeuralAssetDescriptor({ ...template, model: 'triposr' }), false);
  assert.equal(isNeuralAssetDescriptor({ ...template, inputKind: 'inferred-full-body' }), false);
  assert.equal(isNeuralAssetDescriptor({ ...template, headYaw: Math.PI / 2 }), true);
  assert.equal(isNeuralAssetDescriptor({ ...template, headYaw: Math.PI }), false);
  assert.equal(isNeuralAssetDescriptor({ ...template, headYaw: NaN }), false);
  assert.equal(isNeuralAssetDescriptor({ ...descriptor, headYaw: .7 }), false);
  assert.equal(isNeuralAssetDescriptor({ ...template, sourceFaceBox: [.2, .3, .4, .5], sourceNeckBox: [.4, .3, .5, .5] }), true);
  for (const box of [[.3, .2, .1, .4], [0, 0, 2, 1], [0, 0, NaN, 1], [0, 0, .001, .2], [0, 0, 1]]) {
    assert.equal(isNeuralAssetDescriptor({ ...template, sourceFaceBox: box }), false);
    assert.equal(isNeuralAssetDescriptor({ ...template, sourceNeckBox: box }), false);
  }
  assert.equal(isNeuralAssetDescriptor({ ...descriptor, sourceFaceBox: [.2, .3, .4, .5] }), false);
  assert.equal(isNeuralAssetDescriptor({ ...descriptor, inputKind: 'anatomical-template' }), false);
  assert.equal(isNeuralAssetDescriptor({ ...template, shapeVariants: { slim: template.shapeVariants!.slim } }), false);
  assert.equal(isNeuralAssetDescriptor({ ...template, shape: 'slim' }), false);
  assert.equal(isNeuralAssetDescriptor({ ...template, shapeVariants: { ...template.shapeVariants, broad: 'https://example.com/broad.glb' } }), false);
  assert.equal(isNeuralAssetDescriptor({ ...template, shapeVariants: { ...template.shapeVariants, broad: template.shapeVariants!.slim } }), false);
  const broad = selectNeuralAssetShape(template, 'broad');
  assert.equal(broad.url, template.shapeVariants!.broad);
  assert.equal(broad.shape, 'broad');
  assert.equal(isNeuralAssetDescriptor(broad), true);
  assert.equal(template.shape, 'average');
  assert.equal(selectNeuralAssetShape(descriptor, 'slim'), descriptor);
});

test('GLB validation rejects remote dependencies, malformed ranges and non-finite data', () => {
  assert.deepEqual(validateNeuralGlb(fixture()), { vertices: 8, triangles: 12 });
  const invalid: Array<(json: any, data: DataView) => void> = [
    json => { json.buffers[0].uri = 'https://example.com/data.bin'; },
    json => { json.images = [{ uri: 'data:image/png;base64,aaaa' }]; },
    json => { json.bufferViews[0].byteLength = 999999; },
    json => { json.accessors[0].byteOffset = 80; },
    json => { json.accessors[0].count = NEURAL_ASSET_LIMITS.vertices + 1; },
    (_, data) => { data.setFloat32(0, Infinity, true); },
    (_, data) => { data.setUint16(192, 10, true); },
    json => { json.nodes[0].children = [0]; },
    json => { json.extensionsUsed = ['KHR_draco_mesh_compression']; },
  ];
  for (const mutate of invalid) assert.throws(() => validateNeuralGlb(fixture(mutate)), /Invalid neural GLB/);
  const truncated = fixture().slice(0, -4);
  assert.throws(() => validateNeuralGlb(truncated), /complete GLB/);
});

test('the loader keeps measured mesh shape and vertex colors, centers it and grounds its feet', async () => {
  const result = await parseNeuralAsset(fixture(), descriptor, 1.8);
  assert.ok(Math.abs(result.bounds.min.y) < 1e-6);
  assert.ok(Math.abs(result.bounds.max.y - 1.8) < 1e-6);
  assert.ok(Math.abs(result.bounds.getCenter(new THREE.Vector3()).x) < 1e-6);
  assert.ok(Math.abs(result.bounds.getCenter(new THREE.Vector3()).z) < 1e-6);
  const meshes: THREE.Mesh[] = [];
  result.group.traverse(object => { if (object instanceof THREE.Mesh) meshes.push(object); });
  assert.equal(meshes.length, 1);
  assert.equal(meshes[0].geometry.getAttribute('position').count, 8);
  assert.ok(meshes[0].material instanceof THREE.MeshBasicMaterial);
  assert.equal((meshes[0].material as THREE.MeshBasicMaterial).vertexColors, true);
  assert.equal((meshes[0].material as THREE.MeshBasicMaterial).toneMapped, false);
  assert.ok(Math.abs(meshes[0].geometry.getAttribute('color').getX(0) - .8) < 1e-6);
  let disposed = 0;
  meshes[0].geometry.addEventListener('dispose', () => { disposed++; });
  result.dispose(); result.dispose();
  assert.equal(disposed, 1);
});

test('Z-up assets are rotated before height normalization and PBR materials are retained', async () => {
  const result = await parseNeuralAsset(fixture(), { ...descriptor, upAxis: 'z', frontYaw: Math.PI / 2, appearance: 'pbr' }, 1.7);
  assert.ok(Math.abs(result.bounds.min.y) < 1e-6);
  assert.ok(Math.abs(result.bounds.max.y - 1.7) < 1e-6);
  const size = result.bounds.getSize(new THREE.Vector3());
  assert.ok(Math.abs(size.x - 3.4) < 1e-6);
  assert.ok(Math.abs(size.z - 1.7) < 1e-6);
  result.group.traverse(object => {
    if (object instanceof THREE.Mesh) {
      assert.ok(object.material instanceof THREE.MeshStandardMaterial);
      assert.equal((object.material as THREE.MeshStandardMaterial).roughness, .82);
    }
  });
  result.dispose();
});

test('a vertex-color model cannot silently load without vertex colors', async () => {
  await assert.rejects(parseNeuralAsset(fixture(json => { delete json.meshes[0].primitives[0].attributes.COLOR_0; }), descriptor), /no color attribute/);
});

test('authored templates retain separate provenance and their selected body shape at runtime', async () => {
  const sourceFaceBox: [number, number, number, number] = [.2, .3, .4, .5];
  const sourceNeckBox: [number, number, number, number] = [.4, .3, .5, .5];
  const result = await parseNeuralAsset(fixture(), selectNeuralAssetShape({ ...template, headYaw: -.7, sourceFaceBox, sourceNeckBox }, 'slim'));
  assert.equal(result.group.userData.kind, 'anatomical-human');
  assert.equal(result.group.userData.model, 'makehuman');
  assert.equal(result.group.userData.inputKind, 'anatomical-template');
  assert.equal(result.group.userData.shape, 'slim');
  assert.equal(result.group.userData.templateHeadYaw, -.7);
  assert.deepEqual(result.group.userData.templateSourceFaceBox, sourceFaceBox);
  assert.deepEqual(result.group.userData.templateSourceNeckBox, sourceNeckBox);
  assert.notEqual(result.group.userData.templateSourceFaceBox, sourceFaceBox);
  assert.match(result.group.name, /anatomical template/);
  assert.ok(Math.abs(result.bounds.max.y - 1.76) < 1e-6);
  result.dispose();
});

test('correctly exported linear glTF vertex colors round-trip the original sRGB color without a second conversion', async () => {
  const expected = new THREE.Color('#c88755');
  const result = await parseNeuralAsset(fixture((_, data) => {
    for (let index = 0; index < 8; index++) {
      data.setFloat32(96 + index * 12, expected.r, true);
      data.setFloat32(100 + index * 12, expected.g, true);
      data.setFloat32(104 + index * 12, expected.b, true);
    }
  }), descriptor);
  result.group.traverse(object => {
    if (object instanceof THREE.Mesh) {
      const recovered = new THREE.Color().fromBufferAttribute(object.geometry.getAttribute('color'), 0);
      assert.equal(recovered.getHexString(THREE.SRGBColorSpace), 'c88755');
    }
  });
  result.dispose();
});

test('downloads reject missing and oversize models and cancel oversized response streams', async () => {
  const originalFetch = globalThis.fetch;
  let cancelled = false;
  try {
    globalThis.fetch = async () => new Response('Missing model', { status: 404 });
    await assert.rejects(loadNeuralAsset(descriptor), /download failed \(404\)/);
    globalThis.fetch = async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), {
      headers: { 'content-length': String(NEURAL_ASSET_LIMITS.bytes + 1) },
    });
    await assert.rejects(loadNeuralAsset(descriptor), /size limit/);
    assert.equal(cancelled, true);
    cancelled = false;
    globalThis.fetch = async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(NEURAL_ASSET_LIMITS.bytes));
        controller.enqueue(new Uint8Array(1));
      },
      cancel() { cancelled = true; },
    }));
    await assert.rejects(loadNeuralAsset(descriptor), /size limit/);
    assert.equal(cancelled, true);
    globalThis.fetch = async (url, init) => {
      assert.equal(url, descriptor.url);
      assert.equal(init?.redirect, 'error');
      return new Response(fixture());
    };
    const result = await loadNeuralAsset(descriptor);
    assert.equal(result.group.userData.model, 'triposr');
    result.dispose();
  } finally { globalThis.fetch = originalFetch; }
});

test('the importer validates without activation, then backs up and updates only the selected subject', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'again-neural-import-'));
  try {
    const fingerprint = '1234567890abcdef1234567890abcdef';
    const directory = path.join(temp, 'uploads', 'reconstructions');
    await mkdir(directory, { recursive: true });
    const worldPath = path.join(directory, `${fingerprint}-world.json`);
    const original = JSON.stringify({
      version: 1, generatedBy: 'local-segmentation', backgroundUrl: '/uploads/reconstructions/background.jpg',
      subjects: [{ id: 'subject-1', label: 'Person', kind: 'person', box: [0, 0, 1, 1], maskUrl: '/uploads/reconstructions/mask.png' }],
    });
    await writeFile(worldPath, original);
    await writeFile(path.join(temp, 'source.glb'), new Uint8Array(fixture()));
    const configPath = path.join(temp, 'config.json');
    await writeFile(configPath, JSON.stringify({
      fingerprint, subjectId: 'subject-1', assetPath: 'source.glb', model: descriptor.model,
      upAxis: descriptor.upAxis, frontYaw: 0, appearance: descriptor.appearance, inputKind: descriptor.inputKind,
    }));
    const run = (...flags: string[]) => spawnSync(process.execPath, ['--import', 'tsx', 'scripts/import-neural-asset.ts', configPath, ...flags], {
      cwd: process.cwd(), env: { ...process.env, DATA_DIR: temp }, encoding: 'utf8', timeout: 30_000,
    });
    const validation = run('--validate-only');
    assert.equal(validation.status, 0, validation.stderr);
    assert.equal(JSON.parse(validation.stdout).activated, false);
    assert.equal(await readFile(worldPath, 'utf8'), original);
    assert.equal((await readdir(directory)).length, 1);
    const imported = run();
    assert.equal(imported.status, 0, imported.stderr);
    const report = JSON.parse(imported.stdout);
    assert.equal(report.activated, true);
    assert.equal(await readFile(report.backupPath, 'utf8'), original);
    const updated = JSON.parse(await readFile(worldPath, 'utf8'));
    assert.deepEqual(updated.subjects[0].neuralAsset, report.descriptor);
    delete updated.subjects[0].neuralAsset;
    assert.deepEqual(updated, JSON.parse(original));
    const copy = await readFile(path.join(directory, path.basename(report.descriptor.url)));
    assert.deepEqual(validateNeuralGlb(copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength)), { vertices: 8, triangles: 12 });
    // tsx's inline/CommonJS entry point and the ESM GLTF loader can resolve
    // different Three constructors. Loading must rely on Three's type flags.
    const inline = `
      const { readFileSync } = require('node:fs');
      const { parseNeuralAsset } = require('./src/scene/neural-asset.ts');
      const bytes = readFileSync(${JSON.stringify(path.join(temp, 'source.glb'))});
      parseNeuralAsset(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), ${JSON.stringify(descriptor)})
        .then(result => { console.log(result.group.userData.kind); result.dispose(); })
        .catch(error => { console.error(error); process.exitCode = 1; });
    `;
    const interop = spawnSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', '-e', inline], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 30_000,
    });
    assert.equal(interop.status, 0, interop.stderr);
    assert.match(interop.stdout, /neural-human/);
    const beforeVariants = await readFile(worldPath, 'utf8');
    for (const [index, shape] of HUMAN_BODY_SHAPES.entries()) {
      const width = .8 + index * .2;
      const model = fixture((json, data) => {
        for (let vertex = 0; vertex < 8; vertex++) data.setFloat32(vertex * 12, 3 + (data.getFloat32(vertex * 12, true) - 3) * width, true);
        json.accessors[0].min[0] = 3 - width;
        json.accessors[0].max[0] = 3 + width;
      });
      await writeFile(path.join(temp, `${shape}.glb`), new Uint8Array(model));
    }
    const variantConfig = {
      fingerprint, subjectId: 'subject-1', model: 'makehuman', inputKind: 'anatomical-template',
      upAxis: 'y', frontYaw: 0, headYaw: 1, appearance: 'vertex-color', shape: 'average',
      sourceFaceBox: [.2, .3, .4, .5], sourceNeckBox: [.4, .3, .5, .5],
      shapeVariantPaths: { slim: 'slim.glb', average: 'average.glb', broad: 'broad.glb' },
    };
    await writeFile(configPath, JSON.stringify(variantConfig));
    const validateVariants = run('--validate-only');
    assert.equal(validateVariants.status, 0, validateVariants.stderr);
    assert.equal(await readFile(worldPath, 'utf8'), beforeVariants);
    const importVariants = run();
    assert.equal(importVariants.status, 0, importVariants.stderr);
    const variantReport = JSON.parse(importVariants.stdout);
    assert.equal(variantReport.variants.length, 3);
    assert.equal(variantReport.descriptor.url, variantReport.descriptor.shapeVariants.average);
    assert.equal(variantReport.descriptor.headYaw, 1);
    assert.deepEqual(variantReport.descriptor.sourceFaceBox, variantConfig.sourceFaceBox);
    assert.deepEqual(variantReport.descriptor.sourceNeckBox, variantConfig.sourceNeckBox);
    assert.equal(isNeuralAssetDescriptor(variantReport.descriptor), true);
    assert.equal(await readFile(variantReport.backupPath, 'utf8'), beforeVariants);
    for (const shape of HUMAN_BODY_SHAPES) {
      const served = await readFile(path.join(directory, path.basename(variantReport.descriptor.shapeVariants[shape])));
      assert.deepEqual(served, await readFile(path.join(temp, `${shape}.glb`)));
    }
    const beforeRejected = await readFile(worldPath, 'utf8');
    await writeFile(configPath, JSON.stringify({ ...variantConfig, shapeVariantPaths: { slim: 'slim.glb', average: 'slim.glb', broad: 'broad.glb' } }));
    const duplicateVariants = run('--validate-only');
    assert.notEqual(duplicateVariants.status, 0);
    assert.match(duplicateVariants.stderr, /three distinct model files/);
    assert.equal(await readFile(worldPath, 'utf8'), beforeRejected);
  } finally { await rm(temp, { recursive: true, force: true }); }
});
