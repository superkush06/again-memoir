/** Apply local object detection to real archived Carriage scenes, including all
 * video depth samples. No Gemini client or paid service is constructed here.
 * Run review-carriage.ts first; optional arguments select specific memory IDs.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { MemoryStore } from '../../server/store.js';
import { SceneReconstructor } from '../../server/reconstruction.js';
import { WorldCompleter } from '../../server/world-completion.js';
import { completeVideoReconstruction } from '../../server/video-reconstruction.js';
import { localObjectRecognizer, LOCAL_OBJECT_MODEL_VERSION } from '../../server/local-object-detector.js';
import type { WorldCompletion } from '../../src/types.js';

const audit = JSON.parse(await readFile('.local/carriage-object-audit/manifest.json', 'utf8'));
const knownIds = new Set<string>([...audit.photos, ...audit.videos].map(entry => entry.memoryId));
const requested = process.argv.slice(2);
if (requested.some(id => !knownIds.has(id))) throw new Error('Select only memory IDs in the audited Carriage archive.');
const selected = requested.length ? new Set(requested) : knownIds;
const directory = path.resolve('data');
const store = new MemoryStore(directory);
await store.initialize();
const reconstructor = new SceneReconstructor(store.uploadsDir);
const completer = new WorldCompleter(store.uploadsDir, {
  poseEstimator: false,
  localObjectRecognizer: localObjectRecognizer(path.join(directory, 'models')),
  localObjectModelVersion: LOCAL_OBJECT_MODEL_VERSION,
});
const outputDirectory = path.resolve('.local/carriage-object-audit/scenes');
await mkdir(outputDirectory, { recursive: true });
const results = [];
for (const memory of store.list().filter(memory => selected.has(memory.id))) {
  const start = Date.now();
  console.log(`Reconstructing ${memory.id} (${memory.mediaType}) with local models.`);
  const geometry = await reconstructor.reconstruct(memory);
  const originalImage = memory.mediaType === 'image' ? await readFile(path.join(store.uploadsDir, path.basename(memory.url))) : undefined;
  const completed = await completeVideoReconstruction(geometry, frame => completer.complete(frame, { originalImage }));
  const frames = completed.video?.frames ?? [{ time: 0, completionUrl: completed.completionUrl }];
  const detections = [];
  for (const frame of frames) {
    if (!frame.completionUrl) throw new Error('Missing object completion metadata.');
    const world: WorldCompletion = JSON.parse(await readFile(path.join(store.uploadsDir, 'reconstructions', path.basename(frame.completionUrl)), 'utf8'));
    if (world.objectRecognition?.source !== 'local-grounding-dino' || world.objectRecognition.status !== 'complete')
      throw new Error(`Local detector unavailable for ${memory.id} at ${frame.time}s.`);
    detections.push({ time: frame.time, recognition: world.objectRecognition, objects: world.subjects.filter(s => s.object).map(s => ({ id: s.id, label: s.label, box: s.box, maskUrl: s.maskUrl, object: s.object })) });
  }
  const result = { memoryId: memory.id, title: memory.title, mediaType: memory.mediaType, milliseconds: Date.now() - start, reconstruction: completed, frames: detections };
  results.push(result);
  await writeFile(path.join(outputDirectory, `${memory.id}.json`), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ memoryId: memory.id, milliseconds: result.milliseconds, counts: detections.map(frame => frame.objects.length) }));
}
await writeFile(path.join(outputDirectory, 'results.json'), JSON.stringify(results, null, 2));
