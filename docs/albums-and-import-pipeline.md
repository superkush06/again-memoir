# Imported media, events, albums, and album worlds

Again deliberately does not mirror a complete cloud photo library. Google Photos Picker supplies only the media a person explicitly selects. Again archives that bounded selection, derives a small number of explainable event groups, and turns those groups into private albums and spatial worlds.

## Data flow

```text
Local upload | Google Photos Picker | Instagram / LinkedIn / YouTube (Apify)
  → server/import-pipeline.ts (one shared pipeline for every source)
  → 1. plan: deterministic local folder per item (holiday → explicit location → theme → Everyday moments)
  → 2. review: ONE Gemini call per batch of ≤48 items with small thumbnails; explicit keep/rename per item
        (strict schema; renames must be a taxonomy theme, a holiday matching the date, or a place in the location field)
  → 3. folders: folder plan + import job persisted together (job.folderPlan) BEFORE any bytes are archived
  → 4. archive: durable import job, local media archive
  → exact/perceptual deduplication
  → local visual embedding
  → explainable derived events
  → private suggested albums
  → one-anchor album world
  → explicit multiplayer share manifest
```

Media bytes remain under `data/uploads/`. `data/memories.json` remains the canonical memory catalog. `data/library-state.json` is an atomically replaced metadata catalog containing import jobs, fingerprints/embeddings, derived events, and albums. This single-process JSON design is appropriate for the local demo. A hosted, multi-user version should move the catalog and job leases to a transactional database while keeping media in object storage.

## Folder-first library

The default landing screen is **Folders**; "All memories" is the last navigation item. Folders are virtual and reference canonical memory IDs only:

- `Pictures` — general media root (shown first); only 3D-ready items
- category folders such as `Halloween 2025`, `Christmas 2025`, `Thanksgiving 2025`, explicit locations like `California`, and the fixed themes `Travel`, `Family`, `Friends`, `School and work`, `Food and places`, `Outdoors`, `Events`, `People`, `Sports`, `Nights out`, `Pets`, `Everyday moments`
- `All memories` — the broad archive (always last); every imported photo/video, unfiltered

Pictures and every category folder contain only memories whose 3D check passed (`readiness3d.ready === true`). Items an active import or rescore is still archiving or checking are listed in `pendingMemoryIds`; items that are not 3D-ready live only in All memories. The full folder tree is still created before any media is archived.

Folders are never named by a bare date, month, or year, and memory labels never expose camera filenames (`PXL_…`, `IMG_…`, `DSC_…`); they read "Photo memory" / "Video memory" instead. Demo placeholder memories disappear from every list, folder, and search as soon as any real memory exists. Batches larger than 48 items are organized locally with no model calls. If Gemini is unavailable, misconfigured, or returns output that fails validation, the local plan is used unchanged.

API: `GET /api/folders`, `GET /api/folders/:id` (individual items with thumbnails and human-readable labels), `POST /api/folders/reorganize` (re-review existing archived memories in batches of 48; never re-downloads or duplicates media).

## 3D readiness check

`server/depth-readiness.ts` scores every archived photo (and one sampled middle frame of each video, falling back to its poster) for how well it explores in 3D/VR. It runs the same Depth Anything V2 small session used for reconstruction (`server/depth-model.ts` loads the weights once per cache directory and serializes CPU inference), on a ≤252px copy with a dedicated 252px image processor rather than the default 518px one (~65–80 ms per photo on an M-series CPU versus ~280 ms).

From the raw, un-normalized relative inverse depth it measures depth range (p5–p95 spread), distinct depth layers (histogram peaks) and band coverage, a ground plane (lower-third nearness rising smoothly toward the bottom edge), a close occluder (one near blob reaching the frame center: selfies, food, faces), and flatness (share of the frame at roughly one depth). These combine with the existing sharpness, exposure, and screenshot signals into `readiness3d: { score, ready, reasons, source, metrics }`. The pass line is the single constant `READY_3D_THRESHOLD`.

If the depth model cannot load or run (for example onnxruntime is missing), the scorer falls back to the legacy `scoreWorldAnchor` heuristic with the stricter `HEURISTIC_READY_THRESHOLD` and marks `source: "heuristic"`. Scoring never fails an import; unscorable items stay in All memories.

`POST /api/library/rescore-3d` (`{ "onlyMissing": true }` optional) scores memories already in the library as one background `rescore-3d` job that shares the import progress UI. `npm run readiness:report` prints scores and timings for the archived library without writing anything.

## Import jobs and restart behavior

Every job records its source, total/processed/skipped/failed counts, current stage, status, timestamps, and per-item retry state. Items advance monotonically:

```text
received → archived → hashed → embedded → scored (3D check) → grouped → ready
```

Every stage is idempotent. Archive filenames derive from the job and provider item ID. Memory insertion is ID-deduplicated. State files are written to a temporary file and atomically renamed. On restart, archived items can resume without downloading again; a provider item that failed before archive remains explicitly retryable and may require a new Picker selection after its provider URL expires. OAuth access and refresh tokens are intentionally not written to disk.

The Picker supports up to 2,000 explicitly selected items per job. Settings offers smaller 50, 200, and 500-item limits for faster batches. Google returns the job immediately after selection metadata is read, and processing continues while the UI polls `GET /api/import-jobs`. Picker sessions cannot automatically select the latest photos; Google requires the person to choose and approve the items.

## Deduplication and provenance

The pipeline uses three bounded comparisons:

- SHA-256 for byte-identical files.
- A 64-bit difference hash for resized/recompressed images.
- A normalized local color-grid embedding for near-duplicate similarity.

If image decoding is unavailable, the clean provider fallback derives an embedding from SHA-256. One canonical `Memory` is retained. The canonical memory and asset record append provenance entries containing source, provider item ID, account/context when available, import job, timestamp, and Apify consent ID when applicable. A duplicate item is counted as skipped, not failed.

The local embedding is intentionally lightweight and deterministic. It supports this demo's similarity, grouping, diversity, and near-duplicate tasks without one Gemini call per photo. A future provider can replace it behind the asset record contract without changing album or job APIs.

## Derived events

`DerivedEvent` is an internal machine result, not a permanent promise to the user. Pairwise grouping considers:

- timestamps within a three-day window;
- local embedding similarity;
- shared caption/title/tag terms;
- the same source account;
- the same explicit import selection.

Location is never required. Every event stores human-readable reasons such as `same time window`, `similar visual content`, `shared caption terms`, `same source account`, and `same selected batch`. IDs and membership are deterministic for the same inputs.

Suggested albums are created only for events with at least two canonical memories. Confirmed and manual albums are not overwritten by regrouping.

## Albums and ranking

Albums are source-neutral. Google Photos, Instagram, LinkedIn, YouTube, and uploads remain provenance/filter metadata rather than album types.

An `Album` stores its ID, title, `suggested|confirmed|manual` type, cover memory, world anchor, members, date range, optional location, confidence, private visibility, and timestamps. Every member, cover, and anchor must resolve to the local library.

Cover and world-anchor selection are separate:

- **Cover score:** sharpness, exposure, composition, visible-subject quality proxy, uniqueness, and visual appeal.
- **World-anchor score:** wide scene, depth variation, visible ground, open space, stable geometry, low blur, low screenshot/UI likelihood, and limited obstruction.

These scores are deterministic image heuristics, not aesthetic or identity judgments. A close portrait can be the cover while a wider photograph becomes the world anchor. The album UI displays both and allows either choice to be changed.

## Album worlds

`POST /api/albums/:id/world` sends the album's anchor through the existing reconstruction/cache pipeline. The response decorates that one hero `SceneSpec` with an `albumWorld` navigation manifest and related memories. The world does not claim multi-view reconstruction. Related memories are navigated as chronological memory points while the hero geometry stays fixed.

The UI and scene metadata state clearly that depth, scale, occluded surfaces, bodies, and unseen space are inferred and are not metrically accurate recovered geometry.

## Privacy and multiplayer

Albums always default to `private`. Opening or reconstructing an album does not share it. Before the host creates or updates a room, `POST /api/albums/:id/share-preview` validates an explicit subset and displays:

- album title;
- media count;
- each memory guests will see;
- represented source platforms.

The host can remove individual memories. Because the anchor photograph is visibly reconstructed as the room itself, it must remain in the selection; a host can choose a different anchor before excluding it. The validated `sharedMemoryIds` subset travels inside the existing SpacetimeDB scene state with the album/world ID, anchor, current related memory, and navigation list. The existing host-only reducer and scene validation remain authoritative. Guests receive only the selected navigation manifest. Room UI does not infer that photographed people consented, identify them, or claim relationships.

## API additions

- `GET /api/import-jobs`
- `POST /api/library/rescore-3d`
- `GET /api/events`
- `GET /api/albums`
- `POST /api/albums`
- `PATCH /api/albums/:id`
- `POST /api/albums/:id/share-preview`
- `POST /api/albums/:id/world`

## Current limitations and next ingestion path

- The local color-grid embedding is useful for bounded demo batches but is not a semantic foundation model.
- Perceptual thresholds can merge extremely similar intentional edits; provenance remains available for review.
- JSON state is single-process and has no distributed job leasing.
- OAuth sessions are memory-only. Items archived before a restart resume; unarchived Google items may need reselection.
- Album titles are deterministic local suggestions and never bare dates. Gemini reviews folder labels once per batch (≤48 items), never once per photo.
- Album worlds use one reconstructed photograph plus related memory navigation, not true multi-view geometry.

A future large-library path should ingest a user-requested official Google Takeout/export bundle. That path should parse export metadata locally, retain the same consent/provenance/job contracts, and feed the same deduplication pipeline. It must not introduce unrestricted Photos API access or scraping workarounds.
