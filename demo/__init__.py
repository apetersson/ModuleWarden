"""ModuleWarden live-demo module.

Self-contained CLI replays of confirmed npm supply-chain incidents through
the deterministic-gate plus cited-model verdict plus Control Evidence Memo
pipeline. Used in the 90-second live pitch.

Run a single replay:

    python -m demo.run_incident_replay --incident postmark-mcp-1.0.16

List available incidents:

    python -m demo.run_incident_replay --list

Incident dossiers and ground-truth reports live in ``demo/incidents/``.
Generated memos are written to ``demo/outputs/`` and ignored from version
control so the demo runs cleanly on a fresh checkout.
"""
