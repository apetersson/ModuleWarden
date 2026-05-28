"""Streamlit UI for the ModuleWarden Underwriter Assistant.

Run:

    streamlit run chat/app.py

The UI is intentionally simple: a chat thread, a sidebar listing
available incidents with one-click insertion into the prompt, an
expandable structured-evidence panel that shows the router decision
for the most recent answer, and a session reset button.

No API keys are required to run. If ``OPENAI_API_KEY`` is set the agent
can be extended to call an LLM (see chat/agent.py); the default
behaviour is the deterministic router which is what the live demo uses.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

try:
    import streamlit as st
except ImportError as exc:  # pragma: no cover - documented requirement
    raise SystemExit(
        "Streamlit is required to run chat/app.py: pip install streamlit"
    ) from exc

from chat.agent import _list_incidents, handle_query

st.set_page_config(
    page_title="ModuleWarden Underwriter Assistant",
    page_icon=":shield:",
    layout="wide",
)


# ---------------------------------------------------------------------------
# State
# ---------------------------------------------------------------------------


if "messages" not in st.session_state:
    st.session_state.messages = [
        {
            "role": "assistant",
            "content": (
                "Hi -- I am the ModuleWarden Underwriter Assistant.\n\n"
                "Ask me about an npm package and version (for example "
                "`postmark-mcp@1.0.16`), ask `what are the gate rules?` "
                "to walk the deterministic policy, or ask `help` for "
                "the full menu."
            ),
        }
    ]
    st.session_state.last_evidence = {}


# ---------------------------------------------------------------------------
# Sidebar
# ---------------------------------------------------------------------------


with st.sidebar:
    st.markdown("### ModuleWarden")
    st.caption("Conversational risk briefing for cyber-policy underwriters")
    st.markdown("---")
    st.markdown("**Try one of these:**")
    for incident in _list_incidents():
        if st.button(f"audit {incident}", key=f"btn_{incident}", use_container_width=True):
            st.session_state.messages.append(
                {"role": "user", "content": f"look up {incident}"}
            )
            turn = handle_query(
                f"look up {incident.split('-')[0]}-{incident.split('-')[1]}@{incident.rsplit('-', 1)[1]}",
                history=st.session_state.messages,
            )
            st.session_state.messages.append(
                {"role": "assistant", "content": turn.response_md}
            )
            st.session_state.last_evidence = turn.evidence
            st.rerun()

    st.markdown("---")
    st.markdown("**Suggested questions:**")
    for q in [
        "what are the gate rules?",
        "list incidents",
        "help",
    ]:
        if st.button(q, key=f"q_{q}", use_container_width=True):
            st.session_state.messages.append({"role": "user", "content": q})
            turn = handle_query(q, history=st.session_state.messages)
            st.session_state.messages.append(
                {"role": "assistant", "content": turn.response_md}
            )
            st.session_state.last_evidence = turn.evidence
            st.rerun()

    st.markdown("---")
    if st.button("Reset session", use_container_width=True):
        st.session_state.messages = st.session_state.messages[:1]
        st.session_state.last_evidence = {}
        st.rerun()


# ---------------------------------------------------------------------------
# Main column
# ---------------------------------------------------------------------------


st.title(":shield: ModuleWarden Underwriter Assistant")
st.caption(
    "Conversational front-end over the ModuleWarden audit pipeline. "
    "Wrap a deterministic verdict with insurance-language explanation."
)

for msg in st.session_state.messages:
    with st.chat_message(msg["role"]):
        st.markdown(msg["content"])


prompt = st.chat_input(
    "Ask about a package, a gate rule, or a historical incident..."
)
if prompt:
    st.session_state.messages.append({"role": "user", "content": prompt})
    with st.chat_message("user"):
        st.markdown(prompt)
    turn = handle_query(prompt, history=st.session_state.messages)
    st.session_state.messages.append(
        {"role": "assistant", "content": turn.response_md}
    )
    st.session_state.last_evidence = turn.evidence
    with st.chat_message("assistant"):
        st.markdown(turn.response_md)


# ---------------------------------------------------------------------------
# Evidence panel
# ---------------------------------------------------------------------------


if st.session_state.last_evidence:
    with st.expander("Structured router evidence (machine-readable)", expanded=False):
        st.json(st.session_state.last_evidence)
