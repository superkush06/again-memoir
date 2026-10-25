# Property-based testing

Again uses `fast-check` for bounded, deterministic property tests around the multi-function flows where one example is not enough. The suite uses a fixed replay seed (`20261024`) so CI failures reproduce locally while each property still explores many generated inputs and shrinks failures.

## Covered invariants

| Flow | Property |
| --- | --- |
| image quality → ranking | Cover and world scores remain in `[0,1]`; adding positive evidence never lowers the relevant score. |
| memories + embeddings → events | Events are deterministic under input reordering, form a partition with no missing or duplicated memories, use only explainable reasons, and do not require location. |
| archive → hash → dedup → restart | Any number of byte-identical imports converges to one canonical memory and one file while retaining every unique provenance record after restart. |
| Google import → event → suggested album → share | Completed batches remain private, cover and anchor selections remain members, restart preserves state, and a share preview never widens the host-selected subset. |
| album → SpacetimeDB scene manifest | Bounded member subsets validate; hidden anchors, nonmembers, and out-of-album current memories are rejected. |
| Settings → Google Picker request | Every integer from 1–2,000 is preserved and out-of-contract limits are rejected. |

These properties complement the example-based API, reconstruction, rendering, and multiplayer tests. They intentionally avoid unbounded media sizes and cloud calls so the default suite remains suitable for local development and CI.
