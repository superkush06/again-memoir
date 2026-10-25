# Video immersion

An uploaded or archived MP4, WebM, or MOV can play on a moving 3D depth surface. The original video supplies color and motion continuously. Depth Anything V2 estimates 2–8 keyframes across the whole recording, and the browser updates the geometry as playback advances or is scrubbed. Stable surfaces interpolate; large depth changes switch at the closest sample to avoid stretching across cuts and occlusions.

Each keyframe also runs common-object recognition. Recognized objects use the same closed category meshes as photo memories, with photographed colors and front markings. Video props follow the nearest sampled frame and cannot be picked up; photos allow pickup. This is a bounded approximation, not a volumetric scan: unobserved views of moving people are not recovered, props can change between samples, and rapid motion or camera cuts can reveal gaps.

The server needs `ffmpeg` and `ffprobe` on PATH, or explicit `FFMPEG_PATH` and `FFPROBE_PATH` values. Extraction is local-only, uses `execFile` without a shell, disables network protocols, and limits each frame to 512 pixels on its longest edge. Browser depth grids are at most 128×128 vertices. Existing 50 MB upload limits apply; recordings longer than one hour are rejected.

Cache keys hash the entire original video, so replacing motion while retaining the same opening frame cannot reuse stale depth. All frame artifacts and ordered timestamps are checked before cached metadata is returned. Video-stream duration takes priority over container duration because an audio tail can extend beyond the final image. Generation runs depth and recognition sequentially to bound CPU and model memory; the first build can take longer than a photo.

Tests cover video-file replacement, missing later-frame artifacts, timestamp and path validation, bounded sampling, audio tails, per-frame recognition, scrubbing/looping, actual vertex movement, and discontinuity handling. The same renderer is used in desktop, mobile, and WebXR views; hardware performance and controller behavior still need a connected Quest test.
