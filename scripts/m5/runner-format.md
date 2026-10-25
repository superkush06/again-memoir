# M5 runner format

Every candidate model must produce one JSON report with this shape:

```json
{
  "version": 1,
  "backend": "depth-pro",
  "results": [
    {
      "backend": "depth-pro",
      "input": "/absolute/path/photo.jpg",
      "elapsedMs": 842,
      "stats": {
        "width": 1536,
        "height": 1024,
        "min": 0.4,
        "max": 18.2,
        "range": 17.8,
        "mean": 4.1,
        "finiteRatio": 1,
        "variance": 2.7
      },
      "valid": true,
      "geometryVertices": 786432,
      "geometryTriangles": 1500000
    }
  ]
}
```

The fixed test set must be identical across models and machines. Include at least:

- a wide indoor scene with people;
- a street or travel scene;
- a landscape with a visible ground plane;
- a close-up portrait;
- a flat wall or screen;
- a dark/night photo;
- a crowded scene with thin occlusion boundaries.

## Heavy-compute tracks

These are separate tracks because they solve different problems:

| Track | What it should improve | Test format | Priority |
| --- | --- | --- | --- |
| VGGT-Ω | multi-photo cameras, point maps, and consistent geometry | 8–32 photos from one event; compare camera consistency and point-cloud completeness | first |
| SAM 3D Body | photographed people, hands, feet, and occluded bodies | person crops plus crowded full-frame photos; compare mesh fit and identity-preserving texture registration | first for people |
| HunyuanWorld | semantic room/world completion and navigable unseen space | one anchor photo plus album context; inspect scene layout, corridor openness, and semantic layers | second |
| Hunyuan3D-2 | individual objects and props | masked object crops; compare GLB validity, silhouette, texture alignment, and triangle budget | second for props |
| COLMAP + gsplat | genuine multi-view reconstruction when several photos exist | 8–32 overlapping photos; compare camera reprojection, coverage, holes, and Quest frame time | highest quality, not single-photo |

Do not put these results into the same winner column as single-image depth. Choose per asset: Depth Pro/MoGe for a strong single photo, VGGT-Ω/COLMAP for an event album, SAM 3D Body for people, and Hunyuan3D only for selected props.

## Acceptance gates

A candidate is not eligible to replace the default unless it:

1. produces finite depth for every test photo;
2. produces a valid mesh for every 3D-ready photo;
3. does not create more stretched silhouette triangles than the baseline;
4. does not regress the flat-wall/screenshot rejection behavior;
5. improves VR inspection quality in a blind Quest comparison;
6. has acceptable average and p95 latency on the M5.

The comparison tool is:

```bash
npx tsx scripts/m5/compare-models.ts \
  --report baseline.json \
  --report depth-pro.json \
  --report moge.json \
  --report vggt.json \
  --output comparison.json
```


## Dump format

Runners write a dump directory instead of judging their own output:

- `run.json`: `version`, `backend`, `label`, `model`, `checkpoint`, `checkpointSha256`, `license`, `device`, `settings`, `machine` (chip, cores, memory, OS), `commit`, `modelLoadMs`, `peakRssBytes`, `peakDeviceBytes`, and `photos[]` with `id`, `input`, `sha256`, `depthFile`, `width`, `height`, `kind` and every timed call in `inferenceMs`.
- `<id>.depth.f32`: little-endian float32, row-major `width × height`. `kind: "inverse"` means larger is nearer (Depth Anything V2); `kind: "metric"` means larger is farther (meters or a scene-normalized scale), with `+inf` for sky.

`scripts/m5/score-depth.ts` converts metric depth to inverse depth (`+inf → 0`), checks it with `inspectRawDepth`/`validateGeometryStats` (gate 1), resamples it to the production 384px mesh grid, normalizes it to 8 bits like the production pipeline and builds it with `createDepthGeometry` (gate 2). **Stretched triangles** (gate 3) are kept triangles whose depth spread exceeds half the renderer's own cut threshold, `max(0.24, 0.12 × nearest)`: the rubber-sheet silhouettes seen in VR. Readiness (gate 4) runs the production `DepthReadinessScorer` with only the depth source swapped; Depth Anything V2 supplies its own 252px raw map.
