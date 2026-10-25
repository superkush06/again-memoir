import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * Every M5 backend (Node or an isolated Python environment) writes the same dump:
 * run.json plus one little-endian float32 depth map per photo. The scorer reads
 * only this, so no model is judged by its own wrapper's notion of validity.
 */
export type DepthKind = 'inverse' | 'metric';
export type DumpPhoto = {
  id: string;
  input: string;
  sha256: string;
  depthFile: string;
  width: number;
  height: number;
  kind: DepthKind;
  /** Optional production readiness map (raw inverse depth at the readiness size). */
  readinessFile?: string;
  readinessWidth?: number;
  readinessHeight?: number;
  /** Every timed call, in order; the first is the per-photo first call (shape warm-up). */
  inferenceMs: number[];
  /** Device that produced this photo's depth, when the runner can tell (production fallback can change it mid-run). */
  device?: string;
  readinessMs?: number[];
};
export type DumpRun = {
  version: 1;
  backend: string;
  label: string;
  model: string;
  checkpoint?: string;
  checkpointSha256?: string;
  license?: string;
  device: string;
  settings: Record<string, unknown>;
  machine: Record<string, unknown>;
  commit?: string;
  createdAt: string;
  modelLoadMs: number;
  peakRssBytes?: number;
  peakDeviceBytes?: number;
  /** macOS physical footprint peak: unlike RSS it includes GPU (Metal) memory on unified-memory Macs. */
  peakFootprintBytes?: number;
  photos: DumpPhoto[];
};

export const PHOTO_PATTERN = /\.(jpe?g|png|webp)$/i;
export const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

export async function photoFiles(input: string) {
  return (await readdir(input)).filter(file => PHOTO_PATTERN.test(file)).sort().map(file => path.resolve(input, file));
}

export function machineInfo() {
  const cpus = os.cpus();
  let chip = cpus[0]?.model || 'unknown';
  try { if (process.platform === 'darwin') chip = execFileSync('sysctl', ['-n', 'machdep.cpu.brand_string'], { encoding: 'utf8' }).trim(); } catch { /* keep os.cpus() model */ }
  return { chip, cores: cpus.length, memoryBytes: os.totalmem(), platform: process.platform, arch: process.arch, osRelease: os.release(), node: process.version };
}

/**
 * Peak physical footprint of a process (macOS only), the figure memory pressure is based on.
 * `footprint` reports exact bytes; `vmmap` rounds to 0.1 GiB above 1 GiB, so it is only a fallback.
 */
export function peakFootprintBytes(pid = process.pid) {
  if (process.platform !== 'darwin') return undefined;
  const read = (command: string, args: string[]) => { try { return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return ''; } };
  const exact = /phys_footprint_peak:\s+(\d+) B/.exec(read('footprint', ['-f', 'bytes', '--noCategories', String(pid)]));
  if (exact) return Number(exact[1]);
  const rounded = /Physical footprint \(peak\):\s+([\d.]+)([KMG])/.exec(read('vmmap', ['--summary', String(pid)]));
  return rounded ? Math.round(Number(rounded[1]) * { K: 2 ** 10, M: 2 ** 20, G: 2 ** 30 }[rounded[2] as 'K' | 'M' | 'G']) : undefined;
}

export function gitCommit() {
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return undefined; }
}

export async function writeFloat32(file: string, data: ArrayLike<number>) {
  const array = data instanceof Float32Array ? data : Float32Array.from(data);
  await writeFile(file, Buffer.from(array.buffer, array.byteOffset, array.byteLength));
}

export async function readFloat32(file: string, length: number) {
  const bytes = await readFile(file);
  if (!Number.isSafeInteger(length) || length <= 0 || bytes.length < length * 4) throw new Error(`${path.basename(file)} is truncated or has an invalid size (${bytes.length} bytes, expected ${length * 4}).`);
  return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + length * 4));
}

export const median = (values: number[]) => percentile(values, 0.5);
export function percentile(values: number[], p: number) {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = p * (sorted.length - 1); const low = Math.floor(rank); const high = Math.ceil(rank);
  return sorted[low] + (sorted[high] - sorted[low]) * (rank - low);
}
/** Steady-state latency for one photo: drop the first call when there are repeats. */
export const steadyMs = (samples: number[]) => median(samples.length > 1 ? samples.slice(1) : samples);
