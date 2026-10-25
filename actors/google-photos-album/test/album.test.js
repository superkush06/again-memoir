import test from 'node:test';
import assert from 'node:assert/strict';
import { checkedAlbumUrl, collectAlbum, fetchAlbumHtml, parseAlbumHtml, parsePageResponse } from '../src/album.js';

const photo = (key, base, width, height, takenMs, offsetMs = -25200000) =>
  [key, [base, width, height, null, null, null, null, null, [null, null, 1], [1]], takenMs, 'dedup', offsetMs, 1792840550467, ['contributor'], [[2]], 2, { 15: 1 }];
const page = (data) => `<!doctype html><script nonce="x">AF_initDataCallback({key: 'ds:0', hash: '1', data:[[]], sideChannel: {}});</script>`
  + `<script nonce="x">AF_initDataCallback({key: 'ds:1', hash: '2', data:${JSON.stringify(data)}, sideChannel: {}});</script>`;
const album = (items, nextPage = '') => [null, items, nextPage, ['AF1QipAlbum', 'Test Album', [1792796686000, 1792824297000]], {}, 1];

test('shared album pages become full-resolution photo records in album order', () => {
  const { album: meta, items } = parseAlbumHtml(page(album([
    photo('AF1QipFirst', 'https://lh3.googleusercontent.com/pw/first', 3024, 4032, 1792796686244),
    photo('AF1QipSecond', 'https://lh3.googleusercontent.com/pw/second', 3600, 2400, 1792799929000, -28800000),
  ])));
  assert.deepEqual(meta, {
    id: 'AF1QipAlbum', title: 'Test Album', firstTakenAt: '2026-10-23T23:04:46.000Z', lastTakenAt: '2026-10-24T06:44:57.000Z',
    itemCount: 2, morePages: false,
  });
  assert.deepEqual(items[0], {
    mediaKey: 'AF1QipFirst', position: 0, width: 3024, height: 4032,
    takenAt: '2026-10-23T23:04:46.244Z', timezoneOffsetMinutes: -420,
    imageUrl: 'https://lh3.googleusercontent.com/pw/first=w3024-h4032',
    originalUrl: 'https://lh3.googleusercontent.com/pw/first=d',
    thumbnailUrl: 'https://lh3.googleusercontent.com/pw/first=w512-h512',
  });
  assert.equal(items[1].position, 1);
  assert.equal(items[1].timezoneOffsetMinutes, -480);
});

test('entries outside the Google Photos CDN or without valid dimensions are dropped, never guessed', () => {
  const { items } = parseAlbumHtml(page(album([
    photo('AF1QipGood', 'https://lh3.googleusercontent.com/pw/good', 100, 80, 1792796686244),
    photo('AF1QipEvil', 'https://evil.example/pw/x', 100, 80, 1792796686244),
    photo('AF1QipFlat', 'https://lh3.googleusercontent.com/pw/flat', 0, 80, 1792796686244),
    ['no-media'],
  ])));
  assert.deepEqual(items.map(item => item.mediaKey), ['AF1QipGood']);
});

test('albums with more pages say so instead of claiming to be complete', () => {
  const { album: meta } = parseAlbumHtml(page(album([], 'next-page-token')));
  assert.equal(meta.morePages, true);
});

test('pages without shared album data explain how to fix the link', () => {
  assert.throws(() => parseAlbumHtml('<html>Sign in</html>'), /link sharing/);
});

test('only HTTPS shared-album links are accepted; account-switcher links are normalized', () => {
  assert.equal(checkedAlbumUrl(' https://photos.app.goo.gl/BYdzzQJMn45bDYio6 '), 'https://photos.app.goo.gl/BYdzzQJMn45bDYio6');
  assert.equal(checkedAlbumUrl('https://photos.google.com/share/AF1Qip?key=abc'), 'https://photos.google.com/share/AF1Qip?key=abc');
  assert.equal(checkedAlbumUrl('https://photos.google.com/u/1/share/AF1Qip?key=abc'), 'https://photos.google.com/share/AF1Qip?key=abc');
  for (const bad of ['http://photos.app.goo.gl/x', 'https://photos.google.com/album/x', 'https://photos.google.com/u/x/share/y', 'https://evil.example/share/x', 'https://u:p@photos.app.goo.gl/x', 'not a url', undefined]) {
    assert.throws(() => checkedAlbumUrl(bad), /shared Google Photos album/);
  }
});

test('album pages are fetched only from photos.google.com after redirects', async () => {
  const ok = async () => ({ ok: true, status: 200, url: 'https://photos.google.com/share/AF1Qip?key=k', text: async () => 'html' });
  assert.deepEqual(await fetchAlbumHtml('https://photos.app.goo.gl/x', ok), { html: 'html', url: 'https://photos.google.com/share/AF1Qip?key=k' });
  const elsewhere = async () => ({ ok: true, status: 200, url: 'https://accounts.google.com/signin', text: async () => 'login' });
  await assert.rejects(fetchAlbumHtml('https://photos.app.goo.gl/x', elsewhere), /did not open a shared album/);
  const missing = async () => ({ ok: false, status: 404, url: 'https://photos.google.com/share/x', text: async () => '' });
  await assert.rejects(fetchAlbumHtml('https://photos.app.goo.gl/x', missing), /404/);
});

const rpcResponse = (entries, nextPage) => `)]}'\n\n123\n${JSON.stringify([['wrb.fr', 'snAcKc', JSON.stringify([null, entries, nextPage]), null, null, null, 'generic']])}\n25\n[["e",4,null,null,1]]\n`;

test('later album pages are read from the batchexecute response', () => {
  const { entries, nextPageToken } = parsePageResponse(rpcResponse([photo('AF1QipNext', 'https://lh3.googleusercontent.com/pw/next', 10, 10, 1)], 'token-3'));
  assert.equal(entries.length, 1);
  assert.equal(nextPageToken, 'token-3');
  assert.throws(() => parsePageResponse(')]}\'\n\n[["er",null]]'), /next page/);
});

test('collectAlbum follows page tokens until maxItems, keeping album order', async () => {
  const requests = [];
  const firstPage = page(album([
    photo('AF1QipA', 'https://lh3.googleusercontent.com/pw/a', 10, 10, 1792796686244),
    photo('AF1QipB', 'https://lh3.googleusercontent.com/pw/b', 10, 10, 1792796686244),
  ], 'token-2')) + '<script>window.WIZ_global_data = {"FdrFJe":"-123","cfb2h":"boq_photosuiserver_20261020"};</script>';
  const fakeFetch = async (url, init = {}) => {
    requests.push({ url: String(url), body: init.body ? String(init.body) : '' });
    if (String(url).startsWith('https://photos.app.goo.gl/')) return { ok: true, status: 200, url: 'https://photos.google.com/share/AF1QipAlbum?key=secret', text: async () => firstPage };
    const token = new URLSearchParams(String(init.body)).get('f.req').includes('token-2') ? 'token-3' : '';
    const key = token ? 'C' : 'D';
    return { ok: true, status: 200, url: String(url), text: async () => rpcResponse([photo(`AF1Qip${key}`, `https://lh3.googleusercontent.com/pw/${key.toLowerCase()}`, 10, 10, 1)], token) };
  };
  const result = await collectAlbum({ albumUrl: 'https://photos.app.goo.gl/x', maxItems: 3 }, fakeFetch);
  assert.deepEqual(result.items.map(item => [item.mediaKey, item.position]), [['AF1QipA', 0], ['AF1QipB', 1], ['AF1QipC', 2]]);
  assert.equal(result.album.pagesRead, 2);
  assert.equal(result.album.morePages, true, 'stopped at maxItems while the album continues');
  const rpc = requests[1];
  assert.match(rpc.url, /^https:\/\/photos\.google\.com\/_\/PhotosUi\/data\/batchexecute\?rpcids=snAcKc/);
  assert.match(rpc.url, /f\.sid=-123/);
  assert.deepEqual(JSON.parse(JSON.parse(new URLSearchParams(rpc.body).get('f.req'))[0][0][1]), ['AF1QipAlbum', 'token-2', null, 'secret']);

  const lastPageCut = await collectAlbum({ albumUrl: 'https://photos.app.goo.gl/x', maxItems: 2 }, async () => ({
    ok: true, status: 200, url: 'https://photos.google.com/share/AF1QipAlbum?key=secret',
    text: async () => page(album([photo('AF1QipA', 'https://lh3.googleusercontent.com/pw/a', 10, 10, 1), photo('AF1QipB', 'https://lh3.googleusercontent.com/pw/b', 10, 10, 1), photo('AF1QipC', 'https://lh3.googleusercontent.com/pw/c', 10, 10, 1)])),
  }));
  assert.equal(lastPageCut.items.length, 2);
  assert.equal(lastPageCut.album.morePages, true, 'photos cut from the last page still count as more');

  const everything = await collectAlbum({ albumUrl: 'https://photos.app.goo.gl/x', maxItems: 100 }, fakeFetch);
  assert.deepEqual(everything.items.map(item => item.mediaKey), ['AF1QipA', 'AF1QipB', 'AF1QipC', 'AF1QipD']);
  assert.equal(everything.album.pagesRead, 3);
  assert.equal(everything.album.morePages, false);
});
