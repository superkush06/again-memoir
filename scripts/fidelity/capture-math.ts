export function cappedDimensions(
  width: number,
  height: number,
  maxEdge: number,
) {
  if (
    ![width, height, maxEdge].every(Number.isSafeInteger) ||
    width < 2 ||
    height < 2 ||
    maxEdge < 2
  ) {
    throw new Error("Image dimensions and maximum edge must be integers >= 2");
  }
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  return {
    width: Math.max(2, Math.round(width * scale)),
    height: Math.max(2, Math.round(height * scale)),
  };
}

/** Pixel-centre nearest sampling; never interpolates depth across boundaries. */
export function capDepthNearest(
  depth: { width: number; height: number; data: ArrayLike<number> },
  maxEdge: number,
) {
  const size = cappedDimensions(depth.width, depth.height, maxEdge);
  if (depth.data.length !== depth.width * depth.height * 4)
    throw new Error("Depth requires four channels per pixel");
  const data = new Uint8ClampedArray(size.width * size.height * 4);
  for (let y = 0; y < size.height; y++) {
    const sy = Math.min(
      depth.height - 1,
      Math.floor(((y + 0.5) * depth.height) / size.height),
    );
    for (let x = 0; x < size.width; x++) {
      const sx = Math.min(
        depth.width - 1,
        Math.floor(((x + 0.5) * depth.width) / size.width),
      );
      const source = (sy * depth.width + sx) * 4;
      const target = (y * size.width + x) * 4;
      for (let c = 0; c < 4; c++) data[target + c] = depth.data[source + c];
    }
  }
  return { ...size, data };
}
