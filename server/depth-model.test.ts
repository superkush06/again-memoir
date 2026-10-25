import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { DEPTH_MODEL_ID, depthDevices, DeviceFallback, parseDepthDiagnostics, type DepthDevice } from './depth-model.js';

/** A fake session per device; options decide which devices break and how. */
function harness(options: { createFails?: DepthDevice[]; runFails?: DepthDevice[]; nonFinite?: DepthDevice[]; devices?: DepthDevice[]; dispose?: (device: DepthDevice) => void | Promise<void> } = {}) {
  const created: DepthDevice[] = []; const disposed: DepthDevice[] = []; const logs: string[] = [];
  const sessions = new DeviceFallback<{ device: DepthDevice }>(
    () => options.devices ?? ['webgpu', 'cpu'],
    async device => { created.push(device); if (options.createFails?.includes(device)) throw new Error(`${device} adapter missing`); return { device }; },
    session => { disposed.push(session.device); return options.dispose?.(session.device); },
    message => logs.push(message),
  );
  const infer = (session: { device: DepthDevice }) => {
    if (options.runFails?.includes(session.device)) return Promise.reject(new Error(`${session.device} device lost`));
    return Promise.resolve({ device: session.device, value: options.nonFinite?.includes(session.device) ? NaN : 1 });
  };
  const run = () => sessions.run(infer, result => Number.isFinite(result.value));
  return { sessions, run, created, disposed, logs };
}

test('auto prefers WebGPU on macOS only; DEPTH_DEVICE=webgpu opts in elsewhere; cpu always wins', () => {
  // Explicit settings only: the test must not depend on a DEPTH_DEVICE exported in the developer's shell.
  assert.deepEqual(depthDevices('', 'darwin'), ['webgpu', 'cpu']);
  assert.deepEqual(depthDevices('auto', 'darwin'), ['webgpu', 'cpu']);
  assert.deepEqual(depthDevices('not-a-device', 'darwin'), ['webgpu', 'cpu']);
  for (const platform of ['linux', 'win32'] as const) {
    assert.deepEqual(depthDevices('', platform), ['cpu']);
    assert.deepEqual(depthDevices('auto', platform), ['cpu']);
    assert.deepEqual(depthDevices('webgpu', platform), ['webgpu', 'cpu']);
    assert.deepEqual(depthDevices('cpu', platform), ['cpu']);
  }
  assert.deepEqual(depthDevices('cpu', 'darwin'), ['cpu']);
});

test('with no argument the setting comes from DEPTH_DEVICE', () => {
  const saved = process.env.DEPTH_DEVICE;
  try {
    process.env.DEPTH_DEVICE = 'cpu';
    assert.deepEqual(depthDevices(), ['cpu']);
    delete process.env.DEPTH_DEVICE;
    assert.deepEqual(depthDevices(), depthDevices('auto'));
  } finally {
    if (saved === undefined) delete process.env.DEPTH_DEVICE; else process.env.DEPTH_DEVICE = saved;
  }
});

test('WebGPU is used when it loads, and concurrent callers share one load', async () => {
  const { sessions, run, created, logs } = harness();
  const [a, b] = await Promise.all([sessions.get(), sessions.get()]);
  assert.equal(a, b);
  assert.equal((await run()).device, 'webgpu');
  assert.deepEqual(created, ['webgpu']);
  assert.deepEqual(sessions.status(), { device: 'webgpu' });
  assert.deepEqual(logs, []);
});

test('a WebGPU load failure falls back to CPU, says why, and reports a fixed code', async () => {
  const { sessions, run, created, logs } = harness({ createFails: ['webgpu'] });
  assert.equal((await run()).device, 'cpu');
  assert.deepEqual(created, ['webgpu', 'cpu']);
  assert.deepEqual(sessions.status(), { device: 'cpu', fallback: 'webgpu-load-failed' });
  assert.match(logs[0], /webgpu unavailable \(webgpu adapter missing\); using cpu/);
});

test('when every device fails to load, the error surfaces and the next call retries all of them', async () => {
  const { sessions, created } = harness({ createFails: ['webgpu', 'cpu'] });
  await assert.rejects(sessions.get(), /cpu adapter missing/);
  await assert.rejects(sessions.get(), /cpu adapter missing/);
  assert.deepEqual(created, ['webgpu', 'cpu', 'webgpu', 'cpu']);
  assert.deepEqual(sessions.status(), {});
});

test('a runtime WebGPU failure retries on CPU, then stays on CPU and releases the GPU session', async () => {
  const { sessions, run, created, disposed, logs } = harness({ runFails: ['webgpu'] });
  assert.equal((await run()).device, 'cpu');
  assert.equal((await run()).device, 'cpu');
  assert.deepEqual(created, ['webgpu', 'cpu']);
  assert.deepEqual(disposed, ['webgpu']);
  assert.deepEqual(sessions.status(), { device: 'cpu', fallback: 'webgpu-run-failed' });
  assert.match(logs[0], /webgpu failed \(webgpu device lost\); switched to cpu/);
});

test('non-finite WebGPU depth is never returned; CPU answers instead', async () => {
  const { run, disposed } = harness({ nonFinite: ['webgpu'] });
  const result = await run();
  assert.equal(result.device, 'cpu');
  assert.ok(Number.isFinite(result.value));
  assert.deepEqual(disposed, ['webgpu']);
});

test('an input that fails on every device keeps the faster device and reports the original error', async () => {
  const { sessions, run, disposed } = harness({ runFails: ['webgpu', 'cpu'] });
  await assert.rejects(run(), /webgpu device lost/);
  assert.deepEqual(sessions.status(), { device: 'webgpu' });
  assert.deepEqual(disposed, ['cpu']);
  const nonFinite = harness({ nonFinite: ['webgpu', 'cpu'] });
  await assert.rejects(nonFinite.run(), /not finite/);
  assert.equal(nonFinite.sessions.device, 'webgpu');
});

test('a failing release never replaces the original error or undoes a successful switch', async () => {
  const rejecting = harness({ runFails: ['webgpu', 'cpu'], dispose: async () => { throw new Error('release failed'); } });
  await assert.rejects(rejecting.run(), /webgpu device lost/);
  assert.equal(rejecting.sessions.device, 'webgpu');
  const throwing = harness({ runFails: ['webgpu'], dispose: device => { if (device === 'webgpu') throw new Error('sync release failed'); } });
  assert.equal((await throwing.run()).device, 'cpu');
  assert.deepEqual(throwing.sessions.status(), { device: 'cpu', fallback: 'webgpu-run-failed' });
});

test('an accept check that throws on the fallback result releases that session and reports the original error', async () => {
  const disposed: DepthDevice[] = [];
  const sessions = new DeviceFallback<DepthDevice>(() => ['webgpu', 'cpu'], async device => device, device => { disposed.push(device); }, () => {});
  await assert.rejects(sessions.run(async device => (device === 'webgpu' ? Promise.reject(new Error('webgpu device lost')) : undefined as unknown as { ok: boolean }), result => result.ok), /webgpu device lost/);
  assert.deepEqual(disposed, ['cpu']);
  assert.equal(sessions.device, 'webgpu');
});

test('only known device names and fallback codes cross the process boundary', () => {
  assert.deepEqual(parseDepthDiagnostics({ depthDevice: 'webgpu', depthFallback: 'webgpu-load-failed' }), { depthDevice: 'webgpu', depthFallback: 'webgpu-load-failed' });
  assert.deepEqual(parseDepthDiagnostics({ depthDevice: 'cpu' }), { depthDevice: 'cpu' });
  assert.deepEqual(parseDepthDiagnostics({ depthDevice: 'coreml', depthFallback: 'Error: /Users/someone/secret path' }), {});
  for (const value of [undefined, null, 'webgpu', 42, []]) assert.deepEqual(parseDepthDiagnostics(value), {});
});

test('a single-device list never falls back', async () => {
  const { run, created } = harness({ devices: ['webgpu'], runFails: ['webgpu'] });
  await assert.rejects(run(), /webgpu device lost/);
  assert.deepEqual(created, ['webgpu']);
  const cpuOnly = harness({ devices: ['cpu'], createFails: ['cpu'] });
  await assert.rejects(cpuOnly.run(), /cpu adapter missing/);
});

test('if the CPU fallback cannot even load, the original WebGPU error is reported and WebGPU stays', async () => {
  const fallback = new DeviceFallback<DepthDevice>(() => ['webgpu', 'cpu'], async device => { if (device === 'cpu') throw new Error('cpu load failed'); return device; }, () => {}, () => {});
  await assert.rejects(fallback.run(async () => { throw new Error('transient webgpu error'); }), /transient webgpu error/);
  assert.equal(fallback.device, 'webgpu');
});

// The real model, offline: guards the cache fix, the finite-output wiring and both estimators.
const modelDir = path.resolve('data/models');
const cached = existsSync(path.join(modelDir, DEPTH_MODEL_ID, 'onnx/model.onnx'));
test('a cached model loads and runs with the network blocked', { skip: cached ? false : 'depth model not downloaded into data/models' }, async () => {
  const transformers = await import('@huggingface/transformers');
  let attempts = 0;
  transformers.env.fetch = async () => { attempts++; throw new TypeError('network blocked by test'); };
  const { depthStatus, sharedDepthEstimator, sharedRawDepthEstimator } = await import('./depth-model.js');
  const width = 64; const height = 48;
  const data = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.fill(Math.round((255 * y) / height), (y * width + x) * 3, (y * width + x) * 3 + 3);
  const depth = await sharedDepthEstimator(modelDir)({ data, width, height });
  assert.equal(depth.channels, 1);
  assert.equal(depth.data.length, depth.width * depth.height);
  const raw = await sharedRawDepthEstimator(modelDir)({ data, width, height });
  assert.equal(raw.width * raw.height, raw.data.length);
  assert.ok(raw.data.every(Number.isFinite));
  assert.equal(attempts, 0);
  assert.ok(depthDevices().includes(depthStatus(modelDir).device!));
  // On macOS with the default setting, a silent fall back to CPU is a regression, not a pass.
  if (process.platform === 'darwin' && !process.env.DEPTH_DEVICE) assert.deepEqual(depthStatus(modelDir), { device: 'webgpu' });
});
