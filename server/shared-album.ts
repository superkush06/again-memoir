import { createHash } from 'node:crypto';
import type { Memory } from '../src/types.js';
import { localDateTime } from './organize.js';

/** A link-shared Google Photos album, or undefined. Account-switcher links (/u/<n>/share/) are normalized. */
export function sharedAlbumLink(value: string) {
  let album: URL;
  try { album = new URL(value); } catch { return undefined; }
  if (album.hostname === 'photos.google.com') album.pathname = album.pathname.replace(/^\/u\/\d+(?=\/share\/)/, '');
  const shared = album.hostname === 'photos.app.goo.gl' || (album.hostname === 'photos.google.com' && album.pathname.startsWith('/share/'));
  return album.protocol === 'https:' && !album.username && !album.password && shared ? album : undefined;
}

/** One dataset row from actors/google-photos-album as a memory draft; rows without an HTTPS image are skipped. */
export function sharedAlbumMemory(row: unknown, context: { albumUrl: string; consentId: string; timeZone: string }): Memory | undefined {
  const item = row as Record<string, unknown> | null;
  const imageUrl = item?.imageUrl;
  if (!item || typeof imageUrl !== 'string' || !imageUrl.startsWith('https://')) return undefined;
  const albumTitle = String(item.albumTitle || 'Shared album').slice(0, 120);
  const taken = typeof item.takenAt === 'string' ? new Date(item.takenAt) : null;
  const capturedAt = taken && !isNaN(taken.getTime()) ? taken.toISOString() : undefined;
  const position = Number.isInteger(item.position) ? (item.position as number) + 1 : undefined;
  return {
    id: `google-album-${createHash('sha256').update(String(item.mediaKey || imageUrl)).digest('hex').slice(0, 20)}`,
    title: position ? `${albumTitle} · ${position}` : albumTitle,
    description: `From the shared Google Photos album “${albumTitle}”.`,
    date: capturedAt ? (localDateTime(capturedAt, context.timeZone)?.date || capturedAt.slice(0, 10)) : '',
    capturedAt,
    location: '',
    tags: ['shared album'],
    source: 'google-photos',
    mediaType: 'image',
    url: imageUrl,
    thumbnailUrl: '',
    width: typeof item.width === 'number' ? item.width : undefined,
    height: typeof item.height === 'number' ? item.height : undefined,
    sourceUrl: context.albumUrl,
    sourceAccount: `Shared album: ${albumTitle}`,
    consentId: context.consentId,
  };
}
