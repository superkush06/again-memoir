import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { isWorldCompletion } from '../src/world-completion-validation.js';
import { localInstanceSegmenter, type SegmentedMask } from '../server/world-completion.js';
import { alignRearTexture } from '../server/rear-alignment.js';
const key = process.argv[2];
if (!key || !/^[a-f0-9]{32}$/.test(key)) throw new Error('Provide the reconstruction fingerprint.');
const dataDir = path.resolve(process.env.DATA_DIR || 'data');
const directory = path.join(dataDir, 'uploads', 'reconstructions');
const world = JSON.parse(await readFile(path.join(directory, `${key}-world.json`), 'utf8'));
if (!isWorldCompletion(world) || !world.rearAtlasUrl) throw new Error('Generate and import the rear atlas first.');
const rearPath = path.join(directory, path.basename(world.rearAtlasUrl));
const image = await readFile(rearPath), targets: SegmentedMask[] = [];
let width = 0, height = 0;
for (const subject of world.subjects) {
  const mask = await sharp(path.join(directory, path.basename(subject.maskUrl))).grayscale().raw().toBuffer({ resolveWithObject: true });
  width = mask.info.width; height = mask.info.height;
  targets.push({ subject: { label: subject.label, kind: subject.kind, box_2d: subject.box.map(value => value * 1000) as [number, number, number, number], polygon: [] }, mask: new Uint8Array(mask.data) });
}
const result = await alignRearTexture(image, targets, width, height, localInstanceSegmenter(path.join(dataDir, 'models')));
await writeFile(rearPath, result.image);
await writeFile(path.join(directory, `${key}-rear-alignment.json`), JSON.stringify({ matches: result.matches, detected: result.detected, at: new Date().toISOString() }));
console.log(JSON.stringify({ key, matches: result.matches, detected: result.detected }));
