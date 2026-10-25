import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import type { RawDepthMap } from '../../server/depth-model.js';
import { buildMesh, toInverse } from './depth-mesh.js';
import { readFloat32, type DumpRun } from './dump-format.js';

/**
 * Blind desktop review packet: every backend's production mesh, textured with the
 * photo, from the source eye and after a sideways head move. Cut triangles stay
 * empty (dark), so holes and rubber-sheet stretching look as they would in VR.
 * Columns are shuffled per photo and labelled A, B, ...; the key is a separate file.
 * This prepares the blind Quest review; it does not replace it.
 */
const args = process.argv.slice(2);
const reports = args.flatMap((arg, index) => arg === '--report' && args[index + 1] ? [args[index + 1]] : []);
const value = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const photosDir = value('--photos'); const output = value('--output');
if (reports.length < 1 || !photosDir || !output) throw new Error('Usage: npx tsx scripts/m5/render-views.ts --report a.json --report b.json --photos <photo-dir> --output <review-dir> [--shift 0.5]');
const shift = Number(value('--shift') ?? '0.5');
const VIEW_WIDTH = 560; const FOV = 60; const EYE_Y = 1.6;
const HOLE = [24, 26, 32];

type Report = { label: string; dump: string; results: { id: string; sha256: string; input: string; valid: boolean; category?: string }[] };
const loaded = await Promise.all(reports.map(async file => JSON.parse(await readFile(file, 'utf8')) as Report));
const runs = await Promise.all(loaded.map(async report => JSON.parse(await readFile(path.join(report.dump, 'run.json'), 'utf8')) as DumpRun));

/** Camera at (x, EYE_Y, 0) looking down -z, turned by yaw (radians, positive = left) toward the scene. */
function render(mesh: ReturnType<typeof buildMesh>['mesh'], aspect: number, texture: { data: Buffer; width: number; height: number }, cameraX: number, yaw: number) {
  const width = VIEW_WIDTH; const height = Math.round(VIEW_WIDTH / aspect);
  const color = Buffer.alloc(width * height * 3); const depth = new Float32Array(width * height).fill(Infinity);
  for (let i = 0; i < width * height; i++) color.set(HOLE, i * 3);
  const tanHalf = Math.tan((FOV * Math.PI) / 360); const cos = Math.cos(yaw); const sin = Math.sin(yaw);
  const count = mesh.positions.length / 3;
  const sx = new Float32Array(count); const sy = new Float32Array(count); const sz = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const x = mesh.positions[i * 3] - cameraX; const y = mesh.positions[i * 3 + 1] - EYE_Y; const z = mesh.positions[i * 3 + 2];
    const cx = cos * x + sin * z; const cz = -sin * x + cos * z; const forward = -cz;
    sz[i] = forward;
    sx[i] = ((cx / forward / (tanHalf * aspect)) + 1) * 0.5 * width;
    sy[i] = (1 - y / forward / tanHalf) * 0.5 * height;
  }
  for (let t = 0; t < mesh.indices.length; t += 3) {
    const a = mesh.indices[t]; const b = mesh.indices[t + 1]; const c = mesh.indices[t + 2];
    if (sz[a] < 0.05 || sz[b] < 0.05 || sz[c] < 0.05) continue;
    const area = (sx[b] - sx[a]) * (sy[c] - sy[a]) - (sy[b] - sy[a]) * (sx[c] - sx[a]);
    if (Math.abs(area) < 1e-9) continue;
    const minX = Math.max(0, Math.floor(Math.min(sx[a], sx[b], sx[c]))); const maxX = Math.min(width - 1, Math.ceil(Math.max(sx[a], sx[b], sx[c])));
    const minY = Math.max(0, Math.floor(Math.min(sy[a], sy[b], sy[c]))); const maxY = Math.min(height - 1, Math.ceil(Math.max(sy[a], sy[b], sy[c])));
    for (let py = minY; py <= maxY; py++) for (let px = minX; px <= maxX; px++) {
      const x = px + 0.5; const y = py + 0.5;
      const w0 = ((sx[b] - x) * (sy[c] - y) - (sy[b] - y) * (sx[c] - x)) / area;
      const w1 = ((sx[c] - x) * (sy[a] - y) - (sy[c] - y) * (sx[a] - x)) / area;
      const w2 = 1 - w0 - w1;
      if (w0 < 0 || w1 < 0 || w2 < 0) continue;
      // Perspective-correct interpolation of depth and texture coordinates.
      const iz = w0 / sz[a] + w1 / sz[b] + w2 / sz[c]; const z = 1 / iz; const pixel = py * width + px;
      if (z >= depth[pixel]) continue;
      depth[pixel] = z;
      const u = (w0 * mesh.uvs[a * 2] / sz[a] + w1 * mesh.uvs[b * 2] / sz[b] + w2 * mesh.uvs[c * 2] / sz[c]) * z;
      const v = (w0 * mesh.uvs[a * 2 + 1] / sz[a] + w1 * mesh.uvs[b * 2 + 1] / sz[b] + w2 * mesh.uvs[c * 2 + 1] / sz[c]) * z;
      const tx = Math.min(texture.width - 1, Math.max(0, Math.round(u * (texture.width - 1))));
      const ty = Math.min(texture.height - 1, Math.max(0, Math.round((1 - v) * (texture.height - 1))));
      texture.data.copy(color, pixel * 3, (ty * texture.width + tx) * 3, (ty * texture.width + tx) * 3 + 3);
    }
  }
  return sharp(color, { raw: { width, height, channels: 3 } }).png().toBuffer();
}

// Report fields are data: escape everything that lands in SVG or HTML, and only accept plain photo ids as file names.
const esc = (text: string) => text.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
const SAFE_ID = /^[A-Za-z0-9._-]+$/;
const label = (text: string, width: number) => Buffer.from(`<svg width="${width}" height="30"><rect width="100%" height="100%" fill="#0d0f14"/><text x="10" y="21" font-size="17" font-family="Helvetica, Arial" fill="#e8e8e8">${esc(text)}</text></svg>`);
await mkdir(output, { recursive: true });
const common = loaded[0].results.filter(result => loaded.every(report => report.results.some(other => other.sha256 === result.sha256)));
const key: Record<string, Record<string, string>> = {}; const index: string[] = [];
for (const photo of common) {
  if (!SAFE_ID.test(photo.id) || photo.id.startsWith('.')) { console.warn(`Skipping photo with an unsafe id: ${JSON.stringify(photo.id).slice(0, 80)}`); continue; }
  const bytes = await readFile(path.join(photosDir, path.basename(photo.input)));
  // Deterministic per-photo shuffle so reviewers cannot learn a fixed column order.
  const order = loaded.map((_, i) => i).sort((a, b) => createHash('sha256').update(photo.sha256 + a).digest('hex').localeCompare(createHash('sha256').update(photo.sha256 + b).digest('hex')));
  key[photo.id] = {};
  const tiles: { input: Buffer; left: number; top: number }[] = []; let rowHeight = 0;
  for (const [column, reportIndex] of order.entries()) {
    const entry = runs[reportIndex].photos.find(item => item.sha256 === photo.sha256)!;
    const map: RawDepthMap = { data: toInverse(await readFloat32(path.join(loaded[reportIndex].dump, path.basename(entry.depthFile)), entry.width * entry.height), entry.kind), width: entry.width, height: entry.height };
    const { grid, mesh } = buildMesh(map);
    const aspect = grid.width / grid.height;
    const texture = await sharp(bytes).rotate().resize(grid.width * 3, grid.height * 3, { fit: 'fill' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const tex = { data: texture.data, width: texture.info.width, height: texture.info.height };
    const viewHeight = Math.round(VIEW_WIDTH / aspect); rowHeight = viewHeight;
    const letter = String.fromCharCode(65 + column); key[photo.id][letter] = loaded[reportIndex].label;
    tiles.push({ input: await render(mesh, aspect, tex, 0, 0), left: column * VIEW_WIDTH, top: 30 });
    tiles.push({ input: await render(mesh, aspect, tex, shift, Math.atan2(shift, 4)), left: column * VIEW_WIDTH, top: 30 + viewHeight + 30 });
    tiles.push({ input: label(`${letter} · source eye`, VIEW_WIDTH), left: column * VIEW_WIDTH, top: 0 });
    tiles.push({ input: label(`${letter} · head moved ${shift} m right`, VIEW_WIDTH), left: column * VIEW_WIDTH, top: 30 + viewHeight });
  }
  const file = `${photo.id}.jpg`;
  await sharp({ create: { width: order.length * VIEW_WIDTH, height: 2 * (rowHeight + 30), channels: 3, background: '#0d0f14' } }).composite(tiles).jpeg({ quality: 86 }).toFile(path.join(output, file));
  index.push(`<section><h2>${esc(photo.id)}</h2><img src="${esc(file)}" alt="${esc(photo.id)}" loading="lazy"></section>`);
  console.log(`rendered ${photo.id}`);
}
await writeFile(path.join(output, 'key.json'), JSON.stringify(key, null, 2) + '\n');
await writeFile(path.join(output, 'index.html'), `<!doctype html><meta charset="utf-8"><title>M5 blind depth review</title><style>body{background:#0d0f14;color:#ddd;font:15px Helvetica,Arial;margin:24px}img{max-width:100%;display:block}h2{font-size:16px;margin:28px 0 8px}</style><h1>Blind depth review</h1><p>Each photo shows the production mesh of every model (shuffled, A/B/...) from the source eye and after a ${shift} m head move. Dark areas are holes. Score before opening key.json.</p>${index.join('\n')}\n`);
console.log(`Review packet: ${path.join(output, 'index.html')} (key in key.json)`);
