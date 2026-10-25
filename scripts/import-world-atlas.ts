import { readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { isWorldCompletion } from '../src/world-completion-validation.js';
import { blendOccludedPixels, localInstanceSegmenter, type SegmentedMask } from '../server/world-completion.js';
import { alignRearTexture } from '../server/rear-alignment.js';

// One supplied atlas contains two equal-width, source-aligned panels: clean background and imagined backs.
const [key, atlasPath] = process.argv.slice(2);
if (!key || !/^[a-f0-9]{32}$/.test(key) || !atlasPath) throw new Error('Usage: npx tsx scripts/import-world-atlas.ts <32-char fingerprint> <atlas-image-file>');
const directory = path.resolve(process.env.DATA_DIR || 'data', 'uploads', 'reconstructions');
const worldFile = path.join(directory, `${key}-world.json`);
const world = JSON.parse(await readFile(worldFile, 'utf8'));
if (!isWorldCompletion(world)) throw new Error('The cached world is not valid. Reconstruct this photo first.');
const source = await sharp(path.join(directory, `${key}-source.jpg`)).removeAlpha().raw().toBuffer({ resolveWithObject: true });
const { width, height } = source.info;
const atlas = await readFile(path.resolve(atlasPath));
const metadata = await sharp(atlas, { limitInputPixels: 20_000_000 }).metadata();
if (!metadata.width || !metadata.height || metadata.width < metadata.height) throw new Error('Use a horizontal two-panel atlas.');
const half = Math.floor(metadata.width / 2);
const union = new Uint8Array(width * height);
const targets: SegmentedMask[] = []; let maskWidth = 0, maskHeight = 0;
for (const subject of world.subjects) {
  if (!subject.maskUrl.startsWith(`/uploads/reconstructions/${key}-`)) throw new Error('A subject mask does not belong to this photo.');
  const mask = await sharp(path.join(directory, path.basename(subject.maskUrl))).resize(width, height).grayscale().raw().toBuffer();
  for (let i = 0; i < union.length; i++) union[i] = Math.max(union[i], mask[i]);
  const originalMask = await sharp(path.join(directory, path.basename(subject.maskUrl))).grayscale().raw().toBuffer({ resolveWithObject: true });
  maskWidth = originalMask.info.width; maskHeight = originalMask.info.height;
  targets.push({ subject: { label: subject.label, kind: subject.kind, box_2d: subject.box.map(value => value * 1000) as [number, number, number, number], polygon: [] }, mask: new Uint8Array(originalMask.data) });
}
const generatedBackground = await sharp(atlas).extract({ left: 0, top: 0, width: half, height: metadata.height }).resize(width, height).removeAlpha().raw().toBuffer();
const background = await blendOccludedPixels(source.data, generatedBackground, union, width, height, width, height);
await sharp(background, { raw: { width, height, channels: 3 } }).jpeg({ quality: 94 }).toFile(path.join(directory, `${key}-background.jpg`));
let rear: Buffer = await sharp(atlas).extract({ left: half, top: 0, width: half, height: metadata.height }).resize(width, height).jpeg({ quality: 94 }).toBuffer();
if (targets.length) {
  const aligned = await alignRearTexture(rear, targets, maskWidth, maskHeight, localInstanceSegmenter(path.resolve(process.env.DATA_DIR || 'data', 'models')));
  rear = aligned.image;
  await writeFile(path.join(directory, `${key}-rear-alignment.json`), JSON.stringify({ matches: aligned.matches, detected: aligned.detected, at: new Date().toISOString() }));
}
await writeFile(path.join(directory, `${key}-rear.jpg`), rear);
world.rearAtlasUrl = `/uploads/reconstructions/${key}-rear.jpg`; world.textureSource = 'imagegen';
if (!isWorldCompletion(world)) throw new Error('The completed atlas manifest is invalid.');
await writeFile(`${worldFile}.tmp`, JSON.stringify(world)); await rename(`${worldFile}.tmp`, worldFile);
console.log(JSON.stringify({ completionUrl: `/uploads/reconstructions/${key}-world.json`, textureSource: world.textureSource, subjects: world.subjects.length, width, height }));
