import { readFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { isWorldCompletion } from '../src/world-completion-validation.js';
const key = process.argv[2];
if (!key || !/^[a-f0-9]{32}$/.test(key)) throw new Error('Provide the 32-character reconstruction fingerprint.');
const directory = path.resolve(process.env.DATA_DIR || 'data', 'uploads', 'reconstructions');
const world = JSON.parse(await readFile(path.join(directory, `${key}-world.json`), 'utf8'));
if (!isWorldCompletion(world)) throw new Error('Invalid world manifest.');
for (const subject of world.subjects) {
  if (!subject.maskUrl.startsWith(`/uploads/reconstructions/${key}-`)) throw new Error('Mask belongs to another source.');
  const file = path.join(directory, path.basename(subject.maskUrl));
  const { data, info } = await sharp(file).grayscale().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  let minX = width, minY = height, maxX = 0, maxY = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (data[y * width + x] >= 128) { minX = Math.min(minX, x); maxX = Math.max(maxX, x + 1); minY = Math.min(minY, y); maxY = Math.max(maxY, y + 1); }
  const box = [minY / height, minX / width, maxY / height, maxX / width];
  const swapped = [box[1], box[0], box[3], box[2]];
  const error = (candidate: number[]) => candidate.reduce((sum, value, i) => sum + Math.abs(value - subject.box[i]), 0);
  if (error(swapped) + .03 >= error(box)) continue;
  const repaired = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) repaired[y * width + x] = data[Math.min(height - 1, Math.floor((x + .5) / width * height)) * width + Math.min(width - 1, Math.floor((y + .5) / height * width))];
  await sharp(Buffer.from(repaired), { raw: { width, height, channels: 1 } }).png().toFile(`${file}.tmp`);
  const { rename } = await import('node:fs/promises'); await rename(`${file}.tmp`, file);
  console.log(`Aligned ${subject.id} to its source bounding box.`);
}
