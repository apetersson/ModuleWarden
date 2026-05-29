"""Headless CLI for the underwriter assistant.

Usage:

    python -m chat.cli "is postmark-mcp@1.0.16 safe to underwrite?"
    python -m chat.cli --interactive     # REPL
    python -m chat.cli --list-incidents  # what incidents do we have?

The CLI exercises the same agent the Streamlit UI uses. It is the
fastest way to verify the assistant runs on a fresh checkout without
installing any UI dependencies.
"""

from __future__ import annotations

import argparse
import os
import sys

# Live GHSA + OSSF advisory lookups are on for the CLI demo (read-only).
os.environ.setdefault("MW_LIVE_ADVISORIES", "1")

from chat.agent import _list_incidents, handle_query


def _make_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="python -m chat.cli",
        description="Conversational ModuleWarden underwriter assistant (CLI).",
    )
    p.add_argument("message", nargs="?", default=None, help="Single message to ask")
    p.add_argument(
        "--interactive",
        action="store_true",
        help="REPL mode: read messages from stdin until empty line or EOF",
    )
    p.add_argument(
        "--list-incidents",
        action="store_true",
        help="list available incident fixtures and exit",
    )
    return p


def main(argv: list[str] | None = None) -> int:
    args = _make_parser().parse_args(argv)
    if args.list_incidents:
        ids = _list_incidents()
        if not ids:
            print("No incident fixtures installed.")
            return 2
        print("Available incidents:")
        for i in ids:
            print(f"  {i}")
        return 0

    if args.interactive:
        history: list[dict[str, str]] = []
        print("ModuleWarden Underwriter Assistant -- CLI REPL")
        print("Press Ctrl+D (Unix) or Ctrl+Z then Enter (Windows) to exit.\n")
        while True:
            try:
                msg = input("> ").strip()
            except (EOFError, KeyboardInterrupt):
                print()
                return 0
            if not msg:
                continue
            history.append({"role": "user", "content": msg})
            turn = handle_query(msg, history=history)
            history.append({"role": "assistant", "content": turn.response_md})
            print()
            print(turn.response_md)
            print()

    if not args.message:
        _make_parser().print_help()
        return 2
    turn = handle_query(args.message)
    print(turn.response_md)
    return 0


if __name__ == "__main__":
    sys.exit(main())
