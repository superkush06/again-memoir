import path from 'node:path';
import { MemoryStore } from '../server/store.js';
import { SceneReconstructor } from '../server/reconstruction.js';

const store = new MemoryStore(path.resolve(process.env.DATA_DIR || 'data'));
await store.initialize();
const reconstructor = new SceneReconstructor(store.uploadsDir);
let failures = 0;
for (const memory of store.list()) {
  const start = performance.now();
  try {
    const result = await reconstructor.reconstruct(memory);
    console.log(`${memory.id}: ${result.kind}, ${result.width}×${result.height}, ${Math.round(performance.now()-start)}ms`);
  } catch(error) {
    failures++;
    console.error(`${memory.id}: ${(error as Error).message}`);
  }
}
if (failures) process.exitCode = 1;
