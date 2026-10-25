# Turning a photograph into a place

The photograph supplies recognizable face and clothing details, material colors, and relative subject positions. Depth Anything V2 estimates relative depth, and Gemini or local DETR separates people and objects. The viewer builds complete human bodies independent of the source crop, including shoulders, arms, hands, pelvis, legs, and shoes on the ground. The anatomy is inferred; it is no longer an extrusion of the photographed silhouette.

Face and torso textures sample separate source regions and blend into the same material color around their sides. Unseen trousers and shoes use a neutral inferred material. Source black-and-white stays black-and-white. Complete bodies have front, side and rear geometry, directional shading and ground contact shadows. A silhouette still guides the appearance sampling and relative layout, but never determines body thickness or chops off a missing limb.

The surroundings use actual proportioned architecture, pavement, curbs, furniture and trees selected from scene hints. Their materials use the source background palette and generated meter-scale surface textures. Portrait scenes have no source-photo billboard, photo-wrapped cylinder, or smeared photographic floor. The background is an imagined setting; it does not recover the precise original street or room. Single-view faces, poses and unseen body parts remain approximations, not photorealistic recovered scans.

## Pipeline and storage

1. `POST /api/memories/:id/scene` loads the selected photo from the local archive. Bundled stock photos may be downloaded from the explicitly allowed sample CDN. Other remote images must first be archived or uploaded.
2. The source is oriented and resized to a maximum dimension of 1600 pixels. The model receives a smaller RGB image, with a maximum dimension of 518 pixels.
3. `@huggingface/transformers` runs `onnx-community/depth-anything-v2-small` on the server, on WebGPU with a CPU fallback on macOS and on the CPU elsewhere by default (`DEPTH_DEVICE`: `auto`, `webgpu` or `cpu`; [measurements](m5-results.md)). The depth stage reports the device it used in its `scene-inference` log line. Its first use downloads the model into `data/models/`; later runs reuse it without network access. No additional service account or inference key is required. Concurrent model requests are serialized to bound CPU and memory use.
4. The server saves a normalized source JPEG, a grayscale depth PNG, and cache metadata under `data/uploads/reconstructions/`. Content hashes distinguish changed source files; changing descriptive metadata can reuse the existing reconstruction. White depth pixels mean near, black means far.
5. World completion requests bounded person/object polygons from Gemini and rasterizes full-image masks. If semantic inference is unavailable, local `Xenova/detr-resnet-50-panoptic` q8 segmentation separates prominent subjects on the CPU. Its input is capped at 384 pixels to bound memory use. Connected regions of near depth are the final fallback. A cached `*-world.json` manifest describes the masks and textures.
6. A bounded image-generation attempt creates a two-panel atlas: the background with subjects removed, and an imagined rear view of those subjects. The original background outside the silhouette masks is preserved. If generation fails, source-color propagation fills hidden background and material colors supply the rear surfaces. The attempt marker prevents repeated paid generation on reopen.
7. The browser analyzes each person mask at up to 1200 pixels for separate head and central shirt regions. It samples dominant shirt, skin and hair colors while excluding background and other people. Head centers determine group ordering; relative depth changes the spacing between bodies without stretching their anatomy. Complete smooth human meshes are built once, with source details on curved head and shirt surfaces. The depth slider updates placement rather than body proportions.
8. Recognized everyday objects use complete meshes with source-image details, colors and silhouette proportions. A separate local OWLv2 → Grounding DINO → SlimSAM recognition pass supports laptops, desktop computers, phones, drink cans, chip bags, water bottles, boxes and backpacks, independently of Gemini quotas. Other non-person subjects retain the closed, smoothed depth-volume path. Landscape scenes retain a source depth surface. The point-cloud control shows the original learned-depth projection as a diagnostic; it is not the completed anatomy. See [video and memory objects](video-and-memory-objects.md).
9. A photographic environment builder projects the cleaned high-resolution background onto floors, walls, storefronts and tree geometry. An optional 2:1 panorama supplies directions outside the photographed view. Photo materials retain baked exposure and source RGB, avoiding a second lighting tint. These surfaces provide parallax and collision, but their dimensions are still inferred.

## Photographic people and the Memento reference

The October 24 update uses the original mask to fit rounded head silhouettes and projects the original face pixels onto the observed side. It retains entire garment regions, rather than enlarging a central shirt crop. Optional full-length front/back atlases supply inferred trousers, shoes, backs and unseen head surfaces; the original observed head and clothing take precedence. Both imported Instagram memories include these atlases and a generated panorama. New uploads still receive the general photo-fitting renderer, but these curated atlases are not automatically generated for every upload.

`scripts/import-photographic-world.ts` imports unchanged PNG assets with explicitly reviewed subject crops. Optional `bodyAtlasUrl`, `bodyFrontBox`, and `bodyBackBox` must occur together on a person, and pass the same local-path and bounded-data validation as other completion assets. It saves the previous manifest before applying a revision. Exact imagegen prompts and paths are in [photographic texture provenance](photographic-texture-prompts.md).

The supplied Memento process illustrates a different, stronger source of fidelity: multiple video frames constrain the same visible surfaces. Its sequence is video frames → camera poses/sparse points → Gaussian splat optimization → interactive playback. [OpenSplat](https://github.com/WebODM/OpenSplat) consumes posed image reconstructions and trains splats; [Spark](https://sparkjs.dev/docs/overview/) can render splats inside Three.js and WebXR.

That multi-view pipeline is **not implemented in this revision**. The current video path samples depth across the clip without recovering camera poses or training splats. A generated panorama or photographic body atlas is not a trained Gaussian reconstruction. For a future multi-view path, recover camera poses with COLMAP (optionally a learned matcher), train/export a splat artifact, and load it alongside the existing room navigation and shared participant poses. Moving people need explicit motion handling; ordinary static-scene reconstruction alone does not solve them. Unseen surfaces still require inference even with video unless the capture actually sees them.

The original media remains in the archive. For a locally archived video, FFmpeg/FFprobe extract 2–8 timestamped frames across the clip and the result is marked `mediaBasis: "video-sequence"`. Playback continuously updates the original video texture while depth interpolates between similar samples or switches across large changes. Recognized props use complete meshes and remain locked during playback and pause. Moving people remain part of the sampled depth surface; complete animated bodies and unseen surfaces are not recovered. This is sampled 2.5D video. `FFMPEG_PATH` and `FFPROBE_PATH` can select server executables. If extraction or learned depth estimation fails, the API returns an error instead of substituting brightness-based geometry.

The source model describes its outputs as relative depth estimates. Its Small variant has 24.8 million parameters and uses Apache-2.0; the larger variants have different licenses. See the [official Depth Anything V2 repository](https://github.com/DepthAnything/Depth-Anything-V2) and the [ONNX conversion used by this app](https://huggingface.co/onnx-community/depth-anything-v2-small).

## Gemini's role

Gemini provides semantic search, visible-content descriptions, source-grounded atmosphere, and bounded foreground silhouettes. Dense depth, complete body geometry and environment construction run separately. Google's documented image-understanding API includes bounding boxes and segmentation; these guide object separation. [Gemini image understanding](https://ai.google.dev/gemini-api/docs/image-understanding).

Gemini image generation supplies optional inferred background and rear textures. Its bitmap output is applied to the explicit geometry; it does not replace that geometry. `generatedBy` records silhouette provenance, while `textureSource` distinguishes generated textures from local source-color inpainting. [Gemini image generation](https://ai.google.dev/gemini-api/docs/image-generation).

The previous closed-volume version generated background/rear atlases for the two imported Instagram memories. For those assets, the configured Gemini image API returned HTTP 429. Built-in imagegen supplied the inferred background and rear atlases instead. Their prompts, saved paths, and import process are documented in [generated textures](generated-textures.md). New photos use the configured Gemini image API when available and source-color inpainting otherwise. Local DETR separated the color photo into three foreground people; Gemini supplied four silhouettes for the monochrome photo.

All model output is treated as bounded data. Masks and generated textures stay in the local archive, and shared descriptors accept only local reconstruction asset paths. The model never supplies executable scene code. Depth remains the output of the local depth model.

Completion assets are revalidated on reopen, including in browsers that cached an earlier reconstruction. This lets corrected silhouettes and regenerated textures replace their previous versions without requiring a cache purge. The original archived photograph is unchanged.

## Shared scene contract

`SceneSpec.reconstruction` is optional for compatibility with older room payloads. New reconstructed scenes carry this compact descriptor:

```json
{
  "version": 1,
  "kind": "depth-mesh",
  "sourceUrl": "/uploads/reconstructions/<content-hash>-source.jpg",
  "depthUrl": "/uploads/reconstructions/<content-hash>-depth.png",
  "width": 1200,
  "height": 800,
  "depthSource": "depth-anything-v2",
  "near": 2,
  "far": 12,
  "fov": 60,
  "mediaBasis": "image",
  "completionUrl": "/uploads/reconstructions/<content-hash>-world.json"
}
```

SpacetimeDB synchronizes the descriptor and participant poses. It does not store original image bytes, model weights, API keys, or the dense mesh. Every participant downloads the same source/depth and completion assets from the shared app backend and creates the same deterministic bodies and surroundings locally. The full-body update changes rendering only; the shared descriptor and database schema are unchanged. Devices must use the same reachable app origin; a laptop's `localhost` is not the phone's or headset's `localhost`.

The browser and module share `src/reconstruction-validation.ts`. It permits relative `/uploads/` paths only, with no queries, credentials, traversal, embedded images, or extra descriptor fields. Dimensions must be integers from 16 to 8192, near must be 0.1–10, far must exceed near and be at most 100, and field of view must be 20–100 degrees. The entire room scene remains limited to 32,000 string characters. The module update changes validation only and keeps the existing tables and reducers.

## Verification

The automated multiplayer tests cover reconstruction metadata round trips, rejected remote/traversal paths, rejected oversized and non-finite geometry parameters, and preservation of the previous room state after invalid input. The live Maincloud smoke test also checks reconstruction synchronization between independent clients and server-side rejection of an untrusted depth URL, alongside room isolation, host authority, pose synchronization, and host handoff. The validation-only update was published with `--delete-data=never` on October 24, 2026.

```powershell
npm exec -- tsx --test src/multiplayer/client.test.ts
npm run test:multiplayer
npm run test:live
```

For visual acceptance, compare a source-facing and an oblique view of the same reconstruction. A recognizable foreground object should move relative to the distant background, and point mode should expose depth rather than a flat rectangle. Test a portrait and landscape photo, change memories, inspect errors and retries, and join the same scene on a second device. Inspect the browser console for shader compilation or texture-loading errors. Physical Meta Quest testing must verify stereo depth, comfortable initial position, controls, and frame rate in a secure WebXR context; desktop inspection alone cannot establish those results.
