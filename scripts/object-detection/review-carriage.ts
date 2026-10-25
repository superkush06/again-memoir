/** Reproduce a read-only review set from the already imported Carriage archive.
 * No network requests, cloud inference, generated objects, or library writes.
 * Run: npx tsx scripts/object-detection/review-carriage.ts
 */
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";

const run = promisify(execFile);
const root = process.cwd();
const output = path.resolve(root, ".local/carriage-object-audit");
const ids = new Set([
  "instagram-c3b12b38f189c3c03708",
  "instagram-1e2b46fe440a15643072",
  "instagram-ef90d9ab05e0d3d81fdf",
  "instagram-ea4c4799641652f2b34c",
  "instagram-48d65fa54e34dc19b2f4",
  "instagram-fd427937e17e9f26d0d1",
  "instagram-15e0e46b42b1d4453cda",
  "instagram-21c762de5b9534ba7464",
]);
type Memory = {
  id: string;
  title: string;
  url: string;
  mediaType: "image" | "video";
};
const memories: Memory[] = JSON.parse(
  await readFile(path.join(root, "data/memories.json"), "utf8"),
);
const archive = memories.filter((memory) => ids.has(memory.id));
await mkdir(output, { recursive: true });

function localMedia(url: string) {
  if (!url.startsWith("/uploads/"))
    throw new Error("Review only supports existing local imports.");
  const file = path.resolve(root, "data", url.slice(1));
  const uploads = path.resolve(root, "data/uploads") + path.sep;
  if (!file.startsWith(uploads)) throw new Error("Media path escaped uploads.");
  return file;
}
const escape = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;");
async function contactSheet(
  entries: { path: string; label: string }[],
  filename: string,
  columns: number,
) {
  const width = 400;
  const height = 330;
  const cards = [];
  for (const [index, entry] of entries.entries()) {
    const image = await sharp(entry.path)
      .resize(width, 300, { fit: "contain", background: "#202020" })
      .toBuffer();
    const label = Buffer.from(
      `<svg width="${width}" height="30"><rect width="100%" height="100%" fill="white"/><text x="8" y="20" font-family="Arial" font-size="12">${escape(entry.label)}</text></svg>`,
    );
    const card = await sharp({
      create: { width, height, channels: 3, background: "#ffffff" },
    })
      .composite([
        { input: image, left: 0, top: 0 },
        { input: label, left: 0, top: 300 },
      ])
      .png()
      .toBuffer();
    cards.push({
      input: card,
      left: (index % columns) * width,
      top: Math.floor(index / columns) * height,
    });
  }
  if (cards.length)
    await sharp({
      create: {
        width: columns * width,
        height: Math.ceil(cards.length / columns) * height,
        channels: 3,
        background: "#202020",
      },
    })
      .composite(cards)
      .png()
      .toFile(path.join(output, filename));
}

const photos = [];
const videos = [];
for (const memory of archive) {
  const file = localMedia(memory.url);
  if (memory.mediaType === "image") {
    const { width, height } = await sharp(file).metadata();
    photos.push({
      memoryId: memory.id,
      title: memory.title,
      path: file,
      width,
      height,
    });
    continue;
  }
  const { stdout } = await run(process.env.FFPROBE_PATH || "ffprobe", [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=duration,width,height",
    "-of",
    "json",
    file,
  ]);
  const stream = JSON.parse(stdout).streams[0];
  const duration = Number(stream.duration);
  if (!(duration > 0 && duration < 3600))
    throw new Error("Unexpected video duration.");
  const frames = [];
  for (let index = 0; index < 8; index++) {
    const time = ((duration - Math.min(0.2, duration / 4)) * index) / 7;
    const frame = path.join(output, `${memory.id}-frame-${index}.jpg`);
    await run(process.env.FFMPEG_PATH || "ffmpeg", [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-ss",
      time.toFixed(6),
      "-protocol_whitelist",
      "file,pipe",
      "-i",
      file,
      "-frames:v",
      "1",
      "-q:v",
      "2",
      frame,
    ]);
    frames.push({ time, path: frame });
  }
  videos.push({
    memoryId: memory.id,
    title: memory.title,
    path: file,
    duration,
    width: stream.width,
    height: stream.height,
    frames,
  });
}
await contactSheet(
  photos.map((photo) => ({
    path: photo.path,
    label: `${photo.memoryId} | ${photo.width} x ${photo.height}`,
  })),
  "photos-native-contact.png",
  2,
);
await contactSheet(
  videos.flatMap((video) =>
    video.frames.map((frame) => ({
      path: frame.path,
      label: `${video.memoryId} | ${frame.time.toFixed(3)} s`,
    })),
  ),
  "video-native-contact.png",
  2,
);

// Human visual observations for evaluation only; never used as detector input.
const observations = [
  {
    memoryId: "instagram-fd427937e17e9f26d0d1",
    category: "drink-can",
    status: "visible-positive",
    boxPixels: [1124, 1042, 1233, 1176],
    notes:
      "Short white drink can with silver top, small dark printing, straw, and partial hand occlusion. Box excludes the straw and hands. Observed shape is wider than a typical tall soda can.",
  },
  {
    memoryId: "instagram-21c762de5b9534ba7464",
    category: "phone",
    status: "probable-positive",
    boxPixels: [205, 665, 248, 746],
    notes:
      "Small, blurred light rectangle held in background left, with dark camera-like circles. Hand occlusion and limited resolution make identity uncertain; do not count as definitive ground truth.",
  },
  {
    memoryId: "instagram-fd427937e17e9f26d0d1",
    category: "water-bottle",
    status: "hard-negative",
    boxPixels: [410, 175, 457, 262],
    notes:
      "Blue cylinder atop shelf has speaker grille/logo and is a portable speaker, not a bottle.",
  },
  {
    memoryId: "instagram-fd427937e17e9f26d0d1",
    category: "laptop",
    status: "hard-negative",
    boxPixels: [227, 175, 363, 264],
    notes:
      "Angled pale object atop shelf appears to be an open book or paper display, not a laptop; no keyboard or display is visible.",
  },
  {
    memoryId: "instagram-48d65fa54e34dc19b2f4",
    category: "water-bottle",
    status: "hard-negative-sequence",
    notes:
      "Grave markers and an obelisk in the first half are not bottles. Later frames show an eye/title graphic followed by black. No requested common objects seen during the 1 Hz visual review; this is a rejection test, not a positive detection showcase.",
  },
];
await writeFile(
  path.join(output, "manifest.json"),
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      source:
        "Already imported carriage.senior.society archive, selected by fixed memory IDs; no network fetch.",
      coordinateConvention:
        "boxPixels=[left,top,right,bottom] at native source dimensions; observational annotations, not comprehensive ground truth",
      photos,
      videos,
      observations,
    },
    null,
    2,
  ),
);
console.log(
  `Reviewed ${photos.length} photos and ${videos.length} videos. Evidence: ${output}`,
);
