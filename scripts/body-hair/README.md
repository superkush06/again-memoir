# Photo-derived hair on authored bodies

This review pipeline keeps the MakeHuman face, body, clothing and UVs, and replaces only the named `Hair` mesh with a small cap extracted from an existing TripoSR reconstruction. It does not reconstruct a face or alter the selected body's proportions. The learned source came from an AI-completed full-body reference, so its hair is inferred geometry rather than a measured scan.

The accepted color-memory candidates are the right person's afro (`subject-1`) and the left person's bowl cut (`subject-3`). The middle person's extracted cap was **rejected** because fitting it onto the authored skull left an unacceptable rear gap. `subject-2` retains the authored MakeHuman `short01` fallback. A rejected candidate remains in the review output so the decision can be inspected; the graft script does not select it.

## Inputs and provenance

The following local assets must already exist:

| Input | Purpose |
| --- | --- |
| `.local/neural-trial/person-256.glb` | Right person's learned hair silhouette and colors |
| `.local/neural-color-middle/person.glb` | Middle person's rejected hair experiment |
| `.local/neural-color-left/person.glb` | Left person's learned hair silhouette and colors |
| `.local/body-templates/{slim,average,broad}.glb` | Authored MakeHuman bodies, clothing, head and fallback hair |

The learned meshes were exported by [the local TripoSR runner](../neural/README.md), including its checkpoint and inference provenance. The authored template inputs come from [the MakeHuman build scripts](../body-templates/build_templates.py). Their embedded extras preserve source, license, shape weights and anatomical fitting metadata. This pipeline preserves those fields and adds `hairReplacement` provenance; it does not relabel learned hair as authored MakeHuman geometry.

Both scripts use the already-installed `.local/triposr-venv` Python environment with NumPy, trimesh and Pillow. No new model inference, API request or cloud upload is performed.

## Reproduce the candidates

Run from the repository root:

```powershell
.local/triposr-venv/Scripts/python.exe scripts/body-hair/extract_hair.py
.local/triposr-venv/Scripts/python.exe scripts/body-hair/graft_caps.py
```

`extract_hair.py` reads the original GLBs without modifying them. It converts their Z-up, +X-facing frame to Y-up, +Z-facing coordinates at a 1.76 m body height. It then:

1. Selects the upper head using height, learned surface brightness and warm-skin rejection.
2. Retains the largest connected hair component and smooths only its cut border.
3. Removes the reviewed source head yaw, then fits the cap to the neutral authored scalp. The left cap's source yaw is −0.7 radians; this is separate from the final reviewed +0.7 head pose used after the body turns around in the memory.
4. Keeps the upper cap outside the authored scalp and closes small interior holes while preserving the main face/neck opening.
5. Exports linear FLOAT vertex colors and front/side/rear diagnostic images for review.

Thresholds, reviewed source yaw and scalp fitting dimensions are explicit in the script. They are approximate fitting choices, not inferred measurements of a person's anatomy. The cap's final head pose is applied later by the application's `headYaw` fitting stage.

`graft_caps.py` consumes only candidates marked `acceptedForGraft`. It appends the cap's binary data and substitutes the original `Hair` primitive, preserving every other authored mesh, material reference, UV attribute and original binary byte. The custom hair mesh carries `sourceHair: true` and `preserveVertexColors: true` so photo fitting can retain its learned hair appearance. The anatomical reference height is updated for the larger hair crown; the runtime loader still grounds each finished body at the requested standing height.

## Outputs and validation

All outputs are review artifacts under `.local/body-hair/`; neither script activates a completion manifest.

- `hair-review-v1.png`: source heads beside isolated caps, from front, side and rear.
- `hair-template-fit-v1.png`: caps fitted over the unchanged authored head, including the rejected middle candidate.
- `report.json` and per-cap JSON files: source hashes, selection thresholds, crop bounds, orientation, fitting transforms and acceptance decisions.
- `subject-1-{slim,average,broad}.glb`: complete authored bodies with the accepted afro cap.
- `subject-3-{slim,average,broad}.glb`: complete authored bodies with the accepted bowl-cut cap.
- `graft-report.json`: final full-body paths, hashes, sizes and reference heights.

All six accepted full-body outputs were checked using the application's binary GLB validator and production loader. They normalize to feet at `y=0` and crown at `y=1.76`, retain one `sourceHair` mesh, and use approximately 15,800–16,700 vertices and 28,400–30,100 triangles each. Source head and clothing geometry remains unchanged by the graft.

After visual review, use [the existing importer](../import-neural-asset.ts) with `model: "makehuman"`, `inputKind: "anatomical-template"`, `appearance: "vertex-color"`, `upAxis: "y"`, `frontYaw: 0`, and the three per-subject output paths. The importer records content-hashed assets and backs up the prior manifest. Keep the subject's reviewed `headYaw` and source crop metadata. Do not point a full-body descriptor at a standalone hair cap, because the loader would normalize the cap as an entire body.
