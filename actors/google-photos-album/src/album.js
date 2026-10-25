// Shared Google Photos albums render their first page into the page as
// AF_initDataCallback payloads. `ds:1` holds the album: [_, items, nextPageToken, meta, ...].
// Each item is [mediaKey, [baseUrl, width, height, ...], takenAtMs, _, timezoneOffsetMs, ...].
// Later pages come from the page's own batchexecute RPC (snAcKc) in the same item format.
const CDN_PREFIX = 'https://lh3.googleusercontent.com/';
const INVALID_LINK = 'Enter a shared Google Photos album link (https://photos.app.goo.gl/… or https://photos.google.com/share/…).';
const HEADERS = { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'en-US,en;q=0.9' };
const MAX_PAGES = 50;

export function checkedAlbumUrl(value) {
  let url;
  try { url = new URL(String(value ?? '').trim()); } catch { throw new Error(INVALID_LINK); }
  // Links copied while signed in to several accounts carry /u/<n>/; the album is the same.
  if (url.hostname === 'photos.google.com') url.pathname = url.pathname.replace(/^\/u\/\d+(?=\/share\/)/, '');
  const shortLink = url.hostname === 'photos.app.goo.gl';
  const shareLink = url.hostname === 'photos.google.com' && url.pathname.startsWith('/share/');
  if (url.protocol !== 'https:' || url.username || url.password || !(shortLink || shareLink)) throw new Error(INVALID_LINK);
  return url.toString();
}

/** Short links redirect to photos.google.com/share; anything else (a sign-in page) is not an album. */
export async function fetchAlbumHtml(albumUrl, fetchImpl = fetch) {
  const response = await fetchImpl(albumUrl, {
    redirect: 'follow',
    // A plain user agent receives the album page; full desktop browser strings get an app deep-link page.
    headers: HEADERS,
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Google Photos returned HTTP ${response.status} for this album.`);
  const finalUrl = new URL(response.url);
  if (finalUrl.hostname !== 'photos.google.com' || !finalUrl.pathname.startsWith('/share/')) {
    throw new Error('The link did not open a shared album. Check that link sharing is on for this album.');
  }
  return { html: await response.text(), url: finalUrl.toString() };
}

/** batchexecute replies with a guarded, length-prefixed stream; the snAcKc payload is [_, items, nextPageToken]. */
export function parsePageResponse(text) {
  for (const line of String(text).split('\n')) {
    if (!line.includes('"wrb.fr"')) continue;
    try {
      const envelope = JSON.parse(line).find((part) => part?.[0] === 'wrb.fr' && part[1] === 'snAcKc');
      const payload = envelope && JSON.parse(envelope[2]);
      if (Array.isArray(payload?.[1])) return { entries: payload[1], nextPageToken: typeof payload[2] === 'string' ? payload[2] : '' };
    } catch { /* Not the album payload; keep scanning. */ }
  }
  throw new Error('Google Photos did not return the next page of this album.');
}

async function fetchNextPage({ albumId, pageToken, key, sourcePath, sessionId, buildLabel }, fetchImpl) {
  const query = new URLSearchParams({ rpcids: 'snAcKc', 'source-path': sourcePath, hl: 'en', rt: 'c' });
  if (sessionId) query.set('f.sid', sessionId);
  if (buildLabel) query.set('bl', buildLabel);
  const body = new URLSearchParams({ 'f.req': JSON.stringify([[['snAcKc', JSON.stringify([albumId, pageToken, null, key]), null, 'generic']]]) });
  const response = await fetchImpl(`https://photos.google.com/_/PhotosUi/data/batchexecute?${query}`, {
    method: 'POST',
    headers: { ...HEADERS, 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
    body,
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Google Photos returned HTTP ${response.status} for the next page of this album.`);
  return parsePageResponse(await response.text());
}

/** Reads the album page by page, in album order, until maxItems or the last page. */
export async function collectAlbum({ albumUrl, maxItems }, fetchImpl = fetch, onPage = () => {}) {
  const { html, url } = await fetchAlbumHtml(albumUrl, fetchImpl);
  const first = parseAlbumHtml(html);
  const items = first.items.slice(0, maxItems);
  let cut = first.items.length > items.length;
  // Positions count every album entry, including ones skipped as invalid.
  let seen = first.entryCount;
  let pageToken = first.nextPageToken;
  let pagesRead = 1;
  const shareUrl = new URL(url);
  const pageContext = {
    albumId: first.album.id,
    key: shareUrl.searchParams.get('key'),
    sourcePath: shareUrl.pathname,
    sessionId: html.match(/"FdrFJe":"(-?\d+)"/)?.[1],
    buildLabel: html.match(/"cfb2h":"([^"]+)"/)?.[1],
  };
  onPage({ page: pagesRead, found: items.length });
  while (pageToken && items.length < maxItems && pagesRead < MAX_PAGES && pageContext.albumId) {
    const next = await fetchNextPage({ ...pageContext, pageToken }, fetchImpl);
    const parsed = parseEntries(next.entries, seen);
    const room = maxItems - items.length;
    if (parsed.length > room) cut = true;
    items.push(...parsed.slice(0, room));
    seen += next.entries.length;
    pageToken = next.nextPageToken;
    pagesRead += 1;
    onPage({ page: pagesRead, found: items.length });
  }
  return { album: { ...first.album, itemCount: items.length, pagesRead, morePages: cut || Boolean(pageToken) }, items };
}

function callbackData(html, key) {
  const start = html.indexOf(`AF_initDataCallback({key: '${key}'`);
  if (start < 0) return undefined;
  const dataAt = html.indexOf('data:', start);
  const end = html.indexOf(', sideChannel:', dataAt);
  if (dataAt < 0 || end < 0) return undefined;
  try { return JSON.parse(html.slice(dataAt + 'data:'.length, end)); } catch { return undefined; }
}

const iso = (ms) => (Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null);
const dimension = (value) => Number.isInteger(value) && value > 0 && value <= 100_000;

function parseEntries(entries, startPosition) {
  return entries.flatMap((entry, index) => {
    const media = Array.isArray(entry) ? entry[1] : undefined;
    if (typeof entry?.[0] !== 'string' || !Array.isArray(media)) return [];
    const [baseUrl, width, height] = media;
    if (typeof baseUrl !== 'string' || !baseUrl.startsWith(CDN_PREFIX) || !dimension(width) || !dimension(height)) return [];
    const offsetMs = Number(entry[4]);
    return [{
      mediaKey: entry[0],
      position: startPosition + index,
      width,
      height,
      takenAt: iso(Number(entry[2])),
      timezoneOffsetMinutes: Number.isFinite(offsetMs) ? Math.round(offsetMs / 60_000) : null,
      // `=w…-h…` serves a full-size JPEG; `=d` serves the original upload.
      imageUrl: `${baseUrl}=w${width}-h${height}`,
      originalUrl: `${baseUrl}=d`,
      thumbnailUrl: `${baseUrl}=w512-h512`,
    }];
  });
}

export function parseAlbumHtml(html) {
  const data = callbackData(html, 'ds:1');
  if (!Array.isArray(data) || !Array.isArray(data[1])) {
    throw new Error('This page has no shared album data. Check that the link points to an album and that link sharing is on.');
  }
  const items = parseEntries(data[1], 0);
  const meta = Array.isArray(data[3]) ? data[3] : [];
  const range = Array.isArray(meta[2]) ? meta[2] : [];
  const nextPageToken = typeof data[2] === 'string' ? data[2] : '';
  return {
    album: {
      id: typeof meta[0] === 'string' ? meta[0] : null,
      title: typeof meta[1] === 'string' && meta[1].trim() ? meta[1].trim() : 'Shared album',
      firstTakenAt: iso(Number(range[0])),
      lastTakenAt: iso(Number(range[1])),
      itemCount: items.length,
      // The first page holds a few hundred items; a token means the album continues.
      morePages: nextPageToken.length > 0,
    },
    items,
    nextPageToken,
    entryCount: data[1].length,
  };
}
