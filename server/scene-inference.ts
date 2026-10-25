import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Memory, Readiness3D, ReconstructionSpec } from '../src/types.js';
import { DepthReadinessScorer, type Readiness3DScorer, type ReadinessInput } from './depth-readiness.js';
import type { ImageQuality } from './image-quality.js';
import { isReconstructionSpec } from '../src/reconstruction-validation.js';
import { HttpError } from './http.js';
import { parseDepthDiagnostics, type DepthDevice, type DepthFallback } from './depth-model.js';

export type SceneInferenceJob =
  | { kind: 'depth'; uploadsDir: string; memory: Memory }
  | { kind: 'complete'; uploadsDir: string; reconstruction: ReconstructionSpec; originalImagePath?: string };

export type InferenceProcessOptions = {
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /** Injectable executable module for process-boundary tests; never supplied by HTTP clients. */
  workerPath?: string;
  maxOutputBytes?: number;
  onDiagnostics?: (value: InferenceDiagnostics) => void;
};

export type InferenceDiagnostics = { elapsedMs: number; peakRssBytes: number; depthDevice?: DepthDevice; depthFallback?: DepthFallback };

// Native ONNX allocations can survive model.dispose(). A process exit is the
// reliable release boundary, and only one model-heavy process may run at a time.
let inferenceQueue: Promise<unknown> = Promise.resolve();

function execute(job: SceneInferenceJob, options: InferenceProcessOptions): Promise<ReconstructionSpec> {
  const env = options.env ?? process.env;
  const configuredTimeout = Number(env.SCENE_INFERENCE_TIMEOUT_MS);
  const timeoutMs = options.timeoutMs ?? (Number.isFinite(configuredTimeout) && configuredTimeout >= 30000 && configuredTimeout <= 600000 ? configuredTimeout : 180000);
  const maxOutputBytes = options.maxOutputBytes ?? 256 * 1024;
  return new Promise((resolve, reject) => {
    const child = fork(options.workerPath ?? fileURLToPath(new URL('./scene-inference-worker.ts', import.meta.url)), [], {
      execPath: process.execPath,
      // Do not inherit --test, inspector ports, or the parent tsx watch process.
      execArgv: ['--expose-gc', '--max-old-space-size=1024', '--import', import.meta.resolve('tsx')],
      env: { ...process.env, ...env, GEMINI_API_KEY: env.GEMINI_API_KEY ?? '', POSE_PYTHON_PATH: env.POSE_PYTHON_PATH ?? '' },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      serialization: 'json',
    });
    let result: ReconstructionSpec | undefined;
    let diagnostics: InferenceDiagnostics | undefined;
    let failure: Error | undefined;
    let outputBytes = 0;
    let settled = false;
    const stop = (error: Error) => {
      failure ??= error;
      child.kill();
    };
    const timer = setTimeout(() => stop(new HttpError(503, 'Reconstruction exceeded its processing limit. Completed frames are saved; retry to resume.')), timeoutMs);
    const collect = (chunk: Buffer) => {
      outputBytes += chunk.length;
      // Discard model output: it can contain paths, provider responses or tokens.
      if (outputBytes > maxOutputBytes) stop(new HttpError(503, 'The reconstruction worker produced excessive diagnostic output. Please retry.'));
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    child.on('message', (message: unknown) => {
      if (!message || typeof message !== 'object' || Array.isArray(message)) {
        stop(new HttpError(503, 'The reconstruction worker returned invalid metadata.'));
        return;
      }
      const response = message as { ok?: unknown; result?: unknown; status?: unknown; message?: unknown; diagnostics?: Partial<InferenceDiagnostics> };
      if (response.diagnostics && typeof response.diagnostics.elapsedMs === 'number' && Number.isFinite(response.diagnostics.elapsedMs) && response.diagnostics.elapsedMs >= 0 && typeof response.diagnostics.peakRssBytes === 'number' && Number.isFinite(response.diagnostics.peakRssBytes) && response.diagnostics.peakRssBytes > 0)
        diagnostics = { elapsedMs: response.diagnostics.elapsedMs, peakRssBytes: response.diagnostics.peakRssBytes, ...parseDepthDiagnostics(response.diagnostics) };
      if (response.ok === true && isReconstructionSpec(response.result)) {
        if (result) stop(new HttpError(503, 'The reconstruction worker returned duplicate metadata.'));
        else result = response.result;
      } else if (response.ok === false) {
        const status = typeof response.status === 'number' && Number.isInteger(response.status) && response.status >= 400 && response.status <= 599 ? response.status : 503;
        failure = new HttpError(status, typeof response.message === 'string' && response.message.length <= 500 ? response.message : 'The reconstruction worker could not complete this frame.');
      } else stop(new HttpError(503, 'The reconstruction worker returned invalid metadata.'));
    });
    child.once('error', () => { failure ??= new HttpError(503, 'The reconstruction worker could not start. Check the local Node.js installation.'); });
    child.once('close', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Telemetry must not strand the global queue or turn a completed model
      // run into an unhandled event-listener exception.
      if (diagnostics) try { options.onDiagnostics?.(diagnostics); } catch { /* Diagnostic sinks are best-effort. */ }
      // Wait for exit even after success so the next model never overlaps this
      // process's native allocations during teardown.
      if (failure) reject(failure);
      else if (code !== 0 || !result) reject(new HttpError(503, 'The reconstruction worker stopped before completing this frame. Completed frames are saved; retry to resume.'));
      else resolve(result);
    });
    child.send(job, error => { if (error) stop(new HttpError(503, 'The reconstruction worker could not receive its input.')); });
  });
}

export function runSceneInferenceJob(job: SceneInferenceJob, options: InferenceProcessOptions = {}): Promise<ReconstructionSpec> {
  const pending = inferenceQueue.catch(() => {}).then(() => execute(job, options));
  inferenceQueue = pending;
  return pending;
}

/** Depth and each completed frame have separate native-model lifetimes. */
export class IsolatedSceneInference {
  constructor(readonly uploadsDir: string, private readonly env: NodeJS.ProcessEnv = process.env) {}
  private run(job: SceneInferenceJob) {
    return runSceneInferenceJob(job, { env: this.env, onDiagnostics: diagnostics => console.info(JSON.stringify({ event: 'scene-inference', stage: job.kind, ...diagnostics })) });
  }
  reconstruct(memory: Memory) {
    return this.run({ kind: 'depth', uploadsDir: this.uploadsDir, memory });
  }
  complete(reconstruction: ReconstructionSpec, originalImagePath?: string) {
    return this.run({ kind: 'complete', uploadsDir: this.uploadsDir, reconstruction, originalImagePath });
  }
}

// ---------------------------------------------------------------------------
// 3D-readiness scoring through the same isolation boundary.
// ---------------------------------------------------------------------------

export type ReadinessProcessOptions = {
  /** Injectable executable module for process-boundary tests; never supplied by HTTP clients. */
  workerPath?: string;
  /** Close the batch process after this long without a request, releasing the model lock. */
  idleMs?: number;
  /** Recycle the process after this many scores so native memory is returned. */
  maxItemsPerProcess?: number;
  /** Per-photo limit; a stuck model is killed and that photo falls back to the heuristic. */
  itemTimeoutMs?: number;
  maxOutputBytes?: number;
  log?: (message: string) => void;
};

type ReadinessSession = {
  child: ChildProcess;
  pending: Map<number, { resolve: (value: Readiness3D) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>;
  scored: number;
  closing: boolean;
  idle?: NodeJS.Timeout;
  /** Which device the worker's depth model used, as reported with each score. */
  depth?: { depthDevice?: DepthDevice; depthFallback?: DepthFallback };
};

const isReadiness3D = (value: unknown): value is Readiness3D => {
  const item = value as Readiness3D;
  return !!item && typeof item === 'object' && typeof item.score === 'number' && Number.isFinite(item.score) && item.score >= 0 && item.score <= 1
    && typeof item.ready === 'boolean' && Array.isArray(item.reasons) && item.reasons.every(reason => typeof reason === 'string')
    && (item.source === 'depth-anything-v2' || item.source === 'heuristic') && typeof item.version === 'number';
};

/**
 * Scores photos for 3D readiness in a short-lived child process that holds the
 * shared inference lock (`inferenceQueue`) for the whole batch, so it never
 * overlaps reconstruction. The model loads once per batch instead of once per
 * photo; the process exits after `idleMs` without work or `maxItemsPerProcess`
 * scores. Any worker failure falls back to the in-process heuristic, so an
 * import never fails because of the 3D check.
 */
export class IsolatedReadinessScorer implements Readiness3DScorer {
  private session?: ReadinessSession;
  private opening?: Promise<ReadinessSession>;
  private nextId = 1;
  private readonly fallback = new DepthReadinessScorer();
  constructor(private readonly modelDir: string, private readonly env: NodeJS.ProcessEnv = process.env, private readonly options: ReadinessProcessOptions = {}) {}

  async score(input: ReadinessInput, quality?: ImageQuality): Promise<Readiness3D> {
    try {
      return await this.scoreInWorker(input, quality);
    } catch {
      return this.fallback.score(input, quality);
    }
  }

  /** Close any open batch process now (tests and shutdown). */
  async close() {
    const session = this.session;
    if (!session) return;
    await new Promise<void>(resolve => { session.child.once('close', () => resolve()); this.shutdown(session); });
  }

  private async scoreInWorker(input: ReadinessInput, quality?: ImageQuality) {
    let session = this.session && !this.session.closing ? this.session : undefined;
    if (!session) session = await (this.opening ??= this.open().finally(() => { this.opening = undefined; }));
    if (session.idle) clearTimeout(session.idle);
    session.scored++;
    const id = this.nextId++;
    const result = new Promise<Readiness3D>((resolve, reject) => {
      const timer = setTimeout(() => { reject(new Error('3D check timed out.')); session!.child.kill(); }, this.options.itemTimeoutMs ?? 60000);
      session!.pending.set(id, { resolve, reject, timer });
    });
    session.child.send({ type: 'score', id, input, quality });
    try { return await result; } finally {
      if (!session.closing && session.pending.size === 0) {
        if (session.scored >= (this.options.maxItemsPerProcess ?? 64)) this.shutdown(session);
        else session.idle = setTimeout(() => this.shutdown(session!), this.options.idleMs ?? 1500);
      }
    }
  }

  private shutdown(session: ReadinessSession) {
    if (session.closing) return;
    session.closing = true;
    if (session.idle) clearTimeout(session.idle);
    if (session.child.connected) session.child.send({ type: 'shutdown' }, () => {});
    else session.child.kill();
    // A worker that ignores shutdown is stopped so the model lock is always released.
    setTimeout(() => { if (session.child.exitCode === null) session.child.kill('SIGKILL'); }, 5000).unref();
  }

  private async open(): Promise<ReadinessSession> {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const acquired = inferenceQueue.catch(() => {});
    inferenceQueue = acquired.then(() => held);
    await acquired;
    const started = performance.now();
    const child = fork(this.options.workerPath ?? fileURLToPath(new URL('./readiness-worker.ts', import.meta.url)), [], {
      execPath: process.execPath,
      execArgv: ['--expose-gc', '--max-old-space-size=1024', '--import', import.meta.resolve('tsx')],
      env: { ...process.env, ...this.env, READINESS_MODEL_DIR: this.modelDir },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      serialization: 'advanced',
    });
    const session: ReadinessSession = { child, pending: new Map(), scored: 0, closing: false };
    let outputBytes = 0;
    const collect = (chunk: Buffer) => { outputBytes += chunk.length; if (outputBytes > (this.options.maxOutputBytes ?? 256 * 1024)) child.kill(); };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { reject(new Error('3D check worker did not start.')); child.kill(); }, 30000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('close', () => { clearTimeout(timer); reject(new Error('3D check worker exited before it was ready.')); });
      child.on('message', (message: unknown) => {
        const response = message as { ready?: boolean; id?: number; ok?: boolean; result?: unknown; depth?: unknown };
        if (response?.ready === true) { clearTimeout(timer); resolve(); return; }
        const waiter = typeof response?.id === 'number' ? session.pending.get(response.id) : undefined;
        if (!waiter) return;
        session.pending.delete(response.id!); clearTimeout(waiter.timer);
        if (response.depth) session.depth = parseDepthDiagnostics(response.depth);
        if (response.ok === true && isReadiness3D(response.result)) waiter.resolve(response.result);
        else waiter.reject(new Error('The 3D check worker could not score this item.'));
      });
    });
    child.once('close', () => {
      session.closing = true;
      if (session.idle) clearTimeout(session.idle);
      for (const waiter of session.pending.values()) { clearTimeout(waiter.timer); waiter.reject(new Error('The 3D check worker stopped.')); }
      session.pending.clear();
      if (this.session === session) this.session = undefined;
      this.options.log?.(JSON.stringify({ event: 'readiness-inference', scored: session.scored, elapsedMs: Math.round(performance.now() - started), ...session.depth }));
      release();
    });
    try { await ready; } catch (error) { if (child.exitCode === null) child.kill(); throw error; }
    this.session = session;
    return session;
  }
}
