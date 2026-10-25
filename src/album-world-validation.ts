import type { AlbumWorldState } from './types';

const safeId = (value: unknown) => typeof value === 'string' && value.length > 0 && value.length <= 256;

export function isAlbumWorldState(value: unknown): value is AlbumWorldState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const state = value as Record<string, unknown>;
  const related = state.relatedMemoryIds;
  const shared = state.sharedMemoryIds;
  return safeId(state.albumId) && safeId(state.worldId) && safeId(state.anchorMemoryId) && safeId(state.currentMemoryId) &&
    typeof state.geometryNotice === 'string' && state.geometryNotice.length > 0 && state.geometryNotice.length <= 500 &&
    Array.isArray(related) && related.length > 0 && related.length <= 200 && related.every(safeId) && new Set(related).size === related.length &&
    related.includes(state.anchorMemoryId as string) && related.includes(state.currentMemoryId as string) &&
    (shared === undefined || (Array.isArray(shared) && shared.length > 0 && shared.length <= related.length && shared.every(safeId) && new Set(shared).size === shared.length && shared.every(id => related.includes(id)) && shared.includes(state.anchorMemoryId as string) && shared.includes(state.currentMemoryId as string)));
}
