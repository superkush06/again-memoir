# Carriage archive object review

The locally imported `carriage.senior.society` archive contains **seven photos and one video**, not a full copy of the Instagram profile. This review uses those actual files without importing additional posts or creating synthetic positives. Photo resolutions range from 1080 to 2048 pixels wide. The video is 960 × 720 and 21.866667 seconds long.

## Reproduce the evidence

```sh
npx tsx scripts/object-detection/review-carriage.ts
```

The read-only script creates `.local/carriage-object-audit/manifest.json`, photo and video contact sheets, and eight native-resolution video frames at the same timestamps as the reconstruction sampler. It makes no network or model calls and does not change the memory library. `ffmpeg` and `ffprobe` must be available, or supplied through `FFMPEG_PATH` and `FFPROBE_PATH`.

The manifest includes source memory IDs, local paths, dimensions, timestamps, and observational boxes. The script deliberately uses the eight known imported memory IDs rather than treating every future Instagram import as Carriage content. Generated media stay in ignored local storage.

## What is actually visible

Coordinates below are `[left, top, right, bottom]` in the original file, not normalized coordinates.

| Source memory                                             | Observation                                                                                       | Approximate box                        | Use in evaluation                                                                            |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------- | -------------------------------------------------------------------------------------------- |
| `instagram-fd427937e17e9f26d0d1` — color group photo      | Short white drink can, silver rim, small dark printing and a straw; hands cover part of the sides | `[1124,1042,1233,1176]` at 2048 × 1536 | Definite positive; compare reconstructed proportions and visible label details to the source |
| `instagram-21c762de5b9534ba7464` — monochrome group photo | Small light rectangle held in the left background, with dark camera-like circles                  | `[205,665,248,746]` at 1102 × 1116     | Probable phone, blurred and partly occluded; not definitive ground truth                     |
| `instagram-fd427937e17e9f26d0d1`                          | Tall blue portable speaker on top of a bookcase                                                   | `[410,175,457,262]`                    | Hard negative for water bottle                                                               |
| `instagram-fd427937e17e9f26d0d1`                          | Angled book or paper display on top of the bookcase; no keyboard or screen visible                | `[227,175,363,264]`                    | Hard negative for laptop                                                                     |
| `instagram-48d65fa54e34dc19b2f4` — video                  | Cemetery monuments and an obelisk, followed by an eye/title graphic and black frames              | Whole sequence                         | Hard negatives for bottles; no requested common-object positive found                        |

All seven photos were inspected. The video was reviewed at approximately one frame per second and at the eight exact reconstruction timestamps: 0, 3.095, 6.190, 9.286, 12.381, 15.476, 18.571, and 21.667 seconds. No definitive computer/laptop, water bottle, chip bag, box, or backpack positive was found in this small archive. The award poster contains shoulder handbags, which should not be relabeled as backpacks.

These observations are a small manual review, **not a comprehensive annotated benchmark**. They do not support an overall accuracy percentage. Object detection on the video is tested by correctly declining to create objects from monuments and graphics. It is not a positive video-object showcase.

## Fidelity criteria

- Preserve the white can's short, broad body, source printing and rim. A tall untextured soda-can primitive fails this example even if its category is correct.
- Exclude visible hands from the object texture where the mask supports it. Do not invent label text hidden by fingers.
- Keep any accepted monochrome phone monochrome; the source does not reveal its original color or a readable brand.
- Hidden surfaces remain inferred. A single visible side cannot verify exact back labels, thickness, or occluded shape.
- Generated shape galleries are separate geometry tests. They are not evidence of detection or fidelity on the archive.

Model inference results should be reported separately from the manual observations, including model/version, score threshold, accepted boxes, rejected hard negatives, and failures. The review script intentionally does not feed its manual boxes to the detector.

## Actual local inference results — 24 October 2026

The final run used `owlv2-dino-slimsam-v4` on **all seven native-resolution photos and all eight native-resolution video samples**. It made no Gemini calls. The model stack was:

- Proposals: `Xenova/owlv2-base-patch16-ensemble`, quantized CPU inference, including overlapping image tiles for small objects.
- Category confirmation: `onnx-community/grounding-dino-tiny-ONNX`, FP32 CPU inference, with separate category prompts and comparison among can/bottle/cup alternatives.
- Visible silhouette: `Xenova/slimsam-77-uniform`, quantized CPU inference, cropped around confirmed objects.

Proposal scores must be at least 0.20; confirmation scores must be at least 0.40 with sufficient box overlap; segmentation candidates must pass their quality and spill checks. These different model scores are **not calibrated probabilities of correctness**. Unsupported competing labels can reject a proposal but never create a prop.

| Actual archived input                                               | Accepted objects                               | Visual review                                                                                                                                                 |
| ------------------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| “Every wheel needs its spokes” — monochrome crowd poster (`c3b12…`) | 0                                              | No definitive target object visible; no invented prop                                                                                                         |
| “introducing our class of 2027 board” (`1e2b…`)                     | 0                                              | Poster/city imagery retained                                                                                                                                  |
| Senior Honor Awards poster (`ef90…`)                                | 0                                              | Shoulder handbags were not turned into backpacks                                                                                                              |
| “Every wheel needs its spokes” — red rush poster (`ea4c…`)          | 0                                              | Text/graphic imagery retained                                                                                                                                 |
| “Spokes have been assembled” (`fd427…`)                             | **1 drink can**, confirmation score **0.6221** | Correct can category and location; native-image mask excludes the prominent fingers on both sides, preserving the visible white body, printing and silver rim |
| “keep the family close” (`15e0…`)                                   | 0                                              | No definitive target object visible                                                                                                                           |
| “Time flies #finale” (`21c7…`)                                      | 0                                              | **Missed/abstained on the probable tiny background phone**; insufficient evidence for claiming phone detection success                                        |
| “THIS WILL BE TO DIE FOR” (`48d65…`), all 8 timestamps              | **0 in every frame**                           | Cemetery markers, obelisk, eye graphic and black frames remained negatives, including the previously misclassified 9.286-second marker                        |

The accepted native can bounds are approximately `[1122,1038,1234,1174]` at 2048 × 1536, close to the independent manual body observation. Its straw and finger-covered label portions are not recovered. The source-mask review is `.local/carriage-object-audit/actual-can-native-detection-v4.png`; it is detection evidence, not a rendered 3D comparison. Raw per-file outputs are in `.local/object-detection-results/`, with the checked aggregate in `.local/carriage-object-audit/final-evaluation-v4.json`.

Resolution mattered materially. A diagnostic run on the prepared 1600-pixel image found the correct can category (score 0.6120) but included left-hand pixels in its mask. Earlier versions also confused this can with a bottle. The production photo path therefore uses the original upload for detection and a separate lossless object texture, independently of depth/body processing. The prepared-image result is retained as a known failure, not counted as successful appearance matching. Even native-resolution segmentation remains approximate at boundaries; this one example does not establish reliable hand exclusion across arbitrary photos.

The measured uncached native-photo runs took roughly 48–140 seconds on this workstation; native video samples took roughly 10–12 seconds. Reused cached results returned in milliseconds. These are development observations, not a general performance benchmark.

The actual scene pipeline was also exercised: the can photo upgraded to the original-resolution texture and mask (`owlv2-dino-slimsam-v4-original-v2`) while retaining its people, and all eight 512-pixel video reconstruction samples completed with zero accepted objects. The video scene upgrade took about 214 seconds on CPU; the photo upgrade reused detection results and took about four seconds. These runs constructed no Gemini client.

This run supports one genuine can positive and rejection of the reviewed negatives. It does **not** establish positive detection accuracy for computers, laptops, phones, chip bags, bottles, boxes, backpacks, or objects moving in video. Those categories are supported by the pipeline and geometry builders but need positive examples beyond the currently imported archive.
