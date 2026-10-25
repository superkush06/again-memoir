import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import type { Memory } from '../src/types.js';
import { ALL_MEMORIES_FOLDER, PICTURES_FOLDER, THEME_FOLDERS, friendlyMemoryTitle, isDateLikeLabel, isFilenameLike } from '../src/memory-labels.js';
import { GEMINI_REVIEW_MAX_ITEMS, MemoryAI } from './ai.js';
import { archivePlannedBatch, planImportBatch, type ImportCandidate } from './import-pipeline.js';
import { LibraryService } from './library.js';
import { getOrganizerTimeZone, isAllowedFolderLabel, organizeMemory, setOrganizerTimeZone, suggestFolder } from './organize.js';
import { MemoryStore } from './store.js';
import { demoMemories } from './demo.js';
import type { Readiness3DScorer } from './depth-readiness.js';

// These tests cover folder planning, so every item passes the 3D check; readiness filtering is tested in depth-readiness.test.ts.
const readyScorer: Readiness3DScorer = { score: async () => ({ version: 1, score: 0.9, ready: true, reasons: ['test scene'], source: 'depth-anything-v2', threshold: 0.6, scoredAt: '2026-10-24T00:00:00.000Z', durationMs: 0 }) };

const memory = (id: string, changes: Partial<Memory> = {}): Memory => ({
  id, title: 'Photo memory', description: '', date: '2025-06-01', location: '', tags: [], source: 'upload',
  mediaType: 'image', url: '', thumbnailUrl: '', ...changes,
});
const label = (changes: Partial<Memory>) => suggestFolder(memory('x', changes)).label;
const png = (color: string) => sharp({ create: { width: 24, height: 24, channels: 3, background: color } }).png().toBuffer();

type Review = { id: string; decision: 'keep' | 'rename'; label: string; reason: string; [key: string]: unknown };
function fakeGemini(answer: (ids: string[], locals: Record<string, string>) => unknown) {
  const calls: any[] = [];
  const client = { models: { generateContent: async (request: any) => {
    calls.push(request);
    const text: string = request.contents[0].parts[0].text;
    const catalog = JSON.parse(text.slice(text.indexOf('Catalog: ') + 'Catalog: '.length)) as { id: string; localFolder: string }[];
    const result = answer(catalog.map(item => item.id), Object.fromEntries(catalog.map(item => [item.id, item.localFolder])));
    if (result instanceof Error) throw result;
    return { text: typeof result === 'string' ? result : JSON.stringify(result) };
  } } };
  return { ai: new MemoryAI(undefined, 'test-model', client), calls };
}

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'memoir-folders-'));
  const store = new MemoryStore(directory, demoMemories); await store.initialize();
  const library = new LibraryService(store, { readiness: readyScorer }); await library.initialize();
  return { directory, store, library, close: () => rm(directory, { recursive: true, force: true }) };
}

const candidate = (id: string, bytes: Buffer, changes: Partial<Memory> = {}, onFetch?: () => void): ImportCandidate => ({
  sourceId: `src-${id}`, memory: memory(id, changes),
  fetch: async () => { onFetch?.(); return { bytes, mimeType: 'image/png' }; },
});

test('folder taxonomy uses the exact root, archive, and category names', () => {
  assert.equal(PICTURES_FOLDER, 'Pictures');
  assert.equal(ALL_MEMORIES_FOLDER, 'All memories');
  assert.deepEqual([...THEME_FOLDERS], ['Travel', 'Family', 'Friends', 'School and work', 'Food and places', 'Outdoors', 'Events', 'People', 'Sports', 'Nights out', 'Pets', 'Everyday moments']);
  assert.equal(label({ title: 'Costume party', date: '2025-10-31' }), 'Halloween 2025');
  assert.equal(label({ title: 'Tree lights', date: '2025-12-25' }), 'Christmas 2025');
  assert.equal(label({ date: '2025-11-27' }), 'Thanksgiving 2025');
  assert.equal(label({ date: '2025-11-20' }), 'Everyday moments');
  assert.equal(label({ location: 'California' }), 'California');
  const themed: [string, string][] = [
    ['Airport before our flight', 'Travel'], ['Dinner with mom and dad', 'Family'], ['Hangout with friends', 'Friends'],
    ['Lecture hall on campus', 'School and work'], ['Ramen restaurant', 'Food and places'], ['Sunset hike', 'Outdoors'],
    ['Birthday party', 'Events'], ['Group photo', 'People'], ['Basketball practice', 'Sports'],
    ['Night out dancing', 'Nights out'], ['Our new puppy', 'Pets'], ['Photo memory', 'Everyday moments'],
  ];
  for (const [title, expected] of themed) assert.equal(label({ title }), expected, title);
});

test('holiday beats explicit location, which beats theme; folders are never named by dates', () => {
  assert.equal(label({ title: 'Pumpkin patch with friends', location: 'California', date: '2025-10-12' }), 'Halloween 2025');
  assert.equal(label({ title: 'Beach day with friends', location: 'California' }), 'California');
  assert.equal(label({ title: 'Beach day with friends' }), 'Friends');
  assert.equal(label({ title: 'Halloween', date: '' }), 'Halloween');
  for (const bad of ['October 2025', '2025-10', 'Oct 2025', 'Summer 2025', '2025', 'Untitled']) assert.equal(isDateLikeLabel(bad), true, bad);
  for (const good of ['Halloween 2025', 'California', 'Everyday moments']) assert.equal(isDateLikeLabel(good), false, good);
  // A stale stored date label is discarded and re-derived locally.
  const stale = organizeMemory(memory('stale', { organization: { key: 'k', label: 'October 2025', confidence: 'low', reasons: [], folderPath: ['October 2025'] } }));
  assert.equal(stale.organization?.label, 'Everyday moments');
});

test('camera filenames are never shown as labels', () => {
  for (const name of ['PXL_20251031_183012345', 'IMG_4821', 'DSC_0012', 'IMG_4821.HEIC', 'VID_20250101_120000', '20251031_183012', 'Screenshot 2025-10-31 at 9.41.22 PM.png']) {
    assert.equal(isFilenameLike(name), true, name);
    assert.equal(friendlyMemoryTitle({ title: name, mediaType: 'image' }), 'Photo memory');
  }
  assert.equal(friendlyMemoryTitle({ title: 'VID_20250101_120000', mediaType: 'video' }), 'Video memory');
  assert.equal(friendlyMemoryTitle({ title: 'Picnic in the park', mediaType: 'image' }), 'Picnic in the park');
  assert.equal(organizeMemory(memory('p', { title: 'PXL_20251031_183012345' })).title, 'Photo memory');
});

test('Gemini explicitly keeps sensible folders and may rename generic or wrong ones', async () => {
  const items = [
    memory('keep', { title: 'Costume party', date: '2025-10-31' }),
    memory('generic'),
    memory('bad-place'),
    memory('bad-date'),
    memory('rename-location', { location: 'Big Sur, California', title: 'Hiking' }),
  ];
  const { ai, calls } = fakeGemini((ids, locals) => ({ items: ids.map((id): Review => ({
    keep: { id, decision: 'keep', label: locals[id], reason: 'Makes sense: costume party on Halloween.' },
    generic: { id, decision: 'rename', label: 'Outdoors', reason: 'Renamed: the thumbnail shows a mountain trail.' },
    'bad-place': { id, decision: 'rename', label: 'Paris', reason: 'Renamed: looks like Paris.' },
    'bad-date': { id, decision: 'rename', label: 'October 2025', reason: 'Renamed: taken in October.' },
    'rename-location': { id, decision: 'rename', label: 'California', reason: 'Renamed: broader place from the location field.' },
  } as Record<string, Review>)[id]) }));
  const plan = await ai.planFolders(items);
  assert.equal(calls.length, 1, 'one model call for the whole batch');
  const byId = new Map(plan.memories.map(value => [value.id, value.organization!]));
  assert.equal(byId.get('keep')!.label, 'Halloween 2025');
  assert.equal(byId.get('keep')!.review?.decision, 'keep');
  assert.match(byId.get('keep')!.review!.reason, /^Makes sense/);
  assert.equal(byId.get('generic')!.label, 'Outdoors');
  assert.equal(byId.get('generic')!.review?.decision, 'rename');
  assert.equal(byId.get('generic')!.review?.previousLabel, 'Everyday moments');
  assert.equal(byId.get('bad-place')!.label, 'Everyday moments', 'unsupported location rejected');
  assert.equal(byId.get('bad-place')!.review?.decision, 'rejected');
  assert.equal(byId.get('bad-date')!.label, 'Everyday moments', 'date-named folder rejected');
  assert.equal(byId.get('rename-location')!.label, 'California');
  assert.deepEqual(plan.review, { mode: 'gemini', reason: 'reviewed', kept: 1, renamed: 2, rejected: 2 });
});

test('Gemini output is validated with a strict schema and labels are sanitized', async () => {
  const extraKey = fakeGemini(ids => ({ items: ids.map(id => ({ id, decision: 'rename', label: 'Outdoors', reason: 'x', person: 'Alex' })) }));
  const strict = await extraKey.ai.planFolders([memory('a')]);
  assert.equal(strict.review.reason, 'invalid_response');
  assert.equal(strict.memories[0].organization?.label, 'Everyday moments');
  const missingDecision = fakeGemini(ids => ({ items: ids.map(id => ({ id, label: 'Outdoors', reason: 'x' })) }));
  assert.equal((await missingDecision.ai.planFolders([memory('a')])).review.reason, 'invalid_response');
  const unknownId = fakeGemini(() => ({ items: [{ id: 'not-in-batch', decision: 'keep', label: 'Travel', reason: 'x' }] }));
  assert.equal((await unknownId.ai.planFolders([memory('a')])).review.reason, 'invalid_response');
  const notJson = fakeGemini(() => 'not json');
  assert.equal((await notJson.ai.planFolders([memory('a')])).review.reason, 'invalid_response');
  const messy = fakeGemini(ids => ({ items: ids.map(id => ({ id, decision: 'rename', label: '  Out<doors>\u0000 ', reason: 'Renamed:\u0007 <b>trail</b>' })) }));
  const sanitized = await messy.ai.planFolders([memory('a')]);
  assert.equal(sanitized.memories[0].organization?.label, 'Outdoors');
  assert.doesNotMatch(sanitized.memories[0].organization!.review!.reason, /[<>\u0000-\u001f]/);
  assert.equal(isAllowedFolderLabel('Halloween 2024', memory('h', { date: '2025-10-31' })), false, 'holiday year must match the date');
});

test('large imports use deterministic local organization with no model calls; failures fall back locally', async () => {
  const many = Array.from({ length: GEMINI_REVIEW_MAX_ITEMS + 1 }, (_, index) => memory(`m${index}`, { title: index % 2 ? 'Sunset hike' : 'Photo memory' }));
  const big = fakeGemini(ids => ({ items: ids.map(id => ({ id, decision: 'keep', label: 'Travel', reason: 'x' })) }));
  const plan = await big.ai.planFolders(many);
  assert.equal(big.calls.length, 0);
  assert.equal(plan.review.reason, 'too_many_items');
  assert.equal(plan.memories[1].organization?.label, 'Outdoors');
  const down = fakeGemini(() => new Error('503 unavailable'));
  const fallback = await down.ai.planFolders([memory('a', { title: 'Our puppy' })]);
  assert.deepEqual([fallback.review.mode, fallback.review.reason, fallback.memories[0].organization?.label], ['local', 'provider_error', 'Pets']);
  const unconfigured = await new MemoryAI().planFolders([memory('a', { title: 'Our puppy' })]);
  assert.deepEqual([unconfigured.review.reason, unconfigured.memories[0].organization?.label], ['not_configured', 'Pets']);
});

test('batch import creates the folder plan before archiving any media', async () => {
  const { directory, store, library, close } = await fixture();
  try {
    const observed: { folders: string[]; pending: number; files: number }[] = [];
    const observe = async () => {
      const folders = library.folders();
      observed.push({ folders: folders.map(folder => folder.name), pending: folders.find(folder => folder.kind === 'root')?.pendingMemoryIds?.length || 0, files: (await readdir(path.join(directory, 'uploads'))).length });
    };
    const bytes = [await png('#ff8800'), await png('#2266aa')];
    const planned = await planImportBatch({ ai: new MemoryAI(), library, source: 'google-photos', candidates: [
      { ...candidate('halloween', bytes[0], { title: 'PXL_20251031_183012345', date: '2025-10-31' }), fetch: async () => { await observe(); return { bytes: bytes[0], mimeType: 'image/png' }; } },
      { ...candidate('ca', bytes[1], { location: 'California' }), fetch: async () => { await observe(); return { bytes: bytes[1], mimeType: 'image/png' }; } },
    ] });
    assert.ok(planned.job.folderPlan, 'job carries the persisted folder plan');
    const names = planned.job.folderPlan!.folderNames;
    assert.equal(names[0], 'Pictures'); assert.equal(names.at(-1), 'All memories');
    for (const name of [...THEME_FOLDERS, 'California', 'Halloween 2025']) assert.ok(names.includes(name), `full folder tree includes ${name}`);
    assert.equal(planned.job.items.length, 0, 'nothing archived yet');
    assert.equal(store.get('halloween'), undefined);
    const before = library.folders();
    assert.equal(before[0].name, 'Pictures'); assert.equal(before.at(-1)!.name, 'All memories');
    assert.deepEqual(before.find(folder => folder.name === 'Halloween 2025')!.pendingMemoryIds, ['halloween']);
    const { job } = await archivePlannedBatch(library, planned);
    assert.equal(observed[0].files, 0, 'first fetch happens with folders created and no archived bytes');
    assert.ok(observed[0].folders.includes('Halloween 2025') && observed[0].folders.includes('California'));
    assert.ok(THEME_FOLDERS.every(name => observed[0].folders.includes(name)), 'every category exists before any image is filed');
    assert.equal(observed[0].pending, 2);
    assert.equal(job.status, 'ready'); assert.equal(job.processedItems, 2); assert.equal(job.totalItems, 2);
    const after = library.folders();
    assert.equal(after.some(folder => folder.pendingMemoryIds?.length), false);
    assert.deepEqual(after.find(folder => folder.name === 'Halloween 2025')!.memoryIds, ['halloween']);
    // Placeholder demo memories disappear once real media exists.
    assert.equal(store.list().some(value => value.source === 'demo'), false);
    assert.equal(after.some(folder => ['Dolomites, Italy', 'Home', 'Big Sur, California'].includes(folder.name)), false);
    assert.ok(store.get('demo-coast'), 'demo records remain resolvable by ID');
  } finally { await close(); }
});

test('folders reference individual archived memories with human-readable labels', async () => {
  const { library, close } = await fixture();
  try {
    const planned = await planImportBatch({ ai: new MemoryAI(), library, source: 'upload', candidates: [
      candidate('one', await png('#113355'), { title: 'IMG_4821' }),
      candidate('two', await png('#aa3311'), { title: 'Sunset hike' }),
    ] });
    await archivePlannedBatch(library, planned);
    const folders = library.folders();
    const pictures = library.folderContents('folder-pictures')!;
    assert.deepEqual(pictures.items.map(item => item.id).sort(), ['one', 'two']);
    assert.deepEqual(pictures.items.map(item => item.label).sort(), ['Photo memory', 'Sunset hike']);
    assert.ok(pictures.items.every(item => item.thumbnailUrl.startsWith('/uploads/')));
    const outdoors = folders.find(folder => folder.name === 'Outdoors')!;
    assert.deepEqual(library.folderContents(outdoors.id)!.items.map(item => item.id), ['two']);
    assert.deepEqual(library.folderContents('folder-all-memories')!.items.map(item => item.id).sort(), ['one', 'two']);
    assert.equal(library.folderContents('missing'), undefined);
  } finally { await close(); }
});

test('the physical archive stays deduplicated and folders reference the canonical memory once', async () => {
  const { directory, store, library, close } = await fixture();
  try {
    const bytes = await png('#55aa77');
    const first = await planImportBatch({ ai: new MemoryAI(), library, source: 'upload', candidates: [candidate('a', bytes, { title: 'Sunset hike' }), candidate('b', bytes, { title: 'Sunset hike' })] });
    const { job } = await archivePlannedBatch(library, first);
    const second = await planImportBatch({ ai: new MemoryAI(), library, source: 'instagram', candidates: [candidate('c', bytes, { title: 'Sunset hike', source: 'instagram' })] });
    const { job: again } = await archivePlannedBatch(library, second);
    assert.equal(job.processedItems, 1); assert.equal(job.skippedItems, 1); assert.equal(again.skippedItems, 1);
    assert.equal(store.list().length, 1);
    assert.equal((await readdir(path.join(directory, 'uploads'))).length, 1);
    assert.equal(store.get('a')!.provenance!.length, 3);
    for (const folder of library.folders()) {
      assert.equal(new Set(folder.memoryIds).size, folder.memoryIds.length);
      assert.ok(folder.memoryIds.every(id => store.get(id)), 'every folder entry resolves to a real memory');
      if (folder.memoryIds.length) assert.deepEqual(folder.memoryIds, ['a']);
    }
  } finally { await close(); }
});

test('the same pipeline is used for Google Photos, Apify sources, and uploads, and Gemini can rename during import', async () => {
  const { store, library, close } = await fixture();
  try {
    const { ai, calls } = fakeGemini(ids => ({ items: ids.map(id => ({ id, decision: 'rename', label: 'Outdoors', reason: 'Renamed: trail in thumbnail.' })) }));
    for (const [index, source] of (['google-photos', 'instagram', 'linkedin', 'youtube', 'upload'] as const).entries()) {
      const planned = await planImportBatch({ ai, library, source, candidates: [{ ...candidate(`${source}-1`, await png(['#ff0000', '#00ff00', '#0000ff', '#ffff00', '#00ffff'][index]), { source }), preview: async () => ({ mimeType: 'image/jpeg', data: Buffer.from('thumb') }) }] });
      assert.equal(planned.job.folderPlan!.review.mode, 'gemini');
      await archivePlannedBatch(library, planned);
    }
    assert.equal(calls.length, 5);
    assert.ok(calls.every(call => call.contents[0].parts.some((part: any) => part.inlineData)), 'thumbnails are sent with the batch review');
    assert.equal(store.list().length, 5);
    assert.ok(store.list().every(value => value.organization?.label === 'Outdoors'));
    assert.deepEqual(library.folders().filter(folder => folder.memoryIds.length).map(folder => folder.name), ['Pictures', 'Outdoors', 'All memories']);
  } finally { await close(); }
});

test('folder API: upload batch → Pictures root, categories, folder contents, re-sort, All memories last', async () => {
  const { createBackend } = await import('./app.js');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'memoir-folder-api-'));
  let rename = false;
  const { ai, calls } = fakeGemini((ids, locals) => ({ items: ids.map(id => rename
    ? { id, decision: 'rename', label: 'Outdoors', reason: 'Renamed: trail visible in the thumbnail.' }
    : { id, decision: 'keep', label: locals[id], reason: 'Makes sense: matches the caption.' }) }));
  const backend = await createBackend({ dataDir: directory, env: {}, ai, readiness: readyScorer, reconstruction: { reconstruct: async () => { throw new Error('unused'); } } });
  await new Promise<void>(resolve => backend.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(backend.server.address() as { port: number }).port}`;
  try {
    const before = (await (await fetch(`${url}/api/folders`)).json()).folders as { name: string; memoryIds: string[] }[];
    // Demo placeholders are unscored: visible in All memories, not filed into 3D-ready folders.
    assert.ok(before.at(-1)!.memoryIds.includes('demo-mountains'), 'demo placeholders populate an empty library');
    assert.equal(before[0].memoryIds.length, 0);
    const form = new FormData();
    form.append('files', new Blob([await png('#ff0000')], { type: 'image/png' }), 'PXL_20251031_183012345.png');
    form.append('files', new Blob([await png('#0000ff')], { type: 'image/png' }), 'IMG_4821.png');
    form.append('date', '2025-10-31');
    const uploaded = await (await fetch(`${url}/api/upload`, { method: 'POST', body: form })).json();
    assert.equal(calls.length, 1, 'one Gemini review for the whole upload batch');
    assert.ok(calls[0].contents[0].parts.filter((part: any) => part.inlineData).length === 2, 'thumbnails accompany the review');
    assert.equal(uploaded.job.totalItems, 2); assert.equal(uploaded.job.processedItems, 2);
    assert.equal(uploaded.folderPlan.review.mode, 'gemini'); assert.equal(uploaded.folderPlan.review.kept, 2);
    assert.ok(uploaded.memories.every((memory: Memory) => memory.title === 'Photo memory' && memory.organization?.review?.decision === 'keep'));
    const folders = (await (await fetch(`${url}/api/folders`)).json()).folders as { id: string; name: string; kind: string; memoryIds: string[] }[];
    assert.deepEqual(folders.filter(folder => folder.memoryIds.length).map(folder => folder.name), ['Pictures', 'Halloween 2025', 'All memories']);
    assert.equal(folders.at(-1)!.name, 'All memories');
    assert.ok(THEME_FOLDERS.every(name => folders.some(folder => folder.name === name)), 'empty categories exist and are ready');
    const halloween = await (await fetch(`${url}/api/folders/${folders[1].id}`)).json();
    assert.equal(halloween.items.length, 2);
    assert.ok(halloween.items.every((item: { label: string; thumbnailUrl: string }) => item.label === 'Photo memory' && item.thumbnailUrl.startsWith('/uploads/')));
    assert.equal((await fetch(`${url}/api/folders/no-such-folder`)).status, 404);
    assert.equal(((await (await fetch(`${url}/api/memories`)).json()).memories as Memory[]).some(memory => memory.source === 'demo'), false);
    rename = true;
    const resorted = await (await fetch(`${url}/api/folders/reorganize`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json();
    // Holiday photos stay in Halloween even when Gemini proposes another theme.
    assert.equal(resorted.summary.renamed, 0); assert.equal(resorted.summary.rejected, 2);
    assert.deepEqual(resorted.folders.filter((folder: { memoryIds: string[] }) => folder.memoryIds.length).map((folder: { name: string }) => folder.name), ['Pictures', 'Halloween 2025', 'All memories']);
    assert.equal((await readdir(path.join(directory, 'uploads'))).length, 2, 're-sorting never duplicates media');
  } finally {
    backend.rooms.wss.close();
    await new Promise<void>(resolve => backend.server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test('suggested albums titled by a bare date are renamed from their folders', async () => {
  const { directory, store, close } = await fixture();
  try {
    await store.add([memory('h1', { title: 'Sunset hike', date: '2025-11-02' }), memory('h2', { title: 'Lake trail', date: '2025-11-03' })]);
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path.join(directory, 'library-state.json'), JSON.stringify({ version: 1, jobs: [], assets: [], events: [], folders: [], albums: [
      { id: 'album-x', title: 'November 2025', type: 'suggested', coverMemoryId: 'h1', worldAnchorMemoryId: 'h1', memoryIds: ['h1', 'h2'], dateRange: { start: '2025-11-02', end: '2025-11-03' }, confidence: 0.6, privacy: 'private', createdAt: '2025-11-03T00:00:00.000Z', updatedAt: '2025-11-03T00:00:00.000Z' },
      { id: 'album-y', title: 'November 2025', type: 'manual', coverMemoryId: 'h1', worldAnchorMemoryId: 'h1', memoryIds: ['h1'], dateRange: { start: '2025-11-02', end: '2025-11-02' }, confidence: 1, privacy: 'private', createdAt: '2025-11-03T00:00:00.000Z', updatedAt: '2025-11-03T00:00:00.000Z' },
    ] }));
    const reopened = new LibraryService(store, { readiness: readyScorer }); await reopened.initialize();
    assert.equal(reopened.album('album-x')!.title, 'Outdoors');
    assert.equal(reopened.album('album-y')!.title, 'November 2025', 'user-named albums are never renamed');
  } finally { await close(); }
});

test('Oct 31 evening photos with UTC timestamps land in Halloween, and holidays overtake Everyday moments', async () => {
  const previous = getOrganizerTimeZone();
  setOrganizerTimeZone('America/Los_Angeles');
  try {
    // Google Photos reports UTC: 7:30 pm on Oct 31 in California is 02:30 UTC on Nov 1.
    const google = (capturedAt: string, changes: Partial<Memory> = {}) => memory('g', { source: 'google-photos', date: capturedAt.slice(0, 10), capturedAt, ...changes });
    assert.equal(label(google('2025-11-01T02:30:00.000Z')), 'Halloween 2025');
    assert.equal(label(google('2025-11-01T09:30:00.000Z')), 'Halloween 2025', '2:30 am after Halloween night still counts');
    assert.equal(label(google('2025-11-01T19:00:00.000Z')), 'Everyday moments', 'Nov 1 daytime is not Halloween');
    assert.equal(label(google('2025-12-26T05:00:00.000Z')), 'Christmas 2025', 'Dec 25 9 pm Pacific');
    // A previously stored generic label never blocks the holiday.
    const stale = organizeMemory(google('2025-11-01T01:15:00.000Z', { organization: { key: 'k', label: 'Everyday moments', confidence: 'low', reasons: [], folderPath: ['Everyday moments'], organizedBy: 'local' } }));
    assert.equal(stale.organization?.label, 'Halloween 2025');
    const reviewed = organizeMemory(google('2025-11-01T01:15:00.000Z', { organization: { key: 'k', label: 'Outdoors', confidence: 'medium', reasons: [], folderPath: ['Outdoors'], organizedBy: 'gemini' } }));
    assert.equal(reviewed.organization?.label, 'Halloween 2025');
    // Gemini cannot move a holiday photo into a generic theme.
    const { ai } = fakeGemini(ids => ({ items: ids.map(id => ({ id, decision: 'rename', label: 'Everyday moments', reason: 'Renamed: generic.' })) }));
    const plan = await ai.planFolders([google('2025-11-01T03:00:00.000Z')]);
    assert.equal(plan.memories[0].organization?.label, 'Halloween 2025');
    assert.equal(plan.memories[0].organization?.review?.decision, 'rejected');
  } finally { setOrganizerTimeZone(previous); }
});

test('every holiday files correctly: dates, timezones, after-midnight, New Year across years, seasonal captions', () => {
  const previous = getOrganizerTimeZone();
  setOrganizerTimeZone('America/Los_Angeles');
  try {
    // Google-style UTC timestamp for a Pacific wall-clock time.
    const pt = (local: string) => new Date(`${local}-08:00`).toISOString();
    const at = (local: string, changes: Partial<Memory> = {}) => { const capturedAt = pt(local); return label({ source: 'google-photos', date: capturedAt.slice(0, 10), capturedAt, ...changes }); };
    const cases: [string, string][] = [
      // Halloween
      [at('2025-10-31T19:30:00'), 'Halloween 2025'],
      [at('2025-11-01T01:15:00'), 'Halloween 2025'],
      [at('2025-11-01T12:00:00'), 'Everyday moments'],
      [label({ title: 'Costume prep', date: '2025-10-20' }), 'Halloween 2025'],
      [label({ title: 'Costume party', date: '2026-03-14' }), 'Events'], // out of season: a party, not Halloween
      // Thanksgiving: fourth Thursday, any year; the date beats a "pumpkin" caption
      [label({ date: '2025-11-27' }), 'Thanksgiving 2025'],
      [label({ date: '2026-11-26' }), 'Thanksgiving 2026'],
      [label({ title: 'Pumpkin pie', date: '2025-11-27' }), 'Thanksgiving 2025'],
      [label({ title: 'Friendsgiving', date: '2025-11-22' }), 'Thanksgiving 2025'],
      [at('2025-11-28T00:45:00'), 'Thanksgiving 2025'],
      [label({ date: '2025-11-20' }), 'Everyday moments'],
      // Christmas: Eve and Day, Christmas night past midnight, season captions, never "Santa Cruz"
      [label({ date: '2025-12-24' }), 'Christmas 2025'],
      [at('2025-12-25T21:00:00'), 'Christmas 2025'],
      [at('2025-12-26T01:30:00'), 'Christmas 2025'],
      [label({ title: 'Christmas tree up', date: '2025-12-10' }), 'Christmas 2025'],
      [label({ title: 'Last of the Christmas lights', date: '2026-01-03' }), 'Christmas 2025'],
      [label({ title: 'Secret santa swap', date: '2025-12-15' }), 'Christmas 2025'],
      [label({ title: 'Santa Cruz beach day', date: '2025-07-04' }), 'Outdoors'],
      [label({ title: 'Santa Monica pier', date: '2025-12-12' }), 'Everyday moments'],
      // New Year: Eve and Day are ONE folder named for the year that begins
      [at('2025-12-31T20:00:00'), 'New Year 2026'],
      [at('2026-01-01T00:30:00'), 'New Year 2026'],
      [label({ date: '2026-01-01' }), 'New Year 2026'],
      [label({ title: 'NYE outfits', date: '2025-12-30' }), 'New Year 2026'],
      [label({ title: 'Bill Nye talk', date: '2025-06-10' }), 'Everyday moments'],
      // Valentine's Day
      [label({ date: '2026-02-14' }), "Valentine's Day 2026"],
      [at('2026-02-15T00:40:00'), "Valentine's Day 2026"],
      [label({ title: "Galentine's brunch", date: '2026-02-13' }), "Valentine's Day 2026"],
      [label({ title: 'Valentine card I found', date: '2026-07-01' }), 'Everyday moments'],
      // Holiday beats an explicit location
      [label({ date: '2025-12-25', location: 'California' }), 'Christmas 2025'],
    ];
    assert.deepEqual(cases.map(([actual]) => actual), cases.map(([, expected]) => expected));
  } finally { setOrganizerTimeZone(previous); }
});

test('Gemini may name a holiday only in season, with that season\'s year, and never relabel a dated holiday', () => {
  const allowed = (name: string, changes: Partial<Memory>) => isAllowedFolderLabel(name, memory('g', changes));
  assert.equal(allowed('Christmas 2025', { date: '2025-12-18' }), true, 'tree visible in a mid-December photo');
  assert.equal(allowed('Christmas 2025', { date: '2026-01-04' }), true, 'early January belongs to last Christmas');
  assert.equal(allowed('Christmas 2026', { date: '2026-01-04' }), false);
  assert.equal(allowed('Christmas 2025', { date: '2025-07-18' }), false, 'out of season');
  assert.equal(allowed('Halloween 2025', { date: '2025-12-25' }), false, 'Christmas Day is never Halloween');
  assert.equal(allowed('New Year 2026', { date: '2025-12-31' }), true);
  assert.equal(allowed('New Year 2025', { date: '2025-12-31' }), false);
  assert.equal(allowed("Valentine's Day 2026", { date: '2026-02-10' }), true);
  assert.equal(allowed('Thanksgiving 2025', { date: '2025-11-27' }), true);
  assert.equal(allowed('Thanksgiving', { date: '' }), true);
});

test('holiday albums are titled by their holiday even when they share other tags', async () => {
  const { store, library, close } = await fixture();
  try {
    const { writeFile } = await import('node:fs/promises');
    await store.add([memory('x1', { date: '2025-12-25', tags: ['family'] }), memory('x2', { date: '2025-12-25', tags: ['family'] }), memory('n1', { date: '2025-12-31', tags: ['party'] }), memory('n2', { date: '2026-01-01', tags: ['party'] })]);
    await writeFile(path.join(store.directory, 'library-state.json'), JSON.stringify({ version: 1, jobs: [], assets: [], events: [], folders: [], albums: [
      { id: 'album-xmas', title: 'Family', type: 'suggested', coverMemoryId: 'x1', worldAnchorMemoryId: 'x1', memoryIds: ['x1', 'x2'], dateRange: { start: '2025-12-25', end: '2025-12-25' }, confidence: 0.6, privacy: 'private', createdAt: '2025-12-26T00:00:00.000Z', updatedAt: '2025-12-26T00:00:00.000Z' },
      { id: 'album-nye', title: 'Party', type: 'suggested', coverMemoryId: 'n1', worldAnchorMemoryId: 'n1', memoryIds: ['n1', 'n2'], dateRange: { start: '2025-12-31', end: '2026-01-01' }, confidence: 0.6, privacy: 'private', createdAt: '2026-01-02T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z' },
    ] }));
    const reopened = new LibraryService(store); await reopened.initialize();
    assert.equal(reopened.album('album-xmas')!.title, 'Christmas 2025');
    assert.equal(reopened.album('album-nye')!.title, 'New Year 2026');
    void library;
  } finally { await close(); }
});

test('a remote-only memory (archive failed) is kept with provenance, then upgraded in place when archived later', async () => {
  const { directory, store, library, close } = await fixture();
  try {
    const remote = memory('insta-1', { source: 'instagram', url: 'https://cdn.example.test/p.jpg', thumbnailUrl: 'https://cdn.example.test/p.jpg', title: 'Sunset hike' });
    const first = await planImportBatch({ ai: new MemoryAI(), library, source: 'instagram', candidates: [{
      sourceId: 'post-1', memory: remote, remoteFallback: planned => ({ ...planned, url: remote.url, thumbnailUrl: remote.thumbnailUrl }),
      fetch: async () => { throw new Error('CDN refused'); },
    }] });
    const kept = await archivePlannedBatch(library, first);
    assert.deepEqual(kept.remoteOnly, ['insta-1']);
    assert.equal(kept.job.items[0].retryable, true);
    assert.equal(store.get('insta-1')!.url, remote.url);
    assert.equal(store.get('insta-1')!.provenance!.length, 1);
    assert.equal(library.folders().find(folder => folder.kind === 'root')!.memoryIds.includes('insta-1'), false, 'remote-only items stay out of the 3D folders');
    assert.ok(library.folders().find(folder => folder.kind === 'all')!.memoryIds.includes('insta-1'));
    const retry = await library.planImport('instagram', [store.get('insta-1')!], { mode: 'local', reason: 'retry', kept: 0, renamed: 0, rejected: 0 });
    await archivePlannedBatch(library, { job: retry, candidates: [{ sourceId: 'archive-retry:insta-1', memory: store.get('insta-1')!, fetch: async () => ({ bytes: await png('#3366aa'), mimeType: 'image/png' }) }] });
    const upgraded = store.get('insta-1')!;
    assert.match(upgraded.url, /^\/uploads\//);
    assert.equal(upgraded.provenance!.length, 2);
    assert.ok(upgraded.readiness3d, 'archived media gets its 3D check');
    assert.equal(store.list().length, 1);
    assert.equal((await readdir(path.join(directory, 'uploads'))).length, 1);
  } finally { await close(); }
});
