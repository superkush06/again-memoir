import path from 'node:path';
import { DepthReadinessScorer, type ReadinessInput } from './depth-readiness.js';
import { depthDiagnostics, sharedRawDepthEstimator } from './depth-model.js';
import type { ImageQuality } from './image-quality.js';
import { ffmpegVideoSampler } from './video-reconstruction.js';

/**
 * 3D-readiness batch worker. Runs in its own process (see scene-inference.ts)
 * so native ONNX memory is released when the batch ends. The parent sends one
 * request at a time; the model is loaded once per batch.
 */
type Request = { type: 'score'; id: number; input: ReadinessInput; quality?: ImageQuality } | { type: 'shutdown' };

// If the API stops, do not leave model processes running unattended.
process.once('disconnect', () => process.exit(1));
const modelDir = process.env.READINESS_MODEL_DIR || '';
if (!path.isAbsolute(modelDir)) process.exit(2);
const scorer = new DepthReadinessScorer({ estimator: sharedRawDepthEstimator(modelDir), videoSampler: ffmpegVideoSampler });

process.on('message', async (message: Request) => {
  if (!message || typeof message !== 'object') return;
  if (message.type === 'shutdown') { process.exit(0); return; }
  if (message.type !== 'score' || !Number.isInteger(message.id)) return;
  try {
    const input = message.input.kind === 'image'
      ? { kind: 'image' as const, bytes: Buffer.from(message.input.bytes) }
      : { kind: 'video' as const, file: message.input.file, ...(message.input.poster ? { poster: Buffer.from(message.input.poster) } : {}) };
    if (input.kind === 'video' && !path.isAbsolute(input.file)) throw new Error('Invalid video path.');
    const result = await scorer.score(input, message.quality);
    process.send?.({ id: message.id, ok: true, result, depth: depthDiagnostics(modelDir) });
  } catch {
    // Never forward raw model errors; the parent falls back to the heuristic.
    process.send?.({ id: message.id, ok: false });
  }
});
process.send?.({ ready: true });
