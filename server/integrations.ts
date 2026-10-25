import { randomBytes, createHash } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import type { Memory } from '../src/types.js';
import type { MemoryStore } from './store.js';
import type { MemoryAI } from './ai.js';
import { HttpError, mimeExtensions, providerJson, isMediaBytes } from './http.js';
import { downloadSocialMedia } from './media.js';
import { runApifyActor, type ApifyActorRunner } from './apify.js';
import { sharedAlbumLink, sharedAlbumMemory } from './shared-album.js';
import { archivePlannedBatch, planImportBatch, previewFromBytes, type ImportCandidate } from './import-pipeline.js';
import { localDateTime, setOrganizerTimeZone, validTimeZone } from './organize.js';
import type { LibraryService } from './library.js';

type GoogleSession = { state?: string; stateExpires?: number; verifier?: string; accessToken?: string; refreshToken?: string; expires?: number; touched: number; pickerIds: Set<string>; pickerLimits: Map<string, number>; returnTo?: 'onboarding' | 'sources' };
type IntegrationOptions = { store: MemoryStore; library: LibraryService; ai: MemoryAI; env: NodeJS.ProcessEnv; apify?: ApifyActorRunner };
const APIFY_CONSENT_STATEMENT = 'I confirm that this is my own account, or that I have permission to import this content, and I authorize this app to retrieve and archive the selected posts and media.';
const SHARED_ALBUM_CONSENT_STATEMENT = 'I confirm that this shared album is mine, or that I have permission to import its photos, and I authorize this app to retrieve and archive them.';
const selectedScope = 'https://www.googleapis.com/auth/photospicker.mediaitems.readonly';
const pickerBase = 'https://photospicker.googleapis.com/v1';
const maxPickerItems = 2000;
const defaultAppOrigin = 'http://localhost:5173';

function trimOrigin(value: string | undefined, fallback: string) {
  const trimmed = value?.trim().replace(/\/+$/, '');
  return trimmed || fallback;
}

export function googleAppOrigin(env: NodeJS.ProcessEnv) {
  return trimOrigin(env.APP_ORIGIN, defaultAppOrigin);
}

export function googleRedirectUri(env: NodeJS.ProcessEnv) {
  return trimOrigin(env.GOOGLE_REDIRECT_URI, `${googleAppOrigin(env)}/api/integrations/google/callback`);
}

export function parseGooglePickerLimit(body: unknown) {
  return z.object({ maxItemCount: z.number().int().min(1).max(maxPickerItems).default(maxPickerItems) }).parse(body || {}).maxItemCount;
}

export function integrationRouter({ store, library, ai, env, apify = runApifyActor }: IntegrationOptions) {
  const router = Router();
  const sessions = new Map<string, GoogleSession>();
  const googleConfigured = !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
  const appOrigin = googleAppOrigin(env);
  const redirectUri = googleRedirectUri(env);
  function session(req: Request, res?: Response) {
    const cookie = req.headers.cookie?.split(';').map(value => value.trim()).find(value => value.startsWith('memoir_google='))?.split('=')[1];
    if (cookie && sessions.has(cookie)) {
      const value = sessions.get(cookie)!;
      value.touched = Date.now();
      return value;
    }
    if (!res) return undefined;
    for (const [id, item] of sessions) if (Date.now() - item.touched > 24 * 60 * 60 * 1000) sessions.delete(id);
    if (sessions.size >= 1000) throw new HttpError(429, 'Too many sign-in sessions. Try again later.');
    const id = randomBytes(24).toString('hex');
    const value: GoogleSession = { touched: Date.now(), pickerIds: new Set(), pickerLimits: new Map() };
    sessions.set(id, value);
    res.cookie('memoir_google', id, { httpOnly: true, sameSite: 'lax', secure: redirectUri.startsWith('https:'), path: '/', maxAge: 24 * 60 * 60 * 1000 });
    return value;
  }
  async function token(value?: GoogleSession) {
    if (!value?.accessToken) throw new HttpError(401, 'Connect Google Photos first.');
    if ((value.expires ?? 0) < Date.now() + 60000 && value.refreshToken) {
      const result = await providerJson('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID!, client_secret: env.GOOGLE_CLIENT_SECRET!, refresh_token: value.refreshToken, grant_type: 'refresh_token' }) });
      value.accessToken = result.access_token;
      value.expires = Date.now() + result.expires_in * 1000;
    }
    return value.accessToken;
  }
  const status = (req?: Request) => ({
    gemini: { configured: ai.configured, status: ai.configured ? 'configured' : 'not_configured', model: env.GEMINI_MODEL || 'gemini-3.5-flash', lastOperation: ai.diagnostic },
    googlePhotos: { configured: googleConfigured, connected: !!(req && session(req)?.accessToken), redirectUri, status: googleConfigured ? 'ready_to_connect' : 'needs_oauth', message: 'Google Photos uses OAuth and a photo picker. Select the photos you want to add; library-wide API search is unavailable.' },
    apify: { configured: !!env.APIFY_TOKEN, instagram: !!env.APIFY_TOKEN, linkedin: !!(env.APIFY_TOKEN && env.APIFY_LINKEDIN_ACTOR), youtube: !!(env.APIFY_TOKEN && env.APIFY_YOUTUBE_ACTOR), googlePhotosAlbum: !!(env.APIFY_TOKEN && env.APIFY_GOOGLE_PHOTOS_ACTOR), status: env.APIFY_TOKEN ? 'configured' : 'not_configured' },
    multiplayer: { mode: 'spacetimedb', status: 'configured', spacetimeConfigured: true, database: env.VITE_SPACETIMEDB_DATABASE || 'vr-mutliplayer-memoir-naxot', url: env.VITE_SPACETIMEDB_URL || 'https://maincloud.spacetimedb.com', fallback: 'websocket', message: 'SpacetimeDB is configured. The browser reports its live connection status; the local WebSocket fallback is also available.' },
  });
  router.get('/', (req, res) => res.json(status(req)));
  router.get('/google/auth-url', (req, res) => {
    if (!googleConfigured) throw new HttpError(503, 'Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET for a Google OAuth web application.');
    const value = session(req, res)!;
    value.returnTo = req.query.context === 'onboarding' ? 'onboarding' : 'sources';
    value.state = randomBytes(24).toString('hex'); value.stateExpires = Date.now() + 10 * 60 * 1000;
    value.verifier = randomBytes(32).toString('base64url');
    const params = new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID!, redirect_uri: redirectUri, response_type: 'code', scope: selectedScope, access_type: 'offline', prompt: 'consent', state: value.state, code_challenge: createHash('sha256').update(value.verifier).digest('base64url'), code_challenge_method: 'S256' });
    res.json({ url: `https://accounts.google.com/o/oauth2/v2/auth?${params}` });
  });
  router.get('/google/callback', async (req, res) => {
    const value = session(req);
    if (!value || typeof req.query.state !== 'string' || req.query.state !== value.state || (value.stateExpires ?? 0) < Date.now()) throw new HttpError(400, 'Google sign-in expired or could not be verified. Connect again.');
    delete value.state;
    if (req.query.error || typeof req.query.code !== 'string') throw new HttpError(400, 'Google Photos access was not granted.');
    const result = await providerJson('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID!, client_secret: env.GOOGLE_CLIENT_SECRET!, redirect_uri: redirectUri, code: req.query.code, grant_type: 'authorization_code', code_verifier: value.verifier! }) });
    value.accessToken = result.access_token; value.refreshToken = result.refresh_token; value.expires = Date.now() + result.expires_in * 1000;
    delete value.verifier;
    const destination = value.returnTo === 'onboarding' ? '?google=connected&onboarding=google' : '?google=connected';
    delete value.returnTo;
    res.redirect(`${appOrigin}/${destination}`);
  });
  router.post('/google/picker', async (req, res) => {
    const value = session(req);
    const bearer = await token(value);
    const maxItemCount = parseGooglePickerLimit(req.body);
    const result = await providerJson(`${pickerBase}/sessions`, { method: 'POST', headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ pickingConfig: { maxItemCount: String(maxItemCount) } }) });
    value!.pickerIds.add(result.id);
    value!.pickerLimits.set(result.id, maxItemCount);
    res.json(result);
  });
  router.get('/google/picker/:sessionId', async (req, res) => {
    const value = session(req);
    if (!value?.pickerIds.has(String(req.params.sessionId))) throw new HttpError(404, 'Picker session not found for this browser.');
    const bearer = await token(value);
    res.json(await providerJson(`${pickerBase}/sessions/${encodeURIComponent(String(req.params.sessionId))}`, { headers: { Authorization: `Bearer ${bearer}` } }));
  });
  router.post('/google/picker/:sessionId/import', async (req, res) => {
    const value = session(req);
    const id = String(req.params.sessionId);
    if (!value?.pickerIds.has(id)) throw new HttpError(404, 'Picker session not found for this browser.');
    const pickerLimit = value.pickerLimits.get(id) || maxPickerItems;
    // Google reports UTC; holidays and dates are decided in the person's own time zone.
    const timeZone = setOrganizerTimeZone(validTimeZone((req.body as { timeZone?: unknown } | undefined)?.timeZone) || '');
    const bearer = await token(value);
    const headers = { Authorization: `Bearer ${bearer}` };
    const current = await providerJson(`${pickerBase}/sessions/${encodeURIComponent(id)}`, { headers });
    if (!current.mediaItemsSet) throw new HttpError(409, 'Finish choosing photos in the Google Photos picker, then import.');
    const selected: any[] = [];
    let pageToken = '';
    do {
      const params = new URLSearchParams({ sessionId: id, pageSize: '100', ...(pageToken ? { pageToken } : {}) });
      const page = await providerJson(`${pickerBase}/mediaItems?${params}`, { headers });
      selected.push(...(page.mediaItems ?? []).slice(0, pickerLimit - selected.length));
      pageToken = page.nextPageToken || '';
    } while (pageToken && selected.length < pickerLimit);
    if (!selected.length) throw new HttpError(409, 'Choose at least one photo or video in Google Photos, then finish the selection.');
    const googleMediaUrl = (item: any, suffix: string) => {
      const base = new URL(item.mediaFile?.baseUrl);
      if (base.protocol !== 'https:' || !['googleusercontent.com', 'ggpht.com'].some(domain => base.hostname === domain || base.hostname.endsWith(`.${domain}`))) throw new Error('Invalid media host');
      return `${base}${suffix}`;
    };
    const download = async (url: string, maxBytes: number) => {
      const downloaded = await fetch(url, { headers, signal: AbortSignal.timeout(60000), redirect: 'error' });
      if (!downloaded.ok || !downloaded.body) throw new Error('Download failed');
      const chunks: Buffer[] = []; let length = 0;
      for await (const chunk of downloaded.body as any) { length += chunk.length; if (length > maxBytes) { await downloaded.body.cancel().catch(() => {}); throw new Error('File exceeds 50 MB'); } chunks.push(Buffer.from(chunk)); }
      return { bytes: Buffer.concat(chunks), mimeType: (downloaded.headers.get('content-type') || '').split(';')[0].trim().toLowerCase() };
    };
    const candidates: ImportCandidate[] = selected.map(item => {
      const sourceId = String(item.id || randomBytes(12).toString('hex'));
      const media = item.mediaFile || {};
      const isVideo = item.type === 'VIDEO';
      return {
        sourceId,
        // Picker filenames such as PXL_… are sanitized into "Photo memory" / "Video memory".
        memory: { id: `google-${sourceId}`, title: media.filename || (isVideo ? 'Video memory' : 'Photo memory'), description: 'Selected from Google Photos.', date: (item.createTime && localDateTime(item.createTime, timeZone)?.date) || item.createTime?.slice(0, 10) || '', capturedAt: item.createTime || undefined, location: '', tags: [], source: 'google-photos' as const, mediaType: isVideo ? 'video' as const : 'image' as const, url: '', thumbnailUrl: '', width: media.mediaFileMetadata?.width, height: media.mediaFileMetadata?.height, sourceUrl: 'https://photos.google.com/', sourceAccount: 'Google Photos selection' },
        // A small still (works for photos and video posters) is all Gemini sees.
        preview: async () => {
          const still = await download(googleMediaUrl(item, '=w384-h384'), 5 * 1024 * 1024);
          return previewFromBytes(still.bytes, still.mimeType.startsWith('image/') ? still.mimeType : 'image/jpeg');
        },
        fetch: async () => {
          const extension = mimeExtensions[media.mimeType];
          if (!extension) throw new Error('The selected file format is not supported.');
          if (isVideo && media.mediaFileMetadata?.videoMetadata?.processingStatus !== 'READY') throw new Error('The selected video is still processing in Google Photos.');
          const { bytes } = await download(googleMediaUrl(item, isVideo ? '=dv' : '=w2560-h2560'), 50 * 1024 * 1024);
          if (!isMediaBytes(bytes, media.mimeType)) throw new Error('Invalid media data');
          let poster: { bytes: Buffer; mimeType: string } | undefined;
          if (isVideo) {
            const still = await download(googleMediaUrl(item, '=w1024-h1024'), 10 * 1024 * 1024).catch(() => undefined);
            if (still && mimeExtensions[still.mimeType] && isMediaBytes(still.bytes, still.mimeType)) poster = still;
          }
          return { bytes, mimeType: media.mimeType, poster };
        },
      };
    });
    // Folder plan + job are persisted before any original is downloaded or archived.
    const planned = await planImportBatch({ ai, library, source: 'google-photos', candidates });
    res.status(202).json({ jobId: planned.job.id, job: planned.job, folderPlan: planned.job.folderPlan });
    void (async () => {
      const { job: completed } = await archivePlannedBatch(library, planned);
      if (!completed.failedItems) {
        await providerJson(`${pickerBase}/sessions/${encodeURIComponent(id)}`, { method: 'DELETE', headers }).catch(() => {});
        value.pickerIds.delete(id);
        value.pickerLimits.delete(id);
      }
    })().catch(() => console.error('Google Photos import job stopped unexpectedly.'));
  });
  router.post('/google/disconnect', (req, res) => {
    const value = session(req);
    if (value) { delete value.accessToken; delete value.refreshToken; value.pickerIds.clear(); value.pickerLimits.clear(); }
    res.json({ disconnected: true });
  });
  router.post('/apify/import', async (req, res) => {
    if (!env.APIFY_TOKEN) throw new HttpError(503, 'Set APIFY_TOKEN on the server to import social memories.');
    const input = z.object({
      source: z.enum(['instagram', 'linkedin', 'youtube']),
      profileUrl: z.string().url().max(500),
      limit: z.number().int().min(1).max(20).default(6),
      confirmOwnership: z.boolean().refine(Boolean, 'Confirm that this is your account or that you have permission to use it.'),
      confirmConsent: z.boolean().refine(Boolean, 'Confirm that you authorize this import.'),
      timeZone: z.string().max(64).optional(),
    }).parse(req.body);
    const timeZone = setOrganizerTimeZone(validTimeZone(input.timeZone) || '');
    const profile = new URL(input.profileUrl);
    const domain = input.source === 'instagram' ? 'instagram.com' : input.source === 'linkedin' ? 'linkedin.com' : 'youtube.com';
    const validHost = profile.hostname === domain || profile.hostname === `www.${domain}` || (input.source === 'youtube' && profile.hostname === 'youtu.be');
    if (profile.protocol !== 'https:' || !validHost || profile.username || profile.password) throw new HttpError(400, `Enter an HTTPS ${domain} account or channel URL.`);
    const actor = input.source === 'instagram' ? (env.APIFY_INSTAGRAM_ACTOR || 'apify/instagram-scraper') : input.source === 'linkedin' ? env.APIFY_LINKEDIN_ACTOR : env.APIFY_YOUTUBE_ACTOR;
    if (!actor) throw new HttpError(503, `Configure an Apify actor for ${input.source} before importing.`);
    let actorInput: Record<string, unknown> = { directUrls: [profile.toString()], resultsType: 'posts', resultsLimit: input.limit, addParentData: false };
    if (input.source !== 'instagram') {
      const template = input.source === 'linkedin' ? env.APIFY_LINKEDIN_INPUT_TEMPLATE : env.APIFY_YOUTUBE_INPUT_TEMPLATE;
      if (!template) throw new HttpError(503, `Set the ${input.source === 'linkedin' ? 'LinkedIn' : 'YouTube'} actor input template using {{profileUrl}} and {{limit}} placeholders.`);
      try { actorInput = JSON.parse(template.replaceAll('{{profileUrl}}', profile.toString()).replaceAll('{{limit}}', String(input.limit))); } catch { throw new HttpError(503, `The configured ${input.source} actor input template is invalid JSON.`); }
    }
    const consent = await store.recordConsent({ source: input.source, accountUrl: profile.toString(), statement: APIFY_CONSENT_STATEMENT });
    const params = new URLSearchParams({ timeout: '120', memory: '1024', clean: 'true', limit: String(input.limit), maxTotalChargeUsd: env.APIFY_MAX_CHARGE_USD || '1' });
    const items = await providerJson(`https://api.apify.com/v2/acts/${encodeURIComponent(actor.replace('/', '~'))}/run-sync-get-dataset-items?${params}`, { method: 'POST', headers: { Authorization: `Bearer ${env.APIFY_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(actorInput) }, 130000);
    if (!Array.isArray(items)) throw new HttpError(502, 'The actor did not return a list of posts. Check its output schema.');
    const candidates: ImportCandidate[] = [];
    // One shared download per CDN URL: the review preview and the archive reuse the same bytes.
    const downloads = new Map<string, Promise<Awaited<ReturnType<typeof downloadSocialMedia>>>>();
    const download = (mediaUrl: string, maxBytes: number) => {
      if (!downloads.has(mediaUrl)) downloads.set(mediaUrl, downloadSocialMedia(mediaUrl, maxBytes, 0, input.source));
      return downloads.get(mediaUrl)!;
    };
    for (const item of items.slice(0, input.limit)) {
      const image = item.displayUrl || item.imageUrl || item.thumbnailUrl || item.thumbnail || item.images?.[0] || item.image;
      const video = item.videoUrl;
      const mediaUrl = video || image;
      if (typeof mediaUrl !== 'string' || !mediaUrl.startsWith('https://')) continue;
      const caption = String(item.caption || item.text || item.description || '').slice(0, 4000);
      const dateValue = item.timestamp || item.publishedAt || item.date;
      const parsedDate = dateValue ? new Date(dateValue) : null;
      const identity = item.id || item.shortCode || item.url || mediaUrl;
      const isVideo = Boolean(video && mediaUrl === video);
      const poster = typeof image === 'string' && image !== mediaUrl ? image : (isVideo && typeof item.thumbnailUrl === 'string' ? item.thumbnailUrl : '');
      const memory: Memory = { id: `${input.source}-${createHash('sha256').update(String(identity)).digest('hex').slice(0, 20)}`, title: caption.split(/[\n.!?]/)[0]?.slice(0, 120) || (isVideo ? 'Video memory' : 'Photo memory'), description: caption || 'Imported social post.', date: parsedDate && !isNaN(parsedDate.getTime()) ? (localDateTime(parsedDate.toISOString(), timeZone)?.date || parsedDate.toISOString().slice(0, 10)) : '', capturedAt: parsedDate && !isNaN(parsedDate.getTime()) ? parsedDate.toISOString() : undefined, location: String(item.locationName || '').slice(0, 160), tags: Array.isArray(item.hashtags) ? item.hashtags.map(String).slice(0, 30) : [], source: input.source, mediaType: isVideo ? 'video' : 'image', url: mediaUrl, thumbnailUrl: '', width: item.dimensionsWidth, height: item.dimensionsHeight, sourceUrl: typeof item.url === 'string' ? item.url : profile.toString(), sourceAccount: profile.toString(), consentId: consent.id };
      if (store.get(memory.id) || candidates.some(candidate => candidate.memory.id === memory.id)) continue;
      candidates.push({
        sourceId: String(identity).slice(0, 300),
        memory,
        preview: async () => {
          const still = isVideo ? (poster ? await download(poster, 15 * 1024 * 1024) : undefined) : await download(mediaUrl, 50 * 1024 * 1024);
          return still ? previewFromBytes(still.bytes, still.mimeType) : undefined;
        },
        // If the CDN refuses the download, keep the consented post with its provider link (All memories only).
        remoteFallback: planned => ({ ...planned, url: mediaUrl, thumbnailUrl: isVideo ? poster : mediaUrl }),
        fetch: async () => {
          const media = await download(mediaUrl, 50 * 1024 * 1024);
          const still = isVideo && poster ? await download(poster, 15 * 1024 * 1024).catch(() => undefined) : undefined;
          return { bytes: media.bytes, mimeType: media.mimeType, poster: still && still.mimeType.startsWith('image/') ? { bytes: still.bytes, mimeType: still.mimeType } : undefined };
        },
      });
    }
    // Same batch pipeline as uploads and Google Photos: plan folders → create them → archive → finish.
    const planned = await planImportBatch({ ai, library, source: input.source, candidates });
    const { job, memories, remoteOnly } = await archivePlannedBatch(library, planned);
    const remoteIds = new Set(remoteOnly);
    const warnings = memories.filter(memory => remoteIds.has(memory.id)).map(memory => `${memory.title}: could not archive media from its CDN. The remote URL may expire; upload the original for durable storage.`);
    res.json({ memories, imported: memories.length, skipped: items.length - memories.length, warnings, job, folderPlan: job.folderPlan });
  });
  // Link-shared Google Photos albums, which the Picker API cannot open, come from
  // our own Actor (actors/google-photos-album) run through the Apify SDK.
  router.post('/apify/google-photos-album', async (req, res) => {
    if (!env.APIFY_TOKEN) throw new HttpError(503, 'Set APIFY_TOKEN on the server to import shared albums.');
    const actor = env.APIFY_GOOGLE_PHOTOS_ACTOR;
    if (!actor) throw new HttpError(503, 'Deploy actors/google-photos-album to Apify, then set APIFY_GOOGLE_PHOTOS_ACTOR to its ID (for example, username/google-photos-shared-album).');
    const input = z.object({
      albumUrl: z.string().url().max(500),
      limit: z.number().int().min(1).max(50).default(12),
      confirmConsent: z.boolean().refine(Boolean, 'Confirm that you have permission to import this album.'),
      timeZone: z.string().max(64).optional(),
    }).parse(req.body);
    const album = sharedAlbumLink(input.albumUrl);
    if (!album) throw new HttpError(400, 'Enter a shared Google Photos album link (photos.app.goo.gl or photos.google.com/share).');
    const timeZone = setOrganizerTimeZone(validTimeZone(input.timeZone) || '');
    const consent = await store.recordConsent({ source: 'google-photos', accountUrl: album.toString(), statement: SHARED_ALBUM_CONSENT_STATEMENT });
    const rows = await apify(env.APIFY_TOKEN, actor, { albumUrl: album.toString(), maxItems: input.limit }, { limit: input.limit, maxTotalChargeUsd: Number(env.APIFY_MAX_CHARGE_USD || '1') });
    const candidates: ImportCandidate[] = [];
    for (const row of rows.slice(0, input.limit)) {
      const memory = sharedAlbumMemory(row, { albumUrl: album.toString(), consentId: consent.id, timeZone });
      if (!memory || store.get(memory.id) || candidates.some(candidate => candidate.memory.id === memory.id)) continue;
      let bytes: ReturnType<typeof downloadSocialMedia> | undefined;
      const download = () => (bytes ??= downloadSocialMedia(memory.url, 50 * 1024 * 1024, 0, 'google-photos'));
      candidates.push({
        sourceId: String((row as { mediaKey?: unknown }).mediaKey || memory.url).slice(0, 300),
        memory,
        preview: async () => { const still = await download(); return previewFromBytes(still.bytes, still.mimeType); },
        // No remote fallback: the photo stays in the album, so importing again is the retry,
        // and a kept-by-link copy would bypass duplicate detection.
        fetch: async () => { const media = await download(); return { bytes: media.bytes, mimeType: media.mimeType }; },
      });
    }
    const planned = await planImportBatch({ ai, library, source: 'google-photos', candidates });
    const { job, memories } = await archivePlannedBatch(library, planned);
    const failed = job.items.filter(item => item.status === 'failed').length;
    const warnings = failed ? [`${failed} photo${failed === 1 ? '' : 's'} could not be downloaded. Import the album again to retry ${failed === 1 ? 'it' : 'them'}.`] : [];
    res.json({ memories, imported: memories.length, skipped: rows.length - memories.length, warnings, job, folderPlan: job.folderPlan });
  });
  // Archive existing remote-only social memories without launching another paid actor run.
  // Runs through the library like any import: one job, dedup, provenance, assets, and the 3D check.
  router.post('/apify/archive', async (_req, res) => {
    const pending = store.list().filter(memory => ['instagram', 'linkedin', 'youtube'].includes(memory.source) && !memory.url.startsWith('/uploads/')).slice(0, 20);
    if (!pending.length) { res.json({ memories: [], archived: 0, warnings: [] }); return; }
    const counts = new Map<Memory['source'], number>();
    for (const memory of pending) counts.set(memory.source, (counts.get(memory.source) || 0) + 1);
    const source = [...counts].sort((x, y) => y[1] - x[1])[0][0];
    // Folders were planned when these memories were first imported; keep that plan (no new model review).
    const job = await library.planImport(source, pending, { mode: 'local', reason: 'retry', kept: 0, renamed: 0, rejected: 0 });
    const candidates: ImportCandidate[] = pending.map(memory => ({
      sourceId: `archive-retry:${memory.id}`,
      memory,
      fetch: async () => {
        const media = await downloadSocialMedia(memory.url, 50 * 1024 * 1024, 0, memory.source);
        const still = memory.mediaType === 'video' && memory.thumbnailUrl && !memory.thumbnailUrl.startsWith('/uploads/')
          ? await downloadSocialMedia(memory.thumbnailUrl, 15 * 1024 * 1024, 0, memory.source).catch(() => undefined) : undefined;
        return { bytes: media.bytes, mimeType: media.mimeType, poster: still && still.mimeType.startsWith('image/') ? { bytes: still.bytes, mimeType: still.mimeType } : undefined };
      },
    }));
    await archivePlannedBatch(library, { job, candidates });
    const after = pending.map(memory => store.get(memory.id) || memory);
    const archived = after.filter(memory => memory.url.startsWith('/uploads/'));
    const warnings = after.filter(memory => !memory.url.startsWith('/uploads/')).map(memory => `${memory.title}: could not archive media from its CDN. The remote URL may expire; upload the original for durable storage.`);
    res.json({ memories: archived, archived: archived.length, warnings });
  });
  return { router, status };
}
