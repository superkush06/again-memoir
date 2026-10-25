"""Small standards-compliant GLB exporter with unquantized linear RGB colors."""
import json
import struct


def export_colored_glb(mesh, srgb_colors, path):
    import numpy as np

    color = np.asarray(srgb_colors, dtype=np.float32)
    if color.shape != (len(mesh.vertices), 3) or not np.isfinite(color).all():
        raise ValueError("Expected one finite RGB triplet for each mesh vertex")
    color = np.clip(color, 0, 1)
    linear = np.where(color <= 0.04045, color / 12.92, ((color + 0.055) / 1.055) ** 2.4)
    arrays = [np.asarray(mesh.vertices, dtype="<f4"), np.asarray(mesh.vertex_normals, dtype="<f4"),
              np.asarray(linear, dtype="<f4"), np.asarray(mesh.faces, dtype="<u4").reshape(-1)]
    blob = bytearray()
    views = []
    accessors = []
    for i, array in enumerate(arrays):
        offset = len(blob)
        blob.extend(array.tobytes())
        views.append({"buffer": 0, "byteOffset": offset, "byteLength": array.nbytes,
                      "target": 34963 if i == 3 else 34962})
        accessor = {"bufferView": i, "componentType": 5125 if i == 3 else 5126,
                    "count": len(array), "type": "SCALAR" if i == 3 else "VEC3"}
        if i == 0:
            accessor.update({"min": array.min(axis=0).tolist(), "max": array.max(axis=0).tolist()})
        accessors.append(accessor)
    gltf = {
        "asset": {"version": "2.0", "generator": "TripoSR CPU trial; linear FLOAT vertex colors"},
        "scene": 0, "scenes": [{"nodes": [0]}], "nodes": [{"mesh": 0}],
        "meshes": [{"name": "TripoSR person", "primitives": [{
            "attributes": {"POSITION": 0, "NORMAL": 1, "COLOR_0": 2}, "indices": 3, "material": 0}]}],
        "materials": [{"name": "Photographic vertex color", "doubleSided": False,
            "pbrMetallicRoughness": {"baseColorFactor": [1, 1, 1, 1], "metallicFactor": 0, "roughnessFactor": 0.85}}],
        "buffers": [{"byteLength": len(blob)}], "bufferViews": views, "accessors": accessors,
        "extras": {"sourceColorEncoding": "sRGB", "vertexColorEncoding": "linear", "colorStorage": "FLOAT"},
    }
    encoded = json.dumps(gltf, separators=(",", ":")).encode("utf-8")
    encoded += b" " * ((-len(encoded)) % 4)
    blob += b"\x00" * ((-len(blob)) % 4)
    header = struct.pack("<4sII", b"glTF", 2, 12 + 8 + len(encoded) + 8 + len(blob))
    path.write_bytes(header + struct.pack("<I4s", len(encoded), b"JSON") + encoded
                     + struct.pack("<I4s", len(blob), b"BIN\x00") + blob)
    return {"vertexColorEncoding": "linear", "sourceColorEncoding": "sRGB", "vertexColorStorage": "FLOAT"}
