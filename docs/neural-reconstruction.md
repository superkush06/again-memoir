# Neural reconstruction and texture mapping

This project separates three jobs: recovering geometry, transferring observed photographic detail, and inventing unobserved appearance. A generated image is useful evidence for the third job but is not itself a 3D reconstruction.

## Model choice

The development laptop has Intel Iris Xe integrated graphics and approximately 12.7 GB system RAM, with no CUDA device. We therefore evaluate the public MIT-licensed [TripoSR](https://github.com/VAST-AI-Research/TripoSR) on CPU first. Its image encoder predicts a triplane representation; the decoder supplies density and color, and marching cubes extracts an explicit mesh. This is actual pretrained neural inference, with lower quality expectations than current larger GPU models. The published subsecond timing is on an A100 GPU and does not describe this laptop.

[Hunyuan3D 2.1](https://github.com/Tencent-Hunyuan/Hunyuan3D-2.1) is a stronger candidate for shape plus PBR texture generation on a suitable GPU worker. Its official requirements state 10 GB VRAM for geometry, 21 GB for textures, and 29 GB combined. [TRELLIS.2](https://github.com/microsoft/TRELLIS.2) also exports geometry and material channels, but its documented environment is Linux with at least 24 GB NVIDIA memory. Their exported self-contained GLBs can use the same viewer import path. Neither model is claimed to run on this machine.

[Gemini's image API](https://ai.google.dev/gemini-api/docs/image-generation) produces raster images. It remains useful for segmentation, source descriptions, and inferred reference views. The documented response modalities do not supply a native textured GLB or a differentiable texture field. We do not label generated reference images as neural 3D geometry.

The supplied papers describe related but distinct approaches. [GET3D](https://research.nvidia.com/labs/toronto-ai/GET3D/) learns a generative geometry/texture distribution with image-space adversarial losses; it is not an SDS texturing optimizer for a particular portrait. [The Autodesk texture-field paper](https://arxiv.org/abs/2509.05131) takes both an image and a mesh and reports inference after training. Training that network or running an SDS loop is outside the current local pipeline.

## Observed pixels versus inferred pixels

The image-fitting renderer uses multiple reference views with depth visibility checks. Foreground masks prevent neutral studio backgrounds from being baked onto limbs. Surface angle and actual occlusion determine which views can supply each surface sample. Original face and clothing evidence takes precedence where it is visible; hidden areas use the inferred references. These are deterministic projection operations, not learned material prediction.

For imported TripoSR bodies, the same mapper operates on the learned mesh. It registers each atlas silhouette to the mesh silhouette, measures the neck/head region, and fits the original cropped face and shirt above the inferred legs. Original back-view photographs project onto the body's back. This retains the model's geometry while replacing much of its unreliable RGB prediction. Vertices hidden from every reference keep their learned colors, so some side-view artifacts can remain. Reprojection applies only to vertex-colored assets generated from an inferred full-body reference; supplied PBR models keep their materials.

A single image does not separate intrinsic albedo, lighting, normals, and roughness uniquely. For that reason, the fallback preserves captured RGB and does not manufacture normal maps from shirt lettering or claim to recover physical materials from brightness. Native PBR assets retain their supplied material maps in the GLB viewer; TripoSR vertex-colored assets are explicitly labeled as vertex colors.

## Portable neural assets

An optional `neuralAsset` on a completion subject identifies a reviewed local GLB, its generating model, up axis, front yaw, appearance representation, and whether its input was the original photo or an inferred full-body reference. Runtime loading normalizes standing height and grounds the feet. A failed optional model falls back to the complete photo-fitted body.

GLBs must be self-contained: local reconstruction paths only, bounded file/geometry sizes, finite geometry, and no external buffer/image requests. The room still shares the compact completion URL, so participants load the same artifact without sending dense meshes through SpacetimeDB.

Generated hidden faces, pose, proportions, and clothing are estimates. Human identity and fine fingers are particularly difficult for general object-generation models. Neural candidates need visual comparison from front, side and back before replacing an existing reconstruction.

## Local experiment

The real CPU trial used the existing inferred full-body atlas for the color Instagram memory, not the waist-cropped photo as a complete-body observation. The first 128-grid mesh took 145 seconds including model initialization and inference. Extracting a 256-grid mesh from its saved triplane took another 92.8 seconds without rerunning the transformer. Two additional people took 138.0 and 143.5 seconds each at 256-grid resolution. Each body contains approximately 18,000–19,000 vertices and 36,000–39,000 triangles.

Raw TripoSR output had visibly mottled clothes and weak facial detail. Those raw textures were not accepted as the final appearance. The viewer combines the learned geometry with source-photo and front/back atlas projection. Setup, exact commands, checkpoint provenance and measured timings are in [the CPU runner documentation](../scripts/neural/README.md). This workflow does not run SDS optimization or train a new texture-field model, and it does not reconstruct an entire measured scene from one photo.

## Importing a reviewed GLB

Save an import configuration outside the public upload folder. `assetPath` is relative to this configuration file:

```json
{
  "fingerprint": "<32-character reconstruction fingerprint>",
  "subjectId": "subject-1",
  "assetPath": "./output/mesh.glb",
  "model": "triposr",
  "upAxis": "z",
  "frontYaw": 0,
  "appearance": "vertex-color",
  "inputKind": "inferred-full-body"
}
```

Use `source-photo` only when the model actually consumed the original photo, and `pbr` only when the artifact supplies PBR materials. `frontYaw` is in radians after the up-axis conversion. Other model identifiers accepted by the importer are `hunyuan3d-2.1` and `trellis-2`.

```powershell
npx tsx scripts/import-neural-asset.ts .local/neural-import.json --validate-only
# After reviewing the model from several angles:
npx tsx scripts/import-neural-asset.ts .local/neural-import.json
```

Validation alone does not change the served memory. The import checks the actual binary geometry, copies the GLB under a content-hashed name, backs up the prior completion manifest, and changes only the selected person's `neuralAsset`. Existing photos and texture atlases remain available for fallback. Files above 32 MiB, geometry above 200,000 vertices or 500,000 triangles, external resources, and Draco/Meshopt/Basis compression are rejected; export an ordinary self-contained GLB. To revert the model selection, restore the reported manifest backup.

## Authored anatomical templates and body choices

An authored human model uses `model: "makehuman"` or `"blender-studio"` and `inputKind: "anatomical-template"`. This records the actual source of the geometry separately from neural reconstructions. It does not claim that a person's hidden anatomy or identity was recovered from their photo. The existing `neuralAsset` field and loader names are retained for compatibility.

Three complete model files can be imported together with a selected default:

```json
{
  "fingerprint": "<32-character reconstruction fingerprint>",
  "subjectId": "subject-1",
  "model": "makehuman",
  "upAxis": "y",
  "frontYaw": 0,
  "appearance": "vertex-color",
  "inputKind": "anatomical-template",
  "shape": "average",
  "shapeVariantPaths": {
    "slim": "./templates/slim.glb",
    "average": "./templates/average.glb",
    "broad": "./templates/broad.glb"
  }
}
```

Run the same importer with `--validate-only`, then without that flag to activate. In this form, omit `assetPath`; every path is relative to the configuration file. All three GLBs must be distinct, self-contained files that share the declared axis, facing direction and material representation. Use baked static geometry when applying the source-photo mapper; an unsampled animated skeleton does not provide the posed surface coordinates that mapper needs. Preserve the original model's source and license alongside the exported files.

The manifest stores `shapeVariants` as three local model URLs and keeps `url` equal to the selected `shape`. `selectNeuralAssetShape(descriptor, shape)` selects another model without mutating the manifest default. The viewer's photo-fit choice can therefore return to the per-person default, while slender, average and broader choices load actual alternative meshes. Legacy assets without variants continue to load normally. Partial sets, remote URLs, mismatched defaults and a neural model mislabeled as an authored template are rejected.

An authored template can also include a reviewed `headYaw` in the import config and manifest, bounded to ±π/2 radians. Positive yaw turns the template's forward +Z direction toward +X before the whole body's photographed orientation is restored. The loader exposes this as `group.userData.templateHeadYaw`; the photographic fitter applies it around the template neck before baking. The loader itself does not rotate the head twice. Omit this field when no reviewed pose is available. It is not accepted on neural reconstruction descriptors.

Optional `sourceFaceBox` and `sourceNeckBox` use normalized `[top,left,bottom,right]` coordinates in the original photo. They record reviewed crop boundaries when automatic silhouette-based estimates include too much neck or a neighboring shoulder. They are validated, template-only fitting hints, not facial landmarks recovered by a model. The original image is preserved.

The current color memory uses MakeHuman templates for all three people, with learned hair caps retained for two of them. The three main people in the monochrome memory also use templates; its partially visible person in a long jacket retains the previous clothed fallback. Slender, average, and broader meshes are actual authored morphology blends. Body choices replace the complete visible set only after loading succeeds; a failure keeps the prior bodies in view. Comparison is local to the viewer, while the manifest's reviewed default is shared by room participants.

Template appearance uses per-texel UV projection, rather than limiting face detail to vertex density. Original head and neck crops are fitted separately after head posing; full-body atlases supply clothing but cannot stamp a second face onto the neck. Unseen surfaces start with the source palette, including grayscale, and bounded feathering softens crop boundaries. The resulting captured-RGB textures are unlit to preserve their colors; they are not recovered physical material maps. Source crop resolution determines head texture resolution. Fitting yields between mesh batches to keep controls responsive, and releasing a body also releases its baked textures.

Reproduction and licenses are documented in [the authored template builder](../scripts/body-templates/README.md) and [the hair-only graft workflow](../scripts/body-hair/README.md). Earlier TripoSR bodies remain recoverable through backed-up manifests.
