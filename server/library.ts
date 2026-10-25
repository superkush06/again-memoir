import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  Album,
  AlbumSharePreview,
  DerivedEvent,
  FolderItem,
  ImportFolderPlan,
  ImportItemState,
  ImportJob,
  ImportStage,
  Memory,
  MemoryFolder,
  MemoryProvenance,
  MemorySource,
} from '../src/types.js';
import type { MemoryStore } from './store.js';
import { effectiveMoment, holidayFor, organizeMemory } from './organize.js';
import { fallbackQuality, imageFeatures, scoreWorldAnchor, type ImageQuality } from './image-quality.js';
import { DepthReadinessScorer, heuristicReadiness3d, READINESS_VERSION, type Readiness3DScorer } from './depth-readiness.js';
import { downloadReconstructionSource } from './reconstruction.js';
import { ALL_MEMORIES_FOLDER, FALLBACK_FOLDER, PICTURES_FOLDER, THEME_FOLDERS, friendlyMemoryTitle, isDateLikeLabel } from '../src/memory-labels.js';

export { scoreWorldAnchor, type ImageQuality };

export interface AssetRecord {
  memoryId: string;
  fileHash: string;
  perceptualHash: string;
  embedding: number[];
  embeddingProvider: 'local-grid-v1' | 'deterministic-hash-v1';
  quality: ImageQuality;
  provenance: MemoryProvenance[];
  importJobId: string;
}

type LibraryState = {
  version: 1;
  jobs: ImportJob[];
  assets: AssetRecord[];
  events: DerivedEvent[];
  albums: Album[];
  folders: MemoryFolder[];
  /** Every category folder that has been created (full taxonomy + planned holiday/location folders). */
  folderCatalog?: string[];
};

const stages: ImportStage[] = ['received', 'archived', 'hashed', 'embedded', 'scored', 'grouped', 'ready'];
const stageIndex = (stage: ImportStage) => stages.indexOf(stage);
const clamp = (value: number) => Math.max(0, Math.min(1, value));
const round = (value: number, places = 4) => Number(value.toFixed(places));
const extensions: Record<string, string> = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif',
  'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov',
};

function emptyState(): LibraryState {
  return { version: 1, jobs: [], assets: [], events: [], albums: [], folders: [], folderCatalog: [...THEME_FOLDERS] };
}

function cosine(left: number[] = [], right: number[] = []) {
  if (!left.length || left.length !== right.length) return 0;
  let dot = 0; let a = 0; let b = 0;
  for (let index = 0; index < left.length; index++) {
    dot += left[index] * right[index]; a += left[index] ** 2; b += right[index] ** 2;
  }
  return a && b ? dot / Math.sqrt(a * b) : 0;
}

export function perceptualDistance(left: string, right: string) {
  if (!/^[a-f\d]{16}$/i.test(left) || !/^[a-f\d]{16}$/i.test(right)) return 64;
  let value = BigInt(`0x${left}`) ^ BigInt(`0x${right}`); let count = 0;
  while (value) { count += Number(value & 1n); value >>= 1n; }
  return count;
}

export function scoreCover(quality: ImageQuality, uniqueness = 1) {
  return round(clamp(
    quality.sharpness * 0.22 + quality.exposure * 0.16 + quality.composition * 0.18 +
    quality.subjectQuality * 0.17 + clamp(uniqueness) * 0.12 + quality.visualAppeal * 0.15,
  ));
}

function tokens(memory: Memory) {
  const stop = new Set(['about', 'after', 'again', 'from', 'have', 'into', 'selected', 'that', 'the', 'this', 'with', 'your']);
  return new Set(`${memory.title} ${memory.description} ${memory.tags.join(' ')}`.toLowerCase()
    .match(/[a-z0-9#]{3,}/g)?.filter(value => !stop.has(value)) ?? []);
}

function sharedTerms(left: Set<string>, right: Set<string>) {
  return [...left].filter(value => right.has(value));
}

function validDate(value: string) {
  const parsed = Date.parse(value.length === 10 ? `${value}T12:00:00Z` : value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Deterministic, explainable clustering. Location is intentionally not required. */
export function deriveEvents(memories: Memory[], assets: AssetRecord[]): DerivedEvent[] {
  const assetByMemory = new Map(assets.map(asset => [asset.memoryId, asset]));
  const candidates = memories.filter(memory => assetByMemory.has(memory.id)).sort((a, b) => a.id.localeCompare(b.id));
  const parent = candidates.map((_, index) => index);
  const edgeReasons = new Map<string, Set<string>>();
  const find = (index: number): number => parent[index] === index ? index : (parent[index] = find(parent[index]));
  const union = (left: number, right: number, reasons: string[]) => {
    let a = find(left); let b = find(right); if (a === b) return;
    if (candidates[a].id > candidates[b].id) [a, b] = [b, a];
    parent[b] = a;
    const key = `${Math.min(left, right)}:${Math.max(left, right)}`;
    edgeReasons.set(key, new Set(reasons));
  };
  for (let left = 0; left < candidates.length; left++) for (let right = left + 1; right < candidates.length; right++) {
    const a = candidates[left]; const b = candidates[right];
    const assetA = assetByMemory.get(a.id)!; const assetB = assetByMemory.get(b.id)!;
    const dateA = validDate(a.capturedAt || a.date); const dateB = validDate(b.capturedAt || b.date);
    const timeNear = dateA !== undefined && dateB !== undefined && Math.abs(dateA - dateB) <= 3 * 86400000;
    const visual = cosine(assetA.embedding, assetB.embedding) >= 0.88;
    const terms = sharedTerms(tokens(a), tokens(b));
    const captionNear = terms.length >= 2;
    const accountA = a.sourceAccount || a.provenance?.[0]?.sourceAccount;
    const accountB = b.sourceAccount || b.provenance?.[0]?.sourceAccount;
    const sameAccount = Boolean(accountA && accountB && accountA === accountB);
    const jobsA = new Set(assetA.provenance.map(item => item.importJobId).filter(Boolean));
    const sameBatch = assetB.provenance.some(item => item.importJobId && jobsA.has(item.importJobId));
    const shouldGroup = (timeNear && (visual || captionNear || sameAccount || sameBatch)) ||
      (visual && (captionNear || sameAccount || sameBatch)) ||
      (sameBatch && (dateA === undefined || dateB === undefined));
    if (!shouldGroup) continue;
    const reasons: string[] = [];
    if (timeNear) reasons.push('same time window');
    if (visual) reasons.push('similar visual content');
    if (captionNear) reasons.push('shared caption terms');
    if (sameAccount) reasons.push('same source account');
    if (sameBatch) reasons.push('same selected batch');
    union(left, right, reasons);
  }
  const groups = new Map<number, number[]>();
  candidates.forEach((_memory, index) => { const root = find(index); groups.set(root, [...(groups.get(root) || []), index]); });
  return [...groups.values()].map(indexes => {
    const selected = indexes.map(index => candidates[index]).sort((a, b) => (a.date || '9999').localeCompare(b.date || '9999') || a.id.localeCompare(b.id));
    const ids = selected.map(memory => memory.id);
    const id = `event-${createHash('sha256').update(ids.slice().sort().join('|')).digest('hex').slice(0, 16)}`;
    const reasonSet = new Set<string>();
    for (const [edge, reasons] of edgeReasons) {
      const [a, b] = edge.split(':').map(Number);
      if (indexes.includes(a) && indexes.includes(b)) for (const reason of reasons) reasonSet.add(reason);
    }
    const dates = selected.map(memory => memory.date).filter(value => validDate(value) !== undefined).sort();
    const imported = selected.map(memory => memory.importedAt).filter(Boolean).sort().at(-1) || '1970-01-01T00:00:00.000Z';
    const reasons = ['same time window', 'similar visual content', 'shared caption terms', 'same source account', 'same selected batch'].filter(reason => reasonSet.has(reason));
    return {
      id, memoryIds: ids, reasons, confidence: round(clamp(0.35 + Math.min(0.45, reasons.length * 0.12) + Math.min(0.2, (ids.length - 1) * 0.05))),
      dateRange: { start: dates[0] || '', end: dates.at(-1) || dates[0] || '' }, createdAt: imported,
    };
  }).sort((a, b) => a.id.localeCompare(b.id));
}

function hashEmbedding(fileHash: string) {
  const bytes = Buffer.from(fileHash, 'hex');
  const values = [...bytes].map(value => value / 127.5 - 1); const norm = Math.hypot(...values) || 1;
  return values.map(value => round(value / norm, 5));
}

function provenanceFor(memory: Memory, sourceId: string, jobId: string): MemoryProvenance {
  return {
    source: memory.source, sourceId, sourceUrl: memory.sourceUrl, sourceAccount: memory.sourceAccount,
    importJobId: jobId, importedAt: memory.importedAt || new Date().toISOString(), consentId: memory.consentId,
  };
}

function albumTitle(memories: Memory[], event: DerivedEvent) {
  // A holiday shared by most of the album names it (same rules as the folders).
  const holidays = new Map<string, number>();
  for (const memory of memories) {
    const holiday = holidayFor(memory);
    if (holiday) { const label = holiday.year ? `${holiday.name} ${holiday.year}` : holiday.name; holidays.set(label, (holidays.get(label) || 0) + 1); }
  }
  const [holiday, count] = [...holidays].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))[0] || [];
  if (holiday && count! * 2 >= memories.length) {
    const lateNight = holiday.startsWith('Halloween') && memories.some(memory => {
      const stamp = memory.capturedAt;
      if (!stamp || Number.isNaN(Date.parse(stamp))) return false;
      const hour = effectiveMoment(memory).hour;
      return hour !== undefined && (hour >= 18 || hour <= 3);
    });
    return `${holiday}${lateNight ? ' Night' : ''}`;
  }
  const locations = memories.map(memory => memory.location.trim()).filter(Boolean);
  if (locations.length && locations.every(value => value === locations[0])) {
    const dates = memories.map(memory => validDate(memory.capturedAt || memory.date)).filter((value): value is number => value !== undefined);
    const span = dates.length > 1 ? Math.max(...dates) - Math.min(...dates) : 0;
    return span >= 20 * 60 * 60 * 1000 || memories.length >= 3 ? `${locations[0]} trip` : `Time in ${locations[0]}`;
  }
  const counts = new Map<string, number>();
  memories.flatMap(memory => memory.tags).forEach(tag => counts.set(tag, (counts.get(tag) || 0) + 1));
  const shared = [...counts].filter(([tag, count]) => count > 1 && tag.replace(/^#/, '').trim().length > 2 && !isDateLikeLabel(tag.replace(/^#/, '')))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0]?.replace(/^#/, '').trim();
  if (shared) return shared.replace(/\b\w/g, value => value.toUpperCase());
  // Never title an album by a bare month/date: use the dominant virtual folder.
  const labels = new Map<string, number>();
  for (const memory of memories) { const label = organizeMemory(memory).organization?.label || FALLBACK_FOLDER; labels.set(label, (labels.get(label) || 0) + 1); }
  const dominant = [...labels].sort((a, b) => Number(a[0] === FALLBACK_FOLDER) - Number(b[0] === FALLBACK_FOLDER) || b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
  return dominant || FALLBACK_FOLDER;
}

const folderId = (name: string) => `folder-category-${createHash('sha1').update(name.toLowerCase()).digest('hex').slice(0, 12)}`;
const folderLabel = (memory: Memory) => { const organized = organizeMemory(memory).organization; return organized?.folderPath?.at(-1) || organized?.label || FALLBACK_FOLDER; };
const newestFirst = (a: Memory, b: Memory) => (b.capturedAt || b.date || '').localeCompare(a.capturedAt || a.date || '') || a.id.localeCompare(b.id);

export class LibraryService {
  private state: LibraryState = emptyState();
  private writes: Promise<void> = Promise.resolve();
  private readonly file: string;
  private readonly readiness: Readiness3DScorer;
  private readonly log: (message: string) => void;
  /** Per-job 3D-check durations (ms), reported when the job finishes. */
  private readonly scoreTimes = new Map<string, number[]>();
  /**
   * `readiness` defaults to the heuristic-only scorer so tests never load the
   * depth model; the server injects the shared Depth Anything scorer.
   */
  constructor(private store: MemoryStore, options: { readiness?: Readiness3DScorer; log?: (message: string) => void } = {}) {
    this.file = path.join(store.directory, 'library-state.json');
    this.readiness = options.readiness || new DepthReadinessScorer();
    this.log = options.log || (() => {});
  }

  async initialize() {
    await mkdir(this.store.directory, { recursive: true });
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8')) as LibraryState;
      if (parsed?.version !== 1 || !Array.isArray(parsed.jobs) || !Array.isArray(parsed.assets) || !Array.isArray(parsed.events) || !Array.isArray(parsed.albums)) throw new Error('Library processing state is malformed.');
      this.state = { ...parsed, folders: Array.isArray(parsed.folders) ? parsed.folders : [], folderCatalog: [...new Set([...THEME_FOLDERS, ...(Array.isArray(parsed.folderCatalog) ? parsed.folderCatalog.filter(name => typeof name === 'string' && !isDateLikeLabel(name)) : [])])] };
      this.retitleSuggestedAlbums();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await this.persist();
    }
    await this.resume();
  }

  private persist() {
    const json = JSON.stringify(this.state, null, 2);
    this.writes = this.writes.catch(() => {}).then(async () => { await writeFile(`${this.file}.tmp`, json, 'utf8'); await rename(`${this.file}.tmp`, this.file); });
    return this.writes;
  }

  jobs() { return structuredClone(this.state.jobs).sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
  albums() { return structuredClone(this.state.albums).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); }
  album(id: string) { return structuredClone(this.state.albums.find(album => album.id === id)); }
  events() { return structuredClone(this.state.events); }
  assets() { return structuredClone(this.state.assets); }
  /**
   * Virtual folder tree. Order: Pictures (general root) → category folders →
   * All memories (broad archive, always last). Folders hold canonical memory
   * IDs only; the archive stores each file once.
   *
   * All memories lists every imported photo/video. Pictures and categories
   * list only items whose 3D check passed (readiness3d.ready); items an active
   * job is still archiving or scoring are listed as pending instead.
   */
  private folderSnapshot(memories: Memory[], pending: Record<string, string> = {}): MemoryFolder[] {
    const visible = memories.filter(memory => memory.mediaType === 'image' || memory.mediaType === 'video').slice().sort(newestFirst);
    const present = new Set(visible.map(memory => memory.id));
    const scoring = this.scoringMemoryIds();
    const ready = visible.filter(memory => memory.readiness3d?.ready === true);
    const groups = new Map<string, Memory[]>();
    for (const memory of ready) { const name = folderLabel(memory); groups.set(name, [...(groups.get(name) || []), memory]); }
    const pendingGroups = new Map<string, string[]>();
    const addPending = (name: string, memoryId: string) => pendingGroups.set(name, [...(pendingGroups.get(name) || []), memoryId]);
    for (const [memoryId, name] of Object.entries(pending)) if (!present.has(memoryId)) addPending(name, memoryId);
    for (const memory of visible) if (!memory.readiness3d && scoring.has(memory.id)) addPending(pending[memory.id] || folderLabel(memory), memory.id);
    const arriving = Object.keys(pending).filter(memoryId => !present.has(memoryId));
    const catalog = this.state.folderCatalog?.length ? this.state.folderCatalog : [...THEME_FOLDERS];
    const size = (name: string) => (groups.get(name)?.length || 0) + (pendingGroups.get(name)?.length || 0);
    const rank = (name: string) => { const index = (THEME_FOLDERS as readonly string[]).indexOf(name); return index < 0 ? -1 : index; };
    // Full folder tree: every created category exists even while empty. Filled
    // folders come first (holidays/places before themes, "Everyday moments" last);
    // empty ones follow in taxonomy order, ready to receive memories.
    const names = [...new Set([...catalog, ...groups.keys(), ...pendingGroups.keys()])].sort((a, b) =>
      Number(size(a) === 0) - Number(size(b) === 0) ||
      Number(a === FALLBACK_FOLDER) - Number(b === FALLBACK_FOLDER) ||
      (size(a) && size(b) ? size(b) - size(a) : rank(a) - rank(b)) ||
      a.localeCompare(b));
    const covers = (items: Memory[]) => items.filter(memory => memory.thumbnailUrl || memory.mediaType === 'image').slice(0, 4).map(memory => memory.id);
    const pendingAll = [...pendingGroups.values()].flat();
    const root: MemoryFolder = { id: 'folder-pictures', name: PICTURES_FOLDER, kind: 'root', memoryIds: ready.map(memory => memory.id), coverMemoryIds: covers(ready), ...(pendingAll.length ? { pendingMemoryIds: pendingAll } : {}) };
    const categories: MemoryFolder[] = names.map(name => {
      const items = groups.get(name) || []; const waiting = pendingGroups.get(name) || [];
      return { id: folderId(name), name, parentId: root.id, kind: 'category', memoryIds: items.map(memory => memory.id), coverMemoryIds: covers(items), ...(waiting.length ? { pendingMemoryIds: waiting } : {}) };
    });
    // Unfiltered: items being scored are already listed; only not-yet-archived items are pending here.
    const all: MemoryFolder = { id: 'folder-all-memories', name: ALL_MEMORIES_FOLDER, parentId: root.id, kind: 'all', memoryIds: visible.map(memory => memory.id), coverMemoryIds: covers(visible), ...(arriving.length ? { pendingMemoryIds: arriving } : {}) };
    return [root, ...categories, all];
  }
  private pendingAssignments() {
    const pending: Record<string, string> = {};
    for (const job of this.state.jobs) {
      if (!job.folderPlan || (job.status !== 'queued' && job.status !== 'processing')) continue;
      for (const [memoryId, name] of Object.entries(job.folderPlan.assignments)) {
        const item = job.items.find(value => value.memoryId === memoryId);
        if (item?.status === 'failed' || item?.status === 'skipped') continue;
        pending[memoryId] = name;
      }
    }
    return pending;
  }
  /** Archived memories an active import or rescore job has not finished 3D-checking. */
  private scoringMemoryIds() {
    const ids = new Set<string>();
    for (const job of this.state.jobs) {
      if (job.status !== 'queued' && job.status !== 'processing') continue;
      for (const item of job.items) {
        const memoryId = item.canonicalMemoryId || item.memoryId;
        if (memoryId && item.status !== 'failed' && item.status !== 'skipped') ids.add(memoryId);
      }
    }
    return ids;
  }
  /** Current folders: archived memories plus items an active import has planned but not archived yet. */
  folders(): MemoryFolder[] {
    return structuredClone(this.folderSnapshot(this.store.list(), this.pendingAssignments()));
  }
  /** Individual memories inside one folder, with human-readable labels (never source filenames). */
  folderContents(id: string): { folder: MemoryFolder; items: FolderItem[] } | undefined {
    const folder = this.folders().find(value => value.id === id); if (!folder) return undefined;
    const items = folder.memoryIds.map(memoryId => this.store.get(memoryId)).filter((memory): memory is Memory => Boolean(memory)).map(memory => ({
      id: memory.id, label: friendlyMemoryTitle(memory), mediaType: memory.mediaType,
      thumbnailUrl: memory.thumbnailUrl || (memory.mediaType === 'image' ? memory.url : ''), date: memory.date, source: memory.source,
    }));
    return { folder, items };
  }
  /**
   * Batch step 1: persist the folder plan and the import job together, BEFORE
   * any bytes are archived. Every planned memory is assigned a virtual folder.
   */
  async planImport(source: MemorySource, planned: Memory[], review: ImportFolderPlan['review']) {
    const now = new Date().toISOString();
    const organized = planned.map(memory => organizeMemory(memory));
    const assignments = Object.fromEntries(organized.map(memory => [memory.id, folderLabel(memory)]));
    const job: ImportJob = { id: randomUUID(), source, totalItems: planned.length, processedItems: 0, skippedItems: 0, failedItems: 0, currentStage: 'received', status: 'queued', createdAt: now, updatedAt: now, items: [] };
    this.state.jobs.unshift(job);
    // 1) Create the complete folder tree first: Pictures, every taxonomy
    //    category, each holiday/location folder this batch needs, All memories.
    this.state.folderCatalog = [...new Set([...THEME_FOLDERS, ...(this.state.folderCatalog || []), ...Object.values(assignments)])];
    const created = this.folderSnapshot(this.store.list(), this.pendingAssignments());
    this.state.folders = created;
    await this.persist();
    // 2) Only then file the planned memories into those folders (as pending until archived).
    const folders = this.folderSnapshot(this.store.list(), { ...this.pendingAssignments(), ...assignments });
    job.folderPlan = {
      createdAt: now, assignments, plannedMemoryIds: organized.map(memory => memory.id), review,
      folderNames: folders.map(folder => folder.name), folderIds: folders.map(folder => folder.id),
    };
    this.state.folders = folders;
    await this.persist();
    return structuredClone(job);
  }
  /** Re-file existing memories (e.g. after a better Gemini review); bytes are untouched. */
  async refreshFolders() {
    this.state.folders = this.folderSnapshot(this.store.list());
    this.retitleSuggestedAlbums();
    await this.persist();
    return this.folders();
  }
  /** Deprecated alias kept for callers that only need the folder tree. */
  async prepareFolders(planned: Memory[]) {
    const assignments = Object.fromEntries(planned.map(memory => organizeMemory(memory)).map(memory => [memory.id, folderLabel(memory)]));
    this.state.folders = this.folderSnapshot(this.store.list(), { ...this.pendingAssignments(), ...assignments });
    await this.persist();
    return structuredClone(this.state.folders);
  }
  /** Suggested (machine) albums are never titled by a bare date. */
  private retitleSuggestedAlbums() {
    for (const album of this.state.albums) {
      if (album.type !== 'suggested') continue;
      const memories = album.memoryIds.map(memoryId => this.store.get(memoryId)).filter(Boolean) as Memory[];
      const event = this.state.events.find(value => `album-${value.id.slice(6)}` === album.id) || { id: '', memoryIds: album.memoryIds, reasons: [], confidence: album.confidence, dateRange: album.dateRange, createdAt: album.createdAt };
      album.title = albumTitle(memories, event);
    }
  }

  async clearPersonalData() {
    const removedJobs = this.state.jobs.length;
    this.state = emptyState();
    await this.persist();
    return { removedJobs };
  }

  async createJob(source: MemorySource, totalItems: number) {
    const now = new Date().toISOString();
    const job: ImportJob = { id: randomUUID(), source, totalItems, processedItems: 0, skippedItems: 0, failedItems: 0, currentStage: 'received', status: 'queued', createdAt: now, updatedAt: now, items: [] };
    this.state.jobs.unshift(job); await this.persist(); return structuredClone(job);
  }

  private item(job: ImportJob, sourceId: string) {
    let item = job.items.find(candidate => candidate.sourceId === sourceId);
    if (!item) {
      const now = new Date().toISOString();
      item = { id: randomUUID(), sourceId, stage: 'received', status: 'pending', attempts: 0, retryable: true, updatedAt: now };
      job.items.push(item);
    }
    return item;
  }

  private recount(job: ImportJob) {
    job.processedItems = job.items.filter(item => item.status === 'ready').length;
    job.skippedItems = job.items.filter(item => item.status === 'skipped').length;
    job.failedItems = job.items.filter(item => item.status === 'failed').length;
    const active = job.items.filter(item => item.status !== 'skipped' && item.status !== 'failed');
    job.currentStage = active.reduce<ImportStage>((lowest, item) => stageIndex(item.stage) < stageIndex(lowest) ? item.stage : lowest, 'ready');
    job.updatedAt = new Date().toISOString();
  }

  async ingestBytes(jobId: string, sourceId: string, memory: Memory, bytes: Buffer, mimeType: string, poster?: { bytes: Buffer; mimeType: string }) {
    const job = this.state.jobs.find(candidate => candidate.id === jobId); if (!job) throw new Error('Import job not found.');
    const item = this.item(job, sourceId);
    if (item.status === 'ready' || item.status === 'skipped') return item.canonicalMemoryId ? this.store.get(item.canonicalMemoryId) : undefined;
    item.status = 'processing'; item.attempts++; item.lastError = undefined; job.status = 'processing'; this.recount(job); await this.persist();
    try {
      const extension = extensions[mimeType]; if (!extension) throw new Error('Unsupported media format.');
      const filename = `${job.id}-${createHash('sha256').update(sourceId).digest('hex').slice(0, 20)}${extension}`;
      const absolutePath = path.join(this.store.uploadsDir, filename);
      let thumbnailUrl = memory.mediaType === 'image' ? `/uploads/${filename}` : (memory.thumbnailUrl.startsWith('/uploads/') ? memory.thumbnailUrl : '');
      const posterExtension = poster && memory.mediaType === 'video' ? extensions[poster.mimeType] : undefined;
      if (poster && posterExtension && poster.mimeType.startsWith('image/')) {
        const posterName = `${filename.replace(/\.[^.]+$/, '')}-poster${posterExtension}`;
        await writeFile(path.join(this.store.uploadsDir, `${posterName}.tmp`), poster.bytes); await rename(path.join(this.store.uploadsDir, `${posterName}.tmp`), path.join(this.store.uploadsDir, posterName));
        thumbnailUrl = `/uploads/${posterName}`;
      }
      const archivedMemory = { ...memory, url: `/uploads/${filename}`, thumbnailUrl };
      item.memoryId = memory.id;
      item.draftMemory = archivedMemory;
      if (stageIndex(item.stage) < stageIndex('archived')) {
        await writeFile(`${absolutePath}.tmp`, bytes); await rename(`${absolutePath}.tmp`, absolutePath);
        item.localPath = filename; item.mimeType = mimeType; item.stage = 'archived'; item.updatedAt = new Date().toISOString(); await this.persist();
      }
      return await this.processArchived(job, item, archivedMemory);
    } catch (error) {
      await this.failItem(jobId, sourceId, error instanceof Error ? error.message : 'Import failed.', true); return undefined;
    }
  }

  private async processArchived(job: ImportJob, item: ImportItemState, memory: Memory) {
    if (!item.localPath || !item.mimeType) throw new Error('Archived media metadata is missing.');
    const bytes = await readFile(path.join(this.store.uploadsDir, path.basename(item.localPath)));
    const fileHash = createHash('sha256').update(bytes).digest('hex');
    item.stage = 'hashed'; item.memoryId = memory.id; item.updatedAt = new Date().toISOString(); await this.persist();
    let image: Awaited<ReturnType<typeof imageFeatures>> | undefined;
    if (memory.mediaType === 'image') {
      try { image = await imageFeatures(bytes); } catch { /* Deterministic hash fallback keeps imports resumable on unsupported decoders. */ }
    }
    const embedding = image?.embedding || hashEmbedding(fileHash);
    const perceptualHash = image?.perceptualHash || fileHash.slice(0, 16);
    item.stage = 'embedded'; item.updatedAt = new Date().toISOString(); await this.persist();
    const duplicate = this.state.assets.find(asset => {
      if (asset.memoryId === memory.id) return false;
      if (asset.fileHash === fileHash) return true;
      if (memory.mediaType !== 'image') return false;
      const similarity = cosine(asset.embedding, embedding);
      return (perceptualDistance(asset.perceptualHash, perceptualHash) <= 4 && similarity >= 0.92) || similarity >= 0.995;
    });
    const provenance = provenanceFor(memory, item.sourceId, job.id);
    if (duplicate) {
      if (!duplicate.provenance.some(value => value.source === provenance.source && value.sourceId === provenance.sourceId)) duplicate.provenance.push(provenance);
      const canonical = this.store.get(duplicate.memoryId);
      if (canonical) await this.store.update(canonical.id, { provenance: duplicate.provenance });
      await unlink(path.join(this.store.uploadsDir, path.basename(item.localPath))).catch(() => {});
      delete item.localPath;
      item.canonicalMemoryId = duplicate.memoryId; item.stage = 'ready'; item.status = 'skipped'; item.retryable = false; item.updatedAt = new Date().toISOString();
      this.recount(job); await this.persist(); return canonical;
    }
    const existing = this.store.get(memory.id);
    const fullMemory: Memory = existing
      // A memory saved earlier with only its remote link (archive failed) is upgraded in place, keeping its history.
      ? { ...existing, url: memory.url, thumbnailUrl: memory.thumbnailUrl || existing.thumbnailUrl, provenance: [...(existing.provenance || []).filter(value => !(value.source === provenance.source && value.sourceId === provenance.sourceId)), provenance] }
      : { ...memory, importedAt: memory.importedAt || provenance.importedAt, provenance: [provenance] };
    if (existing) await this.store.update(memory.id, { url: fullMemory.url, thumbnailUrl: fullMemory.thumbnailUrl, provenance: fullMemory.provenance });
    else await this.store.add([fullMemory]);
    let asset = this.state.assets.find(value => value.memoryId === memory.id);
    if (!asset) {
      asset = { memoryId: memory.id, fileHash, perceptualHash, embedding, embeddingProvider: image ? 'local-grid-v1' : 'deterministic-hash-v1', quality: image?.quality || fallbackQuality, provenance: [provenance], importJobId: job.id };
      this.state.assets.push(asset);
    }
    // The memory is archived and listed in All memories; folders show it as pending until the 3D check lands.
    item.canonicalMemoryId = memory.id; item.updatedAt = new Date().toISOString(); this.recount(job); await this.persist();
    if (this.store.get(memory.id)?.readiness3d?.version !== READINESS_VERSION) {
      const readiness3d = await this.scoreMemory(job.id, fullMemory, bytes, asset.quality)
        .catch(() => heuristicReadiness3d(asset.quality, 'The 3D check could not read this file'));
      await this.store.update(memory.id, { readiness3d });
    }
    item.status = 'ready'; item.retryable = false; item.stage = 'scored'; item.updatedAt = new Date().toISOString();
    this.recount(job); await this.persist(); return this.store.get(memory.id);
  }

  /** One 3D check. The scorer falls back to the heuristic itself; this never fails the import. */
  private async scoreMemory(jobId: string, memory: Memory, bytes?: Buffer, quality?: ImageQuality) {
    const local = (url: string) => url.startsWith('/uploads/') ? path.join(this.store.uploadsDir, path.basename(url)) : undefined;
    let result;
    if (memory.mediaType === 'video') {
      const file = local(memory.url); if (!file) throw new Error('Only archived videos can be checked for 3D.');
      const posterFile = memory.thumbnailUrl ? local(memory.thumbnailUrl) : undefined;
      const poster = posterFile ? await readFile(posterFile).catch(() => undefined) : undefined;
      result = await this.readiness.score({ kind: 'video', file, ...(poster ? { poster } : {}) });
    } else {
      const file = local(memory.url);
      const source = bytes || (file ? await readFile(file) : await downloadReconstructionSource(memory.url));
      result = await this.readiness.score({ kind: 'image', bytes: source }, quality || this.state.assets.find(asset => asset.memoryId === memory.id)?.quality);
    }
    this.scoreTimes.set(jobId, [...(this.scoreTimes.get(jobId) || []), result.durationMs]);
    this.log(`[3d-check] ${memory.id.slice(0, 16)} ${memory.mediaType} ${result.score.toFixed(3)} ${result.ready ? 'ready' : 'not ready'} (${result.source}) ${result.durationMs}ms`);
    return result;
  }

  private logScoreTotals(jobId: string) {
    const times = this.scoreTimes.get(jobId); this.scoreTimes.delete(jobId);
    if (!times?.length) return;
    const total = times.reduce((sum, value) => sum + value, 0);
    this.log(`[3d-check] job ${jobId.slice(0, 8)}: ${times.length} items in ${total}ms (avg ${Math.round(total / times.length)}ms/item)`);
  }

  /**
   * Queue a background 3D check of memories already in the library, as one
   * job with the same progress UI as imports. Returns the active job instead of
   * starting a second one.
   */
  async startRescore3d(options: { onlyMissing?: boolean } = {}) {
    const active = this.state.jobs.find(job => job.kind === 'rescore-3d' && (job.status === 'queued' || job.status === 'processing'));
    if (active) return { job: structuredClone(active), started: false };
    const targets = this.store.list().filter(memory => (memory.mediaType === 'image' || memory.mediaType === 'video') && memory.url.startsWith('/uploads/') && (!options.onlyMissing || !memory.readiness3d || memory.readiness3d.version !== READINESS_VERSION));
    const counts = new Map<MemorySource, number>();
    for (const memory of targets) counts.set(memory.source, (counts.get(memory.source) || 0) + 1);
    const now = new Date().toISOString();
    const job: ImportJob = {
      id: randomUUID(), kind: 'rescore-3d', source: [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] || 'upload',
      totalItems: targets.length, processedItems: 0, skippedItems: 0, failedItems: 0, currentStage: 'embedded', status: 'queued', createdAt: now, updatedAt: now,
      items: targets.map(memory => ({ id: randomUUID(), sourceId: `rescore-3d:${memory.id}`, memoryId: memory.id, canonicalMemoryId: memory.id, stage: 'embedded', status: 'pending', attempts: 0, retryable: true, updatedAt: now })),
    };
    this.state.jobs.unshift(job); await this.persist();
    return { job: structuredClone(job), started: true };
  }

  /** Score each queued item in turn; one failure never stops the batch. */
  async runRescore3d(jobId: string) {
    const job = this.state.jobs.find(candidate => candidate.id === jobId && candidate.kind === 'rescore-3d'); if (!job) throw new Error('Rescore job not found.');
    const started = performance.now();
    job.status = 'processing'; this.recount(job); await this.persist();
    for (const item of job.items.filter(value => value.status === 'pending' || value.status === 'processing')) {
      const memory = item.memoryId ? this.store.get(item.memoryId) : undefined;
      if (!memory) { item.status = 'skipped'; item.retryable = false; item.lastError = 'This memory is no longer in the library.'; this.recount(job); continue; }
      item.status = 'processing'; item.attempts++; item.updatedAt = new Date().toISOString(); await this.persist();
      try {
        await this.store.update(memory.id, { readiness3d: await this.scoreMemory(job.id, memory) });
        item.status = 'ready'; item.stage = 'scored'; item.retryable = false; item.lastError = undefined;
      } catch (error) {
        item.status = 'failed'; item.retryable = true; item.lastError = (error instanceof Error ? error.message : 'The 3D check failed.').slice(0, 240);
      }
      item.updatedAt = new Date().toISOString(); this.recount(job); await this.persist();
    }
    for (const item of job.items) if (item.status === 'ready') item.stage = 'ready';
    this.recount(job);
    job.status = job.failedItems ? (job.processedItems ? 'partial' : 'failed') : 'ready';
    job.completedAt = new Date().toISOString(); job.updatedAt = job.completedAt;
    this.logScoreTotals(job.id);
    this.log(`[3d-check] rescore ${job.id.slice(0, 8)} finished in ${Math.round(performance.now() - started)}ms wall time`);
    this.rebuildDerived();
    this.state.folders = this.folderSnapshot(this.store.list(), this.pendingAssignments());
    await this.persist(); return structuredClone(job);
  }

  /**
   * The media could not be archived, but the person consented to this item:
   * keep it as a remote-only memory (provenance recorded, no asset, no 3D
   * check) and leave the item retryable. It appears in All memories only.
   */
  async keepRemote(jobId: string, sourceId: string, memory: Memory, message: string) {
    const job = this.state.jobs.find(candidate => candidate.id === jobId); if (!job) throw new Error('Import job not found.');
    const item = this.item(job, sourceId);
    const provenance = provenanceFor(memory, sourceId, job.id);
    if (!this.store.get(memory.id)) await this.store.add([{ ...memory, importedAt: memory.importedAt || provenance.importedAt, provenance: [provenance] }]);
    item.memoryId = memory.id; item.canonicalMemoryId = memory.id;
    await this.failItem(jobId, sourceId, message, true);
    return this.store.get(memory.id);
  }

  async failItem(jobId: string, sourceId: string, message: string, retryable = true) {
    const job = this.state.jobs.find(candidate => candidate.id === jobId); if (!job) return;
    const item = this.item(job, sourceId); item.status = 'failed'; item.retryable = retryable; item.lastError = message.slice(0, 240); item.updatedAt = new Date().toISOString();
    this.recount(job); job.status = job.items.some(value => value.status === 'ready' || value.status === 'skipped') ? 'partial' : 'failed'; await this.persist();
  }

  async finishJob(jobId: string) {
    const job = this.state.jobs.find(candidate => candidate.id === jobId); if (!job) throw new Error('Import job not found.');
    this.rebuildDerived();
    for (const item of job.items) if (item.status === 'ready') { item.stage = 'grouped'; item.updatedAt = new Date().toISOString(); }
    await this.persist();
    for (const item of job.items) if (item.status === 'ready') { item.stage = 'ready'; item.updatedAt = new Date().toISOString(); }
    this.recount(job);
    job.status = job.failedItems ? (job.processedItems || job.skippedItems ? 'partial' : 'failed') : 'ready';
    job.completedAt = new Date().toISOString(); job.updatedAt = job.completedAt;
    this.logScoreTotals(job.id);
    this.state.folders = this.folderSnapshot(this.store.list(), this.pendingAssignments());
    await this.persist(); return structuredClone(job);
  }

  private rebuildDerived() {
    this.state.events = deriveEvents(this.store.list(), this.state.assets);
    const existing = new Map(this.state.albums.map(album => [album.id, album]));
    for (const event of this.state.events.filter(value => value.memoryIds.length >= 2)) {
      const id = `album-${event.id.slice(6)}`; const current = existing.get(id);
      if (current && current.type !== 'suggested') continue;
      const memories = event.memoryIds.map(memoryId => this.store.get(memoryId)).filter(Boolean) as Memory[];
      const rankings = memories.map(memory => {
        const asset = this.state.assets.find(value => value.memoryId === memory.id)!;
        const similarity = Math.max(0, ...this.state.assets.filter(value => value.memoryId !== memory.id).map(value => cosine(asset.embedding, value.embedding)));
        return { memory, cover: scoreCover(asset.quality, 1 - similarity), world: memory.readiness3d?.score ?? scoreWorldAnchor(asset.quality) };
      });
      const cover = rankings.slice().sort((a, b) => b.cover - a.cover || a.memory.id.localeCompare(b.memory.id))[0];
      const anchor = rankings.slice().sort((a, b) => b.world - a.world || a.memory.id.localeCompare(b.memory.id))[0];
      const dates = memories.map(memory => memory.date).filter(Boolean).sort(); const locations = memories.map(memory => memory.location).filter(Boolean);
      const now = current?.createdAt || new Date().toISOString();
      const album: Album = {
        id, title: albumTitle(memories, event), type: 'suggested', coverMemoryId: cover.memory.id, worldAnchorMemoryId: anchor.memory.id,
        memoryIds: event.memoryIds, dateRange: { start: dates[0] || '', end: dates.at(-1) || '' },
        ...(locations.length && locations.every(value => value === locations[0]) ? { location: locations[0] } : {}),
        confidence: event.confidence, privacy: 'private', createdAt: now, updatedAt: new Date().toISOString(),
        selection: {
          coverScore: cover.cover, worldAnchorScore: anchor.world,
          coverReasons: ['sharpness', 'exposure', 'composition', 'subject quality', 'uniqueness', 'visual appeal'],
          worldAnchorReasons: ['wide scene', 'depth variation', 'visible ground', 'open space', 'stable geometry', 'low obstruction'],
        },
      };
      if (current) this.state.albums[this.state.albums.findIndex(value => value.id === id)] = album; else this.state.albums.push(album);
    }
  }

  async createManual(title: string, memoryIds: string[], coverMemoryId?: string, worldAnchorMemoryId?: string) {
    this.validateMembers(memoryIds); const unique = [...new Set(memoryIds)]; const now = new Date().toISOString();
    const album: Album = { id: randomUUID(), title, type: 'manual', coverMemoryId: coverMemoryId || unique[0], worldAnchorMemoryId: worldAnchorMemoryId || unique[0], memoryIds: unique, dateRange: this.dateRange(unique), confidence: 1, privacy: 'private', createdAt: now, updatedAt: now };
    if (!unique.includes(album.coverMemoryId) || !unique.includes(album.worldAnchorMemoryId)) throw new Error('Cover and world anchor must belong to the album.');
    this.state.albums.unshift(album); await this.persist(); return structuredClone(album);
  }

  async updateAlbum(id: string, changes: { title?: string; type?: 'confirmed'; addMemoryIds?: string[]; removeMemoryIds?: string[]; coverMemoryId?: string; worldAnchorMemoryId?: string }) {
    const index = this.state.albums.findIndex(album => album.id === id); if (index < 0) return undefined;
    const album = this.state.albums[index]; const remove = new Set(changes.removeMemoryIds || []);
    const memoryIds = [...new Set([...album.memoryIds.filter(memoryId => !remove.has(memoryId)), ...(changes.addMemoryIds || [])])];
    this.validateMembers(memoryIds); if (!memoryIds.length) throw new Error('An album needs at least one memory.');
    const coverMemoryId = changes.coverMemoryId || (memoryIds.includes(album.coverMemoryId) ? album.coverMemoryId : memoryIds[0]);
    const worldAnchorMemoryId = changes.worldAnchorMemoryId || (memoryIds.includes(album.worldAnchorMemoryId) ? album.worldAnchorMemoryId : memoryIds[0]);
    if (!memoryIds.includes(coverMemoryId) || !memoryIds.includes(worldAnchorMemoryId)) throw new Error('Cover and world anchor must belong to the album.');
    this.state.albums[index] = { ...album, ...(changes.title ? { title: changes.title } : {}), ...(changes.type ? { type: changes.type } : {}), memoryIds, coverMemoryId, worldAnchorMemoryId, dateRange: this.dateRange(memoryIds), updatedAt: new Date().toISOString() };
    await this.persist(); return structuredClone(this.state.albums[index]);
  }

  sharePreview(id: string, selected?: string[]): AlbumSharePreview | undefined {
    const album = this.state.albums.find(value => value.id === id); if (!album) return undefined;
    const memoryIds = selected ? [...new Set(selected)] : album.memoryIds;
    if (!memoryIds.length || memoryIds.some(memoryId => !album.memoryIds.includes(memoryId))) throw new Error('Shared memories must belong to this album.');
    if (!memoryIds.includes(album.worldAnchorMemoryId)) throw new Error('A shared album world must include its visible world anchor. Choose a different anchor before excluding this memory.');
    const memories = memoryIds.map(memoryId => this.store.get(memoryId)).filter(Boolean) as Memory[];
    return { albumId: album.id, title: album.title, totalMedia: memories.length, memoryIds, memories: memories.map(({ id: memoryId, title, mediaType, thumbnailUrl, source }) => ({ id: memoryId, title, mediaType, thumbnailUrl, source })), sources: [...new Set(memories.map(memory => memory.source))] };
  }

  private validateMembers(memoryIds: string[]) {
    if (!memoryIds.length || memoryIds.some(memoryId => !this.store.get(memoryId))) throw new Error('Every album item must refer to a memory in this library.');
  }

  private dateRange(memoryIds: string[]) {
    const dates = memoryIds.map(memoryId => this.store.get(memoryId)?.date || '').filter(Boolean).sort(); return { start: dates[0] || '', end: dates.at(-1) || '' };
  }

  private async resume() {
    for (const job of this.state.jobs.filter(value => value.status === 'processing' || value.status === 'queued')) {
      // An interrupted rescore continues in the background; scored items are not redone.
      if (job.kind === 'rescore-3d') { void this.runRescore3d(job.id).catch(() => {}); continue; }
      for (const item of job.items.filter(value => value.localPath && stageIndex(value.stage) >= stageIndex('archived') && value.status !== 'ready' && value.status !== 'skipped')) {
        const memory = (item.memoryId && this.store.get(item.memoryId)) || item.draftMemory;
        if (!memory) { item.status = 'failed'; item.retryable = true; item.lastError = 'Archived media is safe, but its metadata needs a retry.'; continue; }
        try { await this.processArchived(job, item, memory); } catch { item.status = 'failed'; item.retryable = true; item.lastError = 'Archived media could not finish processing.'; }
      }
      if (job.items.length && job.items.every(item => ['ready', 'skipped', 'failed'].includes(item.status))) await this.finishJob(job.id);
      else { job.status = 'partial'; this.recount(job); await this.persist(); }
    }
  }
}
