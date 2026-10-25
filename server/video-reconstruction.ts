import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ReconstructionSpec } from "../src/types.js";
import { HttpError } from "./http.js";

const runFile = promisify(execFile);
export const VIDEO_CACHE_VERSION = "video-depth-sequence-v1";
export type VideoSampler = {
  duration(file: string): Promise<number>;
  frame(file: string, time: number): Promise<Buffer>;
};

/** Uniform samples include the end of the clip, not only its first few seconds. */
export function videoSampleTimes(duration: number): number[] {
  if (!Number.isFinite(duration) || duration <= 0 || duration > 3600)
    throw new HttpError(
      422,
      "Use a video between a fraction of a second and one hour long.",
    );
  const count = Math.min(8, Math.max(2, Math.ceil(duration / 2) + 1));
  const end = Math.max(duration * 0.9, duration - 0.2);
  return Array.from({ length: count }, (_, i) => (end * i) / (count - 1));
}

/** Audio tails must not schedule depth extraction after the last video frame. */
export function videoStreamDuration(probe: {
  streams?: { duration?: unknown }[];
  format?: { duration?: unknown };
}) {
  const stream = Number(probe.streams?.[0]?.duration);
  const duration =
    Number.isFinite(stream) && stream > 0
      ? stream
      : Number(probe.format?.duration);
  videoSampleTimes(duration);
  return duration;
}

/** Local files only; execFile never invokes a shell and FFmpeg cannot fetch remote streams. */
export const ffmpegVideoSampler: VideoSampler = {
  async duration(file) {
    try {
      const { stdout } = await runFile(
        process.env.FFPROBE_PATH || "ffprobe",
        [
          "-v",
          "error",
          "-protocol_whitelist",
          "file,pipe",
          "-select_streams",
          "v:0",
          "-show_entries",
          "stream=duration:format=duration",
          "-of",
          "json",
          file,
        ],
        { windowsHide: true, timeout: 30000, maxBuffer: 128 * 1024 },
      );
      return videoStreamDuration(JSON.parse(stdout));
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(
        422,
        "Video immersion needs ffmpeg and ffprobe on the server. Install them (or set FFMPEG_PATH and FFPROBE_PATH), then retry this video.",
      );
    }
  },
  async frame(file, time) {
    try {
      const { stdout } = await runFile(
        process.env.FFMPEG_PATH || "ffmpeg",
        [
          "-nostdin",
          "-v",
          "error",
          "-protocol_whitelist",
          "file,pipe",
          "-ss",
          time.toFixed(6),
          "-i",
          file,
          "-frames:v",
          "1",
          "-vf",
          "scale=512:512:force_original_aspect_ratio=decrease",
          "-f",
          "image2pipe",
          "-vcodec",
          "mjpeg",
          "pipe:1",
        ],
        {
          encoding: "buffer",
          windowsHide: true,
          timeout: 30000,
          maxBuffer: 3 * 1024 * 1024,
        },
      );
      if (!stdout.length) throw new Error("No decoded frame");
      return stdout;
    } catch {
      throw new HttpError(
        422,
        "A video frame could not be decoded. Install ffmpeg on the server and use a playable MP4, WebM, or MOV video.",
      );
    }
  },
};

/** Each bounded keyframe gets semantic recognition. Video objects remain fixed during playback. */
export async function completeVideoReconstruction(
  reconstruction: ReconstructionSpec,
  complete: (frame: ReconstructionSpec) => Promise<ReconstructionSpec>,
): Promise<ReconstructionSpec> {
  if (!reconstruction.video) return complete(reconstruction);
  const { video, ...base } = reconstruction;
  const frames = [];
  for (const frame of video.frames) {
    const completed = await complete({
      ...base,
      sourceUrl: frame.sourceUrl,
      depthUrl: frame.depthUrl,
      completionUrl: frame.completionUrl,
      mediaBasis: "video-frame",
    });
    frames.push({
      ...frame,
      ...(completed.completionUrl
        ? { completionUrl: completed.completionUrl }
        : {}),
    });
  }
  return {
    ...reconstruction,
    completionUrl: frames[0].completionUrl,
    video: { ...video, frames },
  };
}
