import * as THREE from 'three';
import type { PhotoProjection } from './texture-projection';
import type { PhotoBox } from './human-appearance';

/** A bounded residual image registration keeps eyes/lips on their landmarks
 * without pulling anatomically correct geometry into an extreme shape. */
export function warpFacePixel(fit: { textureWarp?: unknown }, x: number, y: number): [number, number] {
  const warp = fit.textureWarp as { centers?: number[][]; coefficients?: number[][]; radiusPixels?: number; maxDisplacementPixels?: number } | undefined;
  if (!warp || !Array.isArray(warp.centers) || !Array.isArray(warp.coefficients)
    || warp.centers.length < 3 || warp.centers.length > 32 || warp.centers.length !== warp.coefficients.length
    || !Number.isFinite(warp.radiusPixels) || warp.radiusPixels! < 1 || warp.radiusPixels! > 500
    || !Number.isFinite(warp.maxDisplacementPixels) || warp.maxDisplacementPixels! < 0 || warp.maxDisplacementPixels! > 20) return [x, y];
  let dx = 0, dy = 0;
  for (let i = 0; i < warp.centers.length; i++) {
    const center = warp.centers[i], coefficient = warp.coefficients[i];
    if (!Array.isArray(center) || !Array.isArray(coefficient) || center.length !== 2 || coefficient.length !== 2
      || ![...center, ...coefficient].every(n => Number.isFinite(n) && Math.abs(n) < 100000)) return [x, y];
    const weight = Math.exp(-((x - center[0]) ** 2 + (y - center[1]) ** 2) / (2 * warp.radiusPixels! ** 2));
    dx += weight * coefficient[0]; dy += weight * coefficient[1];
  }
  const amount = Math.min(1, warp.maxDisplacementPixels! / Math.max(Math.hypot(dx, dy), 1e-9));
  return [x + dx * amount, y + dy * amount];
}

/** Camera calibration stored with an offline, landmark-fitted anatomical head.
 * Coordinates belong to the GLB scene, before loader normalization/centering. */
export function registeredFaceOf(group: THREE.Group) {
  group.updateMatrixWorld(true);
  const inverseRoot = group.matrixWorld.clone().invert();
  let result: {
    camera: (box: PhotoBox) => PhotoProjection;
    sourceBox: PhotoBox;
    landmarkErrorPixels: number;
    strategy: string;
  } | undefined;
  group.traverse(object => {
    if (result) return;
    const fit = object.userData.photoFaceFit;
    if (!fit || fit.version !== 1 || fit.preposed !== true
      || !Array.isArray(fit.sourceSize) || fit.sourceSize.length !== 2
      || !fit.sourceSize.every((n: unknown) => typeof n === 'number' && Number.isFinite(n) && n >= 32 && n <= 20000)
      || !Number.isFinite(fit.pixelsPerMeter) || fit.pixelsPerMeter < 50 || fit.pixelsPerMeter > 100000
      || !Array.isArray(fit.offsetPixels) || fit.offsetPixels.length !== 2
      || !fit.offsetPixels.every((n: unknown) => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) < 1e6)
      || !Array.isArray(fit.sourceBox) || fit.sourceBox.length !== 4
      || !fit.sourceBox.every((n: unknown) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1)
      || fit.sourceBox[2] - fit.sourceBox[0] < .005 || fit.sourceBox[3] - fit.sourceBox[1] < .005
      || !Number.isFinite(fit.landmarkErrorPixels) || fit.landmarkErrorPixels < 0 || fit.landmarkErrorPixels > 50) return;
    const matrix = new THREE.Matrix4().multiplyMatrices(inverseRoot, object.matrixWorld);
    const inverse = matrix.clone().invert();
    const direction = new THREE.Vector3(0, 0, 1).transformDirection(matrix);
    const point = new THREE.Vector3();
    result = {
      sourceBox: [...fit.sourceBox] as PhotoBox,
      landmarkErrorPixels: fit.landmarkErrorPixels,
      strategy: typeof fit.strategy === 'string' ? fit.strategy : 'landmark-registration',
      camera: (box: PhotoBox) => ({
        direction: direction.clone(),
        project: (rootPoint: THREE.Vector3) => {
          point.copy(rootPoint).applyMatrix4(inverse);
          const [x, y] = warpFacePixel(fit, point.x * fit.pixelsPerMeter + fit.offsetPixels[0], -point.y * fit.pixelsPerMeter + fit.offsetPixels[1]);
          const u = x / fit.sourceSize[0];
          const v = y / fit.sourceSize[1];
          return { u: (u - box[1]) / (box[3] - box[1]), v: (v - box[0]) / (box[2] - box[0]), depth: point.z };
        },
      }),
    };
  });
  return result;
}
