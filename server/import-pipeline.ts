import sharp from 'sharp';
import type { ImportJob, Memory, MemorySource } from '../src/types.js';
import { GEMINI_REVIEW_MAX_ITEMS, type FolderPreview, type MemoryAI } from './ai.js';
import type { LibraryService } from './library.js';

/**
 * The single folder-first import pipeline shared by local uploads, Google
 * Photos Picker selections, and Instagram / LinkedIn / YouTube (Apify) imports:
 *
 *   1. plan    – deterministic local folder for every item, then ONE optional
 *                Gemini keep/rename review for batches ≤ GEMINI_REVIEW_MAX_ITEMS
 *   2. folders – the folder plan and the import job are persisted together
 *   3. archive – bytes are fetched/archived, hashed, deduplicated, embedded,
 *                then 3D-checked (depth readiness; only ready items are filed
 *                into Pictures/category folders, everything stays in All memories)
 *   4. finish  – events/albums/folders are rebuilt once for the whole batch
 *
 * Callers see one job with aggregate progress, never a per-file workflow.
 */
export type ImportCandidate = {
  sourceId: string;
  memory: Memory;
  /** Small image used only for the folder review; never archived. */
  preview?: () => Promise<FolderPreview | undefined>;
  /** Produces the media bytes to archive. Runs after the folder plan exists. */
  fetch: () => Promise<{ bytes: Buffer; mimeType: string; poster?: { bytes: Buffer; mimeType: string } }>;
  /**
   * When archiving fails, keep the consented item as a remote-only memory (its
   * provider link) instead of dropping it. The import item stays retryable.
   */
  remoteFallback?: (planned: Memory) => Memory;
};

export type PlannedImport = { job: ImportJob; candidates: ImportCandidate[] };

/** Downscale an image to a ≤384px JPEG for the folder review. Videos/unsupported → undefined. */
export async function previewFromBytes(bytes: Buffer, mimeType: string): Promise<FolderPreview | undefined> {
  if (!mimeType.startsWith('image/')) return undefined;
  try {
    const data = await sharp(bytes, { failOn: 'error' }).rotate().resize(384, 384, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 70 }).toBuffer();
    return { mimeType: 'image/jpeg', data };
  } catch { return undefined; }
}

async function mapLimit<T, R>(items: T[], limit: number, task: (item: T) => Promise<R>) {
  const results: R[] = new Array(items.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const index = next++; results[index] = await task(items[index]); }
  }));
  return results;
}

/** Steps 1–2: build and persist the folder plan + job before any media is archived. */
export async function planImportBatch(options: { ai: MemoryAI; library: LibraryService; source: MemorySource; candidates: ImportCandidate[] }): Promise<PlannedImport> {
  const { ai, library, source, candidates } = options;
  const previews = new Map<string, FolderPreview>();
  // Previews only matter when Gemini will actually review this batch.
  if (ai.configured && candidates.length <= GEMINI_REVIEW_MAX_ITEMS) {
    await mapLimit(candidates, 6, async candidate => {
      const preview = await candidate.preview?.().catch(() => undefined);
      if (preview) previews.set(candidate.memory.id, preview);
    });
  }
  const plan = await ai.planFolders(candidates.map(candidate => candidate.memory), previews);
  const byId = new Map(plan.memories.map(memory => [memory.id, memory]));
  const job = await library.planImport(source, plan.memories, plan.review);
  return { job, candidates: candidates.map(candidate => ({ ...candidate, memory: byId.get(candidate.memory.id) || candidate.memory })) };
}

/** Steps 3–4: archive every planned item under the one job, then finish it once. */
export async function archivePlannedBatch(library: LibraryService, planned: PlannedImport) {
  const saved: Memory[] = []; const remote: string[] = [];
  for (const candidate of planned.candidates) {
    try {
      const media = await candidate.fetch();
      const memory = await library.ingestBytes(planned.job.id, candidate.sourceId, candidate.memory, media.bytes, media.mimeType, media.poster);
      if (memory && !saved.some(item => item.id === memory.id)) saved.push(memory);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The selected item could not be imported.';
      if (candidate.remoteFallback) {
        const kept = await library.keepRemote(planned.job.id, candidate.sourceId, candidate.remoteFallback(candidate.memory), `Saved with its remote link; archiving will be retried. ${message}`);
        if (kept && !saved.some(item => item.id === kept.id)) saved.push(kept);
        remote.push(candidate.memory.id);
      } else await library.failItem(planned.job.id, candidate.sourceId, message, true);
    }
  }
  const job = await library.finishJob(planned.job.id);
  return { job, memories: saved, remoteOnly: remote };
}
