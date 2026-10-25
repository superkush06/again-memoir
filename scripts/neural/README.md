# Local pretrained image-to-3D trial

`triposr_cpu.py` runs the official [TripoSR](https://github.com/VAST-AI-Research/TripoSR) pretrained transformer/triplane model and exports a vertex-colored GLB for review. It does not train a model, use SDS, or claim PBR material generation. A full-body image inferred from a cropped photograph remains inferred even after neural geometry reconstruction.

The CPU trial uses a project-local Python environment because the host's pre-existing global PyTorch installation fails to load `shm.dll`. It does not modify global Python packages.

## Setup on this Windows host

```powershell
git clone --depth 1 https://github.com/VAST-AI-Research/TripoSR.git .local/TripoSR
python -m venv .local/triposr-venv
.local/triposr-venv/Scripts/python.exe -m pip install torch==2.5.1 --index-url https://download.pytorch.org/whl/cpu
.local/triposr-venv/Scripts/python.exe -m pip install numpy==1.26.4 Pillow==10.1.0 omegaconf==2.3.0 einops==0.7.0 transformers==4.35.0 trimesh==4.0.5 rembg==2.0.57 onnxruntime imageio scikit-image psutil
New-Item -ItemType Directory -Path .local/models/triposr -Force
curl.exe -L --fail --silent --show-error https://huggingface.co/stabilityai/TripoSR/resolve/main/config.yaml -o .local/models/triposr/config.yaml
curl.exe -L --fail --silent --show-error 'https://huggingface.co/stabilityai/TripoSR/resolve/main/model.ckpt?download=true' -o .local/models/triposr/model.ckpt
```

The official code and checkpoint are MIT licensed. The downloaded repository retains its LICENSE. The checkpoint is approximately 1.68 GB; the model also fetches the public DINO configuration into the project-local `.local/model-cache` directory. No photos are uploaded by this script.

## Run the color memory's rightmost person

```powershell
.local/triposr-venv/Scripts/python.exe scripts/neural/triposr_cpu.py --image data/generated-textures/instagram-color-bodies-v2.png --crop 0.006836 0.781250 0.469727 0.876302 --output .local/neural-trial --resolution 128 --chunk-size 4096 --threads 4
```

Input preparation crops the existing inferred full-body reference and pads it without changing the original photo or served textures. The learned architecture and checkpoint are unchanged. The CPU compatibility adapter substitutes scikit-image's marching-cubes isosurface extraction for the C++/CUDA `torchmcubes` extension; it preserves the upstream axis convention and repairs winding before export. That operation extracts an existing learned density field, rather than generating shape procedurally.

Outputs include `input.png`, `person.glb`, the learned `scene-code.npy`, and `diagnostics.json` with timings, RAM readings, model revision, source digest, triangle count, and an explicit `approvedForApp: false`. The renderer must not activate the candidate until it passes visual checks for geometry, orientation, recognizable clothing, and color.

`colored_glb.py` stores FLOAT linear RGB in glTF `COLOR_0`. It queries the learned color field again before export, avoiding both Trimesh's sRGB-valued byte export and dark-color quantization from converting linear values to eight bits. The original sRGB decoder output is transformed once; the browser uses ordinary glTF color handling.

The official camera helper is Z-up with azimuth-zero view from +X. For the app's Y-up coordinate system, rotate about X by `-pi/2`, then apply a Y-axis `frontYaw` of `-pi/2` to present that same view. Visual correspondence must still be checked before adoption.

## Recorded trial, 2026-10-24

The first complete run succeeded in 145 seconds: approximately 81.5 seconds for transformer inference and 9.2 seconds for density extraction. Recorded process RSS at export was about 1,647 MiB. It produced a watertight mesh with 4,520 vertices and 9,036 triangles at extraction resolution 128. Final standard-color GLB size is 272,440 bytes. `.local/neural-trial/diagnostics.json` retains the original run and the subsequent 11.7-second color re-export using the saved triplane. These measurements are from this single example, not performance guarantees.

To re-export the same learned geometry/colors without repeating image inference, append `--reuse` to the command. `triposr-requirements-lock.txt` records the environment used. No actual user photograph was uploaded to an external model service during this trial.

To sample the existing learned triplane more densely while preserving the initial candidate:

```powershell
.local/triposr-venv/Scripts/python.exe scripts/neural/triposr_cpu.py --image data/generated-textures/instagram-color-bodies-v2.png --crop 0.006836 0.781250 0.469727 0.876302 --output .local/neural-trial-256 --scene-code .local/neural-trial/scene-code.npy --resolution 256 --chunk-size 4096 --threads 4
```

This repeats density extraction and color sampling only. A denser grid can reduce faceting and preserve details already predicted by the model. It cannot add identity details, clothing text, or geometry absent from that learned field.

The 256-grid extraction completed in 92.84 seconds total, with 83.34 seconds spent extracting the mesh. It produced a watertight 19,250-vertex / 38,500-triangle model, 1,156,300 bytes. Its separate review copy is `.local/neural-trial/person-256.glb`; the 128-grid candidate remains unchanged. The higher resolution increases mesh detail, while the learned color field remains the same and can still contain artifacts. Source-photo texture baking is a separate correction, not evidence that the model recovered those details.

The middle gray-shirt person was independently inferred from the same full-body atlas using crop `[0.008789,0.448568,0.469727,0.546875]`. Its `.local/neural-color-middle/person.glb` candidate contains 17,990 vertices and 35,980 triangles, is watertight, and is 1,080,700 bytes. That complete 256-grid run took 138.01 seconds (66.11 seconds transformer inference, 61.49 seconds extraction). It uses the same verified FLOAT linear RGB encoding.

The left pink-shirt person was independently inferred using crop `[0.011719,0.121745,0.468750,0.218750]`. Its `.local/neural-color-left/person.glb` candidate contains 18,508 vertices and 37,020 triangles, is watertight, and is 1,111,824 bytes. That complete 256-grid run took 143.52 seconds (41.58 seconds transformer inference, 88.20 seconds extraction). Its front-facing reference is inferred: the original memory photo shows this person facing away.

| Person | Candidate | Grid | Vertices | Triangles | Run time |
| --- | --- | --- | ---: | ---: | ---: |
| Right, black shirt | `.local/neural-trial/person.glb` | 128 | 4,520 | 9,036 | 145.03 s |
| Right, black shirt | `.local/neural-trial/person-256.glb` | 256 | 19,250 | 38,500 | 92.84 s, cached triplane |
| Middle, gray shirt | `.local/neural-color-middle/person.glb` | 256 | 17,990 | 35,980 | 138.01 s |
| Left, pink shirt | `.local/neural-color-left/person.glb` | 256 | 18,508 | 37,020 | 143.52 s |

All four candidate exports are independent, complete learned meshes. No candidate was activated by the inference runner. A source/atlas texture bake may be applied downstream to replace the learned RGB field's visible artifacts while retaining learned geometry. That step and app activation must be assessed separately from successful model inference.

Reproducibility identifiers:

- Repository commit: `107cefdc244c39106fa830359024f6a2f1c78871`.
- Checkpoint SHA-256: `429e2c6b22a0923967459de24d67f05962b235f79cde6b032aa7ed2ffcd970ee`.
- Full-body atlas SHA-256: `ae0b235ca870bd4ca81d3612041db58c81c54db0bc7051708b898073491228cb`.

## Model feasibility

The current machine has Intel Iris Xe graphics, no detected NVIDIA CUDA GPU, and about 12 GB physical RAM. [Hunyuan3D 2.1](https://github.com/Tencent-Hunyuan/Hunyuan3D-2.1) documents 10 GB VRAM for shape, 21 GB for texture, and 29 GB combined. [TRELLIS.2](https://github.com/microsoft/TRELLIS.2) requires Linux and an NVIDIA GPU with at least 24 GB memory. Neither is a supported local inference path on this machine.

[Stable Fast 3D](https://github.com/Stability-AI/stable-fast-3d) supports CPU and produces textured GLB with illumination disentanglement, but its weights require Hugging Face access and acceptance of the Stability AI Community License. TripoSR's publicly available MIT weights make it a practical local test without an additional account. Its face and clothing fidelity still require visual evaluation; CPU compatibility does not imply acceptable output quality.

Gemini image generation can provide image references and inferred unseen views. Its documented image-generation API returns raster images, not a directly usable textured 3D mesh. A dedicated 3D reconstruction stage remains necessary for learned geometry.
