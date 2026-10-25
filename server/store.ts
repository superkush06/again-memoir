import { mkdir, readFile, rename, writeFile, rm, readdir } from 'node:fs/promises';
import path from 'node:path';
import type { Memory } from '../src/types.js';
import { demoMemories } from './demo.js';
import { organizeMemory } from './organize.js';
import { randomUUID } from 'node:crypto';

export type ImportConsent = {
  id: string;
  source: 'instagram' | 'linkedin' | 'youtube' | 'google-photos';
  accountUrl: string;
  statement: string;
  acceptedAt: string;
};

/** A single-process store. Writes are serialized and atomically replaced. */
export class MemoryStore {
  private memories: Memory[] = [];
  private consents: ImportConsent[] = [];
  private writes: Promise<void> = Promise.resolve();
  readonly uploadsDir: string;
  constructor(readonly directory: string, private seed: Memory[] = demoMemories) {
    this.uploadsDir = path.join(directory, 'uploads');
  }
  async initialize() {
    await mkdir(this.uploadsDir, { recursive: true });
    try {
      const data = JSON.parse(await readFile(path.join(this.directory, 'memories.json'), 'utf8'));
      if (!Array.isArray(data)) throw new Error('Memory catalog is malformed. Restore data/memories.json from a backup.');
      this.memories = data;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      this.memories = structuredClone(this.seed);
      await this.persist();
    }
    try {
      const data = JSON.parse(await readFile(path.join(this.directory, 'import-consents.json'), 'utf8'));
      if (Array.isArray(data)) this.consents = data;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  /**
   * The visible library. Demo placeholders exist only to make an empty app
   * explorable: once any real memory is imported they disappear from every
   * list, folder, and search result (they remain resolvable by ID so open
   * rooms and old references do not break, and they return after a reset).
   */
  list() {
    const real = this.memories.filter(memory => memory.source !== 'demo');
    return structuredClone(real.length ? real : this.memories);
  }
  /** Every catalog record, including hidden demo placeholders. */
  all() { return structuredClone(this.memories); }
  hasRealMemories() { return this.memories.some(memory => memory.source !== 'demo'); }
  get(id: string) { return structuredClone(this.memories.find(item => item.id === id)); }
  async add(items: Memory[]) {
    const existing = new Set(this.memories.map(item => item.id));
    const added = items.map(organizeMemory).filter(item => {
      if (existing.has(item.id)) return false;
      existing.add(item.id);
      return true;
    });
    this.memories.unshift(...added);
    await this.persist();
    return structuredClone(added);
  }
  async recordConsent(input: Omit<ImportConsent, 'id' | 'acceptedAt'>) {
    const consent: ImportConsent = { ...input, id: randomUUID(), acceptedAt: new Date().toISOString() };
    this.consents.push(consent);
    const file = path.join(this.directory, 'import-consents.json');
    const json = JSON.stringify(this.consents, null, 2);
    this.writes = this.writes.catch(() => {}).then(async () => {
      await writeFile(`${file}.tmp`, json, 'utf8');
      await rename(`${file}.tmp`, file);
    });
    await this.writes;
    return consent;
  }
  async update(id: string, changes: Partial<Memory>) {
    const index = this.memories.findIndex(item => item.id === id);
    if (index < 0) return undefined;
    this.memories[index] = { ...this.memories[index], ...changes, id };
    await this.persist();
    return this.get(id);
  }
  /** Apply several metadata changes with one atomic catalog write. */
  async updateMany(changes: { id: string; changes: Partial<Memory> }[]) {
    let changed = 0;
    for (const { id, changes: patch } of changes) {
      const index = this.memories.findIndex(item => item.id === id);
      if (index < 0) continue;
      this.memories[index] = { ...this.memories[index], ...patch, id }; changed++;
    }
    if (changed) await this.persist();
    return changed;
  }
  /** Remove user-owned catalog data and archived media while retaining the demo shell. */
  async clearPersonalData() {
    const removedMemories = this.memories.filter(memory => memory.source !== 'demo').length;
    const entries = await readdir(this.uploadsDir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) await rm(path.join(this.uploadsDir, entry.name), { recursive: true, force: true });
    this.memories = structuredClone(this.seed).filter(memory => memory.source === 'demo');
    this.consents = [];
    await this.persist();
    const consentFile = path.join(this.directory, 'import-consents.json');
    await writeFile(`${consentFile}.tmp`, '[]\n', 'utf8');
    await rename(`${consentFile}.tmp`, consentFile);
    return { removedMemories, removedFiles: entries.length };
  }
  private persist() {
    const json = JSON.stringify(this.memories, null, 2);
    const save = async () => {
      const file = path.join(this.directory, 'memories.json');
      await writeFile(`${file}.tmp`, json, 'utf8');
      await rename(`${file}.tmp`, file);
    };
    this.writes = this.writes.catch(() => {}).then(save);
    return this.writes;
  }
}
