import type { DepthPixels } from "./reconstruction";
import type { HumanPoseRig } from "./human-pose";

type Box = [number, number, number, number];
export interface HumanLayoutInput {
  box: Box;
  faceBox?: Box;
  mask: DepthPixels;
  poseRig?: HumanPoseRig;
  bodyMinY?: number;
  bodyScale?: number;
}

/** Fit the source view's eye height robustly; one uncertain reconstructed leg
 * must not drag the entire photo composition up or down. */
export function estimateCaptureHeight(
  heads: {
    worldY: number;
    depth: number;
    photoV: number;
    confidence: number;
  }[],
  fov = 60,
) {
  const estimates = heads
    .filter(
      (head) =>
        head.confidence >= 0.6 &&
        head.depth > 0 &&
        [head.worldY, head.depth, head.photoV].every(Number.isFinite),
    )
    .map(
      (head) =>
        head.worldY +
        (head.photoV - 0.5) * 2 * Math.tan((fov * Math.PI) / 360) * head.depth,
    )
    .sort((a, b) => a - b);
  if (estimates.length < 2) return 1.6;
  const middle = Math.floor(estimates.length / 2);
  const height =
    estimates.length % 2
      ? estimates[middle]
      : (estimates[middle - 1] + estimates[middle]) / 2;
  return Math.max(0.9, Math.min(1.8, height));
}

export function humanPoseScales(subjects: { poseRig?: HumanPoseRig }[]) {
  const values = subjects
    .flatMap((s) => (s.poseRig ? [s.poseRig.pixelsPerMeter] : []))
    .sort((a, b) => a - b);
  const median = values[Math.floor(values.length / 2)] ?? 1;
  return subjects.map((s) =>
    s.poseRig
      ? Math.max(0.85, Math.min(1.15, s.poseRig.pixelsPerMeter / median))
      : 1,
  );
}

/** Touching silhouettes of similarly sized, nearby faces are evidence of a
 * compact group. A narrow/occluded torso must not independently move one of
 * those neighbours metres away. Distant or disconnected people stay separate. */
function photographedNeighbours(subjects: HumanLayoutInput[], aspect: number) {
  const width = 64,
    height = Math.max(16, Math.round(width / aspect));
  const owners = new Uint16Array(width * height);
  subjects.forEach((subject, index) => {
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const mx = Math.min(
          subject.mask.width - 1,
          Math.floor(((x + 0.5) * subject.mask.width) / width),
        );
        const my = Math.min(
          subject.mask.height - 1,
          Math.floor(((y + 0.5) * subject.mask.height) / height),
        );
        if (subject.mask.data[(my * subject.mask.width + mx) * 4] > 128)
          owners[y * width + x] |= 1 << index;
      }
  });
  const touching = new Set<number>();
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const own = owners[y * width + x];
      if (!own) continue;
      let nearby = 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          if (x + dx >= 0 && x + dx < width && y + dy >= 0 && y + dy < height)
            nearby |= owners[(y + dy) * width + x + dx];
        }
      for (let a = 0; a < subjects.length; a++)
        if (own & (1 << a))
          for (let b = a + 1; b < subjects.length; b++)
            if (nearby & (1 << b)) touching.add(a * subjects.length + b);
    }
  return [...touching].flatMap((key) => {
    const a = Math.floor(key / subjects.length),
      b = key % subjects.length;
    const fa = subjects[a].faceBox,
      fb = subjects[b].faceBox;
    // Without facial scale evidence, leave genuinely distant small figures alone.
    if (!fa || !fb) return [];
    const wa = (fa[3] - fa[1]) * aspect,
      wb = (fb[3] - fb[1]) * aspect;
    const ha = fa[2] - fa[0],
      hb = fb[2] - fb[0];
    const sa = Math.sqrt(wa * ha),
      sb = Math.sqrt(wb * hb);
    if (Math.min(sa, sb) <= 0 || Math.max(sa, sb) / Math.min(sa, sb) > 1.8)
      return [];
    const separation = Math.hypot(
      ((fa[1] + fa[3] - fb[1] - fb[3]) / 2) * aspect,
      (fa[0] + fa[2] - fb[0] - fb[2]) / 2,
    );
    return separation <= (2.6 * (sa + sb)) / 2 ? [[a, b] as const] : [];
  });
}

/** Use head centers, rather than outstretched-arm bounding boxes, to place people.
 * Relative depth controls spacing; it never stretches a person's anatomy. */
export function layoutHumanBodies(
  subjects: HumanLayoutInput[],
  depth: DepthPixels,
  strength = 1.25,
  options: { fov?: number } = {},
) {
  if (!subjects.length) return [];
  const candidates = subjects.map((subject, index) => {
    const head = subject.faceBox ?? subject.box;
    const u = subject.poseRig?.sourceAnchor[0] ?? (head[1] + head[3]) / 2;
    const depths: number[] = [];
    for (let i = 0; i < depth.width * depth.height; i++) {
      if (subject.mask.data[i * 4] > 128)
        depths.push(Number(depth.data[i * 4]));
    }
    depths.sort((a, b) => a - b);
    return {
      index,
      u,
      inverseDepth: depths[Math.floor(depths.length / 2)] ?? 128,
    };
  });
  const meanU =
    candidates.reduce((sum, item) => sum + item.u, 0) / candidates.length;
  const meanDepth =
    candidates.reduce((sum, item) => sum + item.inverseDepth, 0) /
    candidates.length;
  const headWidths = subjects
    .map((s) =>
      s.faceBox ? s.faceBox[3] - s.faceBox[1] : (s.box[3] - s.box[1]) * 0.35,
    )
    .sort((a, b) => a - b);
  const perspective = subjects.some((s) => s.poseRig);
  const unitsPerImage = Math.min(
    9,
    Math.max(
      2.8,
      0.21 / Math.max(0.025, headWidths[Math.floor(headWidths.length / 2)]),
    ),
  );
  const positions = candidates.map((item) => {
    if (perspective) {
      const subject = subjects[item.index],
        rig = subject.poseRig;
      const image = rig?.sourceSize ?? {
        width: depth.width,
        height: depth.height,
      };
      const fov = Math.max(30, Math.min(95, options.fov ?? 60));
      const focal = image.height / (2 * Math.tan((fov * Math.PI) / 360));
      const face = subject.faceBox;
      const faceWidth = face
        ? face[3] - face[1]
        : (subject.box[3] - subject.box[1]) * 0.35;
      const pixelsPerMeter =
        rig?.pixelsPerMeter ??
        (Math.max(0.015, faceWidth) * image.width) / 0.21;
      // Apparent image size primarily describes distance, not a giant/small
      // adult. Keep physical size bounded and move the source ray in depth.
      const estimatedDepth =
        (focal * (subject.bodyScale ?? 1)) / pixelsPerMeter;
      const refinement =
        ((item.inverseDepth - meanDepth) / 255) * 0.45 * strength;
      const distance = Math.max(
        1.15,
        Math.min(7.5, estimatedDepth - refinement),
      );
      return {
        index: item.index,
        x: (((item.u - 0.5) * image.width) / focal) * distance,
        z: -distance,
      };
    }
    const x = (item.u - meanU) * unitsPerImage;
    return {
      index: item.index,
      x,
      z:
        -3.8 +
        Math.max(-0.65, Math.min(0.65, (item.inverseDepth - meanDepth) / 95)) *
          strength,
    };
  });
  if (perspective) {
    const neighbours = photographedNeighbours(
      subjects,
      depth.width / depth.height,
    );
    // Project onto bounded neighbour-depth differences. This retains distinct
    // rows and their mean distance; it adds no horizontal minimum spacing and
    // does not scale or deform anyone's body to make the group fit.
    for (let pass = 0; pass < 40; pass++) {
      let adjustment = 0;
      for (const [a, b] of neighbours) {
        const delta = positions[a].z - positions[b].z;
        const excess = Math.max(0, Math.abs(delta) - 0.45);
        if (!excess) continue;
        const correction = (Math.sign(delta) * excess) / 2;
        positions[a].z -= correction;
        positions[b].z += correction;
        adjustment = Math.max(adjustment, excess);
      }
      if (adjustment < 0.00001) break;
    }
    // Move along the source camera ray, so compacting uncertain depth cannot
    // introduce an additional left/right gap in the original view.
    positions.forEach((position, index) => {
      const subject = subjects[index],
        rig = subject.poseRig;
      const image = rig?.sourceSize ?? depth;
      const focal =
        image.height /
        (2 *
          Math.tan(
            (Math.max(30, Math.min(95, options.fov ?? 60)) * Math.PI) / 360,
          ));
      if (rig && subject.faceBox && rig.confidenceByJoint.head >= 0.6) {
        // A hidden hip is a poor anchor in crowds. Align the observed face,
        // subtracting its posed local offset instead of centering the body there.
        const scale = subject.bodyScale ?? 1;
        const u = (subject.faceBox[1] + subject.faceBox[3]) / 2;
        const headDepth = -position.z - rig.joints.head.z * scale;
        position.x =
          (((u - 0.5) * image.width) / focal) * headDepth -
          rig.joints.head.x * scale;
      } else {
        position.x =
          (((candidates[index].u - 0.5) * image.width) / focal) * -position.z;
      }
    });
  }
  // Image height mixes camera perspective, crop and support height. Without a
  // recovered chair/stair plane, copying that row into world Y floats bodies.
  // Translate each complete articulated mesh to its lowest support point;
  // seated knees, bent hips and horizontal bodies retain every joint angle.
  return positions
    .sort((a, b) => a.index - b.index)
    .map(
      (p) =>
        [
          p.x,
          subjects[p.index].poseRig
            ? -(subjects[p.index].bodyMinY ?? -0.9) *
              (subjects[p.index].bodyScale ?? 1)
            : 0,
          p.z,
        ] as [number, number, number],
    );
}
