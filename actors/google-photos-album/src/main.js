import { Actor, log } from 'apify';
import { checkedAlbumUrl, collectAlbum } from './album.js';

await Actor.init();
try {
  const input = (await Actor.getInput()) ?? {};
  const albumUrl = checkedAlbumUrl(input.albumUrl);
  const requested = Number.isInteger(input.maxItems) ? input.maxItems : 100;
  const maxItems = Math.min(Math.max(requested, 1), 5000);

  log.info('Opening shared album', { albumUrl, maxItems });
  const { album, items } = await collectAlbum({ albumUrl, maxItems }, fetch, ({ page, found }) => log.info(`Read page ${page}`, { found }));
  const photos = items.map((item) => ({ ...item, albumTitle: album.title, albumUrl }));

  await Actor.pushData(photos);
  // The dataset holds one row per photo; the album summary sits beside it.
  await Actor.setValue('ALBUM', { ...album, albumUrl, returned: photos.length });
  if (album.morePages) log.info('Stopped at maxItems; the album has more photos.', { returned: photos.length });
  log.info(`Saved ${photos.length} photos from “${album.title}” (${album.pagesRead} page${album.pagesRead === 1 ? '' : 's'}).`);
  await Actor.exit();
} catch (error) {
  await Actor.fail(error instanceof Error ? error.message : String(error));
}
