"""Replace only a template's named Hair primitive with reviewed learned hair.

Preserves authored faces, clothing, UVs, source geometry and linear color data.
Outputs review-only complete GLBs; never activates a reconstruction manifest.
"""
import argparse
import copy
import hashlib
import json
from pathlib import Path
import struct


def read_glb(path):
    data = path.read_bytes()
    if data[:4] != b"glTF" or struct.unpack_from("<I", data, 4)[0] != 2:
        raise ValueError(f"Not a GLB 2 file: {path}")
    length = struct.unpack_from("<I", data, 12)[0]
    document = json.loads(data[20:20 + length])
    binary = data[28 + length:28 + length + document["buffers"][0]["byteLength"]]
    return document, binary


def write_glb(path, document, binary):
    document["buffers"] = [{"byteLength": len(binary)}]
    encoded = json.dumps(document, separators=(",", ":")).encode()
    encoded += b" " * (-len(encoded) % 4)
    binary += b"\x00" * (-len(binary) % 4)
    length = 12 + 8 + len(encoded) + 8 + len(binary)
    path.write_bytes(struct.pack("<4sII", b"glTF", 2, length)
        + struct.pack("<I4s", len(encoded), b"JSON") + encoded
        + struct.pack("<I4s", len(binary), b"BIN\x00") + binary)


def graft(template_path, cap_path, output, subject, review):
    document, binary = read_glb(template_path)
    cap, cap_binary = read_glb(cap_path)
    matching = [mesh for mesh in document["meshes"] if mesh.get("name") == "Hair"]
    if len(matching) != 1:
        raise ValueError("Expected exactly one authored Hair mesh")
    hair = matching[0]
    original_hair = copy.deepcopy(hair)
    binary += b"\x00" * (-len(binary) % 4)
    binary_offset = len(binary)
    view_offset = len(document["bufferViews"])
    accessor_offset = len(document["accessors"])
    material_offset = len(document.get("materials", []))
    for source in cap["bufferViews"]:
        item = copy.deepcopy(source)
        item["buffer"] = 0
        item["byteOffset"] = source.get("byteOffset", 0) + binary_offset
        document["bufferViews"].append(item)
    for source in cap["accessors"]:
        item = copy.deepcopy(source)
        item["bufferView"] += view_offset
        document["accessors"].append(item)
    document.setdefault("materials", []).extend(copy.deepcopy(cap.get("materials", [])))
    primitives = copy.deepcopy(cap["meshes"][0]["primitives"])
    for primitive in primitives:
        primitive["attributes"] = {key: value + accessor_offset for key, value in primitive["attributes"].items()}
        primitive["indices"] += accessor_offset
        if "material" in primitive:
            primitive["material"] += material_offset
    hair["primitives"] = primitives
    hair["extras"] = {"source": "TripoSR learned hair cap", "sourceHair": True, "subject": subject, "preserveVertexColors": True,
                     "neutralizedSourcePose": True, "sourceSha256": hashlib.sha256(cap_path.read_bytes()).hexdigest()}
    # The original pivot coordinates remain in the same raw body frame. Update
    # the reference height because the afro extends above the authored scalp.
    minima, maxima = [], []
    for mesh in document["meshes"]:
        for primitive in mesh["primitives"]:
            accessor = document["accessors"][primitive["attributes"]["POSITION"]]
            minima.append(accessor["min"][1])
            maxima.append(accessor["max"][1])
    reference_height = max(maxima) - min(minima)
    document["extras"]["anatomicalFit"]["referenceHeight"] = reference_height
    document["extras"]["hairReplacement"] = {
        "sourceModel": "TripoSR", "sourceInputKind": "inferred-full-body", "subject": subject,
        "sourceTemplateSha256": hashlib.sha256(template_path.read_bytes()).hexdigest(),
        "sourceCapSha256": hashlib.sha256(cap_path.read_bytes()).hexdigest(),
        "review": review, "headGeometryChanged": False, "uvDataChanged": False,
        "templateModel": document["extras"].get("model"), "originalHairName": original_hair["name"],
    }
    write_glb(output, document, binary + cap_binary)
    return {"subjectId": subject, "shape": document["extras"]["shape"], "path": str(output),
            "bytes": output.stat().st_size, "referenceHeight": reference_height,
            "sha256": hashlib.sha256(output.read_bytes()).hexdigest()}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--templates", default=".local/body-templates")
    parser.add_argument("--hair", default=".local/body-hair")
    args = parser.parse_args()
    templates, directory = Path(args.templates), Path(args.hair)
    report = json.loads((directory / "report.json").read_text())
    selected = {"color-right": "subject-1", "color-left": "subject-3"}
    assets = []
    for candidate in report["candidates"]:
        subject = selected.get(candidate["subject"])
        if not subject or not candidate.get("acceptedForGraft"):
            continue
        for shape in ["slim", "average", "broad"]:
            assets.append(graft(templates / f"{shape}.glb", Path(candidate["neutralAsset"]),
                                directory / f"{subject}-{shape}.glb", subject, candidate["review"]))
    if len(assets) != 6:
        raise ValueError("Expected six reviewed full-body grafts")
    manifest = {"status": "review-only", "activated": False, "assets": assets,
                "subject2": "Use the unchanged authored short-hair templates; its learned cap failed review"}
    (directory / "graft-report.json").write_text(json.dumps(manifest, indent=2))
    print(json.dumps(manifest))


if __name__ == "__main__":
    main()
