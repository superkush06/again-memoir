# Reusable anatomical templates

These three neutral models contain only authored MakeHuman CC0 geometry,
clothing, hair, UVs and skin weights. They contain no photographs or personal
data. The `slim`, `average` and `broad` files are distinct morphology blends.
They are generic adult templates, not recovered scans of any photographed
person; they do not cover every age, body type, hairstyle or garment.

Reproduce from the project root after the existing asset-fetch step:

```powershell
.local/triposr-venv/Scripts/python.exe scripts/body-templates/build_posed_templates.py
```

The builder uses the original `scripts/body-templates/build_templates.py`
data reader. MakeHuman application code is not included. Exact upstream
revisions and asset checksums are in `scripts/body-templates/assets.json`.

- MakeHuman hm08, authored macro targets, skeleton, skin weights and eyes:
  https://github.com/makehumancommunity/makehuman/blob/a8bc2d54ff0ac92e78ff71431b1023eda42bf482/LICENSE.ASSETS.md
- MRT `toigo_basic_tucked_t-shirt` and `toigo_wool_pants`: CC0 headers in
  the official shirts01 and pants01 asset packs.
- MakeHuman `shoes02` and `short01` hair: CC0 asset-pack headers.

See `scripts/body-templates/README.md` for complete provenance. Files retain
linear RGB placeholder colors and source UVs. Custom `_POSE_JOINTS` and
`_POSE_WEIGHTS` contain four authored weights per vertex for 15 reduced bones.
Scene extras record rest anchors and the reduction's side convention. The
renderer applies bounded bone lengths and pose before fitting source colors.
The facial surface, eyes and hair receive one rigid head transform; neck
blending ends below the chin.

Articulation uses authored weights with dual-quaternion blending and minimal
bone swing inherited from each parent. This avoids sudden twists when limbs
point toward the camera. Local orientation constraints repair folded joint
surfaces, moving clothing at most 5 cm and exposed arm skin/lower neck at most 2 cm;
UV seam duplicates stay together. Shoes move as rigid shells. These checks
do not establish collision-free anatomy or recover unseen historical detail.
All facial vertices above the chin remain pinned during neck correction.
If a pose cannot be corrected within those limits, the remaining folded or
collapsed triangles are reported; the solver does not keep stretching the
body to force a clean diagnostic. A clean report for one photo is not a
guarantee for every pose, occlusion or body proportion.
