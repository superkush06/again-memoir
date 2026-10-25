import type { ReconstructionSpec } from "./types";

/** Shared browser/module guard: media is fetched from the app, never a room-supplied remote origin. */
export function isReconstructionSpec(
  value: unknown,
): value is ReconstructionSpec {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  const keys = new Set([
    "version",
    "kind",
    "sourceUrl",
    "depthUrl",
    "width",
    "height",
    "depthSource",
    "near",
    "far",
    "fov",
    "mediaBasis",
    "completionUrl",
    "video",
  ]);
  if (Object.keys(item).some((key) => !keys.has(key))) return false;
  const assetPath = (path: unknown, depth = false) => {
    if (
      typeof path !== "string" ||
      path.length > 256 ||
      !/^\/uploads\/[A-Za-z0-9_./-]+$/.test(path)
    )
      return false;
    if (
      path
        .split("/")
        .slice(2)
        .some((segment) => !segment || segment === "." || segment === "..")
    )
      return false;
    return depth ? /\.png$/i.test(path) : /\.(jpe?g|png|webp)$/i.test(path);
  };
  const dimension = (number: unknown) =>
    typeof number === "number" &&
    Number.isInteger(number) &&
    number >= 16 &&
    number <= 8192;
  const numberIn = (
    value: unknown,
    min: number,
    max: number,
  ): value is number =>
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= min &&
    value <= max;
  const completionPath = (value: unknown) =>
    value === undefined ||
    (typeof value === "string" &&
      /^\/uploads\/reconstructions\/[A-Za-z0-9_-]{1,128}-world\.json$/.test(
        value,
      ));
  const videoValid = () => {
    if (item.video === undefined) return item.mediaBasis !== "video-sequence";
    if (
      item.mediaBasis !== "video-sequence" ||
      !item.video ||
      typeof item.video !== "object" ||
      Array.isArray(item.video)
    )
      return false;
    const video = item.video as Record<string, unknown>;
    if (
      Object.keys(video).some(
        (key) => !["version", "duration", "frames"].includes(key),
      ) ||
      video.version !== 1 ||
      !numberIn(video.duration, 0.0001, 3600) ||
      !Array.isArray(video.frames) ||
      video.frames.length < 2 ||
      video.frames.length > 8
    )
      return false;
    let previous = -1;
    return video.frames.every((frame: unknown, index: number) => {
      if (!frame || typeof frame !== "object" || Array.isArray(frame))
        return false;
      const value = frame as Record<string, unknown>;
      if (
        Object.keys(value).some(
          (key) =>
            !["time", "sourceUrl", "depthUrl", "completionUrl"].includes(key),
        ) ||
        !numberIn(value.time, 0, Number(video.duration)) ||
        value.time <= previous ||
        !assetPath(value.sourceUrl) ||
        !assetPath(value.depthUrl, true) ||
        !completionPath(value.completionUrl)
      )
        return false;
      previous = value.time;
      return (
        index !== 0 ||
        (value.time === 0 &&
          value.sourceUrl === item.sourceUrl &&
          value.depthUrl === item.depthUrl)
      );
    });
  };
  return (
    item.version === 1 &&
    item.kind === "depth-mesh" &&
    item.depthSource === "depth-anything-v2" &&
    assetPath(item.sourceUrl) &&
    assetPath(item.depthUrl, true) &&
    dimension(item.width) &&
    dimension(item.height) &&
    numberIn(item.near, 0.1, 10) &&
    numberIn(item.far, 0.2, 100) &&
    item.far > item.near &&
    numberIn(item.fov, 20, 100) &&
    (item.mediaBasis === undefined ||
      item.mediaBasis === "image" ||
      item.mediaBasis === "video-frame" ||
      item.mediaBasis === "video-sequence") &&
    completionPath(item.completionUrl) &&
    videoValid()
  );
}
