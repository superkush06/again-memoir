# Prototype acceptance

The first complete journey is: import → search → open original → enter 3D → invite → join from another client → see shared selection and presence → save a source-linked chapter.

| Check | Evidence / expected behavior |
|---|---|
| No fabricated memories | Search returns existing catalog IDs only; samples are labeled. |
| Original preserved | Image/video remains available in detail view and within the scene. |
| Actual 3D geometry | People have complete heads, torsos, arms, hands, legs and grounded feet. Other subjects use learned-depth volumes; point mode reveals the original depth projection. |
| Honest extrapolation | Complete anatomy, unseen clothing, poses and surroundings are inferred. Faces remain approximations and the result is not claimed as a recovered scan. |
| Walk around subjects | Walk mode supports keyboard and held touch controls. Front, Side, and Behind presets expose complete bodies. Buildings and columns block walking and teleportation. Movement stays inside the surrounding environment. |
| Retained color | Curved face and shirt surfaces retain source detail; material colors continue around bodies. Inferred surroundings use the source palette. Monochrome remains monochrome. |
| Provider failure | Search labels keyword fallback. Depth-model failure reports an actionable error; it never substitutes invented geometry. Gemini atmosphere failure does not prevent local reconstruction. |
| Persistence | Uploaded media, metadata, and chapter edits survive API restart. |
| Live rooms | Multiple independent Maincloud identities share memory selection and poses. |
| Private room membership | A nonmember cannot read room data or change its scene. |
| Host authority | Guests cannot select the shared memory; departing host hands control to another member. |
| Stable navigation | Pose updates do not close original-media dialogs or pull users back into the scene. |
| Google Photos | Missing OAuth configuration produces an actionable setup message. Picker imports require explicit selection. |
| Credentials | Provider keys are read server-side from the shared `.env` in this private repository; browser bundles exclude them. |
| Quest | Requires a physical headset check on a secure origin; desktop browser cannot verify immersive input. |

Architecture: React/Vite → Express API → local media/catalog + Gemini/Google/Apify. Depth Anything V2 runs locally through ONNX and caches source images plus depth maps. Gemini silhouettes or local DETR segmentation guide appearance sampling for complete bodies and depth volumes for other objects. React → SpacetimeDB subscriptions/reducers for authoritative live room state and validated reconstruction descriptors. Three.js deprojects depth into textured geometry and owns navigation and WebXR input.

This acceptance scope is a hackathon prototype, not a production readiness certification. Live browser and provider checks are recorded in the implementation handoff; automated checks are runnable with the commands in README.md.

## Verified on October 24, 2026

- API/client/geometry tests cover reconstruction caching, inference failures, projection, discontinuities, and shared metadata. SpacetimeDB module tests also validate bounded reconstruction descriptors.
- Maincloud was exercised with three independent identities, including unauthorized scene changes and host handoff; temporary test rooms were cleaned up.
- Two browser clients joined a room through the actual interface and opened the same memory. Overlapping initial avatar positions no longer obscure the camera.
- Gemini semantic search returned the coastal sample for “Summers by the ocean.” A scene request returned `generatedBy: gemini`; both imported Instagram images received visual descriptions. Transient HTTP 503s also verified the labeled fallback path.
- Two Instagram posts from the requested profile were imported and archived locally. A sample chapter was saved through the interface with its original source link.
- Google OAuth and LinkedIn remain configuration-dependent. Physical phone/Quest operation, headset controls, and wireless HTTPS are not hardware-verified.
- Actual learned-depth inference ran successfully for all eight library images, including both imported Instagram posts. A generated local video also passed first-frame extraction and depth inference.
- Reconstruction update: production build passed; 22 API/client/geometry tests and four SpacetimeDB module tests passed. Browser orbit, depth slider, point mode, and both Instagram reconstructions rendered without console errors. Two independent browser origins joined the same room and followed a host switch between the reconstructed images; the temporary room was cleaned up. Screenshots are saved locally under `.local/reconstructed-memory.png`, `.local/reconstructed-points.png`, and `.local/shared-reconstruction.png`.
- Walkable-world update: 44 app tests and four SpacetimeDB module tests pass. Production build passes. The suite covers watertight foreground volumes, retained source colors, bounded depth, walking boundaries, silhouette axes, actual Sharp mask blending, rear texture alignment and its ambiguity fallback, cached completion assets, and multiplayer completion descriptors. The live three-client Maincloud check passed with the completion manifest URL.
- Browser checks verified both imported photos from the front, side, and rear; held movement controls, orbit inspection, depth adjustment, and point mode worked without rendering errors. The color photo has three separate closed subjects with aligned generated rear textures. The monochrome photo has four closed subjects and retains its original generated rear texture when correspondence is ambiguous. Final preview: `.local/walkable-memory-rear.png`.


## Complete-body update

- Replaced person silhouette extrusions with complete anatomical meshes, including cropped-out legs, feet, hands and inferred rear surfaces. Separate high-resolution face and shirt crops preserve source detail; sampled clothing, skin and hair colors continue around the body. The body dimensions remain stable across depth adjustments.
- Replaced the stretched photo cylinder, floor and sky with proportioned street/interior/landscape geometry. Meter-scale material textures retain background hues, with brightness compensation for dark photographed materials. Architecture has collision bounds.
- Production build and 65 app tests passed, followed by the additional all-around head visibility regression (all five body tests pass). Tests cover complete grounded anatomy, front/rear ray intersections, finite geometry, source RGB retention, grayscale preservation, source back views, placement, environmental texture scale and building collisions.
- Browser verification covered front/side/rear views of both imported photos, held walking controls, orbit inspection, maximum depth, switching to the original diagnostic point cloud, switching memories, and returning to Walk mode. No rendering warnings/errors were recorded.
- Saved previews: `.local/fullbody-front.png`, `.local/fullbody-side.png`, `.local/fullbody-behind.png`, `.local/fullbody-monochrome.png` and `.local/fullbody-world-final.png`.
- This update is a complete procedural 3D interpretation with inferred anatomy and surroundings. It is visibly stylized; it does not recover photorealistic hidden identities, clothing or the precise original room/street. Physical Quest performance and controls remain unverified.

## Photographic detail update

- Rounded head outlines now follow source silhouettes, without generic hair caps or face geometry obscuring the original pixels. Whole-garment projection retains graphic placement, collars, and original RGB; skin pixels within person masks are excluded from clothing surfaces.
- Both imported memories include reviewed full-length front/back atlases and 2:1 environment panoramas. Complete bodies, hands, legs and rear surfaces remain. The source photograph takes precedence on observed heads and clothing. Atlas data are optional and validated as local raster paths with finite bounded crops.
- Surroundings use photographic materials on walkable geometry. The clean indoor panorama avoids duplicate background people; floor detail repeats at ordinary scale rather than projecting the whole room across the ground. Invented foreground tree branches and intrusive storefront geometry were removed after walkthrough inspection.
- All 84 app tests pass, including source RGB retention, source-shaped closed heads, body atlas coverage, skin-to-shirt bleed prevention and strict completion validation. The final floor revision also passes all seven environment tests. Production TypeScript/Vite build passes; Vite reports its existing large Three.js chunk advisory.
- Browser verification covered source-facing, side and rear views of both imported memories, held walking controls, depth adjustment, diagnostic point mode and switching between memories. No shader or texture-loading errors were observed. Phone-width layout was inspected in the desktop browser; physical phone/Quest hardware remains unverified.
- Previews: `.local/photographic-color-front.png`, `.local/photographic-color-side.png`, `.local/photographic-color-rear.png`, `.local/photographic-monochrome-world.png`, and `.local/photographic-monochrome-rear.png`. Assets and exact prompts are documented in `docs/photographic-texture-prompts.md`.
- These images remain single-photo interpretations with approximate anatomy and inferred unseen surfaces. The supplied Memento video → camera poses → Gaussian splat pipeline is a documented future direction, not a feature claimed by this update.

## Pretrained geometry and visibility-aware mapping update

- Ran the official pretrained TripoSR transformer/triplane model locally on CPU for all three people in the color Instagram memory. The reviewed 256-grid GLBs contain 55,748 vertices and 111,500 triangles combined. These learned meshes now replace that memory's procedural people; the monochrome memory retains its complete-body fallback with improved projection.
- Preserved source RGB by baking the inferred front/back atlases onto the learned silhouettes, then fitting original head and clothing crops with real mesh occlusion checks. Skin/shirt guards prevent clothing pixels from covering bare arms. Back-view sources project onto the back. These operations do not change the learned geometry or claim to recover PBR materials.
- The first 128-grid trial took 145 seconds; a denser extraction from its saved triplane took 92.8 seconds. Additional 256-grid people took 138.0 and 143.5 seconds. Raw model textures had white mottling, so the accepted appearance uses the photographic bake. Original photographs and earlier manifests remain available.
- All 102 app tests and the TypeScript/Vite production build pass. GLTF loading is lazy; Vite retains its large Three.js bundle advisory. Tests cover actual triangle occlusion, cropped-source fitting, skin boundaries, original/grayscale color retention, bounded model validation, resource disposal, and reversible imports.
- Browser checks covered front/side/rear views, walking, maximum depth, point mode and restoring solid bodies. The monochrome memory still opens and remains monochrome. The final browser error/warning log was empty. Previews: `.local/neural-three-front.png`, `.local/neural-three-side.png`, `.local/neural-world-final.png`, and `.local/mapping-v3-monochrome-front.png`.
- Faces, fingers, side textures and unseen poses remain approximate. The environment remains the existing extrapolated photo environment; this update does not claim a measured scene scan, SDS optimization, Gaussian splat training, or physical Quest verification. The CPU runner and model tradeoffs are documented in `scripts/neural/README.md` and `docs/neural-reconstruction.md`.

## Authored human anatomy update

- Downloaded and fitted MakeHuman CC0 anatomical geometry, authored morphology targets, skin weights, shirt, trousers, shoes, eyes and short hair. Three moderate slender/average/broader meshes use actual authored targets, with relaxed arms and individual hands/fingers. Covered skin was removed beneath garments to eliminate intersections. Base files contain approximately 17,300 vertices and 28,900 triangles each.
- All three people in the color memory now use these authored bodies, replacing the distorted TripoSR anatomy. Two retain accepted hair-only caps from their learned reconstructions. The three main people in the monochrome memory also use authored bodies; the partial long-jacket subject keeps its previous clothed fallback. Earlier manifests are backed up by the importer.
- The Body shape selector compares complete meshes while retaining the viewing position; Photo fit restores each person's reviewed default. Loading, stale requests, failed imports and scene cleanup are covered by tests. Room participants receive the same reviewed defaults; manual comparisons are local.
- Original head and neck crops are reviewed separately from the full-body references. UV texture baking preserves per-pixel face/clothing detail and source colors, while excluding atlas faces from necks. Head pivot/chin coordinates follow loader normalization. Source palettes keep unobserved surfaces monochrome when appropriate. The actual three-person color fit took approximately 15 seconds total in the local Node smoke; browser timings vary. Browser work yields through posted tasks to avoid background timer clamping.
- All 114 app tests passed. The final scheduling adjustment also passed all 14 photo-fitting/projection tests. The TypeScript/Vite production build passes, with the existing Three.js chunk-size advisory. Hardware Quest verification remains outstanding.
- Browser checks covered all three body choices, preserving the camera during a swap, walking, source-facing/side/rear views, depth changes, and diagnostic point mode. Both imported memories rendered; the second remains grayscale. No browser rendering warnings or errors were reported. Review images are `.local/anatomical-color-front.png`, `.local/anatomical-color-side.png`, `.local/anatomical-color-rear.png`, and `.local/anatomical-monochrome-front.png`.
- These are fitted anatomical templates with inferred clothes, poses and unseen surfaces. They improve body proportions but do not recover exact individual anatomy, facial identity from every angle, or photorealistic missing views. Sources and repeatable preparation are in `scripts/body-templates/README.md` and `scripts/body-hair/README.md`.

## Body ground shadows

- Added transparent shadow receivers over the photographic floor and raised sidewalks. Body silhouettes come from the actual 3D meshes and the directional shadow map, with 2048-pixel PCF filtering and lower-opacity contact shadows. Original body/photo materials retain their captured colors; this adds cast ground shadows, not recovered physical lighting or self-shadowing to the unlit photographic skin.
- Reconstructed architecture no longer casts its baked lighting a second time. In particular, an inferred indoor ceiling cannot obscure all body shadows. Receivers are owned by the environment, hidden in diagnostic point mode, and disposed with shared geometry/materials exactly once.
- All 115 app tests passed, including the receiver, ceiling and disposal regression. The final softness/opacity adjustment passed all eight environment tests and the production build.
- Browser review confirmed cast silhouettes and foot contact in the outdoor and monochrome indoor memories, attached shadows from a side view, correct placement at maximum depth, and clean hiding/restoration in point mode. The indoor floor stays illuminated instead of receiving a room-sized ceiling shadow. Preview: `.local/body-shadows-indoor.png`.

## Facial registration and shape correction

- Corrected the authored chin landmark (previously near the upper lip) and moved the head-pose blend below the jaw. Previously, a 1-radian turn could change facial landmark distances by 5.42 cm. The face now rotates rigidly, with a wider neck transition.
- Local MediaPipe extraction detected the two profile faces and three monochrome faces. Compared rigid and bounded face fitting for all three body shapes (30 candidates), retaining the bounded fit with 2.9–6.8 mm maximum adjustments. Calibrated UV projection uses actual features rather than hair/crown bounds; a separate texture correction is capped at 12 source pixels. Estimated opposite-side facial texture comes from bilateral reflection before the observed photo takes priority.
- All five observed people now have calibrated assets for each body choice. The back-facing person's corrected template retains its inferred face. No private photographs were sent to a service. Scripts, limits and provenance are in `scripts/face-fitting/README.md`.
- All 126 app tests and the production build pass. The 30-candidate geometry audit found unchanged body geometry and UV topology, finite positions and zero flipped facial triangles. A 306,030-point texture audit found no sampled mapping folds. These checks do not establish exact facial identity or complete surface recovery.
- Close-up browser comparisons cover the original view and two offset angles. Faces preserve source color, and the second memory remains monochrome. The original photos remain the reference; unseen surfaces, hair and fine facial detail are approximate.
