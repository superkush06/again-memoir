# Integrations and API

This prototype keeps uploaded media and metadata on the computer running the server. `data/memories.json`, `data/library-state.json`, `data/chapters.json`, and `data/uploads/` form the archive. Back up this directory. The six sample memories are fictional examples using stock photos, not the user's actual history. The server is intended for a trusted local demo; add accounts, authorization, encrypted token storage, quota controls, and a durable database before hosting a private archive on the public internet.

## Gemini

Set `GEMINI_API_KEY` in the server environment. `GEMINI_MODEL` defaults to `gemini-3.5-flash`. Never use a `VITE_` variable for a secret. Batch imports use deterministic local embeddings rather than sending every photo to Gemini. The explicit per-memory Analyze action can send one archived JPEG, PNG, or WebP (up to 15 MB) for a visible-content description and tags. Dates and identities are not invented; add those details yourself.

Search sends the current memory metadata, including descriptions, to Gemini for ranked matching. It validates returned IDs against the local library. If Gemini fails, the response explicitly reports `mode: "keyword"` and uses local token matching with a small synonym dictionary. Scene generation requests a structured atmosphere specification, and can include uploaded image bytes. A separate local Depth Anything V2 model estimates dense relative depth; the browser projects the original pixels into a textured 3D mesh with an extrapolated surround. This is a single-view reconstruction, with inferred surfaces and unknown occluded regions. See [photo reconstruction](reconstruction.md) for the pipeline, cache, limits, and shared geometry contract. Colors and labels are validated before use. [Gemini structured output documentation](https://ai.google.dev/gemini-api/docs/structured-output) describes the schema support.

## Google Photos

Google Photos cannot be connected with just an API key. Create a Google Cloud OAuth web application, enable the Photos Picker API, configure the consent screen and a test user, and set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GOOGLE_REDIRECT_URI`. For local development the callback defaults to `${APP_ORIGIN}/api/integrations/google/callback` (normally `http://localhost:5173/api/integrations/google/callback`); register that exact URI with Google. If you run the web app on another port, set both `APP_ORIGIN` and `GOOGLE_REDIRECT_URI` to that web origin, for example `http://localhost:5174/api/integrations/google/callback`. Use your actual HTTPS origins in deployment.

The app uses the `photospicker.mediaitems.readonly` scope. The user signs in, opens a Picker session, and selects media. The server imports only that selection. Imported files are downloaded into the archive because Picker media URLs expire. Access and refresh tokens remain in server memory, associated with an HttpOnly cookie; restarting the server requires reconnecting. Disconnect clears the local connection; account-level grant revocation is available in Google Account settings. See [Google's web OAuth guide](https://developers.google.com/identity/protocols/oauth2/web-server), [Picker session guide](https://developers.google.com/photos/picker/guides/sessions), and [media retrieval guide](https://developers.google.com/photos/picker/guides/media-items).

Routes:

- `GET /api/integrations/google/auth-url` returns `{url}` and establishes a browser session.
- `POST /api/integrations/google/picker` returns `{id,pickerUri,pollingConfig,...}`. Open `pickerUri` in a new tab.
- `GET /api/integrations/google/picker/:sessionId` returns `mediaItemsSet` and polling guidance. Respect Google's polling interval and deadline.
- `POST /api/integrations/google/picker` accepts a `maxItemCount` from 1–2,000. The UI defaults to Google's maximum of 2,000 and offers 50, 200, 500, and 2,000-item presets in Settings.
- `POST /api/integrations/google/picker/:sessionId/import` records a durable job and returns HTTP 202 with `{jobId,job}`. Selected items are retrieved in pages of 100; each item is limited to 50 MB. Poll `GET /api/import-jobs` for archive, hash, embedding, grouping, duplicate, failure, and ready counts.
- `POST /api/integrations/google/disconnect` clears the browser's server-side tokens.

Search runs over imported memories. Google does not let Picker clients sort, preselect, or silently retrieve the latest items. Since March 31, 2025, the Library API only lists media created by the requesting app. Again therefore cannot implement an automatic “latest 2,000” import: the user must approve every item in Google's Picker.

## Instagram and LinkedIn with Apify

Set `APIFY_TOKEN` on the server. Import runs only after an explicit request with a profile/channel URL, two explicit confirmations (ownership/permission and authorization to retrieve/archive), and a configured actor. Connecting a token alone starts no actor. Instagram defaults to `apify/instagram-scraper`; LinkedIn and YouTube require configured actors plus JSON input templates using `{{profileUrl}}` and `{{limit}}`. The request uses a bounded result limit and a maximum charge of $1 per run by default. Default import size is six posts; the API caps it at twenty. See the [actor input schema](https://apify.com/apify/instagram-scraper/input-schema) and [Apify synchronous run endpoint](https://docs.apify.com/api/v2/actor-run-sync-get-dataset-items-post).

`POST /api/integrations/apify/import` accepts the source URL plus `confirmOwnership:true` and `confirmConsent:true`, and returns `{memories,imported,skipped,warnings}`. The server records a local consent ID with the source URL and statement, but never asks for or stores a social password. Reimporting the same post deduplicates by source ID. Media is archived only from an audited provider CDN allowlist; redirects, DNS, size, and file signatures are validated. Imported memories retain source URL, source account, import time, and consent ID. The local organizer adds explainable month/location/source grouping metadata and normalized tags. `POST /api/integrations/apify/archive` retries archiving existing remote imports without starting another paid scrape.

LinkedIn actors differ in their schemas. Set `APIFY_LINKEDIN_ACTOR` and `APIFY_LINKEDIN_INPUT_TEMPLATE` to an input object compatible with the selected actor, using `{{profileUrl}}` and `{{limit}}` placeholders. Import with `source:"linkedin"`. The adapter accepts common output fields (`imageUrl`, `images[0]`, `videoUrl`, `text`, `description`, `publishedAt`) and skips posts without media. Select an actor suitable for the account and data you are authorized to import. The app does not request or store social platform passwords.

## Shared Google Photos albums with our Apify Actor

Google's Picker only opens the signed-in user's own library, so albums other people share by link (an event's community album, a friend's trip) use our own Actor in [`actors/google-photos-album`](../actors/google-photos-album/README.md), built with the Apify SDK. Deploy it with `npx apify-cli push` from that folder and set `APIFY_GOOGLE_PHOTOS_ACTOR=<username>/google-photos-shared-album`. The server runs it through `apify-client` (`server/apify.ts`), waits for the run, and reads its dataset.

`POST /api/integrations/apify/google-photos-album` accepts `{albumUrl, limit, confirmConsent:true}` for `https://photos.app.goo.gl/…` or `https://photos.google.com/share/…` links only, records a consent, and imports through the same plan → archive pipeline as other sources. Photos keep their capture time, the album link as `sourceUrl`, and `Shared album: <title>` as `sourceAccount`; reimports deduplicate by the photo's media key, and burst shots are deduplicated by the library like any upload. A photo whose download fails is not kept by link: the job marks it retryable and importing the album again retries it. Media is archived only from `googleusercontent.com`. Default import size is twelve photos; the API caps it at fifty. Account-switcher links (`photos.google.com/u/1/share/…`) are normalized, and the Actor reads past an album's first page.

## Core API

- `GET /api/health`: server and integration setup status, never secrets.
- `GET /api/memories`: `{memories}`.
- `POST /api/search`: `{query}` to `{memories,mode,explanation}`.
- `POST /api/upload`: multipart field `files`, up to eight files, 50 MB each and 100 MB total. Optional fields: `title`, `description`, `date`, `location`, comma-separated `tags`. Returns saved memories and per-file analysis status. Media signatures are checked; SVG and HTML are rejected.
- `PATCH /api/memories/:id`: edit the searchable title, description, date, location, or tags.
- `POST /api/memories/:id/scene`: validated `SceneSpec`, using Gemini or labeled local presets.
- `POST /api/memories/:id/analyze`: retry Gemini description for an already archived local photo, without uploading again or starting an Apify run. Returns `{memory,status,analyzed}`. It preserves the title, date, location, and caption while refreshing the generated visual description and merging tags. Temporary provider failures keep the original memory unchanged; health includes a sanitized `gemini.lastOperation` diagnostic.
- `GET /api/chapters`: `{chapters}`.
- `POST /api/chapters`: create or update `{id?,title,body,memoryIds}`. All memory links must resolve. Chapter text remains editable and stored locally.

## Local multiplayer fallback

The local `/ws` transport is available for development independently of the SpacetimeDB integration. One server process holds rooms in memory. Restarting the server ends rooms; the media archive persists. Room codes are six uppercase characters, with up to twelve participants. Only the host changes the shared memory, and the next participant becomes host if the host disconnects. Poses are transient and are relayed at up to roughly twenty updates per second.

Client messages: `{type:"create",name,device}`, `{type:"join",code,name,device}`, `{type:"leave"}`, `{type:"select",memoryId}`, `{type:"pose",pose:{position:[x,y,z],rotation:[x,y,z,w]}}`, and `{type:"device",device}`. Devices are `desktop`, `mobile`, or `vr`. The server sends `{type:"welcome",clientId}`, `{type:"room",room}`, `{type:"pose",clientId,pose}`, `{type:"left"}`, and `{type:"error",message}`. `room` matches the shared `RoomSnapshot` TypeScript interface.

For a phone or Meta Quest, use the same reachable server origin. Browser WebXR requires a secure context; `http://localhost` only works on the device running the browser. Use a trusted HTTPS deployment or tunnel for the Quest, or USB development forwarding. Merely opening an HTTP LAN address does not enable immersive VR. These rooms synchronize selection and participant presence; they are not a full avatar or voice-chat service.
