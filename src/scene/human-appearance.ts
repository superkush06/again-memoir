import type { VolumePixels } from "./volume";

export type PhotoBox = [
  top: number,
  left: number,
  bottom: number,
  right: number,
];

/** Source colors stay in sRGB. Unseen clothes are an explicit, neutral inference. */
export interface HumanAppearance {
  shirtColor: string;
  pantsColor: string;
  skinColor: string;
  hairColor: string;
  shoeColor: string;
  height?: number;
  yaw?: number;
  headYaw?: number;
  sourceView?: "front" | "back";
  sleeves?: "short" | "long";
  hairLength?: "short" | "long";
  hairVolume?: number;
  /** Crown to chin, excluding neck and neighboring people's shoulders. */
  faceBox?: PhotoBox;
  /** Central fabric only: avoids projecting somebody's arms onto a torso. */
  chestBox?: PhotoBox;
  /** Photographic shoulders through the observed shirt hem. Unlike chestBox,
   * this retains the scale and position of collars, graphics and necklaces. */
  torsoBox?: PhotoBox;
  neckBox?: PhotoBox;
  /** Bounded anatomical fit, measured in source pixels rather than mask UVs. */
  headWidthScale?: number;
  headHeightScale?: number;
  torsoWidthScale?: number;
  /** Fraction of a normal shirt seen in the photo; the remainder is inferred. */
  torsoSourceBottom?: number;
}

type RGB = [number, number, number];
type Span = { left: number; right: number; count: number; y: number };
const clamp = (v: number, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));
const quantile = (values: number[], q: number) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) * clamp(q))];
};
const hex = (rgb: RGB) =>
  `#${rgb
    .map((n) =>
      Math.round(clamp(n, 0, 255))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
const brightness = (rgb: RGB) =>
  rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
const colorDistance = (a: RGB, b: RGB) =>
  Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const warmSkin = (p: RGB) =>
  p[0] > 32 &&
  p[0] > p[1] * 1.08 &&
  p[0] - p[2] > 15 &&
  p[1] > p[2] * 0.95 &&
  p[0] - p[1] < 115;

/** Pick the strongest color family, then average its local neighborhood. Large
 * white shirt graphics therefore do not turn a black shirt gray. */
function dominantColor(pixels: RGB[], fallback: RGB): RGB {
  if (!pixels.length) return fallback;
  const bins = new Map<string, RGB[]>();
  for (const p of pixels) {
    const key = p.map((v) => Math.floor(v / 24)).join(":");
    const bin = bins.get(key) ?? [];
    bin.push(p);
    bins.set(key, bin);
  }
  let strongest: RGB[] = [];
  for (const bin of bins.values())
    if (bin.length > strongest.length) strongest = bin;
  const seed = [0, 1, 2].map((i) =>
    quantile(
      strongest.map((p) => p[i]),
      0.5,
    ),
  ) as RGB;
  const neighbors = pixels.filter((p) => colorDistance(p, seed) < 38);
  return [0, 1, 2].map((i) =>
    quantile(
      neighbors.map((p) => p[i]),
      0.5,
    ),
  ) as RGB;
}

export function analyzeHumanAppearance({
  source,
  mask,
  box,
  label,
}: {
  source: VolumePixels;
  mask: VolumePixels;
  box: PhotoBox;
  label: string;
}): HumanAppearance {
  for (const pixels of [source, mask]) {
    if (
      pixels.width < 2 ||
      pixels.height < 2 ||
      pixels.data.length < pixels.width * pixels.height * 4
    )
      throw new Error(
        "Human appearance requires complete RGBA source and mask pixels.",
      );
  }
  if (!box.every(Number.isFinite) || box[2] <= box[0] || box[3] <= box[1])
    throw new Error(
      "Human appearance requires a nonempty normalized subject box.",
    );

  const w = mask.width,
    h = mask.height;
  const top = Math.floor(clamp(box[0]) * (h - 1));
  const bottom = Math.ceil(clamp(box[2]) * (h - 1));
  const left = Math.floor(clamp(box[1]) * (w - 1));
  const right = Math.ceil(clamp(box[3]) * (w - 1));
  const active = (x: number, y: number) =>
    x >= 0 &&
    y >= 0 &&
    x < w &&
    y < h &&
    Number(mask.data[(y * w + x) * 4]) >= 110;
  const sample = (x: number, y: number): RGB => {
    const sx = Math.round((x / (w - 1)) * (source.width - 1));
    const sy = Math.round((y / (h - 1)) * (source.height - 1));
    const i = (sy * source.width + sx) * 4;
    return [
      Number(source.data[i]),
      Number(source.data[i + 1]),
      Number(source.data[i + 2]),
    ];
  };
  const rows: Span[] = [];
  for (let y = top; y <= bottom; y++) {
    let first = w,
      last = -1,
      count = 0;
    for (let x = left; x <= right; x++)
      if (active(x, y)) {
        first = Math.min(first, x);
        last = x;
        count++;
      }
    if (count >= 2) rows.push({ left: first, right: last, count, y });
  }
  if (!rows.length)
    return {
      shirtColor: "#777777",
      pantsColor: "#303238",
      skinColor: "#ae8970",
      hairColor: "#272421",
      shoeColor: "#252525",
      height: 1.76,
      yaw: 0,
      headYaw: 0,
      sourceView: "front",
      sleeves: "short",
      hairLength: "short",
      faceBox: box,
    };

  const crown = rows[0].y,
    visibleBottom = rows[rows.length - 1].y;
  const visibleHeight = Math.max(2, visibleBottom - crown);
  // Arms can span most of the photograph. Find the head above them, rather than
  // assuming that the center or width of the whole person is a head landmark.
  const crownRows = rows.filter(
    (r) =>
      r.y > crown + visibleHeight * 0.035 && r.y < crown + visibleHeight * 0.15,
  );
  const headRows = crownRows.length
    ? crownRows
    : rows.slice(0, Math.max(1, Math.ceil(rows.length * 0.15)));
  const headWidth = Math.max(
    4,
    quantile(
      headRows.map((r) => r.right - r.left + 1),
      0.65,
    ),
  );
  const headCenter = quantile(
    headRows.map((r) => (r.left + r.right) / 2),
    0.5,
  );
  let chin = Math.min(visibleBottom, crown + headWidth * 1.38);
  const shoulderExpansion = (row: Span) => {
    const width = row.right - row.left + 1;
    if (width <= headWidth * 1.3) return false;
    // A hand laid over a friend's shoulder often joins the head/neck mask on
    // just one side. That jump is an arm, not the person's chin or collar.
    if (width > headWidth * 1.8 &&
      (row.left > headCenter - headWidth * 0.62 ||
       row.right < headCenter + headWidth * 0.62)) return false;
    return true;
  };
  for (let i = 0; i < rows.length - 2; i++) {
    const r = rows[i];
    if (r.y < crown + headWidth * 1.05 || r.y > crown + headWidth * 1.8)
      continue;
    if (
      rows.slice(i, i + 3).every(shoulderExpansion)
    ) {
      chin = Math.min(r.y, crown + headWidth * 1.55);
      break;
    }
  }
  const headHeight = Math.max(4, chin - crown);
  const headOutline = rows.filter(
    (r) => r.y > crown + headHeight * 0.06 && r.y < crown + headHeight * 0.85,
  );
  const headLeft = clamp(
    Math.min(
      headCenter - headWidth * 0.48,
      quantile(
        headOutline.map((r) => r.left),
        0.15,
      ),
    ),
    Math.max(left, headCenter - headWidth * 0.64),
    right,
  );
  const headRight = clamp(
    Math.max(
      headCenter + headWidth * 0.48,
      quantile(
        headOutline.map((r) => r.right),
        0.85,
      ),
    ),
    left + 1,
    Math.min(right, headCenter + headWidth * 0.64),
  );

  const normalized = (t: number, l: number, b: number, r: number): PhotoBox => [
    clamp(t / (h - 1)),
    clamp(l / (w - 1)),
    clamp(b / (h - 1)),
    clamp(r / (w - 1)),
  ];
  const faceBox = normalized(crown, headLeft, chin, headRight);
  const shirtTop = Math.min(visibleBottom - 2, chin + headHeight * 0.17);
  const shirtBottom = Math.min(visibleBottom, chin + headHeight * 2.35);
  const torsoRows = rows.filter(
    (r) =>
      r.y >= shirtTop + (shirtBottom - shirtTop) * 0.45 && r.y <= shirtBottom,
  );
  const torsoLeft = quantile(
    torsoRows.map((r) => r.left),
    0.5,
  );
  const torsoRight = quantile(
    torsoRows.map((r) => r.right),
    0.5,
  );
  const torsoCenter = torsoRows.length
    ? (torsoLeft + torsoRight) / 2
    : headCenter;
  const chestHalfWidth = Math.max(
    3,
    Math.min((torsoRight - torsoLeft) * 0.35, headWidth * 0.78),
  );
  const chestBox = normalized(
    shirtTop,
    torsoCenter - chestHalfWidth,
    shirtBottom,
    torsoCenter + chestHalfWidth,
  );

  // A shirt crop must retain its photographic width. The old palette crop is
  // intentionally narrow and made a small printed logo fill the entire chest.
  // Follow the contiguous component under the head, rejecting a second person
  // or an arm that travels across the image. Shoulder widths are bounded by
  // anatomy; occlusion by a neighboring person cannot shrink a torso in half.
  const componentNear = (y: number, anchor: number): Span | undefined => {
    const runs: Span[] = [];
    let start = -1;
    for (let x = left; x <= right + 1; x++) {
      if (x <= right && active(x, y)) {
        if (start < 0) start = x;
      } else if (start >= 0) {
        runs.push({ left: start, right: x - 1, count: x - start, y });
        start = -1;
      }
    }
    const distance = (r: Span) => Math.max(r.left - anchor, anchor - r.right, 0);
    return runs.filter((r) => r.count > 2)
      .sort((a, b) => distance(a) - distance(b) || b.count - a.count)[0];
  };
  const garmentTop = Math.min(visibleBottom - 2, chin + headHeight * 0.04);
  const expectedHem = garmentTop + headHeight * 2.35;
  const garmentBottom = Math.min(visibleBottom, expectedHem);
  const garmentRows = rows
    .filter((r) => r.y > garmentTop + headHeight * 0.3 && r.y < garmentBottom)
    .map((r) => componentNear(r.y, headCenter))
    .filter((r): r is Span => Boolean(r));
  const usefulWidths = garmentRows
    .map((r) => r.right - r.left + 1)
    .filter((width) => width < headWidth * 3.2);
  const garmentWidth = clamp(
    quantile(usefulWidths, 0.82),
    headWidth * 1.85,
    headWidth * 2.75,
  );
  const garmentCenter = headCenter + clamp(
    quantile(garmentRows.map((r) => (r.left + r.right) / 2), 0.5) - headCenter,
    -headWidth * 0.25,
    headWidth * 0.25,
  );
  const torsoBox = normalized(
    garmentTop,
    garmentCenter - garmentWidth / 2,
    garmentBottom,
    garmentCenter + garmentWidth / 2,
  );
  const neckBox = normalized(
    Math.max(crown, chin - headHeight * 0.1),
    headCenter - headWidth * 0.3,
    Math.min(visibleBottom, chin + headHeight * 0.24),
    headCenter + headWidth * 0.3,
  );
  const photographedHeadAspect =
    ((faceBox[3] - faceBox[1]) * source.width) /
    Math.max(1, (faceBox[2] - faceBox[0]) * source.height);
  const fitAspect = photographedHeadAspect / (0.19 / 0.272);

  const collect = (area: PhotoBox, erode = false) => {
    const result: { color: RGB; x: number; y: number }[] = [];
    for (
      let y = Math.max(top, Math.floor(area[0] * (h - 1)));
      y <= Math.min(bottom, Math.ceil(area[2] * (h - 1)));
      y++
    )
      for (
        let x = Math.max(left, Math.floor(area[1] * (w - 1)));
        x <= Math.min(right, Math.ceil(area[3] * (w - 1)));
        x++
      ) {
        if (!active(x, y)) continue;
        if (
          erode &&
          (!active(x - 1, y) ||
            !active(x + 1, y) ||
            !active(x, y - 1) ||
            !active(x, y + 1))
        )
          continue;
        result.push({ color: sample(x, y), x, y });
      }
    return result;
  };
  const head = collect(faceBox, true);
  const allColors = collect(chestBox, true).map((p) => p.color);
  const chroma = [...head.map((p) => p.color), ...allColors];
  const grayscale =
    chroma.length > 0 &&
    quantile(
      chroma.map((p) => Math.max(...p) - Math.min(...p)),
      0.94,
    ) < 9;
  const skinArea = head.filter(
    (p) => p.y > crown + headHeight * 0.25 && p.y < crown + headHeight * 0.9,
  );
  const warm = skinArea.filter((p) => warmSkin(p.color));
  const skinBrightness = quantile(
    skinArea.map((p) => brightness(p.color)),
    0.48,
  );
  const skinCandidates = grayscale
    ? skinArea
        .map((p) => p.color)
        .filter((p) => brightness(p) >= skinBrightness)
    : warm.map((p) => p.color);
  const skin = dominantColor(
    skinCandidates,
    grayscale ? [145, 145, 145] : [151, 107, 78],
  );
  const crownColors = head
    .filter((p) => p.y < crown + headHeight * 0.36)
    .map((p) => p.color);
  const hair = dominantColor(crownColors, [30, 27, 24]);
  const shirtCandidates = grayscale
    ? allColors
    : allColors.filter((p) => !(warmSkin(p) && colorDistance(p, skin) < 80));
  const shirt = dominantColor(
    shirtCandidates.length ? shirtCandidates : allColors,
    [105, 105, 105],
  );
  const fullBodyVisible = visibleHeight > headHeight * 5.1;
  const pantsArea = normalized(
    chin + headHeight * 2.6,
    torsoCenter - chestHalfWidth * 0.85,
    Math.min(visibleBottom, chin + headHeight * 4.4),
    torsoCenter + chestHalfWidth * 0.85,
  );
  const pants = fullBodyVisible
    ? dominantColor(
        collect(pantsArea, true).map((p) => p.color),
        grayscale ? [43, 43, 43] : [38, 43, 49],
      )
    : grayscale
      ? ([43, 43, 43] as RGB)
      : ([38, 43, 49] as RGB);

  let yaw = 0,
    headYaw = 0;
  let sourceView: "front" | "back" = "front";
  if (!grayscale && skinArea.length > 16) {
    const centralBand = skinArea.filter(
      (p) =>
        p.y < crown + headHeight * 0.68 &&
        Math.abs(p.x - headCenter) < headWidth * 0.3,
    );
    const centralSkin = centralBand.filter((p) => warmSkin(p.color));
    const skinFraction = centralSkin.length / Math.max(1, centralBand.length);
    const darkFraction =
      centralBand.filter((p) => brightness(p.color) < 70).length /
      Math.max(1, centralBand.length);
    // A back-of-head has mostly hair across its center; a neck or ear alone must
    // not cause us to paint a new face onto the side seen in the photograph.
    if (
      (skinFraction < 0.28 && darkFraction > 0.72) ||
      /\b(back of|facing away|turned away|from behind)\b/i.test(label)
    ) {
      yaw = Math.PI;
      sourceView = "back";
    } else if (warm.length > 12) {
      const skinCenter =
        warm.reduce((total, p) => total + p.x, 0) / warm.length;
      const offset = (skinCenter - headCenter) / headWidth;
      headYaw = Math.abs(offset) > 0.065 ? clamp(offset * 3, -0.8, 0.8) : 0;
    }
  }
  const monochrome = (p: RGB): RGB => {
    const gray = Math.round(brightness(p));
    return [gray, gray, gray];
  };
  const preserve = (p: RGB) => hex(grayscale ? monochrome(p) : p);
  // Hair mass is read from the crown color's coverage of the observed head.
  // Matching the crown, rather than testing "dark", avoids treating dark skin
  // as hair. A rear view naturally shows more hair and needs a separate cap.
  const hairCoverage =
    head.filter((p) => colorDistance(p.color, hair) < 39).length /
    Math.max(1, head.length);
  const hairVolume =
    sourceView === "back" ? 0.4 : clamp((hairCoverage - 0.2) * 2.3, 0.25, 0.95);
  return {
    shirtColor: preserve(shirt),
    pantsColor: preserve(pants),
    skinColor: preserve(skin),
    hairColor: preserve(hair),
    shoeColor: grayscale ? "#252525" : "#252629",
    height: 1.76,
    yaw,
    headYaw,
    sourceView,
    sleeves: /\b(jacket|coat|sweater|long.sleeve|hoodie)\b/i.test(label)
      ? "long"
      : "short",
    hairLength: /\blong hair\b/i.test(label) ? "long" : "short",
    hairVolume: /\b(curly|afro|voluminous)\b/i.test(label)
      ? Math.max(0.85, hairVolume)
      : hairVolume,
    faceBox,
    chestBox,
    torsoBox,
    neckBox,
    headWidthScale: clamp(Math.sqrt(fitAspect), 0.86, 1.18),
    headHeightScale: clamp(1 / Math.sqrt(fitAspect), 0.9, 1.12),
    torsoWidthScale: clamp((garmentWidth / headWidth) / 2.2, 0.88, 1.22),
    torsoSourceBottom: clamp(
      (garmentBottom - garmentTop) / (expectedHem - garmentTop),
      0.25,
      1,
    ),
  };
}
