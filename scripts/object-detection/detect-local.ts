import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import {
  localObjectRecognizer,
  LOCAL_OBJECT_MODELS,
  LOCAL_OBJECT_MODEL_VERSION,
} from "../../server/local-object-detector.js";

const files = process.argv.slice(2);
if (!files.length)
  throw new Error(
    "Usage: npx tsx scripts/object-detection/detect-local.ts <image.jpg> [image2.jpg ...]",
  );
const detect = localObjectRecognizer(path.resolve("data/models"));
await mkdir(".local/object-detection-results", { recursive: true });
for (const file of files) {
  const start = Date.now();
  const objects = await detect(await readFile(file));
  const result = {
    file,
    modelVersion: LOCAL_OBJECT_MODEL_VERSION,
    models: LOCAL_OBJECT_MODELS,
    milliseconds: Date.now() - start,
    objects,
  };
  const output = path.join(
    ".local/object-detection-results",
    path.basename(file).replace(/\.[^.]+$/, "") + ".json",
  );
  await writeFile(output, JSON.stringify(result, null, 2));
  console.log(
    JSON.stringify({
      file,
      output,
      milliseconds: result.milliseconds,
      objects,
    }),
  );
}
