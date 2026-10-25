import type { NeuralAssetDescriptor } from "./neural-asset-validation";
import type { MemoryObjectSpec } from "./memory-objects";

export type MemorySource =
  "demo" | "upload" | "google-photos" | "instagram" | "linkedin" | "youtube";
export type ImportStage =
  | "received"
  | "archived"
  | "hashed"
  | "embedded"
  /** 3D check: depth-based readiness for VR exploration. */
  | "scored"
  | "grouped"
  | "ready";
export type ImportJobStatus =
  | "queued"
  | "processing"
  | "ready"
  | "partial"
  | "failed";
export interface MemoryProvenance {
  source: MemorySource;
  sourceId: string;
  sourceUrl?: string;
  sourceAccount?: string;
  importJobId?: string;
  importedAt: string;
  consentId?: string;
}
/** Whether a memory looks good explored in 3D/VR. Only ready items are filed into Pictures and category folders. */
export interface Readiness3D {
  /** 2 = eye-level depth fit + blur gate. Older versions are re-checked automatically. */
  version: 1 | 2;
  score: number;
  ready: boolean;
  /** Human-readable reasons, strongest first. */
  reasons: string[];
  /** "heuristic" means the depth model was unavailable and image statistics were used conservatively. */
  source: "depth-anything-v2" | "heuristic";
  threshold: number;
  /** Depth-map measurements (0-1 unless noted); absent for heuristic scores. */
  metrics?: {
    depthRange: number;
    /** Count of distinct depth peaks in the depth histogram. */
    depthLayers: number;
    depthCoverage: number;
    groundPlane: number;
    closeOccluder: number;
    flatness: number;
    /** Share of the middle (eye-line) strip at a walkable distance: not touching the lens, not at the horizon. */
    eyeLevelContent?: number;
    /** Mean nearness of the bottom band minus the top band; ~0 when the camera points down at a surface. */
    verticalRise?: number;
    /** Nearness of the farthest horizontal band; high when nothing in the frame is far away. */
    farthestBand?: number;
    /** Mean nearness of the central region; high when something fills the view right at the lens. */
    centerNearness?: number;
    /** Lower-third mean nearness. */
    lowerBand?: number;
    /** Contrast-normalized fine detail (Laplacian energy / local contrast), 75th percentile of textured tiles. */
    detail?: number;
    /** Raw Laplacian energy, 75th percentile of textured tiles. */
    edgeEnergy?: number;
  };
  /** Video readiness is measured on one sampled frame. */
  sampledAt?: number;
  scoredAt: string;
  durationMs: number;
}
export interface Memory {
  id: string;
  title: string;
  date: string;
  /** Full capture/publish timestamp when a source provides one; date remains the editable display field. */
  capturedAt?: string;
  location: string;
  description: string;
  tags: string[];
  source: MemorySource;
  mediaType: "image" | "video";
  url: string;
  thumbnailUrl: string;
  width?: number;
  height?: number;
  /** Provider permalink/account retained for provenance; never used as executable input. */
  sourceUrl?: string;
  sourceAccount?: string;
  importedAt?: string;
  consentId?: string;
  /** Every known origin is retained when duplicate media collapses to one memory. */
  provenance?: MemoryProvenance[];
  organization?: {
    key: string;
    label: string;
    confidence: "high" | "medium" | "low";
    reasons: string[];
    /** Virtual folder layers; never used as a filesystem path. */
    folderPath?: string[];
    category?: "event" | "trip" | "holiday" | "daily" | "source";
    organizedBy?: "local" | "gemini";
    /** Gemini's explicit review of the local folder suggestion, when one ran. */
    review?: {
      decision: "keep" | "rename" | "rejected";
      reason: string;
      previousLabel?: string;
      suggestedLabel?: string;
    };
  };
  readiness3d?: Readiness3D;
}
export interface ImportItemState {
  id: string;
  sourceId: string;
  memoryId?: string;
  canonicalMemoryId?: string;
  stage: ImportStage;
  status: "pending" | "processing" | "ready" | "skipped" | "failed";
  localPath?: string;
  mimeType?: string;
  /** Sanitized metadata only; provider tokens and expiring media URLs are never persisted. */
  draftMemory?: Memory;
  attempts: number;
  retryable: boolean;
  lastError?: string;
  updatedAt: string;
}
export interface ImportJob {
  id: string;
  /** "rescore-3d" jobs only re-run the 3D check on memories already in the library. */
  kind?: "import" | "rescore-3d";
  source: MemorySource;
  totalItems: number;
  processedItems: number;
  skippedItems: number;
  failedItems: number;
  currentStage: ImportStage;
  status: ImportJobStatus;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  /** The virtual folder plan built and persisted before any media was archived. */
  folderPlan?: ImportFolderPlan;
  items: ImportItemState[];
}
export interface ImportFolderPlan {
  createdAt: string;
  folderIds: string[];
  folderNames: string[];
  plannedMemoryIds: string[];
  /** Planned memory ID → virtual folder name. */
  assignments: Record<string, string>;
  review: {
    mode: "gemini" | "local";
    reason: "reviewed" | "not_configured" | "empty" | "too_many_items" | "provider_error" | "invalid_response" | "retry";
    kept: number;
    renamed: number;
    rejected: number;
  };
}
export interface MemoryFolder {
  id: string;
  name: string;
  parentId?: string;
  kind: "root" | "category" | "all";
  /** References to canonical memory IDs. Media is archived once; folders never copy files. */
  memoryIds: string[];
  /** Up to four memory IDs whose thumbnails represent the folder. */
  coverMemoryIds?: string[];
  /** Memory IDs planned for this folder by an import that is still archiving. */
  pendingMemoryIds?: string[];
}
export interface FolderItem {
  id: string;
  label: string;
  mediaType: "image" | "video";
  thumbnailUrl: string;
  date: string;
  source: MemorySource;
}
export interface DerivedEvent {
  id: string;
  memoryIds: string[];
  reasons: string[];
  confidence: number;
  dateRange: { start: string; end: string };
  createdAt: string;
}
export type AlbumType = "suggested" | "confirmed" | "manual";
export interface Album {
  id: string;
  title: string;
  type: AlbumType;
  coverMemoryId: string;
  worldAnchorMemoryId: string;
  memoryIds: string[];
  dateRange: { start: string; end: string };
  location?: string;
  confidence: number;
  privacy: "private";
  createdAt: string;
  updatedAt: string;
  selection?: {
    coverScore: number;
    worldAnchorScore: number;
    coverReasons: string[];
    worldAnchorReasons: string[];
  };
}
export interface AlbumSharePreview {
  albumId: string;
  title: string;
  totalMedia: number;
  memoryIds: string[];
  memories: Pick<Memory, "id" | "title" | "mediaType" | "thumbnailUrl" | "source">[];
  sources: MemorySource[];
}
export interface AlbumWorldState {
  albumId: string;
  worldId: string;
  anchorMemoryId: string;
  currentMemoryId: string;
  relatedMemoryIds: string[];
  sharedMemoryIds?: string[];
  /** The scene is inferred from one photograph; geometry is not metrically recovered. */
  geometryNotice: string;
}
export interface SceneSpec {
  memoryId: string;
  title: string;
  environment:
    | "gallery"
    | "indoor"
    | "outdoor"
    | "beach"
    | "city"
    | "forest"
    | "mountain"
    | "garden";
  skyColor: string;
  floorColor: string;
  accentColor: string;
  ambientLight: number;
  description: string;
  generatedBy: "gemini" | "fallback";
  albumWorld?: AlbumWorldState;
  depthLayers: { distance: number; scale: number; opacity: number }[];
  reconstruction?: ReconstructionSpec;
  objects?: {
    type: "tree" | "rock" | "flower" | "lantern" | "building" | "mountain";
    position: [number, number, number];
    scale?: number;
    color?: string;
  }[];
}
/** White depth pixels are near; black pixels are far. Distances are artistic units, not measured meters. */
export interface ReconstructionSpec {
  version: 1;
  kind: "depth-mesh";
  sourceUrl: string;
  depthUrl: string;
  width: number;
  height: number;
  depthSource: "depth-anything-v2";
  near: number;
  far: number;
  fov: number;
  mediaBasis?: "image" | "video-frame" | "video-sequence";
  completionUrl?: string;
  video?: VideoReconstructionSpec;
}
/** Depth samples follow playback time; unseen surfaces remain approximate. */
export interface VideoReconstructionSpec {
  version: 1;
  duration: number;
  frames: {
    time: number;
    sourceUrl: string;
    depthUrl: string;
    completionUrl?: string;
  }[];
}
/** MediaPipe's fixed landmark order. Left/right refer to the subject's anatomy. */
export const HUMAN_POSE_LANDMARK_NAMES = [
  "nose",
  "left_eye_inner",
  "left_eye",
  "left_eye_outer",
  "right_eye_inner",
  "right_eye",
  "right_eye_outer",
  "left_ear",
  "right_ear",
  "mouth_left",
  "mouth_right",
  "left_shoulder",
  "right_shoulder",
  "left_elbow",
  "right_elbow",
  "left_wrist",
  "right_wrist",
  "left_pinky",
  "right_pinky",
  "left_index",
  "right_index",
  "left_thumb",
  "right_thumb",
  "left_hip",
  "right_hip",
  "left_knee",
  "right_knee",
  "left_ankle",
  "right_ankle",
  "left_heel",
  "right_heel",
  "left_foot_index",
  "right_foot_index",
] as const;
export interface HumanPoseLandmark {
  name: (typeof HUMAN_POSE_LANDMARK_NAMES)[number];
  /** Full-source x/y (may leave the frame); z is model-relative, not scene depth. */
  image: [number, number, number];
  /** Hip-relative meters: +x right, +y down, +z away from the camera. */
  world: [number, number, number];
  visibility: number;
  presence: number;
}
export interface HumanPose {
  version: 1;
  source: "mediapipe-pose";
  model: "pose-landmarker-full" | "pose-landmarker-heavy";
  landmarks: HumanPoseLandmark[];
  confidence: number;
  observedFraction: number;
  sourceBox: [number, number, number, number];
}
/** Source-aligned masks and inferred textures used to close objects into walkable volumes. */
export interface WorldCompletion {
  version: 1;
  generatedBy: "gemini" | "local-segmentation" | "depth-fallback";
  textureSource?: "gemini" | "imagegen" | "source-inpaint";
  environment?: "indoor" | "outdoor";
  horizon?: number;
  backgroundUrl: string;
  objectSourceUrl?: string;
  panoramaUrl?: string;
  rearAtlasUrl?: string;
  objectRecognition?: {
    version: 1;
    status: "complete" | "unavailable";
    source: "gemini" | "local-segmentation" | "local-grounding-dino";
    modelVersion?: string;
    detected: number;
  };
  poseEstimation?: {
    version: 1;
    source: "mediapipe-pose";
    model?: HumanPose["model"];
    status: "complete" | "unavailable";
    detected: number;
    matched: number;
  };
  subjects: {
    id: string;
    label: string;
    kind: "person" | "object";
    object?: MemoryObjectSpec;
    box: [number, number, number, number];
    maskUrl: string;
    rearUrl?: string;
    /** Inferred full-length views; crops are [top, left, bottom, right] in the atlas. */
    bodyAtlasUrl?: string;
    bodyFrontBox?: [number, number, number, number];
    bodyBackBox?: [number, number, number, number];
    /** A reviewed, self-contained model produced by a pretrained 3D model. */
    neuralAsset?: NeuralAssetDescriptor;
    humanPose?: HumanPose;
    thickness?: number;
  }[];
}
export interface Pose {
  position: [number, number, number];
  rotation: [number, number, number, number];
}
export interface Participant {
  id: string;
  name: string;
  color: string;
  device: "desktop" | "mobile" | "vr";
  pose?: Pose;
}
export interface RoomSnapshot {
  roomId: string;
  code: string;
  hostId: string;
  memoryId: string | null;
  scene: SceneSpec | null;
  albumId?: string;
  worldId?: string;
  relatedMemoryIds?: string[];
  sharedMemoryIds?: string[];
  members: Participant[];
}
export interface Chapter {
  id: string;
  title: string;
  body: string;
  memoryIds: string[];
  updatedAt: string;
}
