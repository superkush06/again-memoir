#!/usr/bin/env node
// Runs the production Depth Anything V2 baseline on the fixed photo set and scores it.
// Run the same command on the M3 and the M5; only the report name changes.
import { execFileSync, spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const value = (name, fallback) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : fallback; };
const input = args[0] && !args[0].startsWith('--') ? path.resolve(args[0]) : undefined;
if (!input) throw new Error('Usage: node scripts/m5/run-suite.mjs /path/to/fixed-photo-set [--name m5-da2] [--device auto|webgpu|cpu|coreml] [--threads 4 (cpu only)] [--repeats 3]\nGet the fixed set with: node scripts/m5/fetch-photo-set.mjs data/m5-photos');
let chip = os.cpus()[0]?.model || 'unknown';
try { if (process.platform === 'darwin') chip = execFileSync('sysctl', ['-n', 'machdep.cpu.brand_string'], { encoding: 'utf8' }).trim(); } catch { /* keep os.cpus() model */ }
const device = value('--device', 'auto'); const threads = value('--threads', '4'); const repeats = value('--repeats', '3');
if (args.includes('--threads') && device !== 'cpu') throw new Error('--threads applies only to --device cpu.');
const production = device === 'auto' || device === 'webgpu' || (device === 'cpu' && threads === '4');
const chipTag = /\bM(\d+)\b/.exec(chip)?.[0].toLowerCase() ?? chip.toLowerCase().replace(/[^a-z0-9]+/g, '-');
// Production runs and probes never share a name, so a probe cannot overwrite a production report.
const defaultName = production ? `${chipTag}-da2${device === 'auto' ? '' : `-${device}`}` : `${chipTag}-da2-probe-${device}${device === 'cpu' ? `-${threads}t` : ''}`;
const name = value('--name', defaultName);
const root = path.resolve(process.env.M5_REPORT_DIR || 'data/m5-reports-local');
await mkdir(root, { recursive: true });
// Run TypeScript through this Node with tsx, not npx: no shell, so it works on Windows and with spaces in paths.
const tsx = (script, scriptArgs) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ['--import', 'tsx', script, ...scriptArgs], { stdio: 'inherit', env: { ...process.env } });
  child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${script} exited with ${code}`)));
});
const dump = path.join(root, 'dumps', name);
console.log(`${chip}: ${production ? 'production' : 'probe'} Depth Anything V2 (${device}${device === 'cpu' && !production ? `, ${threads} threads` : ''}) -> ${name}.json`);
await tsx('scripts/m5/da2-runner.ts', ['--input', input, '--output', dump, '--device', device, ...(device === 'cpu' ? ['--threads', threads] : []), '--repeats', repeats]);
await tsx('scripts/m5/score-depth.ts', ['--dump', dump, '--photos', input, '--output', path.join(root, `${name}.json`)]);
console.log(`Report written to ${path.join(root, `${name}.json`)}.`);
console.log('Compare: npm run benchmark:3d:compare -- --report <baseline.json> --report <other.json> [...]');
