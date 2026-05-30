# Hackathon Build Log: Zero-One Hack Vienna 2026

This is a short narrative of what landed during the build window at Zero-One
Hack Vienna 2026. The project pivoted from the Track-02 UNIQA insurance framing
to the Forecast track (partner Sybilion); see decision-10. The intent is to give
judges a reproducible map of the pipeline and the design decisions that shaped it
under time pressure.

## What ships

The repo has three composable surfaces:

| Surface | What it does | Where it lives |
|---|---|---|
| Production gate | Self-hosted npm registry proxy plus per-job Docker audit. Approves, quarantines, or blocks each install request before it executes. | `packages/api-proxy/`, `packages/worker/`, `packages/audit-runner/`, `docker-compose.yml` |
| Fine-tune pipeline | Python SFT pipeline aligned to the canonical `audit_dossier.v1` and `audit_report.v1` schemas. 4-arm eval matrix per the finetune README. | `finetune/python/` |
| Conversational front-end | Conversational underwriter assistant. Streamlit UI plus headless CLI. Reads the same incident fixtures the live demo uses. | `chat/` |

The live-pitch demo is offline: `python -m demo.run_incident_replay`
runs without docker, without network, without an LLM. The conversational
assistant is offline by default and gates the optional LLM-augmented
path behind `OPENAI_API_KEY`.

## Architecture decisions worth flagging

1. **Schema-first contracts.** Every artifact this repo produces validates
   against a JSON Schema in `finetune/contracts/`. The dossier (model
   input) and report (model output) carry a `schema_version` stamp. This
   is what lets the chat assistant guarantee the verdict it reads is
   real rather than invented.

2. **Three identity surfaces consciously separated.** The deterministic
   policy gate is one identity, the cited model verdict is a second, the
   conversational underwriter framing is a third. None of them lies
   about the other: the chat agent never invents a verdict, the model
   never overrides a gate FAIL, the gate never claims model confidence.

3. **Deterministic-router-first chat.** The conversational assistant is
   a router by default, not a free-form LLM agent. This keeps the live
   demo reproducible and prevents a hallucinated verdict from being
   shown to judges.

4. **Three named incidents.** The demo replays
   `postmark-mcp-1.0.16` (the centerpiece, Sep 2025 BCC exfil),
   `postmark-mcp-1.0.12` (last clean release of the same package, to
   prove the gate does not block on package name), and `lodash-4.17.21`
   (a popular package baseline, to prove the gate does not block on
   everything). All three are paired (dossier, report) pairs that
   validate against the canonical schemas.

5. **Two training options documented.** `finetune/python/HACKATHON_NOTES.md`
   describes both the Pantheon-recommended Qwen2.5-Coder-7B + QLoRA path
   (safer in a 24h window) and the stated Qwen3.6-27B path with the
   pre-abliterated `huihui-ai/Huihui-Qwen3.6-27B-abliterated` checkpoint.
   FSDP1 + `Qwen3DecoderLayer` wrap + `use_reentrant=False` + `all-linear`
   target_modules are the documented gotchas.

## Insurance framing (downstream application)

The control output for a UNIQA cyber underwriter is a Control Evidence
Memo (markdown plus JSON plus audit log). Same artifact serves SOC 2
auditors and cyber-policy underwriting questionnaires. The
conversational chat translates verdicts into underwriting language:
control-class credit eligibility, supply-chain questionnaire signal,
remediation-clause trigger.

The framework anchors cited in `finetune/python/pitch/underwriter-economics.md`
are ISO 27001 A.8.28, NIST SSDF PS.3.1, and CIS Control 16. Floor
baselines from arXiv:2403.12196 (GPT-4 zero-shot 97 percent on npm
malware) and arXiv:2510.20739 (taint-flow F1=0.915) are documented in
`HACKATHON_NOTES.md`.

## What is intentionally not in scope

- **No autonomous LLM agent that runs tools at the user.** The chat
  router is deterministic for the live demo.
- **No SaaS-locked model.** The optional LLM path is OpenAI-compatible
  via env vars; vLLM or Ollama also work.
- **No UNIQA-specific UI skin yet.** The visual treatment is neutral so
  the Friday case reveal can drive the final styling without rework.
- **No claim of beating GPT-4 on the open-source baseline yet.** The
  HACKATHON_NOTES floor baselines (87 to 97 percent across two cited
  papers) are the bar; a real run on Leonardo on Saturday produces the
  actual number.

## Pre-pitch verification checklist

```bash
# Demo
python -m demo.run_incident_replay --list
python -m demo.run_incident_replay --incident postmark-mcp-1.0.16
python -m demo.run_incident_replay --incident postmark-mcp-1.0.12
python -m demo.run_incident_replay --incident lodash-4.17.21

# Conversational assistant (CLI)
python -m chat.cli --list-incidents
python -m chat.cli "look up postmark-mcp@1.0.16"
python -m chat.cli "what are the gate rules?"

# Conversational assistant (UI)
pip install -r chat/requirements.txt
streamlit run chat/app.py    # http://localhost:8501

# Tests
pytest finetune/python/tests/  # schema conformance + attack catalog
pytest demo/tests/             # incident-replay alignment with slide deck
pytest chat/tests/             # router intent + verdict rendering
```
