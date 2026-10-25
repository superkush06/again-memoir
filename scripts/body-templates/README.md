# Authored anatomical body candidates

This CPU pipeline builds three clothed, complete human body templates from
MakeHuman's authored CC0 geometry, morph targets, clothing, and skin weights.
It replaces the malformed single-image TripoSR body shape with consistent
anatomy. Photo-specific appearance is applied by the application's separate
UV texture fitter. These are inferred template bodies, not recovered scans of
the photographed people.

## Reproduce

Run from the project root. No MakeHuman or Blender application installation,
GPU, PyTorch, account, or paid service is required. The existing neural trial
environment already has the dependencies; a separate minimal environment can
also be used:

```powershell
python -m venv .local/body-template-venv
.local/body-template-venv/Scripts/python.exe -m pip install -r scripts/body-templates/requirements.txt
.local/body-template-venv/Scripts/python.exe scripts/body-templates/fetch_assets.py
.local/body-template-venv/Scripts/python.exe scripts/body-templates/build_templates.py --variant all
.local/body-template-venv/Scripts/python.exe scripts/body-templates/preview_templates.py .local/body-templates/average.glb
```

`fetch_assets.py` checks SHA-256 hashes from `assets.json`. It downloads only
the selected entries of official asset-pack ZIPs using HTTP byte ranges and
checks ZIP CRCs. It refuses a server response that ignores the range request.
The 21 required source files total about 5.5 MB uncompressed. Existing matching
files are reused; mismatched downloads are rejected. No whole 280 MB system
asset pack is necessary.

Outputs are ignored local artifacts:

- `.local/body-templates/slim.glb`
- `.local/body-templates/average.glb`
- `.local/body-templates/broad.glb`
- Per-shape JSON reports with exact metadata and mesh counts.
- `preview.png`: front, side, and back geometry QA, generated without editing
  any source photograph.

Building all three took about 5 seconds on the project's Windows CPU system.
The script does not edit or activate the application's neural asset manifest.
Use `scripts/import-neural-asset.ts` only after reviewing the result.

## Geometry and material contract

- Static GLB, Y-up, front +Z, feet at y=0, crown at 1.76 m including hair.
- `model: makehuman`, `inputKind: anatomical-template`, `upAxis: y`,
  `frontYaw: 0`, `appearance: vertex-color`.
- Semantic meshes: `Head`, `Skin` (exposed arms/hands), `Shirt`, `Pants`,
  `Shoes`, `Hair`, and `Eyes`.
- Original authored UVs are preserved through seam-aware vertex splitting.
- Neutral `COLOR_0` values are FLOAT linear RGB, converted exactly once from
  specified sRGB colors, following glTF semantics. They are placeholders for
  the subsequent source-photo texture bake.
- `anatomicalFit` in scene extras contains a head pivot, smooth neck rotation
  interval, chin estimate, and `referenceHeight`. The viewer can turn the
  head before baking source pixels without an armature or skinned mesh.
- Shoulders and elbows use authored skin weights. Arms rest downward with
  slight asymmetric elbow bend; hands and individual fingers retain authored
  anatomical geometry. The shared head remains neutral for per-person posing.
- Actual shirt, trouser, shoe, eye, and hair meshes are fitted using their
  authored body-vertex correspondences. This preserves collars, sleeves,
  trouser volume, and soles. Covered skin is omitted to prevent intersections
  between the dense body and lower-resolution clothing. The visible body is
  complete; hidden skin beneath clothes is not exported.

The three builds blend authored per-vertex morphology targets rather than
scaling the same mesh's width. `slim` uses 55% lower-weight and 45% average
targets; `average` uses the average target; `broad` combines 35% average,
40% stronger musculature, and 25% higher weight. Differences are intentionally
moderate. All use the same evenly blended generic adult male base. Asset
category names in the source files do not classify any photographed person's
ancestry, gender, age, or body composition.

Initial validated base outputs:

| Shape | Vertices | Triangles | Size |
| --- | ---: | ---: | ---: |
| Slim | 17,341 | 28,948 | 1,119,452 bytes |
| Average | 17,341 | 28,938 | 1,119,276 bytes |
| Broad | 17,343 | 28,946 | 1,119,588 bytes |

Position, UV, and color arrays were checked for finite values, indices checked
against vertex counts, colors checked against [0,1], and grounded height
checked at 1.76 m. Front/side/back previews were inspected, including clothing
coverage and collar continuity. These are well below the viewer's per-person
geometry and file-size limits.

## Provenance and licenses

The MakeHuman repository distinguishes **AGPL application code** from **CC0
assets**. This directory contains an original OBJ/proxy data reader, target
blender, weighted poser, and GLB exporter; no MakeHuman application source is
incorporated. The downloaded assets' CC0 license is saved at
`.local/body-templates/makehuman/LICENSE.ASSETS.md`.

- [MakeHuman repository and asset license](https://github.com/makehumancommunity/makehuman/blob/a8bc2d54ff0ac92e78ff71431b1023eda42bf482/LICENSE.ASSETS.md):
  hm08 base, macrodetail targets, rig/skin weights, and low-poly eyes. All raw
  file URLs are pinned to commit `a8bc2d54ff0ac92e78ff71431b1023eda42bf482`.
- [Official shirts pack](https://static.makehumancommunity.org/assets/assetpacks/shirts01.html):
  `toigo_basic_tucked_t-shirt`, authored by MRT, explicit CC0 header.
- [Official trousers pack](https://static.makehumancommunity.org/assets/assetpacks/pants01.html):
  `toigo_wool_pants`, authored by MRT, explicit CC0 header.
- [Official MakeHuman system assets](https://static.makehumancommunity.org/assets/assetpacks/makehuman_system_assets.html):
  `shoes02` and `short01` hair, explicit September 2020 CC0 asset headers.

The manifest records source URLs, selected archive entry names, byte lengths,
and SHA-256 for every required file. Downloaded source data and license text
stay in `.local/body-templates/`; source meshes and private photos are not
committed by these scripts.

## Limits

The face is an authored neutral anatomical template with source appearance
fitted separately. It does not recover a person's true hidden face geometry.
Clothes are plausible authored shirt/trouser shapes, not garment-specific
reconstructions. The base hair is a generic short style; optional per-person
caps are handled in `scripts/body-hair/`. The body is static and does not yet
carry animation, foot IK, or a recovered pose from the original photograph.
Further high-fidelity reconstruction would need additional viewpoints or a
dedicated reconstruction service/model with suitable compute.
