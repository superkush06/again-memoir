import { constants } from 'node:fs';
import { copyFile, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { HUMAN_BODY_SHAPES, isNeuralAssetDescriptor, NEURAL_ASSET_LIMITS, validateNeuralGlb, type HumanBodyShape } from '../src/neural-asset-validation.js';
import { isWorldCompletion } from '../src/world-completion-validation.js';

/**
 * npx tsx scripts/import-neural-asset.ts <config.json> [--validate-only]
 * Config: { fingerprint, subjectId, assetPath, model, upAxis, frontYaw,
 *           appearance, inputKind }
 * Or replace assetPath with shape + shapeVariantPaths:{slim,average,broad}.
 * assetPath is resolved relative to the config file. Only a successful,
 * explicitly run import changes the selected person's model.
 */
const [configArgument, ...flags] = process.argv.slice(2);
if (!configArgument || flags.some(flag => flag !== '--validate-only')) throw new Error('Supply one import config JSON and optionally --validate-only.');
const configPath = path.resolve(configArgument);
const config = JSON.parse(await readFile(configPath, 'utf8'));
const allowed = new Set(['fingerprint', 'subjectId', 'assetPath', 'model', 'upAxis', 'frontYaw', 'appearance', 'inputKind', 'shape', 'shapeVariantPaths', 'headYaw', 'sourceFaceBox', 'sourceNeckBox']);
if (!config || typeof config !== 'object' || Array.isArray(config) || Object.keys(config).some(key => !allowed.has(key))) throw new Error('Invalid neural import configuration.');
if (typeof config.fingerprint !== 'string' || !/^[a-f0-9]{32}$/.test(config.fingerprint)) throw new Error('Invalid reconstruction fingerprint.');
if (typeof config.subjectId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(config.subjectId)) throw new Error('Invalid subject ID.');
const hasVariants = config.shape !== undefined || config.shapeVariantPaths !== undefined;
if (hasVariants && (config.assetPath !== undefined || !HUMAN_BODY_SHAPES.includes(config.shape)
  || !config.shapeVariantPaths || typeof config.shapeVariantPaths !== 'object' || Array.isArray(config.shapeVariantPaths)
  || Object.keys(config.shapeVariantPaths).length !== 3
  || !HUMAN_BODY_SHAPES.every(shape => typeof config.shapeVariantPaths[shape] === 'string'))) {
  throw new Error('Supply shape and all three shapeVariantPaths, without assetPath.');
}
const readArtifact = async (assetPath: unknown, shape?: HumanBodyShape) => {
  if (typeof assetPath !== 'string' || path.extname(assetPath).toLowerCase() !== '.glb') throw new Error('Select a self-contained GLB file.');
  const sourcePath = path.resolve(path.dirname(configPath), assetPath);
  const sourceStat = await stat(sourcePath);
  if (!sourceStat.isFile() || sourceStat.size > NEURAL_ASSET_LIMITS.bytes) throw new Error('The GLB is missing or exceeds the 32 MiB limit.');
  const source = await readFile(sourcePath);
  const buffer = source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength) as ArrayBuffer;
  const geometry = validateNeuralGlb(buffer);
  const hash = createHash('sha256').update(source).digest('hex');
  const filename = `${config.fingerprint}-${config.subjectId}-${config.model}${shape ? `-${shape}` : ''}-${hash.slice(0, 16)}.glb`;
  return { sourcePath, source, geometry, hash, filename, url: `/uploads/reconstructions/${filename}`, shape };
};
const artifacts = hasVariants
  ? await Promise.all(HUMAN_BODY_SHAPES.map(shape => readArtifact(config.shapeVariantPaths[shape], shape)))
  : [await readArtifact(config.assetPath)];
if (hasVariants && new Set(artifacts.map(artifact => artifact.hash)).size !== 3) throw new Error('Body shape choices must refer to three distinct model files.');
const selected = hasVariants ? artifacts.find(artifact => artifact.shape === config.shape)! : artifacts[0];
const descriptor = {
  url: selected.url,
  model: config.model, upAxis: config.upAxis, frontYaw: config.frontYaw,
  appearance: config.appearance, inputKind: config.inputKind,
  ...(config.headYaw !== undefined ? { headYaw: config.headYaw } : {}),
  ...(config.sourceFaceBox !== undefined ? { sourceFaceBox: config.sourceFaceBox } : {}),
  ...(config.sourceNeckBox !== undefined ? { sourceNeckBox: config.sourceNeckBox } : {}),
  ...(hasVariants ? {
    shape: config.shape,
    shapeVariants: Object.fromEntries(artifacts.map(artifact => [artifact.shape, artifact.url])),
  } : {}),
};
if (!isNeuralAssetDescriptor(descriptor)) throw new Error('Invalid model metadata.');
const directory = path.resolve(process.env.DATA_DIR || 'data', 'uploads', 'reconstructions');
const worldPath = path.join(directory, `${config.fingerprint}-world.json`);
const original = await readFile(worldPath, 'utf8');
const world = JSON.parse(original);
if (!isWorldCompletion(world)) throw new Error('The source must have a valid world reconstruction first.');
const subject = world.subjects.find(item => item.id === config.subjectId);
if (!subject || subject.kind !== 'person') throw new Error('The selected subject is not a reconstructed person.');
subject.neuralAsset = descriptor;
if (!isWorldCompletion(world)) throw new Error('The resulting completion metadata is invalid.');
const details = {
  subjectId: subject.id, descriptor, bytes: selected.source.byteLength, sha256: selected.hash, ...selected.geometry,
  ...(hasVariants ? { variants: artifacts.map(artifact => ({ shape: artifact.shape, url: artifact.url, bytes: artifact.source.byteLength, sha256: artifact.hash, ...artifact.geometry })) } : {}),
};
if (flags.includes('--validate-only')) {
  console.log(JSON.stringify({ validated: true, activated: false, ...details }, null, 2));
} else {
  for (const artifact of artifacts) {
    const destination = path.join(directory, artifact.filename);
    await copyFile(artifact.sourcePath, destination, constants.COPYFILE_EXCL).catch(async error => {
      if (error.code !== 'EEXIST') throw error;
      const existing = await readFile(destination);
      if (createHash('sha256').update(existing).digest('hex') !== artifact.hash) throw new Error('A different model already exists at the destination.');
    });
  }
  const previousHash = createHash('sha256').update(original).digest('hex').slice(0, 16);
  const backupPath = `${worldPath}.before-neural-${previousHash}`;
  await writeFile(backupPath, original, { flag: 'wx' }).catch(error => {
    if (error.code !== 'EEXIST') throw error;
  });
  const temporary = `${worldPath}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(world));
  await rename(temporary, worldPath);
  console.log(JSON.stringify({ validated: true, activated: true, backupPath, ...details }, null, 2));
}
