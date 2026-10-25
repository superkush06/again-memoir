import { HUMAN_POSE_LANDMARK_NAMES, type HumanPose } from "./types";

const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const bounded = (v: unknown, lo: number, hi: number): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi;
const keysOnly = (v: Record<string, unknown>, keys: string[]) =>
  Object.keys(v).every(key => keys.includes(key));

/** Reject malformed/model-incompatible pose data before it can deform geometry. */
export function isHumanPose(value: unknown): value is HumanPose {
  if (!record(value) || !keysOnly(value, ["version", "source", "model", "landmarks", "confidence", "observedFraction", "sourceBox"])) return false;
  if (value.version !== 1 || value.source !== "mediapipe-pose" || !["pose-landmarker-full", "pose-landmarker-heavy"].includes(String(value.model)) ||
      !bounded(value.confidence, 0, 1) || !bounded(value.observedFraction, 0, 1)) return false;
  const box = value.sourceBox;
  if (!Array.isArray(box) || box.length !== 4 || !box.every(v => bounded(v, 0, 1)) ||
      box[0] >= box[2] || box[1] >= box[3]) return false;
  return Array.isArray(value.landmarks) && value.landmarks.length === 33 && value.landmarks.every((joint, i) =>
    record(joint) && keysOnly(joint, ["name", "image", "world", "visibility", "presence"]) &&
    joint.name === HUMAN_POSE_LANDMARK_NAMES[i] &&
    Array.isArray(joint.image) && joint.image.length === 3 &&
    bounded(joint.image[0], -2, 3) && bounded(joint.image[1], -2, 3) && bounded(joint.image[2], -5, 5) &&
    Array.isArray(joint.world) && joint.world.length === 3 && joint.world.every(v => bounded(v, -4, 4)) &&
    bounded(joint.visibility, 0, 1) && bounded(joint.presence, 0, 1));
}
