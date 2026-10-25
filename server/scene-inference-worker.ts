import path from 'node:path';
import { readFile } from 'node:fs/promises';
import type { SceneInferenceJob } from './scene-inference.js';
import { SceneReconstructor } from './reconstruction.js';
import { WorldCompleter } from './world-completion.js';
import { localObjectRecognizer, LOCAL_OBJECT_MODEL_VERSION } from './local-object-detector.js';
import { isReconstructionSpec } from '../src/reconstruction-validation.js';
import { HttpError } from './http.js';
import { depthDiagnostics } from './depth-model.js';

// If the API stops, do not leave model processes running unattended.
process.once('disconnect', () => process.exit(1));

process.once('message', async (job: SceneInferenceJob) => {
  const started = performance.now();
  // The depth stage also reports which device ran it (and any fallback): worker output is discarded, so this is the only signal.
  const diagnostics = () => ({ elapsedMs: Math.round(performance.now() - started), peakRssBytes: Math.max(process.memoryUsage().rss, process.resourceUsage().maxRSS * 1024), ...(job?.kind === 'depth' && typeof job.uploadsDir === 'string' && path.isAbsolute(job.uploadsDir) ? depthDiagnostics(path.join(path.dirname(job.uploadsDir), 'models')) : {}) });
  try {
    if (!job || !path.isAbsolute(job.uploadsDir)) throw new Error('Invalid worker input.');
    let result;
    if (job.kind === 'depth') {
      result = await new SceneReconstructor(job.uploadsDir).reconstruct(job.memory);
    } else if (job.kind === 'complete' && isReconstructionSpec(job.reconstruction)) {
      let originalImage: Buffer | undefined;
      if (job.originalImagePath) {
        if (path.dirname(path.resolve(job.originalImagePath)) !== path.resolve(job.uploadsDir) || !/^[A-Za-z0-9_-]+\.(?:jpg|jpeg|png|webp|gif)$/i.test(path.basename(job.originalImagePath))) throw new Error('Invalid original image path.');
        originalImage = await readFile(job.originalImagePath);
      }
      const video = job.reconstruction.mediaBasis === 'video-frame';
      const completion = new WorldCompleter(job.uploadsDir, {
        // The moving-video renderer uses depth + category objects. Static people
        // segmentation, pose and invented rear textures are unused for video;
        // do not allocate those models or call cloud segmentation for each frame.
        ...(video ? { localSegmenter: false as const, poseEstimator: false as const } : {
          apiKey: process.env.GEMINI_API_KEY,
          model: process.env.GEMINI_MODEL,
          imageModel: process.env.GEMINI_IMAGE_MODEL,
          posePythonPath: process.env.POSE_PYTHON_PATH,
          poseModelVariant: process.env.POSE_MODEL_VARIANT === 'full' ? 'full' as const : 'heavy' as const,
        }),
        localObjectRecognizer: localObjectRecognizer(path.join(path.dirname(job.uploadsDir), 'models')),
        localObjectModelVersion: LOCAL_OBJECT_MODEL_VERSION,
      });
      result = await completion.complete(job.reconstruction, { originalImage });
      if (video) {
        const world = JSON.parse(await readFile(path.join(job.uploadsDir, 'reconstructions', path.basename(result.completionUrl || '')), 'utf8'));
        if (world.objectRecognition?.status !== 'complete')
          throw new HttpError(503, 'Video object recognition is unavailable for this frame. Completed frames are saved; retry after the model is available.');
      }
    } else throw new Error('Invalid reconstruction stage.');
    if (!isReconstructionSpec(result)) throw new Error('Invalid reconstruction result.');
    process.send?.({ ok: true, result, diagnostics: diagnostics() }, () => process.exit(0));
  } catch (error) {
    // Never forward raw model/provider messages to clients: they may include
    // credentials or source paths. HttpError messages are authored by this app.
    const response = error instanceof HttpError
      ? { ok: false, status: error.status, message: error.message }
      : { ok: false, status: 503, message: 'The reconstruction model could not complete this frame. Completed frames are saved; retry to resume.' };
    process.send?.({ ...response, diagnostics: diagnostics() }, () => process.exit(1));
  }
});
