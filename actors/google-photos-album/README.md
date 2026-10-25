# Google Photos Shared Album

An Apify Actor that lists the photos in a link-shared Google Photos album. Again uses it to bring
an event's community album (or any album a friend shared with you) into a private memoir, where
each photo can become a walkable 3D memory.

Google's Photos Picker API only opens the signed-in user's own library, so albums other people
share by link need a different path. This Actor reads the album's public share page; it never
signs in and never needs a Google account.

## Input

| Field | Type | Notes |
|---|---|---|
| `albumUrl` | string, required | `https://photos.app.goo.gl/…` or `https://photos.google.com/share/…` |
| `maxItems` | integer, 1–5000, default 100 | Photos are returned in album order |

## Output

One dataset row per photo:

| Field | Example |
|---|---|
| `mediaKey` | `AF1QipPykvMQ…` (stable ID within the album) |
| `position` | `0` |
| `width`, `height` | `3024`, `4032` |
| `takenAt` | `2026-10-23T23:04:46.244Z` |
| `timezoneOffsetMinutes` | `-420` |
| `imageUrl` | full-size JPEG (`…=w3024-h4032`) |
| `originalUrl` | the original upload (`…=d`) |
| `thumbnailUrl` | 512 px preview |
| `albumTitle`, `albumUrl` | album context |

The key-value store record `ALBUM` holds the album title, capture date range, item count, pages
read and whether the album has more photos than were returned.

## Limits

- The album page carries the first ~300 items; later pages come from the same request the Google
  Photos web page makes when you scroll (up to 50 pages). `ALBUM.pagesRead` says how many were read and
  `ALBUM.morePages` is `true` when the run stopped at `maxItems` before the end of the album.
- Links copied with an account switcher (`photos.google.com/u/1/share/…`) are accepted and normalized.
- Every item is returned as a still image. Videos and motion photos come back as their still frame.
- Only use albums you own or have permission to import.

## Run

```bash
npm install
npm test
mkdir -p storage/key_value_stores/default
echo '{"albumUrl":"https://photos.app.goo.gl/BYdzzQJMn45bDYio6","maxItems":25}' > storage/key_value_stores/default/INPUT.json
npm start
```

Results land in `storage/datasets/default/`. To deploy, run `npx apify-cli login` and then
`npx apify-cli push` from this folder, and set `APIFY_GOOGLE_PHOTOS_ACTOR=<username>/google-photos-shared-album`
in the app's `.env`. The app calls it through `apify-client` (`server/apify.ts`).
