import * as THREE from 'three';
import type { PhotoBox } from './human-appearance';
import type { VertexPhotoView } from './texture-projection';
import type { VolumePixels } from './volume';
import { warpFacePixel } from './registered-face';

const finiteVector = (value: unknown, length: number): value is number[] =>
  Array.isArray(value) && value.length === length
  && value.every(n => typeof n === 'number' && Number.isFinite(n));

/** Infer only the unseen facial surface by reflecting the observed photograph
 * across the posed head's bilateral plane. This changes no geometry and does
 * not claim to recover an unseen eye or cheek. The observed view must be applied
 * after this view so it retains priority over the inferred counterpart. */
export function mirroredFaceView(
  group: THREE.Group, source: VolumePixels, mask: VolumePixels,
): VertexPhotoView | undefined {
  group.updateMatrixWorld(true);
  const inverseRoot = group.matrixWorld.clone().invert();
  let result: VertexPhotoView | undefined;
  group.traverse(object => {
    if (result) return;
    const fit = object.userData.photoFaceFit;
    if (!fit || fit.version !== 1 || fit.preposed !== true
      || !finiteVector(fit.headPivot, 3)
      || fit.headPivot.some((v: number) => Math.abs(v) > 10)
      || !Array.isArray(fit.rotation) || fit.rotation.length !== 3
      || !fit.rotation.every((row: unknown) => finiteVector(row, 3))
      || !finiteVector(fit.sourceSize, 2)
      || fit.sourceSize.some((v: number) => v < 32 || v > 20000)
      || Math.abs(source.height - source.width * fit.sourceSize[1] / fit.sourceSize[0]) > 1
      || !Number.isFinite(fit.canonicalChinY)
      || fit.canonicalChinY < fit.headPivot[1] - .15 || fit.canonicalChinY > fit.headPivot[1] + .15
      || !finiteVector(fit.offsetPixels, 2)
      || fit.offsetPixels.some((v: number) => Math.abs(v) > 1e6)
      || !Number.isFinite(fit.pixelsPerMeter) || fit.pixelsPerMeter < 50 || fit.pixelsPerMeter > 100000
      || !finiteVector(fit.sourceBox, 4) || fit.sourceBox.some((v: number) => v < 0 || v > 1)
      || fit.sourceBox[2] - fit.sourceBox[0] < .005 || fit.sourceBox[3] - fit.sourceBox[1] < .005) return;

    const rotation = new THREE.Matrix3().set(
      fit.rotation[0][0], fit.rotation[0][1], fit.rotation[0][2],
      fit.rotation[1][0], fit.rotation[1][1], fit.rotation[1][2],
      fit.rotation[2][0], fit.rotation[2][1], fit.rotation[2][2],
    );
    const inverseRotation = rotation.clone().transpose();
    const orthogonal = inverseRotation.clone().multiply(rotation);
    if (Math.abs(rotation.determinant() - 1) > .001
      || orthogonal.elements.some((v, i) => Math.abs(v - (i % 4 === 0 ? 1 : 0)) > .001)) return;
    const matrix = new THREE.Matrix4().multiplyMatrices(inverseRoot, object.matrixWorld);
    if (!matrix.elements.every(Number.isFinite) || Math.abs(matrix.determinant()) < 1e-12) return;
    const inverse = matrix.clone().invert();
    const pivot = new THREE.Vector3().fromArray(fit.headPivot);
    // Reflection is its own inverse: the reflected camera direction is S * +Z.
    const reflection = rotation.clone().multiply(new THREE.Matrix3().set(-1, 0, 0, 0, 1, 0, 0, 0, 1))
      .multiply(inverseRotation);
    const direction = new THREE.Vector3(0, 0, 1).applyMatrix3(reflection).transformDirection(matrix);
    const box = [...fit.sourceBox] as PhotoBox;
    const point = new THREE.Vector3();
    const canonical = new THREE.Vector3();
    result = {
      image: source, mask, box, strength: 1, edgeFeather: .035,
      meshFilter: mesh => /^(head|eyes?)(?:$|[_.-])/i.test(mesh.name),
      camera: {
        direction,
        project(rootPoint) {
          point.copy(rootPoint).applyMatrix4(inverse).sub(pivot).applyMatrix3(reflection).add(pivot);
          const [pixelX, pixelY] = warpFacePixel(fit,
            point.x * fit.pixelsPerMeter + fit.offsetPixels[0],
            -point.y * fit.pixelsPerMeter + fit.offsetPixels[1]);
          // Browser decoding may downsample a large photograph. Calibration
          // remains in its original pixel coordinates; sampling uses UVs.
          const u = pixelX / fit.sourceSize[0], v = pixelY / fit.sourceSize[1];
          return { u: (u - box[1]) / (box[3] - box[1]), v: (v - box[0]) / (box[2] - box[0]), depth: point.z };
        },
      },
      acceptSample(_rgb, rootPoint) {
        canonical.copy(rootPoint).applyMatrix4(inverse).sub(pivot).applyMatrix3(inverseRotation).add(pivot);
        // The Head mesh also contains neck and the rear skull. Neither may
        // receive a mirrored mouth/eye. Coordinates are raw authored meters.
        return canonical.z >= Math.max(.075, pivot.z + .045)
          && canonical.y >= fit.canonicalChinY - .002 && canonical.y <= pivot.y + .24
          && Math.abs(canonical.x - pivot.x) <= .115;
      },
    };
  });
  return result;
}
