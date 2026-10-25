import test from "node:test";
import assert from "node:assert/strict";
import { isHumanPose } from "../human-pose-validation";
import { isWorldCompletion } from "../world-completion-validation";
import { HUMAN_POSE_LANDMARK_NAMES, type HumanPose } from "../types";

const pose: HumanPose = {
  version: 1, source: "mediapipe-pose", model: "pose-landmarker-full",
  confidence: 0.8, observedFraction: 0.7, sourceBox: [0, 0, 1, 1],
  landmarks: HUMAN_POSE_LANDMARK_NAMES.map(name => ({ name, image: [0.5, 0.5, 0], world: [0, 0, 0], visibility: 0.9, presence: 0.9 })),
};
test("pose data retains cropped joints without treating them as observed in-frame points", () => {
  const cropped = structuredClone(pose);
  cropped.landmarks[27].image = [0.5, 1.2, 0.1];
  cropped.landmarks[27].visibility = 0.1;
  assert.ok(isHumanPose(cropped));
});
test("pose input rejects wrong landmark order, malformed coordinates and impossible allocations", () => {
  for (const change of [
    (p: HumanPose) => { p.landmarks.pop(); },
    (p: HumanPose) => { p.landmarks[1].name = "nose"; },
    (p: HumanPose) => { p.landmarks[5].world[0] = Infinity; },
    (p: HumanPose) => { p.landmarks[5].image[1] = NaN; },
    (p: HumanPose) => { p.landmarks[5].presence = -1; },
    (p: HumanPose) => { p.sourceBox = [1, 0, 0, 1]; },
    (p: HumanPose) => { p.confidence = 2; },
  ]) {
    const invalid = structuredClone(pose); change(invalid);
    assert.equal(isHumanPose(invalid), false);
  }
});
test("pose enrichment coexists with old worlds and cannot be attached to an object", () => {
  const completion = { version: 1, generatedBy: "local-segmentation", backgroundUrl: "/uploads/reconstructions/bg.jpg",
    poseEstimation: { version: 1, source: "mediapipe-pose", status: "complete", detected: 1, matched: 1 },
    subjects: [{ id: "person-0", label: "person", kind: "person", box: [0, 0, 1, 1], maskUrl: "/uploads/reconstructions/mask.png", humanPose: pose }],
  };
  assert.ok(isWorldCompletion(completion));
  assert.equal(isWorldCompletion({ ...completion, subjects: [{ ...completion.subjects[0], kind: "object" }] }), false);
  assert.equal(isWorldCompletion({ ...completion, poseEstimation: { ...completion.poseEstimation, matched: 5 } }), false);
});
