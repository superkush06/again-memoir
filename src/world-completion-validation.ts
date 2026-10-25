import type { WorldCompletion } from "./types";
import { isNeuralAssetDescriptor } from "./neural-asset-validation";
import { isHumanPose } from "./human-pose-validation";
import { isMemoryObjectSpec } from "./memory-objects";

const asset = (value: unknown) =>
  typeof value === "string" &&
  /^\/uploads\/reconstructions\/[A-Za-z0-9_-]{1,160}\.(?:png|jpe?g|webp)$/.test(
    value,
  );
const optionalAsset = (value: unknown) => value === undefined || asset(value);
const normalizedBox = (value: unknown) =>
  Array.isArray(value) &&
  value.length === 4 &&
  value.every(
    (v: unknown) =>
      typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1,
  ) &&
  value[0] < value[2] &&
  value[1] < value[3];

/** Completion files are data only. Never accept executable content or a remote asset address. */
export function isWorldCompletion(value: unknown): value is WorldCompletion {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  const keys = new Set([
    "version",
    "generatedBy",
    "textureSource",
    "environment",
    "horizon",
    "backgroundUrl",
    "objectSourceUrl",
    "panoramaUrl",
    "rearAtlasUrl",
    "subjects",
    "poseEstimation",
    "objectRecognition",
  ]);
  if (Object.keys(item).some((key) => !keys.has(key))) return false;
  if (
    item.version !== 1 ||
    !["gemini", "local-segmentation", "depth-fallback"].includes(
      String(item.generatedBy),
    ) ||
    !asset(item.backgroundUrl) ||
    !optionalAsset(item.objectSourceUrl) ||
    !optionalAsset(item.panoramaUrl) ||
    !optionalAsset(item.rearAtlasUrl)
  )
    return false;
  if (
    item.textureSource !== undefined &&
    !["gemini", "imagegen", "source-inpaint"].includes(
      String(item.textureSource),
    )
  )
    return false;
  if (
    item.environment !== undefined &&
    !["indoor", "outdoor"].includes(String(item.environment))
  )
    return false;
  if (
    item.horizon !== undefined &&
    (typeof item.horizon !== "number" ||
      !Number.isFinite(item.horizon) ||
      item.horizon < 0 ||
      item.horizon > 1)
  )
    return false;
  if (
    !Array.isArray(item.subjects) ||
    item.subjects.length > 24 ||
    item.subjects.filter((s) => s?.kind === "person").length > 12
  )
    return false;
  if (item.poseEstimation !== undefined) {
    const pose = item.poseEstimation;
    if (!pose || typeof pose !== "object" || Array.isArray(pose)) return false;
    const p = pose as Record<string, unknown>;
    if (
      Object.keys(p).some(
        (key) =>
          ![
            "version",
            "source",
            "model",
            "status",
            "detected",
            "matched",
          ].includes(key),
      ) ||
      p.version !== 1 ||
      p.source !== "mediapipe-pose" ||
      !["complete", "unavailable"].includes(String(p.status)) ||
      (p.model !== undefined &&
        !["pose-landmarker-full", "pose-landmarker-heavy"].includes(
          String(p.model),
        )) ||
      !Number.isInteger(p.detected) ||
      Number(p.detected) < 0 ||
      Number(p.detected) > 64 ||
      !Number.isInteger(p.matched) ||
      Number(p.matched) < 0 ||
      Number(p.matched) > 12 ||
      Number(p.matched) > Number(p.detected)
    )
      return false;
  }
  const ids = new Set<string>();
  if (item.objectRecognition !== undefined) {
    const recognition = item.objectRecognition;
    if (
      !recognition ||
      typeof recognition !== "object" ||
      Array.isArray(recognition)
    )
      return false;
    const r = recognition as Record<string, unknown>;
    if (
      Object.keys(r).some(
        (key) => !["version", "status", "source", "detected", "modelVersion"].includes(key),
      ) ||
      r.version !== 1 ||
      !["complete", "unavailable"].includes(String(r.status)) ||
      !["gemini", "local-segmentation", "local-grounding-dino"].includes(String(r.source)) ||
      (r.modelVersion !== undefined && (typeof r.modelVersion !== "string" || !/^[a-zA-Z0-9_.-]{1,100}$/.test(r.modelVersion))) ||
      !Number.isInteger(r.detected) ||
      Number(r.detected) < 0 ||
      Number(r.detected) > 12
    )
      return false;
  }
  return item.subjects.every((subject) => {
    if (!subject || typeof subject !== "object" || Array.isArray(subject))
      return false;
    const keys = new Set([
      "id",
      "label",
      "kind",
      "box",
      "maskUrl",
      "rearUrl",
      "bodyAtlasUrl",
      "bodyFrontBox",
      "bodyBackBox",
      "neuralAsset",
      "thickness",
      "humanPose",
      "object",
    ]);
    if (Object.keys(subject).some((key) => !keys.has(key))) return false;
    if (
      typeof subject.id !== "string" ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(subject.id) ||
      ids.has(subject.id)
    )
      return false;
    ids.add(subject.id);
    if (
      typeof subject.label !== "string" ||
      subject.label.length < 1 ||
      subject.label.length > 160 ||
      !["person", "object"].includes(subject.kind)
    )
      return false;
    if (!normalizedBox(subject.box)) return false;
    if (
      subject.object !== undefined &&
      (subject.kind !== "object" || !isMemoryObjectSpec(subject.object))
    )
      return false;
    if (
      subject.humanPose !== undefined &&
      (subject.kind !== "person" || !isHumanPose(subject.humanPose))
    )
      return false;
    if (!asset(subject.maskUrl) || !optionalAsset(subject.rearUrl))
      return false;
    if (
      subject.neuralAsset !== undefined &&
      (subject.kind !== "person" ||
        !isNeuralAssetDescriptor(subject.neuralAsset))
    )
      return false;
    const hasBodyAtlas = ["bodyAtlasUrl", "bodyFrontBox", "bodyBackBox"].some(
      (key) => subject[key] !== undefined,
    );
    if (
      hasBodyAtlas &&
      (subject.kind !== "person" ||
        !asset(subject.bodyAtlasUrl) ||
        !normalizedBox(subject.bodyFrontBox) ||
        !normalizedBox(subject.bodyBackBox))
    )
      return false;
    return (
      subject.thickness === undefined ||
      (typeof subject.thickness === "number" &&
        Number.isFinite(subject.thickness) &&
        subject.thickness >= 0.05 &&
        subject.thickness <= 5)
    );
  });
}
