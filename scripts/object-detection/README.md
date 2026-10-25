# Local object detection

Run from the repository root after `npm install`:

```powershell
npx tsx scripts/object-detection/detect-local.ts data/uploads/example.jpg
```

This uses the existing `@huggingface/transformers` package and CPU ONNX Runtime.
No Python, API key, paid inference service, or remote custom code is required.
The first run downloads public Apache-2.0 model weights into `data/models`:

* [OWLv2 base ensemble](https://huggingface.co/Xenova/owlv2-base-patch16-ensemble), quantized, proposes the eight supported categories while competing with common confusing objects.
* [Grounding DINO tiny](https://huggingface.co/onnx-community/grounding-dino-tiny-ONNX), full precision, independently confirms category and box. Single-category queries are deliberate: combined queries misattributed labels during our actual-photo trial. Keep this export's native 800×800 processor size; changing it produced incorrect coordinates.
* [SlimSAM](https://huggingface.co/Xenova/slimsam-77-uniform), quantized, refines the detected box into a visible-object silhouette. Its corner prompt comes from the detector, not a manual annotation. Fingers and background excluded by the mask are not used as object texture.

Together the downloaded weights are about 900 MB. They are loaded sequentially and released between stages to limit memory; first-time analysis is slower than cached playback. Larger images use overlapping tiles to retain small held objects. Empty output is valid: ambiguous categories, disagreeing detectors, and unreliable silhouettes are rejected. Model scores are not calibrated probabilities and differ between models.

Detection results, including proposals and confirmed boxes for auditing, are cached by image content and algorithm version under `data/models/object-detections`. Only completed inference is cached; a runtime failure is retriable. These local data and media files are gitignored. The CLI writes human-readable output into `.local/object-detection-results`.

For the existing Carriage archive, `npx tsx scripts/object-detection/review-carriage.ts` creates an observational review set and native-resolution video samples without downloading additional social media or changing the library. This is not a comprehensive benchmark. Hidden surfaces and metric dimensions cannot be recovered exactly from one image; the renderer uses observed pixels and silhouette, with inferred unseen geometry.

Reference: [Grounding DINO documentation](https://huggingface.co/docs/transformers/en/model_doc/grounding-dino), [SlimSAM usage](https://huggingface.co/Xenova/slimsam-77-uniform).
