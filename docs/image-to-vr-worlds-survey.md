# 25 projects for turning 2D images into 3D worlds for VR

Research checked **October 24, 2026**. This survey covers 25 distinct projects and pipelines in detail, plus four practical capture products and tools. It focuses on whole scenes, spatial photographs, and reconstruction pipelines. Different releases of the same generator count once. WorldMirror is counted as a separately published reconstruction project, although HY-World 2.0 also uses it as a component. Object-only generators and renderers are not used to reach the 25-project target.

**The strongest starting points for Again are Marble for generating an explorable environment from one photograph, a layered spatial-photo approach for preserving the photographed moment, and COLMAP plus Nerfstudio or 3D Gaussian Splatting when overlapping photos or video exist.** These solve different problems. Generating a room's unseen side can make a compelling world, but it cannot establish what was actually there.

The assessments below distinguish published results from engineering judgments. They draw on official repositories, papers, model cards, and product documentation; no models were run or headsets benchmarked for this survey. Timing numbers retain their published context and are not directly comparable across methods. Code licenses and model licenses are listed separately where they differ.

## How to interpret the results

A **single image** supplies appearance and perspective from one position. A **panorama** sees around one position, but still cannot reveal surfaces hidden behind furniture or people. **Overlapping images** add real observations of the same scene from different positions. Unrelated album pictures do not provide that geometry.

| Method family | What happens to the images | What it does well | Main limitation for VR |
| --- | --- | --- | --- |
| Spatial photograph | Estimate depth; separate surfaces; fill hidden layers; render nearby views | Retains much of the original appearance and adds head-motion parallax | A restricted viewing region; holes and stretched edges appear with larger translations |
| Panorama reconstruction | Predict panoramic depth and complete occlusions; fit a mesh or splats | Surrounds the viewer and gives some movement | Seeing 360 degrees does not imply that walking behind objects is supported |
| Generative scene reconstruction | Synthesize additional views, often with diffusion; enforce consistency; reconstruct explicit 3D | Creates plausible unseen surroundings and broader exploration | Can alter faces, text, layout, object counts, and historical details |
| Photogrammetry | Match features across real photos; estimate cameras; triangulate and fuse surfaces | Evidence-based geometry and conventional meshes | Needs overlap, texture, stable lighting, and largely static subjects |
| Radiance-field or Gaussian reconstruction | Optimize a scene to reproduce many observed views | Photographic appearance and view-dependent effects | Coverage gaps, rendering cost, and a separate need for physical collision geometry |
| Learned reconstruction | Predict depth, cameras, points, or Gaussians directly from images | Fast geometry or novel-view initialization | Dataset bias and incomplete coverage; geometry prediction is not automatically a finished world |

**Representations matter.** A textured mesh has explicit surfaces that conventional engines can render and use for collision. A neural radiance field (NeRF) describes appearance along viewing rays and needs a renderer or conversion. A Gaussian scene represents appearance with many oriented, translucent 3D blobs. A layered depth image (LDI) or multiplane image (MPI) keeps multiple surfaces or image planes for local parallax. None of these automatically supplies editable objects, avatars, multiplayer, or game logic.

## Comparison of the 25 projects

The input and output summaries are expanded and sourced in the individual entries. “Code” means a public implementation exists; it does not imply unrestricted use of all weights and dependencies.

| No. | Project | Required image input | Main output | Practical role |
| --- | --- | --- | --- | --- |
| 1 | [World Labs Marble](#1-world-labs-marble) | One image, panorama, multiple images, or video | Gaussian splats and meshes | Hosted world-generation baseline |
| 2 | [Tencent HY-World](#2-tencent-hunyuanworld-and-hy-world-family) | One image or panorama; version-dependent pipeline | Meshes and/or Gaussians | Broad scene generation with substantial compute |
| 3 | [NVIDIA Lyra](#3-nvidia-lyra-20) | One image | Video-derived 3D Gaussians | Research on larger, consistent generated worlds |
| 4 | [VistaDream](#4-vistadream) | One image | 3D Gaussians | Public implementation of generated scene completion |
| 5 | [WonderWorld](#5-wonderworld) | Seed image and generation controls | Surface-aligned Gaussians | Interactive scene expansion |
| 6 | [LucidDreamer](#6-luciddreamer) | Image, usually with text guidance | 3D Gaussians | Iterative generation and alignment |
| 7 | [Pano2Room](#7-pano2room) | One equirectangular panorama | Gaussians; intermediate mesh | Room reconstruction from panoramic coverage |
| 8 | [DreamScene360](#8-dreamscene360) | One panorama, or a generated panorama | 3D Gaussians | Panoramic 3D scene initialization |
| 9 | [PanoDreamer](#9-panodreamer) | One image | Panorama, layered depth, Gaussians | Image-to-panorama-to-scene pipeline |
| 10 | [CAT3D](#10-google-cat3d) | One or a few images | NeRF or 3D Gaussians | Strong research reference for generated multiview reconstruction |
| 11 | [Apple SHARP](#11-apple-sharp) | One image | Metric 3D Gaussians | Fast nearby-view spatial photographs |
| 12 | [Flash3D](#12-flash3d) | One image | Layered 3D Gaussians | Fast image lifting with hidden-surface prediction |
| 13 | [3D Photo Inpainting](#13-3d-photo-inpainting) | One image | Layered depth and vertex-colored PLY mesh | Transparent baseline for local motion parallax |
| 14 | [AdaMPI](#14-adampi) | One image | Adaptive multiplane image | Efficient local novel-view synthesis |
| 15 | [Worldsheet](#15-worldsheet) | One image | Warped textured mesh | Foundational single-image scene reconstruction |
| 16 | [HunyuanWorld-Mirror](#16-hunyuanworld-mirror-and-worldmirror) | One or more images | Cameras, geometry, Gaussians | Unified reconstruction front end |
| 17 | [DUSt3R](#17-dust3r) | Overlapping image pair or collection | Dense point maps and aligned geometry | Camera-free reconstruction building block |
| 18 | [MASt3R](#18-mast3r) | Overlapping images | Dense matches and aligned geometry | Stronger matching for reconstruction |
| 19 | [VGGT](#19-vggt) | One or more images | Cameras, depth, points, tracks | Fast geometry and pose initialization |
| 20 | [pixelSplat](#20-pixelsplat) | Two posed images | 3D Gaussians | Feed-forward stereo novel views |
| 21 | [MVSplat](#21-mvsplat) | Sparse posed images | 3D Gaussians | Cost-volume-based sparse-view reconstruction |
| 22 | [DepthSplat](#22-depthsplat) | Multiple posed images | Depth and 3D Gaussians | Combines learned depth with multiview evidence |
| 23 | [COLMAP](#23-colmap) | Many overlapping photos | Cameras, point clouds, meshes | Classical reconstruction backbone |
| 24 | [3D Gaussian Splatting](#24-original-3d-gaussian-splatting) | Many posed photos, typically from SfM | Optimized 3D Gaussians | Photoreal capture with a documented OpenXR branch |
| 25 | [Nerfstudio](#25-nerfstudio) | Overlapping photos or video | NeRFs or Gaussians, depending on method | Practical processing, training, and export toolkit |

## Detailed project assessments

### 1 World Labs Marble

**Input and method.** A hosted generative world model accepts an image, panorama, multiple images, video, or text and creates a persistent 3D scene. Its internal training architecture and weights are proprietary. Current official product/API documentation lists Marble 1.1, 1.1 Plus, 1.0, and 1.0 Draft; Plus expands spatial coverage where possible. Do not treat the Atlas waitlist/preview as a generally available Marble API model. [Launch](https://www.worldlabs.ai/blog/marble-world-model), [current model names](https://docs.worldlabs.ai/api/models).

**Code and models.** The generator and weights are proprietary; access is through Marble and the World API. The separate [Spark renderer](https://sparkjs.dev/) renders existing scenes. In the Marble web app, splat/collider exports are paid-plan features, while high-quality textured meshes and commercial rights are listed on Pro and above. The API has separate credit billing; app credits do not transfer to it. [Web-app plans](https://marble.worldlabs.ai/pricing), [API billing](https://docs.worldlabs.ai/api/pricing).

**Output, quality, and VR assessment.** Exports include SPZ/PLY splats at approximately 2 million or 500,000 splats, a GLB collider, and higher-quality GLB meshes. This is one of the most direct product routes to importing an image-derived world into a VR renderer. The official mesh documentation explicitly reports holes, floaters, and uneven geometry, particularly for thin structures, reflective/transparent materials, and poorly covered regions. Splats retain the best appearance; the collider is simplified physics geometry. Headset performance still depends on renderer, stereo workload, and asset simplification. [Export specifications](https://docs.worldlabs.ai/marble/export/specs), [mesh limitations](https://docs.worldlabs.ai/marble/export/mesh).

### 2 Tencent HunyuanWorld and HY-World family

**Input and methods.** HunyuanWorld 1.0 (2025) converts a single image into a panorama, decomposes it into semantic layers, and reconstructs layered meshes. Its released panorama components use FLUX. HY-World 2.0 (2026) adds HY-Pano 2.0, WorldNav camera planning, WorldStereo 2.0 generation, and WorldMirror plus optimized Gaussian reconstruction. It can also reconstruct directly from multiple photos or video. These are materially different pipelines within one family. [1.0 code](https://github.com/Tencent-Hunyuan/HunyuanWorld-1.0), [2.0 code](https://github.com/Tencent-Hunyuan/HY-World-2.0), [2.0 paper](https://arxiv.org/abs/2604.14268).

**Code and models.** Inference and checkpoints are released for 2.0's panorama, expansion, and reconstruction components. [Model collection](https://huggingface.co/tencent/HY-World-2.0). Both versions use custom Tencent community licenses with territory exclusions, including the EU, UK, and South Korea, and additional conditions; public source does not mean permissive licensing. [1.0 license](https://github.com/Tencent-Hunyuan/HunyuanWorld-1.0/blob/main/LICENSE), [2.0 license](https://github.com/Tencent-Hunyuan/HY-World-2.0/blob/main/License.txt).

**Output, quality, and VR assessment.** Meshes and splats make this a strong self-hosted world-generation candidate. Version 1.0's image-to-world table reports Q-Align 3.9 and CLIP-I 84.5 versus 3.5/83.3 for DimensionX, but these measure appearance/alignment, not faithful recovery of hidden geometry or VR comfort. Version 2.0's released full-generation setup recommends at least four GPUs, was tested on eight H20s, and requires a VLM service. This is a substantial offline pipeline. Its export path includes PLY, SPZ, and TSDF meshes; invented regions still require inspection. [1.0 evidence](https://github.com/Tencent-Hunyuan/HunyuanWorld-1.0#performance), [2.0 hardware and exports](https://github.com/Tencent-Hunyuan/HY-World-2.0/blob/main/hyworld2/worldgen/README.md).

### 3 NVIDIA Lyra 2.0

**Input and method.** Lyra 2.0 (2026) takes an image, camera trajectory, and text captions. It generates a long camera-controlled video, retrieving relevant history through per-frame geometry to reduce forgetting and training against degraded histories to reduce drift. A second stage uses VIPE and Depth Anything 3 to reconstruct an explicit Gaussian scene. [Paper](https://arxiv.org/abs/2604.13036), [project](https://research.nvidia.com/labs/sil/projects/lyra2/).

**Code and models.** [Source, training code, and GUI](https://github.com/nv-tlabs/lyra/tree/main/Lyra-2) are available under Apache-2.0. The [14B Wan-based model/checkpoints](https://huggingface.co/nvidia/Lyra-2.0) have a separate NVIDIA Internal Scientific Research and Development Model License. The model card expressly excludes production use and generating works for sale or distribution. This materially limits a deployed VR application.

**Output, quality, and VR assessment.** Outputs include `reconstructed_scene.ply`. Official H100 80GB timings are approximately nine minutes per 80 generated frames, or about 35 seconds with the four-step distilled model, plus roughly one minute for reconstruction; these are not headset-generation timings. Documented limitations include hallucinated obstacles, camera-scale ambiguity, repetitive patterns/weaker prompt following with distillation, and blur when reconstructing very long videos in one pass. It is a strong research candidate for larger explorable worlds and revisiting locations, but has heavy setup and licensing costs. [Runtime and limitations](https://github.com/nv-tlabs/lyra/blob/main/Lyra-2/README.md), [installation](https://github.com/nv-tlabs/lyra/blob/main/Lyra-2/INSTALL.md).

### 4 VistaDream

**Input and method.** VistaDream (2024 preprint; ICCV 2025) builds a coarse scene scaffold from one image, boundary outpainting, and estimated depth. Iterative RGB-D inpainting completes missing viewpoints, and its Multiview Consistency Sampling constrains diffusion outputs across views. This is training-free composition of existing models, followed by a Gaussian scene representation. [Paper](https://arxiv.org/abs/2410.16892), [interactive project](https://vistadream-project-page.github.io/).

**Code and models.** [Official MIT-licensed implementation](https://github.com/WHU-USI3DV/VistaDream) includes a weight-download script and interactive UI. Its documented original dependencies include Fooocus, Depth Pro, Prior Depth Anything, SD-LCM, LLaVA, MaskFormer, and Stable Diffusion 1.5, each retaining its own license. A current branch adds MoGe-3 and LingBot-Depth; the sparse-view mode uses VGGT. There is no single standalone VistaDream foundation checkpoint.

**Output, quality, and VR assessment.** The Gaussian field can be exported to PLY and inspected in SuperSplat. The maintainers tested the pipeline on Ubuntu 20.04 and one RTX 4090. Paper comparisons support more consistent novel views than the evaluated baselines, but generated completion is not proof of the true hidden scene. Compared with simple depth lifting, it explicitly addresses holes and disagreement between generated views. It is a practical single-image research candidate, with many dependencies and slower iterative synthesis. Viewpoint range and stereo quality still need testing before a headset experience. [Code, dependencies, export instructions, and current branch status](https://github.com/WHU-USI3DV/VistaDream).

### 5 WonderWorld

**WonderWorld: Interactive 3D Scene Generation from a Single Image** — 2024 preprint; CVPR 2025 Highlight. A photograph starts a scene; subsequent camera positions and text descriptions determine where and what to generate. Its Fast Layered Gaussian Surfels (FLAGS) separate scene content into layers, initialize geometry from one view, and use guided depth diffusion to align new portions with existing geometry. The output is a persistent Gaussian-surface scene that can be explored and expanded, rather than just a generated fly-through. [Project](https://kovenyu.com/wonderworld/) · [Paper](https://arxiv.org/abs/2406.09394).

**Code and models:** [Official code](https://github.com/KovenYu/WonderWorld) includes interactive browser/server viewing and save/load. It uses Marigold depth diffusion, Stable Diffusion components, and a downloadable RepViT-SAM checkpoint. The current README specifies **48 GB GPU memory**, CUDA, PyTorch3D, and custom rasterizer extensions. No top-level project license was identified in the repository/README inspected; do not label this permissively licensed merely because code is public. Dependencies have separate terms.

**Quality and VR fit:** The authors report **under 10 seconds for a new scene on one A6000**, enabling incremental creation. That is scene-generation latency, not per-frame latency. The browser exploration and persistent geometry make it one of the most directly relevant research systems. Guided depth addresses seams, but generated content is inferred, and layered visible surfaces do not establish watertight collision geometry. VR integration still needs stereo rendering, locomotion/collision design, and performance measurements.

### 6 LucidDreamer

**LucidDreamer: Domain-free Generation of 3D Gaussian Splatting Scenes** — 2023 preprint; TVCG 2025. This is the Seoul National University scene project, not similarly named object-generation work. Starting from an image and text prompt, it alternates “dreaming” (project current points, diffusion-inpaint missing pixels, estimate depth) and alignment (merge the newly lifted geometry). It then optimizes a 3D Gaussian Splatting scene from the assembled point cloud. [Project](https://luciddreamer-cvlab.github.io/) · [Paper](https://arxiv.org/abs/2311.13384).

**Code and models:** [Official code](https://github.com/luciddreamer-cvlab/LucidDreamer) provides CLI and Gradio demos, custom-image input, selectable generation paths, ZoeDepth, and Stable Diffusion inpainting (SD 1.5 by default; alternative compatible checkpoints supported). The README describes a full demo using about **15 GB**. The [root license](https://github.com/luciddreamer-cvlab/LucidDreamer/blob/main/LICENSE) is **CC BY-NC-SA 4.0**; assess downstream models separately.

**Quality and VR fit:** The project reports CLIP-IQA quality **0.6161 versus RGBD2’s 0.1279** on its comparison; these are paper-specific perceptual scores, not universal world-accuracy measurements. Its main strength is detailed, stylized or photographic scene generation without a narrow 3D-training-domain restriction. Repeated objects, uncertain hidden surfaces, and inconsistency accumulated along a generation path remain practical concerns; its own prompt guide cautions against repeatedly generating people from subject tags. Useful for explorable memory-inspired scenes, with a splat renderer and auxiliary collision geometry required.

### 7 Pano2Room

**Pano2Room: Novel View Synthesis from a Single Indoor Panorama** — SIGGRAPH Asia 2024. Input is one indoor panorama. It first forms a mesh, searches for useful missing-region viewpoints, inpaints RGB and depth, and applies geometry-conflict checks. The completed mesh and collected synthetic views initialize and train a 3D Gaussian Splatting field. [Paper](https://arxiv.org/html/2408.11413v2).

**Code and models:** [Official code](https://github.com/TrickyGo/Pano2Room) is labeled **MIT** at the root, with separately licensed dependencies. The documented checkpoints are **LaMa, Omnidata depth, and Omnidata normals**; Stable Diffusion inpainting can be fine-tuned per panorama. PyTorch3D and a depth-capable Gaussian rasterizer are required. [Checkpoint instructions](https://github.com/TrickyGo/Pano2Room/blob/main/checkpoints/README.md).

**Quality and VR fit:** The paper reports approximately **40 minutes on an Nvidia A40**: 20 minutes for per-scene diffusion fine-tuning, 10 for mesh construction, and 10 for Gaussian optimization. It reports **156 FPS** rendering in its evaluation, not stereo-headset performance. The authors explicitly identify failure modes: glass/reflections cause depth errors that propagate; long hallways lose geometric detail; close inspection exposes sparse distant mesh and blurred texture. Their search assumes the panorama reveals basic room structure. Among these projects, this is a particularly relevant reproducible option for indoor room exploration because occlusion completion is central to the design, although fidelity to unseen real-world content cannot be guaranteed.

### 8 DreamScene360

**DreamScene360: Unconstrained Text-to-3D Scene Generation with Panoramic Gaussian Splatting** — ECCV 2024. Despite the text-to-3D title, its official implementation explicitly accepts an existing **360-degree panorama** of arbitrary resolution. It estimates perspective depths, aligns them into a global point cloud, initializes Gaussians, and regularizes geometry and semantics across original and virtual views. A panorama supplies surrounding appearance more directly than a single perspective photograph. [Project](https://dreamscene360.github.io/) · [Paper](https://arxiv.org/abs/2404.06903).

**Code and models:** [Official code](https://github.com/ShijieZhou-UCLA/DreamScene360) includes panorama input commands and Windows/Ubuntu SIBR viewers. Checkpoint instructions cover Omnidata depth and, for optional panorama synthesis, Stable Diffusion 2.1, a VAE, and StitchDiffusion LoRA. Supplied-pano reconstruction does not require the optional GPT-4V prompt-refinement path. The [root license](https://github.com/ShijieZhou-UCLA/DreamScene360/blob/main/LICENSE.md) is the inherited **Gaussian-Splatting research/noncommercial license**.

**Quality and VR fit:** The paper demonstrates 360-degree generated scenes and real-time exploration, with reconstruction taking minutes in its reported setup. Its global panorama initialization reduces the risk of sequential stitching inconsistencies. Full angular coverage should not be confused with complete geometry: one panorama still lacks object backs and disoccluded surfaces. This is a plausible route for a visually immersive environment near the capture position; aggressive translation needs specific inspection. The distributed desktop viewer demonstrates navigation, not a ready-made headset integration or verified Quest frame rate.

### 9 PanoDreamer

**PanoDreamer: Optimization-Based Single Image to 360° 3D Scene With Diffusion** — 2024 preprint; SIGGRAPH Asia 2025, with a January 2026 paper revision. This is the **Paliwal et al. / Texas A&M** project, distinct from another paper called PanoDreamer. A single image anchors a cylindrical panorama. Alternating optimization improves panorama coherence and aligns overlapping depth predictions; layered-depth inpainting and Gaussian optimization produce the final 3D scene. [Paper](https://arxiv.org/html/2412.04827v3).

**Code and models:** [Official repository](https://github.com/avinashpaliwal/PanoDreamer) now includes the complete documented stages and PLY Gaussian export. It uses Stable Diffusion-based generation, **Depth Anything V2**, 3d-moments inpainting checkpoints, and **gsplat**; optional MoGe V2 calibration is also documented. No top-level project license was identified in the repository/README inspected; dependency permissions remain distinct. The README still has a placeholder clone URL, so use the actual repository URL.

**Quality and VR fit:** The paper reports **100 minutes per scene on an RTX A5000**, dominated by panorama generation. It targets coherent loop closure rather than interactive generation. The authors acknowledge a mostly horizontal-horizon requirement, reconstruction of object fronts rather than backs, and occasional blur near panorama edges. A strong candidate for turning an archival landscape/photo into an enveloping scene with local parallax; a weaker fit for walking freely behind furniture or expecting faithful unseen room layouts.

### 10 Google CAT3D

**Input and method.** CAT3D, *Create Anything in 3D with Multi-View Diffusion Models* (NeurIPS 2024), takes one or more real/generated images plus target viewpoints. A camera-conditioned multiview diffusion model synthesizes mutually consistent views, then a robust reconstruction stage optimizes a 3D representation. The project describes Zip-NeRF and 3D Gaussian Splatting outputs. [Official project](https://cat3d.github.io/), [paper](https://arxiv.org/abs/2405.10314).

**Code and models.** The official project provides a paper, gallery, and interactive examples, but no official runnable inference/training implementation or model checkpoint was identified. The `cat3d/cat3d.github.io` repository is the project website, not the model implementation. Unofficial repositories must not be presented as Google's released code or weights. [Website source](https://github.com/cat3d/cat3d.github.io).

**Quality and VR assessment.** The authors report complete scene creation in as little as one minute and stronger results than the single-image/few-view baselines they evaluated. This headline is an experimental pipeline timing, not an established one-minute consumer GPU workflow. Its interactive splat demos are valuable evidence that the output is persistent 3D. For a VR project, it demonstrates an influential method—generate a consistent virtual photo capture, then reconstruct—but is currently more useful as a research reference than an installable dependency. Newly synthesized surfaces remain plausible alternatives, and fine geometry can degrade away from observed views. [Peer-reviewed paper](https://proceedings.neurips.cc/paper_files/paper/2024/file/89e4433fec4b99f1d859db57af1e0a0f-Paper-Conference.pdf).

### 11 Apple SHARP

**Input and method.** SHARP, *Sharp Monocular View Synthesis in Less Than a Second* (2025), predicts metric-scale 3D Gaussians from one photograph in one feed-forward pass. It targets photorealistic nearby viewpoints. It does not claim to recover the unseen back side of an entire room. [Paper](https://arxiv.org/abs/2512.10685), [project](https://apple-aiml-research.github.io/ml-sharp/).

**Code and models.** [Official source](https://github.com/apple-aiml-research/ml-sharp) is available, and the CLI automatically downloads `sharp_2572gikvuh.pt`. Prediction supports CPU, CUDA, and Apple MPS; the bundled trajectory rendering requires CUDA. Apple provides separate [code](https://github.com/apple-aiml-research/ml-sharp/blob/main/LICENSE) and [model](https://github.com/apple-aiml-research/ml-sharp/blob/main/LICENSE_MODEL) licenses. The released model is restricted to noncommercial scientific research and excludes commercial product development.

**Output, quality, and VR assessment.** Export is Gaussian PLY. The authors report subsecond inference on a standard GPU, with LPIPS improvements of 25–34% and DISTS improvements of 21–43% versus their strongest prior baseline across evaluated datasets. Those are author-reported perceptual comparisons, not a general VR score. SHARP is particularly relevant for small head movements around a cherished photo: fast, local, and close to the input appearance. Large translation, missing surfaces, and collision are unresolved by a single-view prediction. An appropriate research baseline for spatial photographs, with more limited movement than a generated world. [Implementation and claims](https://github.com/apple-aiml-research/ml-sharp).

### 12 Flash3D

**Input and method.** Flash3D (2024 preprint; 3DV 2025) reconstructs a scene from one image using a frozen monocular depth foundation model, followed by a ResNet50-like encoder/decoder predicting multiple depth-ordered layers of Gaussian parameters. The extra layers estimate surfaces hidden behind visible pixels rather than merely extruding a depth map. The released depth configuration uses UniDepth v1. [Official project](https://www.robots.ox.ac.uk/~vgg/research/flash3d/), [paper](https://arxiv.org/abs/2406.04343).

**Code and models.** [Training/evaluation source](https://github.com/eldar/flash3d) and the pretrained [RealEstate10K checkpoint](https://huggingface.co/einsafutdinov/flash3d) are available. The official download script obtains `model_re10k_v2.pth`. The documented environment uses Python 3.10, PyTorch 2.2.2, and CUDA 11.8. No explicit top-level license was located in the inspected repository, so do not label it MIT/Apache or assume commercial permission.

**Quality and VR assessment.** Authors report training on one GPU in a day and strong transfer from RealEstate10K to NYUv2 and KITTI, including higher KITTI PSNR than some methods trained on KITTI. Its geometry is suitable for real-time Gaussian rendering, but the release is a research reconstruction pipeline rather than a ready VR application. Predicting hidden layers helps modest disocclusions; it cannot establish the true contents of unseen rooms. A useful lightweight comparison for SHARP, particularly when studying how depth estimation and layered splats affect photo fidelity. [Cross-dataset results and method](https://www.robots.ox.ac.uk/~vgg/research/flash3d/).

### 13 3D Photo Inpainting

**3D Photography using Context-aware Layered Depth Inpainting** — CVPR 2020. A photograph plus measured or estimated depth becomes a layered depth image with explicit connectivity. Separate learned inpainting stages fill hidden color and depth around occlusion boundaries, producing a representation renderable with ordinary graphics engines. The released pipeline estimates depth from ordinary RGB photographs, so a depth camera is not mandatory. [Project](https://shihmengli.github.io/3D-Photo-Inpainting/) · [Paper](https://arxiv.org/abs/2004.04727).

**Code and models:** [Official repository](https://github.com/vt-vl-lab/3d-photo-inpainting) supplies downloadable weights, a Colab, MiDaS integration, and optional **PLY mesh** export via `save_ply`. It is **MIT licensed** at the root and builds on EdgeConnect, MiDaS, and partial-convolution inpainting. The documented stack is old: Python 3.7 and PyTorch 1.4.

**Quality and VR fit:** The README estimates **2–3 minutes per photo**, varying with available hardware. The method is established for motion-parallax photos and demonstrates fewer occlusion artifacts than its contemporary baselines. Its strongest use in a memoir application is preserving the original photograph’s appearance while allowing gentle head movement. Inpainted content behind edges is invented; depth mistakes stretch surfaces, and large translations expose the limits of the source view. It is a strong baseline for a photograph presented spatially in VR, not a general room-generation system. The mesh export makes it easier to integrate into conventional graphics engines than a research-only novel-view video output.

### 14 AdaMPI

**Single-View View Synthesis in the Wild with Learned Adaptive Multiplane Images** — SIGGRAPH 2022. AdaMPI takes a photograph and estimated depth, adjusts the positions of multiple image planes to suit that scene, and predicts color/density for each plane. Its warp-back training procedure builds synthetic stereo supervision from ordinary single-image collections. [Project](https://yxuhan.github.io/AdaMPI/) · [Paper](https://arxiv.org/abs/2205.11733).

**Code and models:** [Official repository](https://github.com/yxuhan/AdaMPI) includes inference and training code. [Model instructions](https://github.com/yxuhan/AdaMPI/blob/master/doc/AdaMPI.md) link **32-plane and 64-plane pretrained models**, use **DPT hybrid MiDaS** depth estimation by default, and provide a pretrained EdgeConnect model for data construction. The README restricts use to **personal/research/noncommercial purposes**. Its example outputs rendered MP4; an application would need to retain/render the MPI for interactive VR.

**Quality and VR fit:** Adaptive planes help distribute detail around complex depth layouts more effectively than fixed plane positions. The authors trained at **256×384** and state that **512×768** also works empirically; they did not validate arbitrary higher resolutions in the documented release. This is well suited to stereo/parallax photography and bounded motion, with low-detail background synthesis and discretized-depth artifacts remaining concerns. It is not a 360-degree room or an editable watertight mesh. Use it as a research baseline for how much immersion can be gained from one photo before adopting heavier world-generation methods.

### 15 Worldsheet

**Worldsheet: Wrapping the World in a 3D Sheet for View Synthesis from a Single Image** — ICCV 2021 Oral. A network predicts offsets and depth for a planar mesh grid, wraps that sheet to inferred scene geometry, and samples a texture map from the source image. Differentiable rendering and an optional inpainter yield new camera views. A multilayer extension handles some occlusions. [Project](https://worldsheet.github.io/) · [Paper](https://arxiv.org/abs/2012.09854).

**Code and models:** [Official repository](https://github.com/facebookresearch/worldsheet) includes pretrained-model download scripts for Matterport3D/Replica and RealEstate10K and interactive notebooks. It uses **MMF and PyTorch3D**, and its documented implementation requires a GPU. The [code license](https://github.com/facebookresearch/worldsheet/blob/main/LICENSE) is **BSD 3-clause**. The repository was archived on **31 October 2023**, so environment maintenance is likely necessary.

**Quality and VR fit:** The authors compare against SynSin and other contemporaries on Matterport3D, Replica, and RealEstate10K and report improved view synthesis, including larger camera changes. Their demonstrated failures include blur around discontinuous object boundaries, such as trees and flowers. Treat the result as a textured 3D pop-up: it is useful for bounded head movement around a photograph and for understanding a lightweight mesh-based approach. It does not infer a complete navigable room with hidden object backs, stable collisions, or unrestricted 360-degree coverage. Model quality should be judged in the context of 2021 baselines.

### 16 HunyuanWorld-Mirror and WorldMirror

**Input and method.** Released in 2025 and accepted to ICML 2026, WorldMirror reconstructs from one or more images or sampled video frames; multiple views improve scene coverage. A feed-forward network combines visual observations with optional camera intrinsics, poses, or depth priors and predicts point maps, cameras, depth, normals, and 3D Gaussians. This is a reconstruction backend, not a system that invents a complete surrounding world from a lone photograph. [Code and documentation](https://github.com/Tencent-Hunyuan/HunyuanWorld-Mirror), [paper including single-view inference](https://arxiv.org/html/2510.10726v2).

**Code and models.** Public inference, training, evaluation, and Gradio code; [pretrained weights](https://huggingface.co/tencent/HunyuanWorld-Mirror). The custom [Tencent license](https://github.com/Tencent-Hunyuan/HunyuanWorld-Mirror/blob/main/License.txt) includes territory restrictions. CUDA 12.4 is recommended. Inference can export Gaussian PLY and COLMAP initialization for subsequent optimization.

**Quality and VR assessment.** The authors report RealEstate10K PSNR 20.62, SSIM 0.706, and LPIPS 0.187 without priors; camera intrinsics plus poses improve these to 22.30, 0.774, and 0.155 in the same evaluation. These establish a benefit from calibrated input, not a universal advantage over every reconstruction method. A useful route for a memory application when several photos or a walkthrough exist. Scene coverage, reflective surfaces, and geometric errors still constrain what users can explore. Splats need a stereo renderer and a separate usable collision surface. [Official evaluation table and export workflow](https://github.com/Tencent-Hunyuan/HunyuanWorld-Mirror#-performance).

### 17 DUSt3R

**Identity and method.** DUSt3R: Geometric 3D Vision Made Easy, CVPR 2024, reconstructs geometry from image pairs or larger uncalibrated collections without requiring camera intrinsics or poses up front. A transformer predicts dense point maps for each pair; global alignment places the pairwise predictions into a shared coordinate system. It unifies monocular and binocular estimation, but additional views provide the evidence needed for a more complete scene. [Official project](https://europe.naverlabs.com/research/publications/dust3r-geometric-3d-vision-made-easy/)

**Code and models.** [naver/dust3r](https://github.com/naver/dust3r) releases inference, training, an interactive demo, and ViT-Large checkpoints at 224/512 resolutions with linear or DPT decoders. Weights can download through Hugging Face or NAVER. Code is CC BY-NC-SA 4.0; checkpoint use also carries relevant training-dataset and base-checkpoint conditions.

**How well it works and VR assessment.** Its published experiments demonstrated strong depth and pose estimation at release. Its useful contribution to VR is simplifying the difficult camera-and-geometry stage for casual photographs. The output point maps, depths, and inferred cameras can seed a later mesh or splat pipeline; they are not a finished photorealistic world. Practical assessment: useful for sparse captures, but confidence filtering, scale/alignment checks, scene completion, textures, and a runtime renderer remain necessary. A single image still cannot establish the true geometry behind occluders. [Methods and results](https://europe.naverlabs.com/research/publications/dust3r-geometric-3d-vision-made-easy/), [implementation](https://github.com/naver/dust3r)

### 18 MASt3R

**Identity and method.** Grounding Image Matching in 3D with MASt3R, ECCV 2024, extends DUSt3R with dense local descriptors and a matching loss. Fast reciprocal matching improves correspondence accuracy while retaining resilience to large viewpoint changes. The maintained repository includes MASt3R-SfM, combining image retrieval/pairing with sparse global alignment for larger photo collections. [Paper](https://arxiv.org/abs/2406.09756), [repository](https://github.com/naver/mast3r)

**Code and models.** The repository provides the `MASt3R_ViTLarge_BaseDecoder_512_catmlpdpt_metric` checkpoint, retrieval weights, training instructions, and demos. Source is CC BY-NC-SA 4.0. Checkpoints carry additional dataset restrictions, specifically called out in `CHECKPOINTS_NOTICE`; top-level availability should not be read as unrestricted commercial permission. [Checkpoint notice](https://github.com/naver/mast3r/blob/main/CHECKPOINTS_NOTICE)

**How well it works and VR assessment.** The paper reports a 30 percentage-point absolute improvement in VCRE AUC over the then-best published methods on Map-free localization. This measures localization/matching, not headset image quality. MASt3R is a strong geometry front end for difficult overlapping photos, and a distinct algorithmic project rather than a DUSt3R wrapper. Its point geometry and camera estimates still require meshing or radiance-field fitting for polished VR. The repository explicitly calls its alternative COLMAP/GLOMAP integration demos experimental and potentially fragile. [Paper result](https://arxiv.org/abs/2406.09756), [MASt3R-SfM documentation](https://github.com/naver/mast3r)

### 19 VGGT

**Identity and method.** Visual Geometry Grounded Transformer, CVPR 2025, predicts cameras, point maps, depth, and point tracks from one, a few, or many images. DINO-derived image tokens pass through alternating per-image and cross-image attention, followed by specialized camera and dense-prediction heads. It is a geometry foundation model rather than a scene-completion generator. [Project](https://vgg-t.github.io/)

**Code and models.** [facebookresearch/vggt](https://github.com/facebookresearch/vggt) includes inference, training, visual demos, and COLMAP export with optional bundle adjustment. Public `VGGT-1B` weights remain noncommercial. Since July 2025 the code permits commercial use under a custom license, and the separately gated [VGGT-1B-Commercial](https://huggingface.co/facebook/VGGT-1B-Commercial) checkpoint supports commercial use under that license and acceptable-use restrictions. Do not label the whole project Apache/MIT or assume the original weights inherited the new terms.

**How well it works and VR assessment.** The project reports sub-second reconstruction in its demonstrated settings and strong geometry-task benchmarks; that is not a promise for hundreds of high-resolution images. Its fast pose/depth estimates and ready COLMAP export make it an attractive preprocessing candidate for splat training. Practical limitations include geometry confidence, memory growth with image count, unobserved areas, and lack of finished surfaces/materials. VR requires a second reconstruction/rendering stage. The repo now links VGGT-Omega as a 2026 successor, not counted separately here. [Capabilities and current release notes](https://github.com/facebookresearch/vggt)

### 20 pixelSplat

**Identity and method.** pixelSplat: 3D Gaussian Splats from Image Pairs for Scalable Generalizable 3D Reconstruction, CVPR 2024, predicts a Gaussian scene in one feed-forward pass from two posed images. An epipolar transformer gathers cross-view evidence, predicts a depth probability distribution, and differentiably samples Gaussian centers. The current code also includes a three-view configuration. [Project](https://davidcharatan.com/pixelsplat/), [code](https://github.com/dcharatan/pixelsplat)

**Code and models.** Source is MIT and camera-ready pretrained models are downloadable, trained on RealEstate10K and ACID. However, its CUDA rasterizer dependency, `dcharatan/diff-gaussian-rasterization-modified`, retains Inria's research/evaluation-only license; the complete default stack is not simply MIT. [Requirements](https://github.com/dcharatan/pixelsplat/blob/main/requirements.txt), [dependency license](https://github.com/dcharatan/diff-gaussian-rasterization-modified/blob/main/LICENSE.md)

**How well it works and VR assessment.** The current README reports RealEstate10K PSNR 26.09, SSIM 0.863, LPIPS 0.136 for its updated model. These are benchmark-view fidelity results, not world-completeness scores. The project notes depth ambiguity on blank surfaces and used additional depth-regularized fine-tuning for its illustrated Gaussian point-cloud exports. Practical assessment: useful rapid sparse-view reconstruction, but two views cannot support arbitrary travel around a complete room; extrapolation and geometry need inspection. It produces renderable 3D, while VR playback, collision, and cleanup remain downstream. [Results](https://github.com/dcharatan/pixelsplat), [geometry caveat](https://davidcharatan.com/pixelsplat/)

### 21 MVSplat

**Identity and method.** MVSplat: Efficient 3D Gaussian Splatting from Sparse Multi-View Images, ECCV 2024, takes as few as two posed images. A multi-view transformer and plane-sweep cost volumes match features across views; predicted depths become Gaussian centers, while another branch predicts color, covariance, and opacity. It produces a scene in a feed-forward pass instead of fitting every scene from scratch. [Project](https://donydchen.github.io/mvsplat/)

**Code and models.** [donydchen/mvsplat](https://github.com/donydchen/mvsplat) supplies MIT source, RealEstate10K/ACID pretrained checkpoints, evaluation scripts, and export examples. Its default modified rasterizer has the same restrictive Inria license noted for pixelSplat, despite the parent project's MIT license. The backbone uses UniMatch initialization. [Requirements](https://github.com/donydchen/mvsplat/blob/main/requirements.txt), [rasterizer license](https://github.com/dcharatan/diff-gaussian-rasterization-modified/blob/main/LICENSE.md)

**How well it works and VR assessment.** The authors report 22-fps feed-forward inference, ten times fewer parameters than pixelSplat, and better cross-dataset generalization in their experiments. Their RealEstate10K final model records PSNR 26.39, SSIM 0.869, LPIPS 0.128. Published failure cases include reflective and non-Lambertian surfaces. Exported PLY Gaussians offer a practical route to a compatible renderer. Assess it as a fast reconstruction building block for overlapping sparse photos, not complete 360-degree scene generation; its 22-fps figure is neither VR rendering speed nor headset throughput. [Paper and limitations](https://arxiv.org/html/2403.14627v2)

### 22 DepthSplat

**Identity and method.** DepthSplat: Connecting Gaussian Splatting and Depth was posted in 2024 and presented at CVPR 2025. It combines multi-view matching with pretrained monocular depth features, then predicts Gaussian scene parameters. The complementary training direction uses image-rendering losses as unsupervised supervision for depth. Scene reconstruction uses multiple posed photographs; its monocular feature branch does not make the whole reconstruction system a single-image world generator. [Project](https://haofeixu.github.io/depthsplat/)

**Code and models.** [cvg/depthsplat](https://github.com/cvg/depthsplat) has MIT source, PyTorch/CUDA instructions, and PLY Gaussian export. Its [model zoo](https://github.com/cvg/depthsplat/blob/main/MODEL_ZOO.md) links public Hugging Face checkpoints for splatting and depth, with small/base/large variants, 2–10 training-view configurations, and RealEstate10K/DL3DV training. Depth models initialize features from Depth Anything V2 and UniMatch; dependencies and pretrained-model terms still require separate attention.

**How well it works and VR assessment.** The project demonstrates novel-view synthesis from six 512×960 input views in 0.3 seconds on an A100 and reports strong ScanNet, RealEstate10K, and DL3DV results. This is reconstruction/synthesis timing, not headset runtime. Its added depth prior makes it a particularly relevant sparse-capture candidate, with directly exportable splats. Incorrect poses, hidden regions, reflective surfaces, scene scale, collision geometry, and stereo rendering remain practical concerns to test. [Reported result](https://haofeixu.github.io/depthsplat/)

### 23 COLMAP

**Identity and method.** COLMAP is the established photogrammetry project associated with the 2016 Structure-from-Motion Revisited and Pixelwise View Selection for Unstructured Multi-View Stereo papers. It takes an overlapping photo collection, estimates camera intrinsics and poses through feature matching and bundle adjustment, then estimates and fuses depth into a dense point cloud. Its current documentation includes surface reconstruction, mesh simplification, and texture-atlas generation. This produces conventional geometry suitable for a game-engine workflow. [Official tutorial](https://colmap.github.io/tutorial.html)

**Code and models.** [colmap/colmap](https://github.com/colmap/colmap) supplies source, GUI, CLI, and Python bindings under BSD-3-Clause, with separately licensed dependencies. The classical SIFT/SfM/MVS path does not require a pretrained generative model. Do not describe it as a one-photo world generator.

**How well it works and VR assessment.** A strong baseline for recovering the actual photographed place, especially when surfaces are textured and views overlap. The authors advise observing each object in at least three images, changing camera position, and avoiding blur, textureless walls, specularities, and inconsistent illumination. Runtime depends heavily on image count and resolution. Mesh exports give a direct route to collision, lighting, and engine deployment after cleanup and optimization; missing coverage stays missing rather than becoming a convincingly invented room. [Capture and dense reconstruction guidance](https://colmap.github.io/tutorial.html)

### 24 Original 3D Gaussian Splatting

**Identity and method.** GraphDeco's 3D Gaussian Splatting for Real-Time Radiance Field Rendering is the SIGGRAPH 2023 reference project. Multiple calibrated photographs and SfM points initialize anisotropic Gaussians; optimization adjusts their position, scale, rotation, opacity, and view-dependent color, while densification adds scene detail. The result is an explicit radiance field, not a watertight triangle mesh. [Project and paper](https://repo-sam.inria.fr/fungraph/3d-gaussian-splatting/)

**Code and models.** [graphdeco-inria/gaussian-splatting](https://github.com/graphdeco-inria/gaussian-splatting) includes training, conversion, viewers, and pretrained example scenes. Those downloads are scene assets, not a general photo-to-world model. Its custom license permits research and evaluation; commercial use requires the licensors' consent. The reference configuration specifies a CUDA GPU and 24 GB VRAM to reproduce paper-quality training. [License](https://github.com/graphdeco-inria/gaussian-splatting/blob/main/LICENSE.md)

**How well it works and VR assessment.** The original project reports high-quality real-time 1080p rendering, making it influential for visual scene playback. This is not a standalone-headset stereo performance guarantee. Crucially, the repository now documents an OpenXR viewer branch, `gaussian_code_release_openxr`, so there is an explicit VR route. Expect excellent captured appearance but incomplete unseen surfaces, rendering artifacts outside coverage, substantial asset sizes, and a separate mesh/collision workflow. [Requirements and OpenXR support](https://github.com/graphdeco-inria/gaussian-splatting)

### 25 Nerfstudio

**Identity and method.** Nerfstudio launched in 2022; its framework paper appeared in 2023. It is a maintained training and visualization framework, counted once here including its Nerfacto and Splatfacto methods. Multi-image or video input is processed into camera poses, commonly with COLMAP, before optimizing a scene-specific radiance field or Gaussian representation. [Repository](https://github.com/nerfstudio-project/nerfstudio), [input pipeline](https://docs.nerf.studio/quickstart/custom_dataset.html)

**Code and models.** Source is Apache-2.0. Nerfacto and Splatfacto generally train a new scene model from the user's capture rather than applying universal photo-to-world weights. Splatfacto uses the separately maintained gsplat renderer. The documented Splatfacto memory estimates are approximately 6 GB for default and 12 GB for the larger variant, not universal guarantees. [Splatfacto documentation](https://docs.nerf.studio/nerfology/methods/splat.html)

**How well it works and VR assessment.** A practical integration starting point because capture, training, inspection, and export are documented together. Gaussian models export as PLY; appropriate neural-field models can export point clouds or textured OBJ meshes. These capabilities are method-specific: Splatfacto's page does not promise a direct mesh export. Appearance can be excellent within captured coverage; poor camera alignment, floaters, spiky Gaussians, and unseen regions still need attention. A VR renderer and a collision proxy remain separate integration work. [Geometry export](https://docs.nerf.studio/quickstart/export_geometry.html), [splat export and artifacts](https://docs.nerf.studio/nerfology/methods/splat.html)

## Four additional practical options

These are separate projects worth considering alongside the research systems. All need multiple observations for photographic reconstruction.

### Varjo Teleport

**Method and availability:** A proprietary hosted Gaussian-splatting capture pipeline accepts photo sets or video and returns scenes that can be explored in a browser or its Windows VR viewer. The published upload guide specifies 50–2,000 photos, or video of 30 seconds to 15 minutes, subject to file-size limits. No public reconstruction source or model weights are offered in the cited workflow. Paid subscribers can export PLY scenes. [Upload requirements](https://teleport.varjo.com/help/en_US/uploading), [export](https://teleport.varjo.com/help/en_US/export).

**How well it fits:** This is an especially useful product baseline because VR viewing is explicitly documented. The Windows app supports Quest 2/3 through Quest Link and other OpenXR headsets; the page recommends substantial desktop GPU capacity, so this is not evidence of standalone Quest performance. It is a practical route for revisiting a captured place, subject to capture coverage and static-scene assumptions. [Supported hardware and navigation](https://teleport.varjo.com/downloads/).

### Meshroom and AliceVision

**Method and availability:** An open node-based application runs AliceVision's feature matching, structure from motion, multiview depth, meshing, and texturing. The conventional pipeline produces an OBJ mesh with material and texture files. Meshroom uses MPL-2.0 and provides source and binaries; the classical workflow does not require a downloadable neural generator. The current framework also exposes optional depth, matching, and Gaussian plugins, whose dependencies should be considered separately. [Source and plugins](https://github.com/alicevision/Meshroom), [photogrammetry pipeline](https://meshroom-manual.readthedocs.io/en/latest/feature-documentation/core/pipelines/photogrammetry.html), [texturing output](https://meshroom-manual.readthedocs.io/en/latest/feature-documentation/nodes/Texturing.html).

**How well it fits:** A useful visual alternative to assembling COLMAP commands when the desired result is an ordinary mesh. VR integration still needs simplification, textures, scale alignment, and engine import. Like other photogrammetry, insufficient overlap, shiny surfaces, plain walls, and movement are difficult cases; it does not invent a convincing unseen room from one photo.

### RealityScan

**Method and availability:** Epic's proprietary photogrammetry application reconstructs objects and environments from image collections, with optional laser-scan inputs. It has desktop and mobile workflows, sample datasets, and CLI automation. Its reconstruction implementation and learned internals are not distributed as a public research model. [Official product and documentation links](https://www.realityscan.com/).

**How well it fits:** A practical mesh-production comparator when additional photographs can be captured. It trades implementation control for a packaged workflow. Its results still depend on image coverage and capture quality, and a dense reconstruction normally needs optimization before headset use. Evaluate its actual exported mesh against the open pipelines on the same photographs; product demonstrations are not a standardized comparative benchmark.

### Polycam

**Method and availability:** Polycam offers photo-based photogrammetry meshes and Gaussian splats, with access and image limits depending on platform and plan. The service does not expose its reconstruction training weights or full source. Its integration guide distinguishes PLY splats for appearance from GLTF geometry for collisions. [Capture modes](https://learn.poly.cam/hc/en-us/articles/27425185907348-How-to-Use-Object-Mode), [engine export workflow](https://learn.poly.cam/hc/en-us/articles/42506758152084-Export-Gaussian-Splats-from-Polycam-to-Unreal-Engine).

**How well it fits:** An accessible capture-to-asset baseline with less setup than research code. Polycam's own guidance flags featureless surfaces and moving subjects as poor targets. Splats can retain difficult visual detail, but their appearance should not be confused with accurate reflective or transparent physical surfaces. A scene exported to an engine still needs stereo performance and collision validation.

## Turning the output into a VR world

For Again's existing Three.js viewer, **Spark is a relevant rendering layer**: it supports common Gaussian formats, mixes splats with meshes, and is MIT licensed. It is a renderer rather than an image reconstruction project, so it is not counted among the 25. GaussianSplats3D also documents built-in WebXR, but its maintainer now directs users to Spark because active development has stopped. [Spark repository](https://github.com/sparkjsdev/spark), [GaussianSplats3D status](https://github.com/mkkellogg/GaussianSplats3D).

Use an offline generation or reconstruction worker, store a fixed asset, and have each participant load that same asset in the same coordinate frame. Keep scene appearance, collision geometry, and interactive props as separate assets. A Gaussian PLY is not interchangeable with a polygon-mesh PLY, and neither becomes a GLB simply by changing its extension.

| Integration concern | What to verify |
| --- | --- |
| Stereo | Both eye views remain plausible; transparent surfaces and splat sorting do not produce distracting eye disagreement |
| Head movement | Nearby translations do not reveal large holes, stretched silhouettes, doubled people, or floating texture |
| Scale and origin | Eye height, floor, controllers, avatars, and collision geometry agree on units and axes |
| Locomotion | Traversable space is supported by geometry; restrict artificial walking to the validated region without counteracting tracked head motion |
| Interaction | Pickable objects have their own geometry and transforms; baked scene appearance does not imply separate objects |
| Performance | Measure stereo frame time, dropped frames, load time, GPU memory, and network asset size on the intended headset |
| Repeatability | Preserve input files, model/checkpoint version, camera settings, seed, generation settings, and asset provenance |

Spark's performance guidance suggests roughly **one million splats or fewer for Quest 3**, with distribution and overdraw also affecting speed. That is a rule of thumb, not a frame-rate guarantee. Start with reduced assets and measure the actual stereo scene. A research paper's desktop rendering FPS cannot establish Quest performance. [Spark performance guide](https://sparkjs.dev/docs/performance/).

For Marble exports specifically, scale both Gaussian centers and linear sizes, apply the ground-plane offset only to centers, then convert the renderer axes. Its API exposes 100k, 500k, and full-resolution SPZ assets plus collision geometry; additional exports include meshes. Correct coordinate handling is necessary for the environment to agree with avatars and teleportation. [API asset fields](https://docs.worldlabs.ai/api), [SPZ coordinate specification](https://docs.worldlabs.ai/api/rendering-spz).

## Which projects to try first

These are priorities for evaluation in Again, based on the documented outputs and operational requirements.

| Need | First comparison | Why |
| --- | --- | --- |
| Explore a plausible world from one historical photo | Marble; VistaDream where dependency terms permit; PanoDreamer after its licensing is clarified | Direct scene outputs and explicit image conditioning |
| Preserve the photographed people and moment | Existing photo renderer versus 3D Photo Inpainting; SHARP only within its permitted research scope | Local parallax can preserve observed appearance without requiring invented full bodies |
| Build a world from a real photo sequence or camera-moving video | COLMAP plus Nerfstudio Splatfacto; compare original 3DGS or Teleport | Additional real views constrain geometry and appearance |
| Recover camera poses or initialize geometry quickly | VGGT and Mirror; compare DUSt3R/MASt3R where their terms fit | Useful components for a larger reconstruction pipeline |
| Study larger generated worlds | HY-World 2.0 and Lyra 2.0 | Relevant methods, with substantial hardware and licensing constraints |
| Produce conventional engine geometry | COLMAP/Meshroom or RealityScan | Meshes provide a more direct foundation for collision and editing |

For personal memoirs, evaluate **identity and source-image fidelity separately from scenic beauty**. A plausible café with a different face, an extra person, or changed lettering is a poor reconstruction of that memory even if its flythrough is attractive. Generated content behind the photographer should remain identifiable as inferred content.

## A fair evaluation on this repository's photographs

Use a small shared test set spanning a cluttered indoor scene, an outdoor street, a person close to the camera, thin structures, reflective objects, and a scene with real overlapping views. Keep the original input and comparable output resolution. Do not compare a one-photo method with a many-photo method without recording the extra evidence available to the latter.

1. **Source-view fidelity:** Compare the original camera rendering with the photo. Inspect faces, hands, clothing, text, silhouettes, object counts, and arrangement. For calibrated captures, add image metrics such as PSNR, SSIM, and LPIPS, while recognizing that they do not alone measure identity or comfort.
2. **Unseen real views:** Where extra photographs exist, hold some out of reconstruction and compare the rendered view against them. This is stronger evidence of correct geometry than another generated image.
3. **Exploration coverage:** Test head movement first, then increasing sideways and forward translations. Record the region in which the scene remains convincing. The same nominal movement distance can expose very different errors in close and distant scenes.
4. **Stereo and headset runtime:** Evaluate both eyes, floor alignment, camera motion, and collisions on the actual Quest. Record sustained frame times and load/memory costs, not just a desktop flythrough.
5. **Operational cost:** Record generation latency, peak VRAM, output size, manual cleanup, failure rate, and any per-scene service charge. Keep generation time separate from runtime rendering speed.

The right result may be two complementary modes: a faithful spatial photograph with a modest viewing region, and an explicitly generated environment with wider exploration. The evidence in the original photographs should determine how confidently either can be described as a reconstruction.
