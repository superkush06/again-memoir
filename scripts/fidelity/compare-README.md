# Saved depth comparison viewer

Run from the repository checkout:

```powershell
npx tsx scripts/fidelity/compare.ts
```

Open `http://127.0.0.1:5181/`. The listener binds only to loopback. It reads the 33-photo inventory and existing depth-ablation captures; it does not run inference, render a live 3D world, or write to saved assets. Restart the server to refresh the inventory/report snapshot.

Select a photo, two named implementations, a shared source/±8 cm **virtual** camera offset, and side-by-side or swipe display. Scene scale is inferred; offsets are not measured physical camera displacements. Reviewed cafe rectangles can be selected as fixed crops. Reset restores the source camera and full image. URL parameters `photo`, `left`, `right`, `view`, `mode` and `crop` restore the selection; the copy button copies that URL.

The initial built-in comparison has measurements for only photos 1–3. All 33 originals remain visible. Missing photos, views, variants and regional scores are explicitly unavailable. Side views suppress source-view numeric scores because there are no corresponding ground-truth images. A flat-plane control exposes shared resampling/color error and must not be interpreted as a reconstruction. Headset and runtime performance remain unmeasured.

Saved source-view global/ROI results come from `global-scores.json`, `evaluation-regions.json`, and `plane-scores.json`. The provenance disclosure links to the original immutable reports and includes camera/configuration, file hashes and geometry sizes. Region crops use the same floor/ceil pixel boundaries as the reviewed rectangular masks in `cafe-regions.json`.

Optional arguments are `--port`, `--inventory` and `--ablation-root`. There is deliberately no arbitrary run registry here; the main implementation comparison UI owns that workflow. Existing review UIs and application runtime files are untouched. The server only serves exact files registered from these local inventories; HTTP writes and arbitrary filesystem paths are rejected. All originals use existing small thumbnails with lazy loading. The measured-results document is linked from the provenance disclosure.
