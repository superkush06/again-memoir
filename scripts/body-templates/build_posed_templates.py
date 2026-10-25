"""Export reusable CC0 templates with authored, reduced skin weights.

This adds a compact static-pose rig to build_templates.py's exact geometry.
Only authored asset data is used; no photographs or inferred identities enter
these distributable files. Run with the same environment as build_templates.
"""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import struct
import numpy as np

spec = importlib.util.spec_from_file_location('template_builder', Path(__file__).with_name('build_templates.py'))
b = importlib.util.module_from_spec(spec)
spec.loader.exec_module(b)
OUTPUT = Path('public/models/human')
BONES = ['pelvis', 'torso', 'head', 'leftUpperArm', 'leftForearm', 'leftHand',
         'rightUpperArm', 'rightForearm', 'rightHand', 'leftThigh', 'leftCalf',
         'leftFoot', 'rightThigh', 'rightCalf', 'rightFoot']


def generate(shape):
    captured = {}
    original_weights, original_operations = b.skin_weights, b.pose_operations
    original_proxy, original_split, original_export = b.fit_proxy, b.split_mesh, b.export_glb

    def skin_weights(count, skeleton):
        names, weights = original_weights(count, skeleton)
        captured.update(names=names, body_weights=weights, skeleton=skeleton)
        return names, weights

    def operations(coords, skeleton, names):
        result = original_operations(coords, skeleton, names)
        captured.update(body=coords.copy(), operations=result)
        return result

    def proxy(*args):
        result = original_proxy(*args)
        captured['proxy_weights'] = result[3]
        return result

    def split(name, vertices, uv, faces, color):
        mesh = original_split(name, vertices, uv, faces, color)
        pairs = np.unique(faces.reshape(-1, 2), axis=0)
        weights = captured['body_weights'] if name in ['Head', 'Skin'] else captured['proxy_weights']
        mesh['authored_weights'] = weights[pairs[:, 0]]
        if name == 'Head':
            captured['head_indices'] = pairs[:, 0]
        return mesh

    def export(meshes, path, metadata):
        names, skeleton = captured['names'], captured['skeleton']
        raw_posed = b.pose(captured['body'], captured['body_weights'], captured['operations'])
        head = next(m for m in meshes if m['name'] == 'Head')
        raw = raw_posed[captured['head_indices']]
        actual = head['positions']
        raw_center, actual_center = raw.mean(axis=0), actual.mean(axis=0)
        scale = ((raw-raw_center)*(actual-actual_center)).sum()/((raw-raw_center)**2).sum()
        translation = actual_center - raw_center*scale

        def point(bone, end='head'):
            result = b.joint(captured['body'], skeleton, bone, end).copy()
            index = names.index(bone)
            for pivot, rotation, indices in captured['operations']:
                if index in indices:
                    result = (result-pivot) @ rotation.T + pivot
            return result*scale+translation

        anchors = {}
        # MakeHuman anatomical R is negative X: the renderer calls that its
        # screen-left slot. This is a correspondence, not inferred handedness.
        for side, authored in [('left', 'R'), ('right', 'L')]:
            for label, bone in [('Shoulder','upperarm01'), ('Elbow','lowerarm01'),
                                ('Wrist','wrist'), ('Hip','upperleg01'),
                                ('Knee','lowerleg01'), ('Ankle','foot'), ('Toe','toe3-1')]:
                anchors[side+label] = point(f'{bone}.{authored}')
            anchors[side+'Heel'] = anchors[side+'Ankle'] + np.array([0,-.025,-.055])
            anchors[side+'HandTip'] = point(f'finger3-3.{authored}', 'tail')
        anchors['hips'] = (anchors['leftHip']+anchors['rightHip'])/2
        anchors['shoulders'] = (anchors['leftShoulder']+anchors['rightShoulder'])/2
        anchors['neck'] = point('neck01')
        above_chin = actual[actual[:,1] >= metadata['anatomicalFit']['headChinY']]
        anchors['head'] = (above_chin.min(axis=0)+above_chin.max(axis=0))/2

        correspondence = np.zeros(len(names), dtype=np.int32)
        correspondence[:] = 1
        head_bones = b.descendants(skeleton, 'neck01')
        for i, name in enumerate(names):
            if name == 'root' or name.startswith('pelvis'):
                correspondence[i] = 0
            elif name in head_bones:
                correspondence[i] = 2
        for side, authored in [('left','R'),('right','L')]:
            for root, reduced in [('upperarm01','UpperArm'),('lowerarm01','Forearm'),
                                  ('wrist','Hand'),('upperleg01','Thigh'),
                                  ('lowerleg01','Calf'),('foot','Foot')]:
                for name in b.descendants(skeleton, f'{root}.{authored}'):
                    if name in names:
                        correspondence[names.index(name)] = BONES.index(side+reduced)

        metadata['poseTemplate'] = {
            'version': 1, 'method': 'authored-weights', 'bones': BONES,
            'joints': {key: value.tolist() for key,value in anchors.items()},
            'sideConvention': 'left-slot=MakeHuman-R; right-slot=MakeHuman-L',
            'headRigidAboveY': metadata['anatomicalFit']['headChinY']-.006,
            'referenceHeight': 1.76,
        }
        metadata['pose'] = 'Reusable neutral anatomy with authored skin weights; photograph pose applied at runtime'
        original_export(meshes, path, metadata)
        file = path.read_bytes()
        json_length = struct.unpack_from('<I',file,12)[0]
        header = json.loads(file[20:20+json_length])
        binary = bytearray(file[28+json_length:])
        for mesh, gltf_mesh in zip(meshes,header['meshes']):
            reduced = np.zeros((len(mesh['positions']),len(BONES)))
            for i, slot in enumerate(correspondence):
                reduced[:,slot] += mesh['authored_weights'][:,i]
            # A rigid jaw, cheeks, nose, eyes and skull prevent the former
            # neck-fade facial distortion. Only the lower neck is blended.
            if mesh['name'] in ['Head','Hair','Eyes']:
                t = np.clip((mesh['positions'][:,1]-(metadata['anatomicalFit']['headChinY']-.09))/.084,0,1)
                t = t*t*(3-2*t)
                if mesh['name'] in ['Hair','Eyes']:
                    t[:] = 1
                reduced[:] = 0
                reduced[:,1], reduced[:,2] = 1-t,t
            if mesh['name'] == 'Shoes':
                # A shoe moves as one rigid shell with its own foot, rather
                # than inheriting ankle-skin bending that folds the sole.
                reduced[:] = 0
                for vertex,position in enumerate(mesh['positions']):
                    reduced[vertex,11 if position[0] < 0 else 14] = 1
            indices = np.argsort(-reduced,axis=1)[:,:4].astype('<u2')
            weights = np.take_along_axis(reduced,indices,axis=1)
            sums = weights.sum(axis=1)
            if np.any(sums<1e-8):
                raise ValueError('Missing authored skin weight')
            weights = (weights/sums[:,None]).astype('<f4')
            for label, array, component in [('_POSE_JOINTS',indices,5123),('_POSE_WEIGHTS',weights,5126)]:
                binary.extend(b'\0'*((-len(binary))%4))
                view = len(header['bufferViews'])
                header['bufferViews'].append({'buffer':0,'byteOffset':len(binary),'byteLength':array.nbytes,'target':34962})
                binary.extend(array.tobytes())
                accessor = len(header['accessors'])
                header['accessors'].append({'bufferView':view,'componentType':component,'count':len(array),'type':'VEC4'})
                gltf_mesh['primitives'][0]['attributes'][label] = accessor
        header['buffers'][0]['byteLength'] = len(binary)
        encoded = json.dumps(header,separators=(',',':')).encode()
        encoded += b' '*((-len(encoded))%4)
        path.write_bytes(struct.pack('<4sII',b'glTF',2,28+len(encoded)+len(binary))+
            struct.pack('<I4s',len(encoded),b'JSON')+encoded+
            struct.pack('<I4s',len(binary),b'BIN\x00')+binary)

    b.skin_weights, b.pose_operations = skin_weights, operations
    b.fit_proxy, b.split_mesh, b.export_glb = proxy, split, export
    b.ROOT = OUTPUT
    try:
        with contextlib.redirect_stdout(io.StringIO()):
            b.build(shape)
        report_path = OUTPUT/f'{shape}.json'
        report = json.loads(report_path.read_text())
        report['file'] = f'{shape}.glb'
        report_path.write_text(json.dumps(report,indent=2)+'\n')
        print(json.dumps({'shape':shape,'bytes':(OUTPUT/f'{shape}.glb').stat().st_size,'bones':len(BONES)}))
    finally:
        b.skin_weights, b.pose_operations = original_weights, original_operations
        b.fit_proxy, b.split_mesh, b.export_glb = original_proxy, original_split, original_export


if __name__ == '__main__':
    OUTPUT.mkdir(parents=True,exist_ok=True)
    for shape in ['slim','average','broad']:
        generate(shape)
