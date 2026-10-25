"""Fit a complete authored head to local photo landmarks; never synthesize pixels.

Compare rigid registration against a bounded, smooth face-only residual fit.
The skull, UV topology, body and original colors are retained. Outputs are review
artifacts until explicitly activated by scripts/import-neural-asset.ts.
"""
import argparse
import copy
import importlib.util
import json
from pathlib import Path
import sys
import numpy as np
from scipy.optimize import least_squares
from scipy.spatial.transform import Rotation
from scipy.spatial.distance import cdist
import trimesh

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('glb_io', 'scripts/body-hair/graft_caps.py')
glb = importlib.util.module_from_spec(spec)
spec.loader.exec_module(glb)


def attribute(doc, binary, index):
    a = doc['accessors'][index]
    v = doc['bufferViews'][a['bufferView']]
    types = {5126: '<f4', 5125: '<u4', 5123: '<u2', 5121: 'u1'}
    dimensions = {'VEC3': 3, 'VEC2': 2, 'SCALAR': 1}
    dtype = np.dtype(types[a['componentType']])
    count = dimensions[a['type']]
    return np.ndarray((a['count'], count), dtype=dtype, buffer=binary,
        offset=v.get('byteOffset', 0) + a.get('byteOffset', 0),
        strides=(v.get('byteStride', count * dtype.itemsize), dtype.itemsize))


def fit_asset(template, output, dataset, face, strategy):
    doc, contents = glb.read_glb(template)
    binary = bytearray(contents)
    fit = doc['scenes'][0]['extras']['anatomicalFit']
    anchors = [a for a in fit['headLandmarks'] if a['mediapipeIndex'] in [4, 168, 33, 133, 263, 362, 61, 291, 152, 10]]
    ids = np.array([a['mediapipeIndex'] for a in anchors])
    points = np.array([a['position'] for a in anchors])
    observed = np.array(face['screenPositionsPixels'])[ids, :2]
    initial_rotation = np.array(face['screenSimilarity']['rotation'])
    pivot = np.array(fit['headPivot'])
    centered = points - pivot
    initial_scale = np.linalg.norm(observed - observed.mean(axis=0)) / np.linalg.norm((centered @ initial_rotation.T)[:, :2] - (centered @ initial_rotation.T)[:, :2].mean(axis=0))
    rotation_vector = Rotation.from_matrix(initial_rotation).as_rotvec()
    initial_translation = (observed - initial_scale * (centered @ initial_rotation.T)[:, :2]).mean(axis=0)
    initial = np.r_[rotation_vector, np.log(initial_scale), initial_translation]
    # Occluded-side eye/corner detections are estimates, so they cannot steer
    # the shape as strongly as the observed near side of a profile.
    canonical = np.array(dataset['canonical']['positions'])
    yaw_sign = initial_rotation[0, 2]
    weights = np.ones(len(ids))
    if abs(yaw_sign) > .45:
        for i, index in enumerate(ids):
            if canonical[index, 0] * yaw_sign > 1.0:
                weights[i] = .25
    weights[ids == 10] = .45

    def residual(parameters):
        rotation = Rotation.from_rotvec(parameters[:3]).as_matrix()
        predicted = np.exp(parameters[3]) * (centered @ rotation.T)[:, :2] + parameters[4:6]
        return np.r_[((predicted - observed) * np.sqrt(weights[:, None])).ravel(),
                     (parameters[:3] - rotation_vector) * 60]

    solution = least_squares(residual, initial, loss='soft_l1', f_scale=3,
        bounds=(np.r_[rotation_vector - .45, np.log(initial_scale / 1.6), [-1e5, -1e5]],
                np.r_[rotation_vector + .45, np.log(initial_scale * 1.6), [1e5, 1e5]]), max_nfev=250)
    rotation = Rotation.from_rotvec(solution.x[:3]).as_matrix()
    scale = np.exp(solution.x[3])
    translation = solution.x[4:6]
    posed_anchors = centered @ rotation.T + pivot
    residual_xy = observed - (scale * (centered @ rotation.T)[:, :2] + translation)
    delta = np.column_stack([residual_xy / scale, np.zeros(len(ids))])
    delta *= np.minimum(1, .007 / np.maximum(np.linalg.norm(delta, axis=1), 1e-12))[:, None]
    delta *= weights[:, None]
    radius = .032
    kernel = np.exp(-cdist(posed_anchors, posed_anchors, 'sqeuclidean') / (2 * radius * radius))
    coefficients = np.linalg.solve(kernel + np.eye(len(ids)) * .18, delta)
    inverse_rotation = rotation.T

    def warp(posed):
        if strategy == 'rigid':
            return np.zeros_like(posed)
        values = np.exp(-cdist(posed, posed_anchors, 'sqeuclidean') / (2 * radius * radius)) @ coefficients
        values *= np.minimum(1, .008 / np.maximum(np.linalg.norm(values, axis=1), 1e-12))[:, None]
        canonical_points = (posed - pivot) @ inverse_rotation.T + pivot
        z_weight = np.clip((canonical_points[:, 2] - .065) / .045, 0, 1)
        y_weight = np.clip((canonical_points[:, 1] - fit['headChinY'] + .004) / .018, 0, 1)
        return values * (z_weight * y_weight)[:, None]

    max_warp = 0.
    inversions = 0
    min_area_ratio = 1.
    for mesh in doc['meshes']:
        if mesh['name'] not in ['Head', 'Eyes', 'Hair']:
            continue
        for primitive in mesh['primitives']:
            index = primitive['attributes']['POSITION']
            positions = attribute(doc, binary, index)
            original = positions.copy().astype(float)
            weight = np.clip((original[:, 1] - fit['headFadeStartY']) / (fit['headFadeEndY'] - fit['headFadeStartY']), 0, 1)
            weight = weight * weight * (3 - 2 * weight)
            rotated = (original - pivot) @ rotation.T + pivot
            posed = original + (rotated - original) * weight[:, None]
            displacement = warp(posed) if mesh['name'] in ['Head', 'Eyes'] else np.zeros_like(posed)
            new_positions = posed + displacement
            max_warp = max(max_warp, float(np.linalg.norm(displacement, axis=1).max()))
            triangles = attribute(doc, binary, primitive['indices']).ravel()
            triangles = triangles.reshape(-1, 3)
            old_edges = posed[triangles]
            new_edges = new_positions[triangles]
            old_normal = np.cross(old_edges[:, 1] - old_edges[:, 0], old_edges[:, 2] - old_edges[:, 0])
            new_normal = np.cross(new_edges[:, 1] - new_edges[:, 0], new_edges[:, 2] - new_edges[:, 0])
            areas = np.linalg.norm(old_normal, axis=1)
            valid = areas > 1e-10
            inversions += int(np.sum(np.einsum('ij,ij->i', old_normal, new_normal)[valid] <= 0))
            min_area_ratio = min(min_area_ratio, float((np.linalg.norm(new_normal, axis=1)[valid] / areas[valid]).min()))
            positions[:] = new_positions
            doc['accessors'][index]['min'] = new_positions.min(axis=0).tolist()
            doc['accessors'][index]['max'] = new_positions.max(axis=0).tolist()
            normals = trimesh.Trimesh(new_positions, triangles, process=False).vertex_normals.copy()
            # UV seams duplicate positions; average their normals to avoid a
            # visible shading seam without merging or changing the UV topology.
            _, inverse = np.unique(np.round(new_positions, 6), axis=0, return_inverse=True)
            sums = np.zeros((inverse.max() + 1, 3))
            np.add.at(sums, inverse, normals)
            normals = sums[inverse]
            normals /= np.maximum(np.linalg.norm(normals, axis=1), 1e-12)[:, None]
            attribute(doc, binary, primitive['attributes']['NORMAL'])[:] = normals
    if inversions or min_area_ratio < .2:
        raise ValueError(f'Unsafe face deformation: {inversions} flipped triangles; min area ratio {min_area_ratio}')
    projected = scale * (posed_anchors + warp(posed_anchors) - pivot)[:, :2] + translation
    errors = np.linalg.norm(projected - observed, axis=1)
    # Small residual differences belong in photo registration, not in a larger
    # deformation of the nose or eye socket. Anchor only the observed side.
    visible = weights >= .45
    texture_centers = projected[visible] * [1, -1]
    texture_delta = (observed[visible] - projected[visible]) * [1, -1]
    texture_delta *= np.minimum(1, 12 / np.maximum(np.linalg.norm(texture_delta, axis=1), 1e-9))[:, None]
    texture_radius = float(scale * .035)
    texture_kernel = np.exp(-cdist(texture_centers, texture_centers, 'sqeuclidean') / (2 * texture_radius ** 2))
    texture_coefficients = np.linalg.solve(texture_kernel + np.eye(len(texture_centers)) * .08, texture_delta)
    texture_shift = texture_kernel @ texture_coefficients
    texture_shift *= np.minimum(1, 12 / np.maximum(np.linalg.norm(texture_shift, axis=1), 1e-9))[:, None]
    texture_after = texture_centers + texture_shift
    texture_error = float(np.sqrt(np.mean(np.sum((texture_after - observed[visible] * [1, -1]) ** 2, axis=1))))
    source_box = np.array(face['sourceHeadBoxPixels'], dtype=float) / np.array([dataset['height'], dataset['width'], dataset['height'], dataset['width']])
    # Include the detected chin even when the old manually selected crop stops
    # a few pixels above it. Never let the image projection stretch a crop.
    landmarks = np.array(face['landmarks'])
    source_box[2] = min(1, max(source_box[2], landmarks[152, 1] + .008))
    calibration = {'version': 1, 'preposed': True, 'strategy': f'landmark-{strategy}-registration',
        'sourceSize': [dataset['width'], dataset['height']], 'sourceSha256': dataset['sourceSha256'],
        'pixelsPerMeter': float(scale),
        'offsetPixels': [float(translation[0] - scale * pivot[0]), float(-translation[1] + scale * pivot[1])],
        'sourceBox': source_box.tolist(), 'rotation': rotation.tolist(), 'headPivot': pivot.tolist(),
        'canonicalChinY': fit['headChinY'],
        'landmarkErrorPixels': float(np.sqrt(np.average(errors ** 2, weights=weights))),
        'maxDisplacementMeters': max_warp, 'triangleInversions': inversions, 'minimumTriangleAreaRatio': min_area_ratio,
        'textureWarp': {'centers': texture_centers.tolist(), 'coefficients': texture_coefficients.tolist(),
            'radiusPixels': texture_radius, 'maxDisplacementPixels': 12},
        'textureLandmarkErrorPixels': texture_error,
        'landmarks': [{'index': int(index), 'errorPixels': float(error)} for index, error in zip(ids, errors)]}
    all_min, all_max = [], []
    for mesh in doc['meshes']:
        for primitive in mesh['primitives']:
            accessor = doc['accessors'][primitive['attributes']['POSITION']]
            all_min.append(accessor['min'][1]); all_max.append(accessor['max'][1])
    for extras in [doc['extras'], doc['scenes'][0]['extras']]:
        extras['photoFaceFit'] = calibration
        extras['anatomicalFit']['referenceHeight'] = max(all_max) - min(all_min)
        extras['anatomicalFit']['headChinY'] = float(posed_anchors[ids == 152, 1][0])
    glb.write_glb(output, doc, bytes(binary))
    return {'path': str(output), 'subjectId': face['subjectId'], **calibration}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--set', choices=['color', 'mono', 'all'], default='all')
    parser.add_argument('--strategy', choices=['rigid', 'bounded', 'both'], default='both')
    args = parser.parse_args()
    output = Path('.local/face-fitting/fitted'); output.mkdir(parents=True, exist_ok=True)
    reports = []
    for name in ['color', 'mono'] if args.set == 'all' else [args.set]:
        data = json.loads(Path(f'.local/face-fitting/{name}-landmarks.json').read_text())
        for face in data['faces']:
            if face['status'] != 'detected':
                continue
            for shape in ['slim', 'average', 'broad']:
                template = Path(f'.local/body-hair/subject-1-{shape}.glb') if name == 'color' and face['subjectId'] == 'subject-1' else Path(f'.local/body-templates/{shape}.glb')
                for strategy in ['rigid', 'bounded'] if args.strategy == 'both' else [args.strategy]:
                    path = output / f'{name}-{face["subjectId"]}-{shape}-{strategy}.glb'
                    report = fit_asset(template, path, data, face, strategy)
                    reports.append(report)
                    print(json.dumps({k: report[k] for k in ['path', 'landmarkErrorPixels', 'maxDisplacementMeters', 'minimumTriangleAreaRatio']}), flush=True)
    (output / 'report.json').write_text(json.dumps(reports, indent=2))


if __name__ == '__main__':
    main()
