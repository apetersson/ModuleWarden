# Curated threat-chain narratives

`curated-threat-chains.json` holds hand-curated MITRE-style kill-chain
narratives for ten well-known npm packages: five real historical compromises
(event-stream/flatmap-stream, eslint-scope, ua-parser-js, rc, coa) and five
benign controls (lodash, react, axios, express, moment). Each entry has the
attack phases, the insurance rider it would map to, an estimated blast radius
in USD, and a recommended action.

Provenance and honesty:

- These are CURATED historical threat intelligence, drawn from public incident
  reports. The facts (the event-stream/Copay theft, the eslint-scope token
  compromise, the ua-parser-js cryptominer) are accurate and well-documented.
- The `tool` labels (dependency_graph, sandbox_execution, etc.) describe HOW
  each finding would be obtained. They are NOT the output of a live tool run
  and NOT a live Decepticon engagement. Nothing here was executed.
- The deterministic verdict authority remains the gate
  (`finetune/python/decepticon/mapper.py` maps live capability signals to
  ATT&CK). This file is curated demo narrative for famous packages, used for
  blast-radius / loss-path enrichment, not to source a verdict.

Source: ported from an early apiary-starter scaffold during the 2026-05-29
decoy cleanup; the scaffold itself was retired (it kept misleading analysis
agents into thinking it was the submission repo).

`famous-incident-packages.txt` is the matching package@version demo set
(known-malicious plus benign controls) for driving the live advisory check.
