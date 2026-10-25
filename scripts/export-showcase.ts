// Packages chosen memories, their 3D scenes and every file those scenes load,
// for the hosted Memory Palace demo. Run it with the API running (npm run dev).
//
//   npx tsx scripts/export-showcase.ts --list
//   npx tsx scripts/export-showcase.ts <photo-memory-id> <video-memory-id>
//
// Output: showcase-export/ with examples.json, source.json and uploads/...
import { execFileSync } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

type Memory = { id: string; title: string; mediaType: string; url: string; readiness3d?: { ready?: boolean } };
const api = (process.env.SHOWCASE_API || 'http://localhost:3001').replace(/\/$/, '');
const out = path.resolve('showcase-export');
const ids = process.argv.slice(2).filter(arg => arg !== '--list');

const listing = await fetch(`${api}/api/memories`).catch(() => undefined);
if (!listing?.ok) throw new Error(`The API is not answering at ${api}. Start it with npm run dev, then run this again.`);
const memories = ((await listing.json()) as { memories: Memory[] }).memories;
if (!ids.length) {
  for (const memory of memories) console.log(`${memory.id}  ${memory.mediaType}  ${memory.title}${memory.readiness3d?.ready ? '  (3D-ready)' : ''}`);
  console.log('\nRun again with the IDs of the photo and video memories to export.');
  process.exit(0);
}

const files = new Set<string>();
const collect = (value: unknown): void => {
  if (typeof value === 'string') { if (value.startsWith('/uploads/')) files.add(value.split(/[?#]/)[0]); }
  else if (Array.isArray(value)) value.forEach(collect);
  else if (value && typeof value === 'object') Object.values(value).forEach(collect);
};

const examples = [];
for (const id of ids) {
  const memory = memories.find(item => item.id === id);
  if (!memory) throw new Error(`No memory with ID ${id}. Run with --list to see them.`);
  // The same request the app makes when you open a memory; cached worlds return immediately.
  const response = await fetch(`${api}/api/memories/${encodeURIComponent(id)}/scene`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  const scene = await response.json() as { reconstruction?: unknown; error?: string };
  if (!response.ok || !scene.reconstruction) throw new Error(`${id} has no 3D world yet: ${scene.error || response.status}. Open it in the app first.`);
  examples.push({ memory, scene });
  collect(memory);
  collect(scene);
}

await rm(out, { recursive: true, force: true });
const done = new Set<string>();
let bytes = 0;
while (done.size < files.size) {
  for (const file of [...files]) {
    if (done.has(file)) continue;
    done.add(file);
    const response = await fetch(api + file);
    if (!response.ok) { console.warn(`Missing ${file} (${response.status})`); continue; }
    const data = Buffer.from(await response.arrayBuffer());
    const destination = path.join(out, ...file.split('/').filter(Boolean));
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, data);
    bytes += data.length;
    // World manifests point at more files (masks, textures, bodies); follow them.
    if (file.endsWith('.json')) { try { collect(JSON.parse(data.toString('utf8'))); } catch { /* not JSON after all */ } }
  }
}

const git = (...args: string[]) => { try { return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; } };
await writeFile(path.join(out, 'examples.json'), JSON.stringify(examples, null, 2));
await writeFile(path.join(out, 'source.json'), JSON.stringify({
  exportedAt: new Date().toISOString(),
  branch: git('rev-parse', '--abbrev-ref', 'HEAD'),
  commit: git('rev-parse', 'HEAD'),
  uncommittedFiles: git('status', '--porcelain').split('\n').filter(Boolean).length,
}, null, 2));
console.log(`Exported ${examples.length} memories and ${done.size} files (${(bytes / 1e6).toFixed(1)} MB) to ${out}`);
