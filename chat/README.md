# ModuleWarden Underwriter Assistant

Conversational front-end that wraps the ModuleWarden audit pipeline in
underwriting-relevant language. Built for the UNIQA Track 02 brief
("Conversational AI and model integration across UNIQA's digital
insurance products").

The assistant talks an underwriter through a verdict on a specific
npm release, walks them through the deterministic policy gate, and
explains how a finding translates into control-class credit at policy
bind. It cites the Control Evidence Memo path so the underwriter has a
file artifact to attach to the policy.

## Two entry points

### Streamlit UI (the live-demo target)

```bash
pip install -r chat/requirements.txt   # only pulls streamlit
streamlit run chat/app.py
```

Browse to http://localhost:8501. The sidebar has one-click buttons for
the three incidents in `demo/incidents/`; the main column is a chat
thread; the expandable "Structured router evidence" panel shows the
machine-readable evidence behind the latest reply.

### Headless CLI (for smoke tests + scripting)

```bash
python -m chat.cli "is postmark-mcp@1.0.16 safe to underwrite?"
python -m chat.cli --interactive
python -m chat.cli --list-incidents
```

## Architecture

```
            user message
                |
                v
       chat/agent.handle_query
                |
       intent classification     <-- chat/agent._detect_intent
                |
   +------------+------------+----------------+
   |            |            |                |
lookup        list         gate            freeform / help
   |            |            |                |
   v            v            v                v
 demo/      _list_       gate rules    help / clarifying
 incidents  incidents()  doc            response
   |
   v
 templated underwriting-language response
```

`chat/agent.py` is a deterministic router. No API keys are required to
run it. The handle_query function takes a user message and an optional
history list and returns a `ChatTurn` with:

- `response_md`: the markdown the UI renders
- `evidence`: a structured dict the UI shows in the side panel
- `route`: "router" (always for now; "llm" when the optional OpenAI
  path is enabled)

When `OPENAI_API_KEY` is set the agent can be extended to wrap the
router output in a chat completion call. See the docstring at the top
of `agent.py` for the contract; the LLM never gets to invent verdicts -
the dossier and report are pre-loaded by the router.

## What the assistant can do

| Ask | What you get |
|---|---|
| `postmark-mcp@1.0.16` | Verdict block, risk critical, 4 primary findings, underwriting implication for the policy file |
| `lodash@4.17.21` | Verdict allow, control-class credit signal |
| `what are the gate rules?` | The five deterministic rules and the underwriter framing |
| `list incidents` | The incident fixtures available for replay |
| `help` | The full menu |

## Pre-pitch checklist

```bash
# 1. CLI smoke - works without Streamlit installed
python -m chat.cli --list-incidents
python -m chat.cli "look up postmark-mcp@1.0.16"
python -m chat.cli "what are the gate rules?"

# 2. UI smoke
pip install -r chat/requirements.txt
streamlit run chat/app.py
# -> open http://localhost:8501 in the demo browser
# -> click "audit postmark-mcp-1.0.16" in the sidebar
# -> verify the verdict line and underwriting implication render
```

## How this composes with the rest of the repo

- `demo/incidents/*.json` are the audit dossiers and reports the chat
  serves up. Adding a new pair under `demo/incidents/` makes it
  immediately reachable from the chat.
- `finetune/contracts/audit-{dossier,report}.schema.json` are the
  canonical schemas. The router does not invent fields; it reads the
  fixtures that conform to these.
- `packages/api-proxy/` and `packages/worker/` are the production audit
  pipeline. In a productionized version, the chat would call the
  `/audit` HTTP endpoint instead of reading static fixtures. The
  conversational shape is unchanged.

## What this PR is NOT

- Not an LLM agent with autonomous tool-use. The router is deterministic
  by design so the live demo is reproducible across runs.
- Not a UNIQA-specific UI skin. The visual treatment is neutral so the
  Friday case reveal can drive the final styling.
- Not a replacement for the production audit pipeline. The chat is the
  conversational *front-end* over the pipeline output.
