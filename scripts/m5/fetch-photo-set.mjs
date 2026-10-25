#!/usr/bin/env node
// Downloads the fixed M5 benchmark photo set and verifies every file by SHA-256,
// so the M3 and M5 runs see byte-identical inputs. Photos stay out of Git.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const args = process.argv.slice(2);
const outDir = path.resolve(args.find(arg => !arg.startsWith('--')) || 'data/m5-photos');
const updateHashes = args.includes('--update-hashes');
const manifestPath = new URL('./photo-set.json', import.meta.url);
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const headers = { 'User-Agent': 'VRMemoirM5Benchmark/1 (github.com/PrranitArora/VR_Multiplayer_Memoir)' };
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
// The manifest decides file names and download hosts, so both are checked before anything is fetched or written.
const SAFE_ID = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;
const ALLOWED_HOSTS = new Set(['thumb.wikimedia.org', 'upload.wikimedia.org']);
for (const photo of manifest.photos) {
  if (typeof photo.id !== 'string' || !SAFE_ID.test(photo.id)) throw new Error(`Unsafe photo id in manifest: ${JSON.stringify(photo.id)}`);
  const url = new URL(photo.url);
  if (url.protocol !== 'https:' || !ALLOWED_HOSTS.has(url.hostname)) throw new Error(`${photo.id}: downloads are limited to https Wikimedia hosts, not ${url.host}`);
  if (!updateHashes && !/^[0-9a-f]{64}$/.test(photo.sha256 ?? '')) throw new Error(`${photo.id}: the manifest has no SHA-256; rerun with --update-hashes to record one.`);
}

async function download(url) {
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(url, { headers });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      if (attempt >= 6) throw new Error(`${url}: ${error.message}`);
      await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
    }
  }
}

await mkdir(outDir, { recursive: true });
let failures = 0;
for (const photo of manifest.photos) {
  const file = path.join(outDir, `${photo.id}.jpg`);
  if (path.dirname(path.resolve(file)) !== outDir) throw new Error(`${photo.id}: resolves outside ${outDir}`);
  const existing = await readFile(file).catch(() => undefined);
  const bytes = existing && (!photo.sha256 || sha256(existing) === photo.sha256) ? existing : await download(photo.url);
  const hash = sha256(bytes);
  if (photo.sha256 && hash !== photo.sha256 && !updateHashes) {
    console.error(`MISMATCH ${photo.id}: expected ${photo.sha256}, got ${hash}`);
    failures++;
    continue;
  }
  if (bytes !== existing) await writeFile(file, bytes);
  photo.sha256 = hash;
  console.log(`ok ${photo.id} ${(bytes.length / 1024).toFixed(0)} KB ${hash.slice(0, 12)}`);
}
if (updateHashes) await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
if (failures) {
  console.error(`${failures} photo(s) differ from the manifest; do not compare reports built from this folder.`);
  process.exit(1);
}
console.log(`Fixed photo set ready: ${outDir}`);
