import { createDepthGeometry } from '../src/scene/reconstruction.js';

const width = 64; const height = 48;
const depth = Array.from({ length: width * height * 4 }, (_, index) => {
  const pixel = Math.floor(index / 4); const x = pixel % width; const y = Math.floor(pixel / width);
  const value = Math.max(0, Math.min(255, 80 + 120 * (y / height) + 18 * Math.sin(x / 7)));
  return index % 4 === 0 ? value : index % 4 === 3 ? 255 : 0;
});
const result = createDepthGeometry({ width, height, data: depth });
const coordinates = Array.from(result.positions);
if (!coordinates.every(Number.isFinite) || result.indices.length === 0 || result.indices.length % 3 !== 0) throw new Error('Synthetic 3D simulation produced invalid mesh data.');
console.log(JSON.stringify({ ok: true, width, height, vertices: result.positions.length / 3, triangles: result.indices.length / 3, edgeVertices: result.edgeVertexIndices.length }, null, 2));

