# Again

Search your life. Step inside a memory. Bring someone with you.

A working browser prototype for desktop, phone, and Meta Quest, built from the direction in [the shared planning conversation](https://chatgpt.com/share/6adc7ba7-98bc-83ea-a110-b727500aee72). The core is a searchable personal memoir, with photographs reconstructed into shared 3D worlds.

## Run

Requires Node.js 22+.

This repository contains the application, tests, and reconstruction scripts.
Keep `.env` local and untracked; use `.env.example` as the configuration
template. Imported photographs/videos, generated reconstructions, and model
caches are excluded from Git. A fresh clone starts with the sample library.

```powershell
npm install
# Copy .env.example to a local .env and add only the providers you use.
npm run dev
```

Open http://localhost:5173. For another laptop or phone on the same Wi-Fi, use the Network URL printed by Vite. Every participant must use the same running API/media server. Enter a memory, choose **Remember together**, start a room, and share the invitation. Guests can join using the code even if their server hostname differs.

API keys are read only by the server from a local `.env`; browser bundles do not include them. Never commit that file. Google OAuth requires its own client configuration. `.env.example` documents the available settings.

## What works

- Photos and videos can be uploaded or explicitly selected with Google Photos Picker. Durable jobs archive, hash, locally embed, deduplicate, and group bounded batches without a Gemini call per image. Video metadata is editable. Uploads and the catalog persist under ignored `data/`.
- Explainable derived events create private suggested albums. Cover and world-anchor ranking are separate; a single anchor uses the existing reconstruction cache while related memories remain navigable inside the album world.
- Natural language search uses Gemini, with an explicitly labeled keyword fallback during provider errors.
- A timeline and editable chapters preserve source links to the original memories.
- Depth Anything V2 estimates depth locally. Gemini separates people and objects into silhouettes, with local DETR segmentation available during provider outages. People receive complete bodies with original face/clothing pixels on observed surfaces. Reviewed subjects use authored anatomical templates; the fallback fits procedural heads to photographed outlines. Both imported Instagram memories also have photographic full-body atlases for unseen clothing, sides, backs and legs, plus 360° surroundings. Source colors are preserved, including monochrome sources. Other foreground objects retain depth-based closed volumes. These are inferred bodies and surroundings, not measured scans.
- The viewer starts in **Walk** mode: drag to look, use WASD/arrow keys or hold the on-screen movement buttons. **Front**, **Side**, and **Behind** move to useful viewpoints. **Inspect** provides orbit controls; depth and point-cloud controls expose the geometry.
- Bodies cast filtered, shape-matched shadows onto the photographic floor and sidewalks. Transparent shadow receivers preserve the underlying photo colors, with subtle contact darkening beneath the feet. Shadows follow the selected body mesh and depth placement.
- The five visible faces in the reviewed color/monochrome memories now use local facial landmarks for pitch, yaw, roll and source-image registration. The whole jaw rotates rigidly, with small bounded adjustments to facial proportions and UV placement. Unseen facial texture is inferred by bilateral reflection; original colors remain unchanged. This is an offline fit for the reviewed people, not an automatic face scan for every upload. See [face fitting](scripts/face-fitting/README.md).
- Reviewed human templates can use MakeHuman's authored anatomy and clothing, with separate slender, average, and broader meshes. The viewer's **Body shape** control compares them in place; **Photo fit** restores the per-person default. Source-photo details and inferred front/back references are baked into UV textures, with reviewed head direction and visibility checks. These are approximate fitted bodies, not scans of the photographed people. See [template preparation](scripts/body-templates/README.md) and [import instructions](docs/neural-reconstruction.md).
- Optional neural bodies use real pretrained TripoSR geometry, computed locally on CPU and imported as self-contained GLBs. The same image mapper checks surface visibility and aligns inferred front/back references to each body. Reconstruction and template preparation run offline; opening a memory does not start a new 3D model run. See [the reproducible CPU runner](scripts/neural/README.md).
- Reconstruction assets and the model download are cached under `data/`. The first scene downloads the depth model; subsequent scenes reuse it. `npm run reconstruct` warms the whole library. Videos use 2–8 depth samples across the clip and require FFmpeg/FFprobe on PATH (or `FFMPEG_PATH`/`FFPROBE_PATH`).
- SpacetimeDB owns room membership, private subscriptions, host-controlled memory selection, album share manifests, poses, and host handoff. Albums stay private until the host reviews and selects the memories included in a room.
- Instagram imports use Apify. The initial requested import found two accessible posts from `_ryan_ding`; these are distinct from the six labeled sample memories.
- Google OAuth + Photos Picker flow is implemented with a configurable 50–2,000 item selection limit, defaulting to 2,000. It needs your own OAuth client ID/secret and Google consent before it can run. Google Photos does not permit automatic “latest photos” access, API-key access, or unrestricted whole-library search.
- LinkedIn imports are configurable with a compatible Apify actor; no LinkedIn actor/profile has been supplied or tested.

## Video immersion and everyday objects

Videos use depth samples across the clip, with playback, pause, sound and scrubbing inside the 3D view. Common-object detection runs locally with OWLv2, Grounding DINO and SlimSAM, independently of Gemini quotas. Computers, phones, cans, chip bags, bottles, boxes and backpacks become solid models fitted to the observed silhouettes, with original visible colors and image details. Photo props can be picked up with a Quest grip or moved with the desktop **Move objects** control. Video props remain locked. See [behavior, setup and current limits](docs/video-and-memory-objects.md) and the [actual Carriage photo/video evaluation](docs/object-detection-evaluation.md).

## Meta Quest

Quest Browser supports the scene's **Enter VR** control when WebXR is available in a secure context. A plain `http://192.168...`/LAN address can show the desktop scene but cannot start immersive VR.

Use the **Meta VR CLI (`metavr`)** deployment workflow. Connect Quest with a USB data cable, enable Developer Mode, and accept its USB debugging prompt. The launcher finds a native `~/.metavr/bin/metavr` install automatically, or uses `metavr` on PATH; `METAVR_BIN` can specify another executable. [Install Meta VR CLI](https://developers.meta.com/vr/essentials/metavr-install/).

```powershell
npm run vr:devices
npm run vr:check
npm run vr:deploy
```

`vr:deploy` builds the current application, verifies that the app and API are running on port **3001**, forwards that port using `metavr adb reverse`, and opens **http://localhost:3001/** in Quest Browser. Keep the backend running with `npm start` in another terminal (an existing `npm run dev` backend works too). For live source changes with Vite already running, use **`npm run vr:dev`** instead; it forwards port **5173**, including the API, uploads, and WebSocket proxy. The deployment command leaves existing servers running and does not upload the memory library to a hosting service.

With multiple headsets, select one explicitly: `npm run vr:deploy -- --device <ID>`. `npm run vr:check -- --port 5173` checks the development server without changing the headset. Missing/unauthorized devices and a stopped server produce actionable errors. Re-run deployment after reconnecting the USB cable.

In Quest Browser, join the room by code, open a memory, choose **Step inside**, then **ENTER VR**. Immersive entry requires your click inside the headset. On laptop/phone, use the normal server URL and the same room code. The left thumbstick walks, the right thumbstick turns, and controller trigger teleports to the ground. Tracked head poses synchronize to other participants. This uses Meta's documented [local Browser port-forwarding workflow](https://developers.meta.com/vr/documentation/web/browser-remote-debugging/); the [localhost exception for WebXR](https://developers.meta.com/vr/documentation/web/port-vr-xr/) avoids an insecure LAN origin.

For wireless VR, serve the app through HTTPS with a certificate trusted by the headset. Vite accepts `TLS_CERT` and `TLS_KEY`; otherwise deploy the built app behind an authenticated HTTPS reverse proxy. Never bypass certificate warnings. Physical Quest hardware testing remains outstanding.

## Verification

```powershell
npm run typecheck
npm test
npm run build
npm --prefix spacetimedb ci
npm --prefix spacetimedb test
```

The tests cover persistence, upload validation, chapters, OAuth state, origins, reconstruction caching and failures, pixel projection, foreground separation, silhouette boundaries, and room synchronization. SpacetimeDB tests cover isolated rooms, authority, reconstruction validation, and lifecycle. `src/multiplayer/live-smoke.ts` is an opt-in integration test that creates temporary rooms against Maincloud and removes them on completion.

## Scope and next work

This is a trusted-device, single-library prototype: API access is shared across devices that can reach the server, while SpacetimeDB rooms use private membership. Before exposing the media API to the Internet, add user authentication, per-memory authorization, durable object storage, and session-aware API rate limits. Voice chat, spatial story annotations, complete 360-degree surface recovery, Factory runtime agents, and personality simulation are not implemented.

The supplied Memento process informs the next reconstruction direction: video frames, recovered camera poses, then trained Gaussian splats. That multi-view pipeline is not yet implemented here; video currently supplies one reconstruction frame. See [the reconstruction comparison](docs/reconstruction.md#photographic-people-and-the-memento-reference) and [generated asset provenance](docs/photographic-texture-prompts.md).

The prototype does not silently publish a public feed. Its shared room codes are private invitations, and rooms expire when the last participant leaves. Google OAuth grants remain in server memory; reconnect after restarting.

See [the album/import architecture](docs/albums-and-import-pipeline.md), [property-based test strategy](docs/property-testing.md), [reconstruction details](docs/reconstruction.md), [integration setup](docs/integrations.md), [multiplayer details](docs/spacetimedb.md), and [acceptance checklist](docs/acceptance.md).
