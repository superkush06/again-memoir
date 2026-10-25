import test from 'node:test';
import assert from 'node:assert/strict';
import { sharedAlbumLink, sharedAlbumMemory } from './shared-album.js';

test('shared album links accept short and share links, normalizing account-switcher paths', () => {
  assert.equal(sharedAlbumLink('https://photos.app.goo.gl/album')?.toString(), 'https://photos.app.goo.gl/album');
  assert.equal(sharedAlbumLink('https://photos.google.com/share/AF1Qip?key=k')?.toString(), 'https://photos.google.com/share/AF1Qip?key=k');
  assert.equal(sharedAlbumLink('https://photos.google.com/u/1/share/AF1Qip?key=k')?.toString(), 'https://photos.google.com/share/AF1Qip?key=k');
  for (const bad of ['http://photos.app.goo.gl/x', 'https://photos.google.com/album/x', 'https://evil.example/share/x', 'https://u:p@photos.app.goo.gl/x', 'nope']) {
    assert.equal(sharedAlbumLink(bad), undefined, bad);
  }
});

test('actor rows become dated, attributed album memories with stable IDs', () => {
  const context = { albumUrl: 'https://photos.app.goo.gl/album', consentId: 'consent-1', timeZone: 'America/Los_Angeles' };
  const row = { mediaKey: 'AF1Qip0', position: 0, width: 3024, height: 4032, takenAt: '2026-10-24T05:30:00.000Z', imageUrl: 'https://lh3.googleusercontent.com/pw/a=w3024-h4032', albumTitle: 'Cal Hacks 13.0 Community Album' };
  const memory = sharedAlbumMemory(row, context);
  assert.deepEqual(memory, {
    id: 'google-album-b57185c82ceff47f362f', title: 'Cal Hacks 13.0 Community Album · 1',
    description: 'From the shared Google Photos album “Cal Hacks 13.0 Community Album”.',
    // 05:30 UTC on the 24th is still the evening of the 23rd in the organizer's time zone.
    date: '2026-10-23', capturedAt: '2026-10-24T05:30:00.000Z', location: '', tags: ['shared album'],
    source: 'google-photos', mediaType: 'image', url: row.imageUrl, thumbnailUrl: '', width: 3024, height: 4032,
    sourceUrl: 'https://photos.app.goo.gl/album', sourceAccount: 'Shared album: Cal Hacks 13.0 Community Album', consentId: 'consent-1',
  });
  assert.equal(sharedAlbumMemory({ ...row, takenAt: 'not a date' }, context)?.date, '', 'unknown dates stay unknown');
  assert.equal(sharedAlbumMemory({ ...row, imageUrl: 'javascript:alert(1)' }, context), undefined);
  assert.equal(sharedAlbumMemory(null, context), undefined);
});
