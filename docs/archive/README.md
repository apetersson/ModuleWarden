# Archive: retired decoy scaffold (2026-05-29 cleanup)

An early scaffold lived at `apiary-starter/` in the sibling kimiclaw working
tree, alongside a `TRACK02-DESIGN.md` planning doc. They were NOT the
submission repo, but three consecutive analysis swarms read them, attributed
their files to apetersson/ModuleWarden, and built plans on a state that did
not match this repo (see the wiki entry Verify-Canonical-Repo-Before-Dispatch).

To stop the recurring confusion, the scaffold was retired. Before deleting it,
the genuinely useful content was extracted into this repo:

- `demo/curated-threat-chains.json` (+ `.README.md`): hand-curated MITRE-style
  kill-chain narratives for 10 famous npm packages. Curated historical intel,
  not a live tool run. See the README for the honesty note.
- `demo/famous-incident-packages.txt`: the malicious + benign demo package set.
- `docs/archive/TRACK02-DESIGN.md`: the early design doc (Flow A/B/C, insurance
  product map, Control Evidence Memo template, kill list). Stale on state,
  banner added.
- `docs/archive/HACKATHON_DEMO_PLAN.md`: the minute-by-minute stage run-sheet.

Not ported (superseded or not honest):
- `precomputed_scores.json`: scores labeled `xgb-fallback-v1`, a model that was
  never trained. Fabricated output, deliberately not carried over.
- `enrichment_service.py` (FastAPI serving the chains, no Docker) and
  `stage_demo.py` (Rich TUI): superseded by `demo/run_incident_replay.py` and
  the live dashboard. Re-derivable from the chains JSON if a chain-serving API
  is wanted.
- `bumblebee_bridge/ingest.py`: a stub for streaming Bumblebee NDJSON through
  the gate. Re-derivable if the Bumblebee integration is built.
- The `scripts/` stubs (train_xgb_fallback, extract_features, etc.): all
  NotImplementedError/TODO skeletons; the real training pipeline is in
  `finetune/python/`.
