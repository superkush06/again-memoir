"""Review-only hair caps from learned meshes; never changes served body assets.

Source meshes retain their original data. Output is Y-up/front +Z in the
normalized 1.76 m body frame, so the cap can be aligned to an authored scalp.
"""
import argparse
import hashlib
import json
from pathlib import Path
import struct
import sys

import numpy as np
from PIL import Image, ImageDraw
import trimesh

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "neural"))
from colored_glb import export_colored_glb


def read_mesh(path, canonical=True, mesh_name=None):
    data = path.read_bytes()
    length = struct.unpack_from("<I", data, 12)[0]
    document = json.loads(data[20:20 + length])
    binary = 28 + length
    source_mesh = next((mesh for mesh in document["meshes"] if mesh.get("name") == mesh_name), document["meshes"][0])
    primitive = source_mesh["primitives"][0]

    def array(index):
        accessor = document["accessors"][index]
        view = document["bufferViews"][accessor["bufferView"]]
        dtype = {5126: "<f4", 5125: "<u4", 5123: "<u2", 5121: "u1"}[accessor["componentType"]]
        size = {"SCALAR": 1, "VEC3": 3, "VEC4": 4}[accessor["type"]]
        result = np.frombuffer(data, dtype=dtype, count=accessor["count"] * size,
                               offset=binary + view.get("byteOffset", 0) + accessor.get("byteOffset", 0)).reshape(-1, size).copy()
        if accessor.get("normalized"):
            result = result.astype(float) / np.iinfo(np.dtype(dtype)).max
        return result

    vertices = array(primitive["attributes"]["POSITION"]).astype(float)
    colors = array(primitive["attributes"]["COLOR_0"])[:, :3].astype(float)
    colors = np.where(colors <= .0031308, colors * 12.92, 1.055 * np.power(np.maximum(colors, 0), 1 / 2.4) - .055)
    faces = array(primitive["indices"]).reshape(-1, 3)
    if canonical:
        # R_y(-pi/2) R_x(-pi/2): (x, y, z) -> (y, z, x).
        vertices = vertices[:, [1, 2, 0]]
        bounds = np.array([vertices.min(axis=0), vertices.max(axis=0)])
        scale = 1.76 / (bounds[1, 1] - bounds[0, 1])
        vertices -= [(bounds[0, 0] + bounds[1, 0]) / 2, bounds[0, 1], (bounds[0, 2] + bounds[1, 2]) / 2]
        vertices *= scale
    return trimesh.Trimesh(vertices=vertices, faces=faces, process=False), colors


def export_cap(cap, colors, path, metadata):
    export_colored_glb(cap, colors, path)
    data = path.read_bytes()
    length = struct.unpack_from("<I", data, 12)[0]
    document = json.loads(data[20:20 + length])
    binary = data[28 + length:]
    document["asset"]["generator"] = "Review-only learned hair cap extraction"
    document["nodes"][0]["name"] = "Hair"
    document["meshes"][0]["name"] = "Hair"
    document["extras"].update(metadata)
    encoded = json.dumps(document, separators=(",", ":")).encode()
    encoded += b" " * (-len(encoded) % 4)
    total = 12 + 8 + len(encoded) + 8 + len(binary)
    path.write_bytes(struct.pack("<4sII", b"glTF", 2, total)
        + struct.pack("<I4s", len(encoded), b"JSON") + encoded
        + struct.pack("<I4s", len(binary), b"BIN\x00") + binary)


def align_neutral(cap, source_yaw, target_size, target_top, target_center_z):
    candidate = cap.copy()
    center = candidate.bounds.mean(axis=0)
    vertices = candidate.vertices - center
    c, s = np.cos(-source_yaw), np.sin(-source_yaw)
    rotation = np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]])
    vertices = vertices @ rotation.T
    current = np.ptp(vertices, axis=0)
    scale = np.asarray(target_size) / current
    vertices *= scale
    vertices[:, 0] -= (vertices[:, 0].min() + vertices[:, 0].max()) / 2
    vertices[:, 1] += target_top - vertices[:, 1].max()
    vertices[:, 2] += target_center_z - (vertices[:, 2].min() + vertices[:, 2].max()) / 2
    # Keep the cap outside the authored upper scalp; the raw learned surface
    # may be concave at a few triangles despite having the correct outline.
    scalp_center = np.array([0., 1.65, target_center_z])
    radius = np.array([.086, .100, .094])
    radial = vertices - scalp_center
    distance = np.linalg.norm(radial / radius, axis=1)
    inside = (distance < 1.025) & (distance > 1e-6) & (vertices[:, 1] > 1.63)
    vertices[inside] = scalp_center + radial[inside] * (1.025 / distance[inside, None])
    candidate.vertices = vertices
    return candidate, {"sourceHeadYaw": source_yaw, "neutralizedHeadYaw": True,
                       "targetScalpFitScale": scale.tolist(), "fittedBounds": candidate.bounds.tolist(),
                       "upperScalpClearanceVertices": int(inside.sum()),
                       "alignmentCaveat": "Reviewed approximate scalp fitting, not measured hair or face geometry"}


def close_small_holes(mesh, colors):
    edges = mesh.edges
    ordered = np.sort(edges, axis=1)
    unique, inverse, counts = np.unique(ordered, axis=0, return_inverse=True, return_counts=True)
    boundary = edges[counts[inverse] == 1]
    components = trimesh.graph.connected_components(np.sort(boundary, axis=1), nodes=np.unique(boundary))
    vertices = list(mesh.vertices.copy())
    output_colors = list(colors.copy())
    faces = list(mesh.faces.copy())
    filled = 0
    for component in components:
        points = mesh.vertices[component]
        # Keep the face/neck opening. Close only tiny interior holes left by
        # removing isolated warm-color pixels from the learned hair surface.
        if len(component) > 32 or np.linalg.norm(np.ptp(points, axis=0)) > .07:
            continue
        members = set(component)
        ring = [edge for edge in boundary if edge[0] in members and edge[1] in members]
        if len(ring) != len(component):
            continue
        center = len(vertices)
        vertices.append(points.mean(axis=0))
        output_colors.append(colors[component].mean(axis=0))
        faces.extend([int(b), int(a), center] for a, b in ring)
        filled += 1
    return trimesh.Trimesh(vertices=np.array(vertices), faces=np.array(faces), process=False), np.array(output_colors), filled


def extract(mesh, colors, lower, threshold):
    vertices = mesh.vertices
    luminance = colors @ [.2126, .7152, .0722]
    skin_warmth = colors[:, 0] - colors[:, 2]
    # A bright warm forehead should not become a hair fringe. Very dark pixels
    # remain eligible even when reflected street light gives them a warm cast.
    darkness = np.clip((threshold - luminance) / .07, 0, 1)
    warmth = np.clip((.07 - skin_warmth) / .06, 0, 1)
    score = darkness * np.maximum(warmth, np.clip((.075 - luminance) / .04, 0, 1))
    score *= np.clip((vertices[:, 1] - lower) / .035, 0, 1)
    crown = vertices[:, 1] > 1.705
    score[crown] = np.maximum(score[crown], .95)
    neighbors = mesh.vertex_neighbors
    for _ in range(2):
        score = .65 * score + .35 * np.array([score[adjacent].mean() if adjacent else 0 for adjacent in neighbors])
    chosen = (score[mesh.faces].mean(axis=1) >= .48) & (vertices[mesh.faces, 1].min(axis=1) >= lower)
    faces = mesh.faces[chosen]
    if not len(faces):
        raise ValueError("No hair surface passed the color/height threshold")
    temporary = trimesh.Trimesh(vertices=vertices, faces=faces, process=False)
    components = trimesh.graph.connected_components(temporary.face_adjacency, nodes=np.arange(len(faces)), min_len=1)
    component = max(components, key=len)
    faces = faces[component]
    used = np.unique(faces)
    remap = np.full(len(vertices), -1)
    remap[used] = np.arange(len(used))
    cap = trimesh.Trimesh(vertices=vertices[used].copy(), faces=remap[faces], process=False)
    # Smooth only the cut border, preserving the learned crown and hair outline.
    edges, count = np.unique(np.sort(cap.edges, axis=1), axis=0, return_counts=True)
    boundary = np.unique(edges[count == 1])
    for _ in range(2):
        moved = cap.vertices.copy()
        for index in boundary:
            adjacent = cap.vertex_neighbors[index]
            if adjacent:
                moved[index] = .8 * cap.vertices[index] + .2 * cap.vertices[adjacent].mean(axis=0)
        cap.vertices = moved
    return cap, colors[used], {
        "colorLuminanceThreshold": threshold,
        "minimumHeight": lower,
        "selection": "height + learned surface color + largest connected hair component",
        "boundarySmoothingIterations": 2,
        "vertices": len(cap.vertices), "triangles": len(cap.faces),
        "bounds": cap.bounds.tolist(), "sourceHeadBounds": [mesh.vertices[vertices[:, 1] >= lower].min(axis=0).tolist(), mesh.vertices[vertices[:, 1] >= lower].max(axis=0).tolist()],
        "openScalpBoundary": True,
    }


def render(mesh, colors, yaw, width=220, height=270, lighting=False):
    image = Image.new("RGB", (width, height), (228, 229, 232))
    draw = ImageDraw.Draw(image)
    vertices = mesh.vertices.copy()
    center = np.array([0, 1.63, 0])
    vertices -= center
    c, s = np.cos(yaw), np.sin(yaw)
    rotation = np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]])
    vertices = vertices @ rotation.T
    screen = np.column_stack([width / 2 + vertices[:, 0] * 650, height / 2 - vertices[:, 1] * 650])
    depth = vertices[mesh.faces, 2].mean(axis=1)
    illumination = .6 + .4 * np.maximum(0, (mesh.face_normals @ rotation.T) @ np.array([.3, .45, .84])) if lighting else np.ones(len(mesh.faces))
    for index in np.argsort(depth):
        face = mesh.faces[index]
        if mesh.vertices[face, 1].max() < 1.47:
            continue
        shade = np.clip(colors[face].mean(axis=0) * 255 * illumination[index], 0, 255).astype(int)
        draw.polygon([tuple(point) for point in screen[face]], fill=tuple(shade))
    return image


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", default=".local/body-hair")
    parser.add_argument("--template", default=".local/body-templates/average.glb")
    args = parser.parse_args()
    output = Path(args.output)
    output.mkdir(parents=True, exist_ok=True)
    sources = [
        ("color-right", Path(".local/neural-trial/person-256.glb"), 1.490, .28, 1.0, [.255, .240, .26], 1.80),
        ("color-middle", Path(".local/neural-color-middle/person.glb"), 1.555, .27, -1.0, [.191, .18, .215], 1.76),
        ("color-left", Path(".local/neural-color-left/person.glb"), 1.545, .27, -.7, [.201, .20, .225], 1.77),
    ]
    report = {"status": "review-only", "activated": False, "upAxis": "y", "frontYaw": 0,
              "bodyHeight": 1.76, "sourceUpAxis": "z", "sourceFrontYaw": -np.pi / 2,
              "caveat": "Hair shape was inferred by TripoSR from an AI-completed reference; it is not a measured scan.", "candidates": []}
    sheet = Image.new("RGB", (1320, 3 * 300), "white")
    labels = ImageDraw.Draw(sheet)
    fitting = Image.new("RGB", (660, 3 * 300), "white")
    fit_labels = ImageDraw.Draw(fitting)
    head, head_colors = read_mesh(Path(args.template), canonical=False, mesh_name="Head")
    eyes, eye_colors = read_mesh(Path(args.template), canonical=False, mesh_name="Eyes")
    for row, (name, source, lower, threshold, source_yaw, target_size, target_top) in enumerate(sources):
        mesh, colors = read_mesh(source)
        cap, cap_colors, details = extract(mesh, colors, lower, threshold)
        destination = output / f"{name}-hair-v1.glb"
        export_cap(cap, cap_colors, destination, {"reviewOnly": True, "space": "source-posed-body", "subject": name})
        neutral, alignment = align_neutral(cap, source_yaw, target_size, target_top, .0405)
        neutral, neutral_colors, filled = close_small_holes(neutral, cap_colors)
        alignment["filledSmallInteriorHoles"] = filled
        neutral_destination = output / f"{name}-hair-neutral-v1.glb"
        export_cap(neutral, neutral_colors, neutral_destination, {"reviewOnly": True, "space": "authored-neutral-head", "subject": name, **alignment})
        metadata = {"subject": name, "source": str(source), "sourceSha256": hashlib.sha256(source.read_bytes()).hexdigest(),
                    "asset": str(destination), "neutralAsset": str(neutral_destination),
                    "acceptedForGraft": name != "color-middle", "review": "Use authored short-hair fallback; extracted cap leaves a rear scalp gap" if name == "color-middle" else "Accepted candidate after front, side and rear scalp alignment review",
                    **details, **alignment}
        (output / f"{name}-hair-v1.json").write_text(json.dumps({**report, **metadata, "candidates": None}, indent=2))
        report["candidates"].append(metadata)
        for column, (yaw, label) in enumerate([(0, "front"), (np.pi / 2, "side"), (np.pi, "back")]):
            x = column * 440
            sheet.paste(render(mesh, colors, yaw), (x, row * 300 + 25))
            sheet.paste(render(cap, cap_colors, yaw), (x + 220, row * 300 + 25))
            labels.text((x + 8, row * 300 + 6), f"{name} {label}: source / isolated hair", fill="black")
            assembled = trimesh.util.concatenate([head, eyes, neutral])
            assembled_colors = np.concatenate([head_colors, eye_colors, neutral_colors])
            fitting.paste(render(assembled, assembled_colors, yaw, lighting=True), (column * 220, row * 300 + 25))
            fit_labels.text((column * 220 + 8, row * 300 + 6), f"{name}: {label}", fill="black")
    sheet.save(output / "hair-review-v1.png")
    fitting.save(output / "hair-template-fit-v1.png")
    (output / "report.json").write_text(json.dumps(report, indent=2))
    print(json.dumps({"report": str(output / "report.json"), "preview": str(output / "hair-review-v1.png"),
                      "triangles": [item["triangles"] for item in report["candidates"]]}))


if __name__ == "__main__":
    main()
