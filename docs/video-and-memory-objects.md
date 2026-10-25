# Moving memories and everyday objects

Photo and video reconstructions support recognition of laptops, desktop computers/monitors, phones, drink cans, chip bags, water bottles, boxes and backpacks. Object recognition runs locally with OWLv2 proposals, Grounding DINO confirmation and SlimSAM masks; it does not call Gemini or require an API key. The first run downloads public model weights to `data/models/`, then inference and cached results stay local. Competing labels such as books, speakers and grave markers help reject misleading shapes. Up to 12 objects and 12 people fit in a world; confirmed props take priority over unclassified depth volumes.

Detected objects become complete meshes with details such as laptop lids and keyboards, bottle caps, box seams and backpack straps. The learned silhouette adjusts proportions and container profiles. Photo detection uses the original upload; a lossless copy and foreground mask preserve object detail up to 3072px independently of the smaller depth and body-analysis images. Source pixels project continuously across the mesh, keeping visible label details and colors in place. Masks reject hands and background, although small boundary artifacts can remain. Hidden surfaces use sampled material colors, and container shape completes across finger occlusions instead of forming dents. A held object's pixels are removed from the holder's body texture so moving the prop does not leave a second painted object behind. Absolute size, unseen depth and hidden markings remain inferred; small or occluded objects can still be missed or misclassified.

Cached scenes upgrade to the versioned local detector when reopened, including scenes previously blocked by Gemini's quota. Successful recognition, including an empty result, is cached by image content and model version. Runtime failures are reported as unavailable and can retry after five minutes. Old masks are preserved during upgrades so stale object removals can restore the source pixels without painting retained people back into the cleaned background. See [actual Carriage evaluation](object-detection-evaluation.md) for the tested positives, negatives and limits.

Run `npx tsx scripts/object-detection/detect-local.ts path/to/photo.jpg` for local detection. `review-carriage.ts` creates the archived-media review set; `reconstruct-carriage.ts` applies the same local detector to its photo scenes and video depth samples without a Gemini client. First inference takes longer than cached reopening; models load one at a time to limit memory alongside depth and human reconstruction.

## Use photo objects

- Quest: point at an object within four metres, hold the controller grip, move your hand, and release to place it. Trigger still teleports when you are not holding a prop.
- Laptop/phone: choose **Move objects**, then drag a prop and release. Turn the mode off to look/orbit normally.
- **Reset objects** restores the original arrangement. Releasing below the ground raises the prop above the floor. There is no rigid-body physics simulation.
- Changes last for the current local view; object movement is not yet synchronized to other room participants or saved to the library.

## Step into video

Upload or open an archived MP4/WebM video, choose **Step inside**, then play it. Playback supports pause, sound and scrubbing. In Quest, the trigger on the video surface toggles playback. All video props remain fixed to their sampled scene, including when paused; grip and desktop movement cannot pick them up.

The server uses FFmpeg and FFprobe, already supported by the local deployment, to sample 2–8 timestamps across the full clip. Depth Anything V2 estimates depth for those frames. The renderer plays the original video continuously while interpolating small depth changes and switching across large jumps. Recognized props are complete meshes updated at sample boundaries. This improves on projecting every frame onto the opening frame's static geometry, but is **sampled 2.5D video**, not a recovered full volumetric performance. Fast motion, camera cuts and unseen surfaces remain approximate; object positions can jump at sample boundaries.

Samples are limited to 512px and render depth grids to 128px for bounded headset work. Video completion avoids generative texture atlases and static human pose fitting. Content hashes invalidate changed source videos; cached recognition prevents a charged call on every play. Cloud failures retain available local results, and detection status is stored in the completion metadata. Input is limited to locally archived files, 50 MB and one hour; browser codec support still applies. Set `FFMPEG_PATH`/`FFPROBE_PATH` when the executables are not on PATH.

Physical Quest interaction and performance require headset testing. The desktop drag path uses the same grab/release manager; tests cover immutable video props, two-controller ownership, transform preservation and floor placement. Controller handling follows [WebXR squeeze events](https://developer.mozilla.org/en-US/docs/Web/API/XRSession/squeezestart_event) and [Three.js controller spaces](https://threejs.org/docs/pages/WebXRManager).
