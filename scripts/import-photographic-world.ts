import { copyFile, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { isWorldCompletion } from "../src/world-completion-validation.js";

/** Import unchanged generated assets and explicit reviewed subject crops.
 * Usage: npx tsx scripts/import-photographic-world.ts <configuration.json>
 * Config: {fingerprint, panoramaPath, bodyAtlasPath, environment, subjects:[
 *   {id, frontBox:[top,left,bottom,right], backBox:[top,left,bottom,right]}]}.
 */
const [configPath] = process.argv.slice(2);
if (!configPath)
  throw new Error("Supply a photographic-world configuration JSON.");
const config = JSON.parse(await readFile(path.resolve(configPath), "utf8"));
if (!/^[a-f0-9]{32}$/.test(config.fingerprint))
  throw new Error("Invalid reconstruction fingerprint.");
const directory = path.resolve(
  process.env.DATA_DIR || "data",
  "uploads",
  "reconstructions",
);
const worldFile = path.join(directory, `${config.fingerprint}-world.json`);
const original = await readFile(worldFile, "utf8");
const world = JSON.parse(original);
if (!isWorldCompletion(world))
  throw new Error("Reconstruct this source photo first.");
for (const name of ["panoramaPath", "bodyAtlasPath"]) {
  const metadata = await sharp(path.resolve(config[name]), {
    limitInputPixels: 20_000_000,
  }).metadata();
  if (metadata.format !== "png" || !metadata.width || !metadata.height)
    throw new Error("Use PNG assets.");
  if (
    name === "panoramaPath" &&
    Math.abs(metadata.width / metadata.height - 2) > 0.05
  ) {
    throw new Error("The panorama must be a 2:1 equirectangular image.");
  }
}
const prefix = `/uploads/reconstructions/${config.fingerprint}`;
world.panoramaUrl = `${prefix}-panorama-v2.png`;
world.environment = config.environment;
world.textureSource = "imagegen";
if (!Array.isArray(config.subjects))
  throw new Error("Subject crop metadata is required.");
const ids = new Set<string>();
for (const crop of config.subjects) {
  const subject = world.subjects.find((item) => item.id === crop.id);
  if (!subject || ids.has(crop.id))
    throw new Error("Unknown or duplicate subject crop.");
  ids.add(crop.id);
  subject.bodyAtlasUrl = `${prefix}-bodies-v2.png`;
  subject.bodyFrontBox = crop.frontBox;
  subject.bodyBackBox = crop.backBox;
}
if (!isWorldCompletion(world))
  throw new Error("The photographic-world metadata is invalid.");
// Keep the previous manifest for easy rollback; source photos are never rewritten.
await writeFile(`${worldFile}.before-photographic-v2`, original, {
  flag: "wx",
}).catch((error) => {
  if (error.code !== "EEXIST") throw error;
});
await copyFile(
  path.resolve(config.panoramaPath),
  path.join(directory, `${config.fingerprint}-panorama-v2.png`),
);
await copyFile(
  path.resolve(config.bodyAtlasPath),
  path.join(directory, `${config.fingerprint}-bodies-v2.png`),
);
await writeFile(`${worldFile}.tmp`, JSON.stringify(world));
await rename(`${worldFile}.tmp`, worldFile);
console.log(
  JSON.stringify({
    completionUrl: `${prefix}-world.json`,
    bodies: ids.size,
    environment: world.environment,
  }),
);
