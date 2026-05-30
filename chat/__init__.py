"""ModuleWarden conversational risk review assistant.

A small Streamlit chat that turns the ModuleWarden audit pipeline into a
natural-language interface for a risk reviewer using a supply-chain
forecasting tool. Wraps the existing ``demo/`` incident replays and the
``finetune/contracts`` schemas; talks to any OpenAI-compatible chat
completion endpoint when one is configured, falls back to a deterministic
intent router when one is not.

Entry points:

    streamlit run chat/app.py                # Streamlit UI
    python -m chat.cli "is postmark-mcp@1.0.16 safe to adopt?"  # CLI

See chat/README.md for the configuration matrix.
"""
