import express, { type ErrorRequestHandler } from 'express';
import multer from 'multer';
import path from 'node:path';
import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import type { Chapter, Memory, SceneSpec } from '../src/types.js';
import { MemoryStore } from './store.js';
import { fallbackScene, GEMINI_REVIEW_MAX_ITEMS, MemoryAI, type FolderPreview } from './ai.js';
import { localDateTime, organizeMemory, setOrganizerTimeZone, validTimeZone } from './organize.js';
import { integrationRouter } from './integrations.js';
import type { ApifyActorRunner } from './apify.js';
import { HttpError, isMediaBytes, mimeExtensions } from './http.js';
import { attachRooms } from './rooms.js';
import { allowedOrigin } from './origin.js';
import type { SceneReconstructor } from './reconstruction.js';
import type { WorldCompleter } from './world-completion.js';
import { completeVideoReconstruction } from './video-reconstruction.js';
import { IsolatedReadinessScorer, IsolatedSceneInference } from './scene-inference.js';
import { LibraryService } from './library.js';
import { DepthReadinessScorer, type Readiness3DScorer, READINESS_VERSION } from './depth-readiness.js';
import { archivePlannedBatch, planImportBatch, previewFromBytes } from './import-pipeline.js';

export async function createBackend(options: { dataDir?: string; env?: NodeJS.ProcessEnv; seed?: Memory[]; ai?: MemoryAI; reconstruction?: Pick<SceneReconstructor, 'reconstruct'>; worldCompletion?: Pick<WorldCompleter, 'complete'>; readiness?: Readiness3DScorer; apify?: ApifyActorRunner } = {}) {
  const env = options.env || process.env;
  const store = new MemoryStore(options.dataDir || path.resolve(env.DATA_DIR || 'data'), options.seed);
  await store.initialize();
  // All native model work runs in isolated worker processes, one at a time
  // (scene-inference.ts). The 3D check uses the same boundary: a short-lived
  // batch worker that holds the shared model lock while it scores.
  const isolatedInference = new IsolatedSceneInference(store.uploadsDir, env);
  // Injected reconstruction means a test backend: never start model workers there unless a scorer is injected too.
  const readiness = options.readiness || (options.reconstruction ? new DepthReadinessScorer() : new IsolatedReadinessScorer(path.join(store.directory, 'models'), env, { log: message => console.info(message) }));
  const library = new LibraryService(store, { readiness, log: message => console.info(message) });
  await library.initialize();
  // The 3D check is backend-only: any imported memory that was never checked
  // (or was checked by older rules) is checked automatically in the background.
  if (!options.reconstruction && store.list().some(memory => memory.source !== 'demo' && memory.url.startsWith('/uploads/') && memory.readiness3d?.version !== READINESS_VERSION)) {
    void library.startRescore3d({ onlyMissing: true })
      .then(({ job, started }) => (started ? library.runRescore3d(job.id) : undefined))
      .catch(error => console.error(`Startup 3D check failed: ${(error as Error)?.message || 'unknown error'}`));
  }
  const ai = options.ai || new MemoryAI(env.GEMINI_API_KEY, env.GEMINI_MODEL);
  const reconstruction = options.reconstruction || isolatedInference;
  const worldCompletion = options.worldCompletion || (options.reconstruction ? { complete: async (geometry: Awaited<ReturnType<SceneReconstructor['reconstruct']>>) => geometry } : undefined);
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    if (req.path.startsWith('/api')) res.setHeader('Cache-Control', 'no-store');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers.origin) {
      if (!allowedOrigin(req.headers.origin, req.headers.host || '', env)) { next(new HttpError(403, 'This request did not come from the memoir app.')); return; }
    }
    next();
  });
  app.use(express.json({ limit: '128kb' }));
  const limits = new Map<string, { start: number; count: number }>();
  app.use('/api', (req, _res, next) => {
    const now = Date.now(); const key = req.ip || 'unknown';
    if (limits.size > 2000) for (const [id, value] of limits) if (now - value.start > 60000) limits.delete(id);
    let value = limits.get(key);
    if (!value || now - value.start > 60000) { value = { start: now, count: 0 }; limits.set(key, value); }
    if (++value.count > 150) { next(new HttpError(429, 'Too many requests. Please wait a moment.')); return; }
    next();
  });
  const integrations = integrationRouter({ store, library, ai, env, apify: options.apify });
  app.get('/api/health', (req, res) => res.json({ ok: true, integrations: integrations.status(req) }));
  app.use('/api/integrations', integrations.router);
  app.get('/api/memories', (_req, res) => res.json({ memories: store.list() }));
  app.get('/api/import-jobs', (_req, res) => res.json({ jobs: library.jobs() }));
  app.get('/api/events', (_req, res) => res.json({ events: library.events() }));
  app.get('/api/albums', (_req, res) => res.json({ albums: library.albums() }));
  // Folder-first library: Pictures root → category folders → All memories (last).
  app.get('/api/folders', (_req, res) => res.json({ folders: library.folders() }));
  app.get('/api/folders/:id', (req, res) => {
    const contents = library.folderContents(String(req.params.id));
    if (!contents) throw new HttpError(404, 'Folder not found.');
    res.json(contents);
  });
  // Re-review existing archived memories in batches (local files only; nothing is re-downloaded or duplicated).
  app.post('/api/folders/reorganize', async (req, res) => {
    const { timeZone } = z.object({ timeZone: z.string().max(64).optional() }).parse(req.body || {});
    const zone = setOrganizerTimeZone(validTimeZone(timeZone) || '');
    // Provider timestamps are UTC; show and file them by the person's local day.
    const memories = store.list().filter(memory => memory.source !== 'demo').map(memory => {
      if (memory.source === 'upload' || !memory.capturedAt) return memory;
      const local = localDateTime(memory.capturedAt, zone);
      return local ? { ...memory, date: local.date } : memory;
    });
    const reviewLimit = GEMINI_REVIEW_MAX_ITEMS * 4;
    const summary = { kept: 0, renamed: 0, rejected: 0, reviewed: 0, local: 0 };
    for (let start = 0; start < memories.length; start += GEMINI_REVIEW_MAX_ITEMS) {
      const batch = memories.slice(start, start + GEMINI_REVIEW_MAX_ITEMS);
      const previews = new Map<string, FolderPreview>();
      if (ai.configured && start < reviewLimit) for (const memory of batch) {
        if (memory.mediaType !== 'image' || !memory.url.startsWith('/uploads/')) continue;
        const file = path.join(store.uploadsDir, path.basename(memory.url));
        const mimeType = Object.entries(mimeExtensions).find(([, extension]) => extension === path.extname(file))?.[0] || '';
        const preview = await readFile(file).then(bytes => previewFromBytes(bytes, mimeType)).catch(() => undefined);
        if (preview) previews.set(memory.id, preview);
      }
      const plan = start < reviewLimit ? await ai.planFolders(batch, previews) : { memories: batch.map(memory => organizeMemory({ ...memory, organization: undefined })), review: { mode: 'local' as const, kept: 0, renamed: 0, rejected: 0 } };
      summary.kept += plan.review.kept; summary.renamed += plan.review.renamed; summary.rejected += plan.review.rejected;
      if (plan.review.mode === 'gemini') summary.reviewed += batch.length; else summary.local += batch.length;
      await store.updateMany(plan.memories.map(memory => ({ id: memory.id, changes: { title: memory.title, date: memory.date, organization: memory.organization } })));
    }
    res.json({ folders: await library.refreshFolders(), summary });
  });
  // Background 3D check of memories already in the library: one job, same progress UI as imports.
  app.post('/api/library/rescore-3d', async (req, res) => {
    const { onlyMissing } = z.object({ onlyMissing: z.boolean().optional() }).parse(req.body || {});
    const { job, started } = await library.startRescore3d({ onlyMissing });
    if (started) void library.runRescore3d(job.id).catch(error => console.error(`3D rescore failed: ${(error as Error)?.message || 'unknown error'}`));
    res.status(202).json({ job, started });
  });
  app.post('/api/albums', async (req, res) => {
    const input = z.object({ title: z.string().trim().min(1).max(160), memoryIds: z.array(z.string().max(200)).min(1).max(200), coverMemoryId: z.string().max(200).optional(), worldAnchorMemoryId: z.string().max(200).optional() }).parse(req.body);
    try { res.status(201).json(await library.createManual(input.title, input.memoryIds, input.coverMemoryId, input.worldAnchorMemoryId)); }
    catch (error) { throw new HttpError(400, (error as Error).message); }
  });
  app.patch('/api/albums/:id', async (req, res) => {
    const input = z.object({ title: z.string().trim().min(1).max(160).optional(), type: z.literal('confirmed').optional(), addMemoryIds: z.array(z.string().max(200)).max(200).optional(), removeMemoryIds: z.array(z.string().max(200)).max(200).optional(), coverMemoryId: z.string().max(200).optional(), worldAnchorMemoryId: z.string().max(200).optional() }).parse(req.body);
    try {
      const album = await library.updateAlbum(String(req.params.id), input);
      if (!album) throw new HttpError(404, 'Album not found.');
      res.json(album);
    } catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(400, (error as Error).message); }
  });
  app.post('/api/albums/:id/share-preview', (req, res) => {
    const input = z.object({ memoryIds: z.array(z.string().max(200)).min(1).max(200).optional() }).parse(req.body);
    try {
      const preview = library.sharePreview(String(req.params.id), input.memoryIds);
      if (!preview) throw new HttpError(404, 'Album not found.');
      res.json(preview);
    } catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(400, (error as Error).message); }
  });
  app.post('/api/search', async (req, res) => {
    const { query } = z.object({ query: z.string().trim().max(1000) }).parse(req.body);
    if (!query) { res.json({ memories: store.list(), mode: 'keyword', explanation: 'Showing every memory in your library.' }); return; }
    res.json(await ai.search(query, store.list()));
  });
  const scenes = new Map<string, SceneSpec>();
  const pendingScenes = new Map<string, Promise<SceneSpec>>();
  const pendingCompletions = new Map<string, Promise<void>>();
  const pendingAtmospheres = new Map<string, Promise<void>>();
  /** Concurrent requests for the same memory share one build (main's isolated pipeline). */
  const buildScene = (memory: Memory) => {
    const key = JSON.stringify(memory);
    let pending = pendingScenes.get(key);
    if (!pending) {
      pending = (async () => {
        const cached = scenes.get(memory.id);
        const originalImagePath = memory.mediaType === 'image' && /^\/uploads\/[A-Za-z0-9_-]+\.(?:jpg|jpeg|png|webp|gif)$/.test(memory.url)
          ? path.join(store.uploadsDir, path.basename(memory.url)) : undefined;
        const originalImage = worldCompletion && originalImagePath ? await readFile(originalImagePath) : undefined;
        // Reuse atmosphere/depth while allowing versioned local stages to enrich
        // old worlds. Each native inference stage exits before the next starts.
        const complete = (geometry: Awaited<ReturnType<SceneReconstructor['reconstruct']>>) =>
          completeVideoReconstruction(geometry, frame => worldCompletion
            ? worldCompletion.complete(frame, { originalImage })
            : isolatedInference.complete(frame, originalImagePath));
        const reusable = cached?.reconstruction && (memory.mediaType !== 'video' || cached.reconstruction.video);
        // Return the local depth scene as soon as it exists. Semantic object
        // recognition, rear-view completion, and generated texture work are
        // useful upgrades, but must not block the first walkable opening.
        const scene: SceneSpec = reusable
          ? { ...cached! }
          : { ...fallbackScene(memory), reconstruction: await reconstruction.reconstruct(memory) };
        scenes.set(memory.id, scene); rooms.updateScene(scene);
        if (!reusable && ai.configured && !pendingAtmospheres.has(memory.id)) {
          const atmosphere = ai.scene(memory, store.uploadsDir).then(nextAtmosphere => {
            const latest = scenes.get(memory.id);
            if (!latest) return;
            const upgraded = { ...latest, ...nextAtmosphere, reconstruction: latest.reconstruction };
            scenes.set(memory.id, upgraded);
            rooms.updateScene(upgraded);
          }).catch(error => {
            console.warn(`Background scene description skipped for ${memory.id}: ${(error as Error)?.message || 'unknown error'}`);
          }).finally(() => pendingAtmospheres.delete(memory.id));
          pendingAtmospheres.set(memory.id, atmosphere);
        }
        const geometry = scene.reconstruction;
        const needsCompletion = Boolean(geometry && !geometry.completionUrl && (originalImagePath || geometry.video || worldCompletion));
        const existingCompletion = reusable ? pendingCompletions.get(memory.id) : undefined;
        if (needsCompletion && geometry && !pendingCompletions.has(memory.id)) {
          const completion = complete(geometry).then(enriched => {
            const latest = scenes.get(memory.id);
            if (!latest) return;
            const upgraded = { ...latest, reconstruction: enriched };
            scenes.set(memory.id, upgraded);
            rooms.updateScene(upgraded);
          }).catch(error => {
            console.warn(`Background world completion skipped for ${memory.id}: ${(error as Error)?.message || 'unknown error'}`);
          }).finally(() => pendingCompletions.delete(memory.id));
          pendingCompletions.set(memory.id, completion);
        }
        // A first open is fast; a deliberate immediate reopen can use the
        // upgraded cached scene if background enrichment already started.
        if (existingCompletion) await existingCompletion;
        return scenes.get(memory.id) || scene;
      })().finally(() => pendingScenes.delete(key));
      pendingScenes.set(key, pending);
    }
    return pending;
  };
  app.post('/api/memories/:id/scene', async (req, res) => {
    const memory = store.get(String(req.params.id));
    if (!memory) throw new HttpError(404, 'Memory not found.');
    res.json(await buildScene(memory));
  });
  app.post('/api/albums/:id/world', async (req, res) => {
    const album = library.album(String(req.params.id));
    if (!album) throw new HttpError(404, 'Album not found.');
    const anchor = store.get(album.worldAnchorMemoryId);
    if (!anchor) throw new HttpError(409, 'The album world anchor is no longer in the library.');
    const scene = await buildScene(anchor);
    const albumWorld = {
      albumId: album.id, worldId: `world-${album.id}`, anchorMemoryId: anchor.id, currentMemoryId: anchor.id,
      relatedMemoryIds: album.memoryIds, geometryNotice: 'This world uses inferred geometry from one anchor photo. Scale and unseen space are artistic estimates, not metric reconstruction.',
    };
    res.json({ album, anchor, memories: album.memoryIds.map(id => store.get(id)).filter(Boolean), scene: { ...scene, albumWorld } });
  });
  app.post('/api/memories/:id/analyze', async (req, res) => {
    const original = store.get(String(req.params.id));
    if (!original) throw new HttpError(404, 'Memory not found.');
    if (original.mediaType !== 'image' || !original.url.startsWith('/uploads/')) throw new HttpError(400, 'Automatic description needs a locally archived photo. Upload the photo or archive its social import first.');
    const filename = path.basename(original.url);
    const mimeType = Object.entries(mimeExtensions).find(([, extension]) => extension === path.extname(filename))?.[0] || '';
    const result = await ai.describe(original, await readFile(path.join(store.uploadsDir, filename)), mimeType);
    let memory = original;
    if (result.analyzed) {
      const originalText = original.description.split('\n\nVisual description:')[0];
      const updated = { ...original, description: `${originalText}${originalText ? '\n\n' : ''}Visual description: ${result.memory.description}`, tags: [...new Set([...original.tags, ...result.memory.tags])].slice(0, 30) };
      memory = (await store.update(original.id, updated))!;
      scenes.delete(original.id);
    }
    res.json({ memory, status: result.status, analyzed: result.analyzed });
  });
  app.patch('/api/memories/:id', async (req, res) => {
    const changes = z.object({ title: z.string().trim().min(1).max(160).optional(), description: z.string().max(4000).optional(), location: z.string().max(200).optional(), date: z.string().regex(/^$|^\d{4}-\d{2}-\d{2}$/).optional(), tags: z.array(z.string().max(60)).max(30).optional() }).parse(req.body);
    const memory = await store.update(String(req.params.id), changes);
    if (!memory) throw new HttpError(404, 'Memory not found.');
    scenes.delete(memory.id); res.json(memory);
  });
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024, files: 8, fields: 8, fieldSize: 16000 }, fileFilter: (_req, file, done) => { if (mimeExtensions[file.mimetype]) done(null, true); else done(new HttpError(400, 'Use JPEG, PNG, WebP, GIF, MP4, WebM, or MOV files.')); } });
  app.post('/api/upload', upload.array('files', 8), async (req, res) => {
    const files = req.files as Express.Multer.File[];
    if (!files?.length) throw new HttpError(400, 'Choose at least one photo or video.');
    if (files.reduce((sum, file) => sum + file.size, 0) > 100 * 1024 * 1024) throw new HttpError(413, 'Upload at most 100 MB at a time.');
    const meta = z.object({ title: z.string().max(160).optional(), description: z.string().max(4000).optional(), location: z.string().max(200).optional(), date: z.string().regex(/^$|^\d{4}-\d{2}-\d{2}$/).optional(), tags: z.string().max(1500).optional() }).parse(req.body);
    const memories: Memory[] = []; const statuses: { id: string; status: string }[] = [];
    for (const file of files) {
      if (!isMediaBytes(file.buffer, file.mimetype)) throw new HttpError(400, `The contents of ${file.originalname.slice(0, 100)} do not match its image or video type.`);
    }
    const pending = files.map(file => {
      const id = randomUUID(); const filename = `${id}${mimeExtensions[file.mimetype]}`; const url = `/uploads/${filename}`;
      const mediaType = file.mimetype.startsWith('video/') ? 'video' : 'image';
      const memory: Memory = { id, title: meta.title || file.originalname.replace(/\.[^.]+$/, '').slice(0, 160), description: meta.description || '', date: meta.date || '', location: meta.location || '', tags: meta.tags ? meta.tags.split(',').map(tag => tag.trim()).filter(Boolean).slice(0, 30) : [], source: 'upload', mediaType, url, thumbnailUrl: mediaType === 'image' ? url : '' };
      return { file, id, memory };
    });
    // Same folder-first batch pipeline as Google Photos and Apify imports.
    const planned = await planImportBatch({ ai, library, source: 'upload', candidates: pending.map(({ file, memory }) => ({
      sourceId: `${file.originalname}:${createHash('sha256').update(file.buffer).digest('hex').slice(0, 16)}:${memory.id}`,
      memory,
      preview: () => previewFromBytes(file.buffer, file.mimetype),
      fetch: async () => ({ bytes: file.buffer, mimeType: file.mimetype }),
    })) });
    const { job: completed, memories: saved } = await archivePlannedBatch(library, planned);
    for (const { id } of pending) {
      const item = completed.items.find(value => value.memoryId === id);
      const canonical = item?.canonicalMemoryId;
      if (canonical && !memories.some(memory => memory.id === canonical)) { const memory = saved.find(value => value.id === canonical) || store.get(canonical); if (memory) memories.push(memory); }
      statuses.push({ id: canonical || id, status: item?.status === 'failed' ? 'Could not be archived; retry this file.' : canonical === id ? 'Archived, embedded, and grouped locally.' : 'Duplicate matched to an existing memory.' });
    }
    res.status(201).json({ memories, statuses, job: completed, folderPlan: completed.folderPlan });
  });
  let chapters: Chapter[] = [];
  const chapterFile = path.join(store.directory, 'chapters.json');
  try { chapters = JSON.parse(await readFile(chapterFile, 'utf8')); if (!Array.isArray(chapters)) throw new Error('Chapter catalog is malformed.'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  let chapterWrites: Promise<void> = Promise.resolve();
  const saveChapters = () => { const json = JSON.stringify(chapters, null, 2); chapterWrites = chapterWrites.catch(() => {}).then(async () => { await mkdir(store.directory, { recursive: true }); await writeFile(`${chapterFile}.tmp`, json); await rename(`${chapterFile}.tmp`, chapterFile); }); return chapterWrites; };
  app.post('/api/account/clear-personal-data', async (req, res) => {
    z.object({ confirm: z.literal(true) }).parse(req.body);
    const catalog = await store.clearPersonalData();
    const libraryState = await library.clearPersonalData();
    chapters = [];
    await saveChapters();
    scenes.clear();
    res.json({ cleared: true, ...catalog, ...libraryState });
  });
  app.get('/api/chapters', (_req, res) => res.json({ chapters }));
  app.post('/api/chapters', async (req, res) => {
    const input = z.object({ id: z.string().uuid().optional(), title: z.string().trim().min(1).max(160), body: z.string().max(30000).default(''), memoryIds: z.array(z.string().max(200)).max(100) }).parse(req.body);
    if (input.memoryIds.some(id => !store.get(id))) throw new HttpError(400, 'Every chapter source must refer to a memory in this library.');
    const chapter: Chapter = { ...input, id: input.id || randomUUID(), memoryIds: [...new Set(input.memoryIds)], updatedAt: new Date().toISOString() };
    const index = chapters.findIndex(item => item.id === chapter.id);
    if (index >= 0) chapters[index] = chapter; else chapters.unshift(chapter);
    await saveChapters(); res.status(index >= 0 ? 200 : 201).json(chapter);
  });
  app.use('/uploads', express.static(store.uploadsDir, { dotfiles: 'deny', index: false, setHeaders: (res, file) => { res.setHeader('Cache-Control', path.dirname(file) === path.join(store.uploadsDir, 'reconstructions') ? 'private, no-cache, must-revalidate' : 'private, max-age=3600'); } }));
  app.use('/api', (_req, res) => res.status(404).json({ error: 'API route not found.' }));
  app.use(express.static(path.resolve('dist'), { index: false }));
  app.get('/{*splat}', (_req, res, next) => { res.sendFile(path.resolve('dist/index.html'), error => { if (error) next(); }); });
  const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
    if (error instanceof z.ZodError) { res.status(400).json({ error: 'Please check the request fields.', fields: error.issues.map(issue => ({ path: issue.path.join('.'), message: issue.message })) }); return; }
    if (error instanceof multer.MulterError) { res.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: error.code === 'LIMIT_FILE_SIZE' ? 'Each file must be 50 MB or smaller.' : error.message }); return; }
    if (error instanceof HttpError) { res.status(error.status).json({ error: error.message }); return; }
    if (error instanceof SyntaxError && 'body' in error) { res.status(400).json({ error: 'Request body must be valid JSON.' }); return; }
    console.error(`Request failed: ${error?.name || 'Error'}`);
    res.status(500).json({ error: 'The request could not be completed. Please try again.' });
  };
  app.use(errorHandler);
  const server = createServer(app);
  const rooms = attachRooms(server, store, scenes, env);
  return { app, server, store, library, rooms, scenes };
}
