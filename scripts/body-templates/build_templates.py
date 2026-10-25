"""Build static clothed body templates from CC0 MakeHuman data.

This is an original data reader, morph blender and linear pose/export utility.
No MakeHuman application code is incorporated. The assets remain CC0.
"""
import argparse
import json
import math
from pathlib import Path
import struct
import sys
sys.dont_write_bytecode = True
import numpy as np
import trimesh

ROOT = Path('.local/body-templates')
DATA = ROOT / 'makehuman'
ASSETS = ROOT / 'assets'

# Reviewed hm08 surface vertices. Skeleton eye tails are gaze targets, and the
# head bone origin lies beside the upper lip: neither is a facial surface anchor.
# Keep explicit topology correspondences so hair bounds cannot move the face fit.
HEAD_LANDMARKS = [
    ('noseTip', 5054, 4), ('nasion', 132, 168),
    ('eyeOuterRight', 21, 33), ('eyeInnerRight', 66, 133),
    ('eyeOuterLeft', 6805, 263), ('eyeInnerLeft', 6850, 362),
    ('mouthCornerRight', 368, 61), ('mouthCornerLeft', 7128, 291),
    ('chinFrontBottom', 732, 152), ('forehead', 983, 10),
    ('upperLipOuter', 466, 0), ('upperLipInner', 468, 13),
    ('lowerLipInner', 493, 14), ('lowerLipOuter', 496, 17),
]
CHIN_BOTTOM_VERTEX = 991


def read_obj(path):
    vertices, uv, faces, groups = [], [], [], []
    group = 'body'
    for line in path.read_text(encoding='utf-8', errors='replace').splitlines():
        t = line.split()
        if not t:
            continue
        if t[0] == 'v':
            vertices.append([float(x) for x in t[1:4]])
        elif t[0] == 'vt':
            uv.append([float(x) for x in t[1:3]])
        elif t[0] == 'g':
            group = t[1]
        elif t[0] == 'f':
            f = []
            for part in t[1:]:
                v = part.split('/')
                f.append((int(v[0]) - 1, int(v[1]) - 1 if len(v) > 1 and v[1] else 0))
            for i in range(1, len(f)-1):
                faces.append([f[0], f[i], f[i+1]])
                groups.append(group)
    return np.asarray(vertices), np.asarray(uv), np.asarray(faces), np.asarray(groups)


def target(name, count):
    value = np.zeros((count, 3))
    for line in (DATA / f'{name}.target').read_text().splitlines():
        t = line.split()
        if len(t) == 4 and not line.startswith('#'):
            value[int(t[0])] = [float(x) for x in t[1:]]
    return value


def rotation(axis, angle):
    c, s = math.cos(angle), math.sin(angle)
    if axis == 'z':
        return np.array([[c,-s,0],[s,c,0],[0,0,1]])
    return np.array([[1,0,0],[0,c,-s],[0,s,c]])


def skin_weights(count, skeleton):
    weights = json.loads((DATA / 'default_weights.mhw').read_text())['weights']
    names = list(skeleton['bones'])
    result = np.zeros((count, len(names)))
    for name, rows in weights.items():
        if name in names:
            a = np.asarray(rows)
            result[a[:,0].astype(int), names.index(name)] = a[:,1]
    return names, result


def descendants(skeleton, root):
    result = {root}
    changed = True
    while changed:
        changed = False
        for name, bone in skeleton['bones'].items():
            if bone['parent'] in result and name not in result:
                result.add(name)
                changed = True
    return result


def joint(coords, skeleton, bone, end='head'):
    return coords[skeleton['joints'][skeleton['bones'][bone][end]]].mean(axis=0)


def pose_operations(coords, skeleton, names):
    operations = []
    for side, sign in [('L',1), ('R',-1)]:
        shoulder = joint(coords, skeleton, f'upperarm01.{side}')
        elbow = joint(coords, skeleton, f'lowerarm01.{side}')
        wrist = joint(coords, skeleton, f'wrist.{side}')
        direction = elbow - shoulder
        desired = math.atan2(-1, sign * 0.14)
        angle = desired - math.atan2(direction[1], direction[0])
        r = rotation('z', angle)
        arm = [names.index(n) for n in descendants(skeleton, f'upperarm01.{side}') if n in names]
        operations.append((shoulder, r, arm))
        elbow2 = (elbow - shoulder) @ r.T + shoulder
        wrist2 = (wrist - shoulder) @ r.T + shoulder
        direction = wrist2 - elbow2
        # Retain a slight forward bend while relaxing the strongly flexed
        # default forearms; this is a bone-space rotation using authored weights.
        angle = math.atan2(direction[2], -direction[1]) - math.radians(11 if side == 'L' else 15)
        forearm = [names.index(n) for n in descendants(skeleton, f'lowerarm01.{side}') if n in names]
        operations.append((elbow2, rotation('x', angle), forearm))
    return operations


def pose(coords, weights, operations):
    result = coords.copy()
    for pivot, r, indices in operations:
        amount = np.clip(weights[:, indices].sum(axis=1), 0, 1)
        moved = (result - pivot) @ r.T + pivot
        result += (moved - result) * amount[:,None]
    return result


def fit_proxy(path, body, body_weights):
    rows, scales, state, obj_name = [], np.ones(3), False, None
    for line in path.read_text().splitlines():
        t = line.split()
        if not t or t[0].startswith('#'):
            continue
        if t[0] == 'obj_file':
            obj_name = t[1]
        elif t[0] in ['x_scale','y_scale','z_scale']:
            axis = 'xyz'.index(t[0][0])
            scales[axis] = abs(body[int(t[1]), axis] - body[int(t[2]), axis]) / float(t[3])
        elif t[0] == 'verts':
            state = True
        elif state and t[0][0].isdigit():
            if len(t) == 1:
                i = int(t[0]); rows.append(([i,i,i], [1,0,0], [0,0,0]))
            elif len(t) >= 9:
                rows.append(([int(x) for x in t[:3]], [float(x) for x in t[3:6]], [float(x) for x in t[6:9]]))
        elif state and rows:
            state = False
    refs = np.asarray([r[0] for r in rows])
    bary = np.asarray([r[1] for r in rows])
    offsets = np.asarray([r[2] for r in rows])
    vertices, uv, faces, groups = read_obj(path.parent / obj_name)
    if len(refs) != len(vertices):
        raise ValueError(f'{path}: {len(refs)} mappings for {len(vertices)} vertices')
    fitted = (body[refs] * bary[:,:,None]).sum(axis=1) + offsets * scales
    weights = (body_weights[refs] * bary[:,:,None]).sum(axis=1)
    return fitted, uv, faces, weights


def split_mesh(name, vertices, uv, faces, color):
    # Preserve separate UV corners while retaining smooth authored topology.
    triangles = faces[:,:,0]
    normals = trimesh.Trimesh(vertices, triangles, process=False).vertex_normals
    pairs, inverse = np.unique(faces.reshape(-1,2), axis=0, return_inverse=True)
    return {'name': name, 'positions': vertices[pairs[:,0]], 'normals': normals[pairs[:,0]],
            'uv': uv[pairs[:,1]], 'faces': inverse.reshape(-1,3), 'color': color}


def export_glb(meshes, path, metadata):
    buffer = bytearray(); views = []; accessors = []; gltf_meshes = []; materials = []
    def add(array, kind, component=5126, target=34962, bounds=False):
        array = np.asarray(array, dtype='<u4' if component==5125 else '<f4')
        offset = len(buffer); buffer.extend(array.tobytes())
        view = len(views); views.append({'buffer':0,'byteOffset':offset,'byteLength':array.nbytes,'target':target})
        accessor = {'bufferView':view,'componentType':component,'count':len(array),'type':kind}
        if bounds:
            accessor.update(min=array.min(axis=0).tolist(),max=array.max(axis=0).tolist())
        index = len(accessors); accessors.append(accessor); return index
    for m in meshes:
        color = np.broadcast_to(np.asarray(m['color']), m['positions'].shape)
        linear = np.where(color <= .04045, color/12.92, ((color+.055)/1.055)**2.4)
        attributes = {'POSITION': add(m['positions'],'VEC3',bounds=True),
                      'NORMAL': add(m['normals'],'VEC3'), 'TEXCOORD_0':add(m['uv'],'VEC2'),
                      'COLOR_0':add(linear,'VEC3')}
        indices = add(m['faces'].reshape(-1),'SCALAR',5125,34963)
        mat = len(materials)
        materials.append({'name':m['name'], 'doubleSided':m['name'] in ['Shirt','Pants','Hair'],
            'pbrMetallicRoughness':{'baseColorFactor':[1,1,1,1],'metallicFactor':0,'roughnessFactor':.85}})
        gltf_meshes.append({'name':m['name'],'primitives':[{'attributes':attributes,'indices':indices,'material':mat}]})
    header = {'asset':{'version':'2.0','generator':'Authored CC0 MakeHuman template fitter'},
        'scene':0,'scenes':[{'nodes':list(range(len(meshes))),'extras':metadata}],
        'nodes':[{'name':m['name'],'mesh':i} for i,m in enumerate(meshes)],'meshes':gltf_meshes,
        'materials':materials,'buffers':[{'byteLength':len(buffer)}],'bufferViews':views,'accessors':accessors,
        'extras':metadata}
    encoded=json.dumps(header,separators=(',',':')).encode();encoded+=b' '*((-len(encoded))%4)
    path.write_bytes(struct.pack('<4sII',b'glTF',2,28+len(encoded)+len(buffer))+
        struct.pack('<I4s',len(encoded),b'JSON')+encoded+struct.pack('<I4s',len(buffer),b'BIN\x00')+buffer)


def build(variant):
    base, body_uv, body_faces, groups = read_obj(DATA/'base.obj')
    skeleton = json.loads((DATA/'default.mhskel').read_text())
    names, weights = skin_weights(len(base), skeleton)
    # Blend the three authored generic male bases evenly; these are template
    # asset categories, never an inferred ancestry classification of a person.
    body = base.copy()
    for prefix in ['african','asian','caucasian']:
        body += target(f'{prefix}-male-young',len(base))/3
    shape_weights = {'slim':{'averagemuscle-averageweight':.45,'averagemuscle-minweight':.55},
                     'average':{'averagemuscle-averageweight':1},
                     'broad':{'averagemuscle-averageweight':.35,'maxmuscle-averageweight':.4,'averagemuscle-maxweight':.25}}[variant]
    for shape, amount in shape_weights.items():
        body += amount*target(f'universal-male-young-{shape}',len(base))
    operations = pose_operations(body,skeleton,names)
    posed = pose(body,weights,operations)
    visible = body_faces[groups=='body']
    skin_indices = np.unique(visible[:,:,0])
    ymin,ymax = posed[skin_indices,1].min(),posed[skin_indices,1].max()
    scale = 1.76/(ymax-ymin)
    def normalize(vertices):
        out=vertices.copy();out[:,1]-=ymin;return out*scale
    neck_base = (joint(body,skeleton,'neck01')[1]-ymin)*scale
    head_joint = (joint(body,skeleton,'head')[1]-ymin)*scale
    pivot = normalize(joint(body,skeleton,'neck03')[None,:])[0]
    body_norm = normalize(posed)
    center_y=body_norm[visible[:,:,0],1].mean(axis=1)
    center_x=body_norm[visible[:,:,0],0].mean(axis=1)
    head_region=(center_y>=neck_base)|((center_y>neck_base-.08)&(np.abs(center_x)<.095))
    meshes=[split_mesh('Head',body_norm,body_uv,visible[head_region],[.60,.47,.37])]
    assets = [
      ('Shirt','clothes/toigo_basic_tucked_t-shirt/toigo_basic_tucked_t-shirt.mhclo',[.35,.37,.38]),
      ('Pants','clothes/toigo_wool_pants/toigo_wool_pants.mhclo',[.18,.22,.28]),
      ('Shoes','clothes/shoes02/shoes02.mhclo',[.12,.12,.12]),
      ('Hair','hair/short01/short01.mhclo',[.08,.07,.06]),
      ('Eyes','eyes/low-poly/low-poly.mhclo',[.60,.58,.54]),
    ]
    for name, relative, color in assets:
        fitted,uv,faces,proxy_weights=fit_proxy(ASSETS/relative,body,weights)
        fitted=pose(fitted,proxy_weights,operations)
        meshes.append(split_mesh(name,normalize(fitted),uv,faces,color))
    # Shirt/pants proxies describe an outer garment, not a fitted opaque shell.
    # Their lower-resolution triangles can cross the high-resolution skin.
    # Keep only exposed arms/hands below the actual sleeve cuffs; the complete
    # clothed silhouette is supplied by Shirt/Pants/Shoes instead of hidden skin.
    arm_names = descendants(skeleton,'upperarm01.L') | descendants(skeleton,'upperarm01.R')
    arm_weight = weights[:,[names.index(n) for n in arm_names if n in names]].sum(axis=1)
    shirt = next(m for m in meshes if m['name']=='Shirt')['positions']
    cuff = shirt[np.abs(shirt[:,0])>np.abs(shirt[:,0]).max()*.72,1].min()+.014
    exposed = (arm_weight[visible[:,:,0]].mean(axis=1)>.5)&(center_y<cuff)
    meshes.insert(1,split_mesh('Skin',body_norm,body_uv,visible[exposed],[.60,.47,.37]))
    # Shoes extend below authored soles. Ground the clothed result and preserve
    # a precise1.76m total height including the authored hair silhouette.
    all_points=np.concatenate([m['positions'] for m in meshes]);low=all_points[:,1].min();high=all_points[:,1].max()
    final_scale=1.76/(high-low)
    for m in meshes:
        m['positions'][:,1]-=low;m['positions']*=final_scale
    pivot[1]-=low;pivot*=final_scale
    final_body = body_norm.copy()
    final_body[:,1] -= low
    final_body *= final_scale
    chin_y = float(final_body[CHIN_BOTTOM_VERTEX, 1])
    head_landmarks = [{'name':name, 'sourceIndex':source_index,
                       'mediapipeIndex':mediapipe_index,
                       'position':final_body[source_index].tolist()}
                      for name, source_index, mediapipe_index in HEAD_LANDMARKS]
    metadata={'model':'makehuman','inputKind':'anatomical-template','shape':variant,'upAxis':'y','frontYaw':0,
        'appearance':'vertex-color','vertexColorEncoding':'linear','source':'MakeHuman hm08 + CC0 authored macro targets and clothing',
        'license':'CC0-1.0','pose':'Authored weighted shoulders and elbows relaxed; static geometry',
        'anatomicalFit':{'headPivot':pivot.tolist(),
          # The complete jaw must rotate rigidly with the eyes and nose. A fade
          # ending at the head bone would twist the lower face during head yaw.
          'headFadeStartY':chin_y-.090, 'headFadeEndY':chin_y-.006,
          'headChinY':chin_y, 'referenceHeight':1.76,
          # Keep garment photo registration independent of corrected face
          # proportions; these are its original calibration, not jaw landmarks.
          'garmentPhotoChinY':(head_joint-.02-low)*final_scale, 'garmentPhotoCrownY':1.76,
          'chinSourceIndex':CHIN_BOTTOM_VERTEX, 'headLandmarks':head_landmarks},
        'shapeWeights':shape_weights}
    output=ROOT/f'{variant}.glb';export_glb(meshes,output,metadata)
    report={**metadata,'file':str(output.resolve()),'bytes':output.stat().st_size,
            'meshes':[{ 'name':m['name'],'vertices':len(m['positions']),'triangles':len(m['faces'])} for m in meshes]}
    (ROOT/f'{variant}.json').write_text(json.dumps(report,indent=2))
    print(json.dumps(report),flush=True)


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--variant',choices=['slim','average','broad','all'],default='all')
    args=parser.parse_args()
    for variant in ['average','slim','broad'] if args.variant=='all' else [args.variant]:build(variant)
