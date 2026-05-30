#!/usr/bin/env python3
"""ModuleWarden: Leonardo team queue dashboard.

Live view of the hackathon Slurm reservation (default s_tra_ncc) plus where
the team's two accounts sit in the queue:

  a08trc01  devops / Decepticon   (operator, also runs the dashboard)
  a08trc02  finetune (petersson)  (the real training runs)

Panels:
  - reservation header: account, state, window, time remaining
  - node capacity: free vs busy nodes, estimated free A100s
  - team jobs: every job owned by either account, anywhere, with state,
    location, runtime/limit, queue reason, and estimated start for pending
  - reservation queue: everyone holding or waiting on the reservation, with
    the team's rows flagged, so you can see your place relative to others

Only one SSH login is needed (squeue sees the whole cluster). Credentials
come from `.leonardo-access` (the gitignored file one level above the repo)
or the LEONARDO_USER / LEONARDO_PASSWORD env vars. Nothing is hardcoded.

Usage:
  python scripts/leonardo/reservation_dashboard.py
  python scripts/leonardo/reservation_dashboard.py --watch 10
  python scripts/leonardo/reservation_dashboard.py --accounts a08trc01,a08trc02
  python scripts/leonardo/reservation_dashboard.py --reservation s_tra_ncc
  python scripts/leonardo/reservation_dashboard.py --no-color

Requires: paramiko (pip install paramiko).
"""
from __future__ import annotations

import argparse
import os
import pathlib
import re
import sys
import time

try:
    import paramiko
except ImportError:
    sys.exit("paramiko is required: pip install paramiko")

GPUS_PER_NODE = 4  # Leonardo Booster: 4x A100 64GB per node
DEFAULT_RESERVATION = "s_tra_ncc"
DEFAULT_LOGIN = "login01-ext.leonardo.cineca.it"

# team accounts -> short role label shown next to their jobs
# Confirmed team accounts get role labels; the rest of the shared tra26_minwinsc
# cohort (the Leonardo group both accounts belong to) is tracked too, so no
# teammate's job is missed whatever trainee login they submit from.
TEAM_ROLES = {
    "a08trc01": "devops/decepticon",
    "a08trc02": "finetune/petersson",
}
COHORT = [
    "a08trc01", "a08trc02", "a08trc0e", "a08trc0r", "a08trc0v", "a08trc0x",
    "a08trc11", "a08trc13", "a08trc14", "a08trc16", "a08trc17", "a08trc21",
    "a08trc22", "a08trc23",
]

FREE_STATES = {"idle", "resv"}
BUSY_STATES = {"mix", "alloc", "comp"}


# ── credentials ──────────────────────────────────────────────────────

def load_credentials() -> tuple[str, str, str]:
    user = os.environ.get("LEONARDO_USER")
    pw = os.environ.get("LEONARDO_PASSWORD") or os.environ.get("LEONARDO_PASS")
    login = os.environ.get("LEONARDO_LOGIN", DEFAULT_LOGIN)
    if not (user and pw):
        here = pathlib.Path(__file__).resolve()
        for path in (
            here.parents[2].parent / ".leonardo-access",
            here.parents[2] / ".leonardo-access",
            pathlib.Path.home() / ".leonardo-env",
        ):
            if path.is_file():
                kv = {}
                for line in path.read_text().splitlines():
                    line = line.strip()
                    if not line or line.startswith("#") or "=" not in line:
                        continue
                    k, v = line.split("=", 1)
                    kv[k.strip()] = v.strip().strip("'\"")
                user = user or kv.get("LEONARDO_USER") or kv.get("USERNAME")
                pw = pw or kv.get("LEONARDO_PASSWORD") or kv.get("PASSWORD")
                login = kv.get("LEONARDO_LOGIN", login)
                break
    if not (user and pw):
        sys.exit("No credentials. Set LEONARDO_USER/LEONARDO_PASSWORD or use a "
                 ".leonardo-access file with USERNAME=/PASSWORD= lines.")
    return user, pw, login


# ── ssh ──────────────────────────────────────────────────────────────

def connect(user: str, pw: str, host: str) -> paramiko.SSHClient:
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(host, username=user, password=pw, timeout=20,
              allow_agent=False, look_for_keys=False)
    return c


def run(c: paramiko.SSHClient, cmd: str, timeout: int = 30) -> str:
    _, out, _ = c.exec_command(cmd, timeout=timeout)
    return out.read().decode(errors="replace")


# ── data collection ──────────────────────────────────────────────────

FMT = "%i|%u|%T|%D|%M|%l|%r|%R|%S"  # id user state nodes time limit reason where start


def parse_jobs(text: str) -> list[dict]:
    keys = ["id", "user", "state", "nodes", "time", "limit", "reason", "where", "start"]
    jobs = []
    for line in text.splitlines():
        parts = line.rstrip("\n").split("|")
        if len(parts) >= len(keys) and parts[0] and parts[0] != "JOBID":
            jobs.append(dict(zip(keys, parts)))
    return jobs


def collect(c, reservation: str, accounts: list[str]) -> dict:
    res_raw = run(c, f"scontrol show reservation {reservation} 2>&1")
    if "ReservationName" not in res_raw:
        return {"error": res_raw.strip() or f"reservation {reservation} not found"}
    fields = dict(re.findall(r"(\w+)=([^\s]+)", res_raw))
    nodes_expr = fields.get("Nodes", "")

    end = fields.get("EndTime", "")
    remain = run(c, f'e=$(date -d "{end}" +%s 2>/dev/null); n=$(date +%s); '
                    f'[ -n "$e" ] && echo $((e-n)) || echo NA').strip()

    nodes = []
    if nodes_expr:
        for line in run(c, f"sinfo -N -n '{nodes_expr}' -h -o '%N|%t' 2>/dev/null").splitlines():
            if "|" in line:
                name, state = line.split("|", 1)
                nodes.append((name.strip(), state.strip().rstrip("*~#$@+")))

    acct_csv = ",".join(accounts)
    team = parse_jobs(run(c, f"squeue -u {acct_csv} -h -o '{FMT}' 2>/dev/null"))
    resq = parse_jobs(run(c, f"squeue --reservation={reservation} -h "
                             f"-S '-t,-Q' -o '{FMT}' 2>/dev/null"))
    return {"raw": fields, "remain": remain, "nodes": nodes,
            "team": team, "resq": resq}


# ── rendering ────────────────────────────────────────────────────────

class C:
    def __init__(self, on: bool):
        self.on = on

    def __call__(self, code: str, s: str) -> str:
        return f"\033[{code}m{s}\033[0m" if self.on else s


def fmt_remaining(secs: str) -> str:
    if secs == "NA" or not secs.lstrip("-").isdigit():
        return "unknown"
    s = int(secs)
    if s <= 0:
        return "EXPIRED"
    d, rem = divmod(s, 86400)
    h, rem = divmod(rem, 3600)
    m, _ = divmod(rem, 60)
    return (f"{d}d " if d else "") + f"{h}h {m}m"


def state_color(state: str) -> str:
    return {"RUNNING": "32", "PENDING": "33", "COMPLETING": "36",
            "FAILED": "31", "CANCELLED": "31"}.get(state, "0")


def short_start(s: str) -> str:
    # squeue %S gives N/A for running, else 2026-05-30T03:11:00
    if not s or s in ("N/A", "NONE"):
        return ""
    return s.replace("T", " ")[5:16]  # MM-DD HH:MM


def bar(free: int, total: int, width: int, c: C) -> str:
    if total == 0:
        return "(no nodes)"
    filled = round(width * (total - free) / total)
    return f"[{c('33', '#' * filled)}{c('32', '#' * (width - filled))}]"


def render(data, reservation, accounts, login, c) -> str:
    if "error" in data:
        return c("31", f"ERROR: {data['error']}")
    f = data["raw"]
    nodes = data["nodes"]
    total = len(nodes)
    free = sum(1 for _, st in nodes if st in FREE_STATES)
    busy = sum(1 for _, st in nodes if st in BUSY_STATES)
    other = total - free - busy
    state = f.get("State", "?")

    L = []
    L.append(c("1;36", "=" * 72))
    L.append(c("1;36", f" Leonardo team queue: {reservation} ".center(72, "=")))
    L.append(c("1;36", "=" * 72))
    L.append("")
    L.append(f"  account {f.get('Accounts','?')}   partition {f.get('PartitionName','?')}"
             f"   state {c('32' if state=='ACTIVE' else '33', state)}")
    L.append(f"  window  {f.get('StartTime','?')} -> {f.get('EndTime','?')}"
             f"   remaining {c('1;35', fmt_remaining(data['remain']))}")
    L.append("")

    free_gpus = free * GPUS_PER_NODE
    L.append(c("1", "  NODE CAPACITY"))
    L.append(f"    {bar(free, total, 44, c)}")
    L.append(f"    free {c('1;32', str(free))}  busy {c('1;33', str(busy))}"
             f"  other {other}  total {total}     "
             f"~{c('1;32', str(free_gpus))} A100 free (est. {GPUS_PER_NODE}/node)")
    L.append("")

    # team jobs (where are WE)
    L.append(c("1", f"  TEAM JOBS ({len(data['team'])})"))
    if data["team"]:
        L.append("    " + c("2", f"{'JOBID':<12}{'ROLE':<19}{'STATE':<10}"
                                  f"{'TIME':<8}{'LIMIT':<9}{'WHERE / WHY':<18}START"))
        for j in data["team"]:
            role = TEAM_ROLES.get(j["user"], j["user"])
            where = j["where"] if j["state"] == "RUNNING" else f"({j['reason']})"
            L.append("    "
                     + f"{j['id']:<12}{role:<19}"
                     + c(state_color(j["state"]), f"{j['state']:<10}")
                     + f"{j['time']:<8}{j['limit']:<9}{where:<18}{short_start(j['start'])}")
    else:
        L.append(c("2", "    (no team jobs - nothing running or queued)"))
    L.append("")

    # reservation queue (where's our PLACE)
    L.append(c("1", f"  RESERVATION QUEUE ({len(data['resq'])})  "
                    + c("2", "running first, then pending by priority")))
    if data["resq"]:
        L.append("    " + c("2", f"{'JOBID':<12}{'USER':<11}{'STATE':<10}"
                                  f"{'N':<3}{'TIME':<8}{'LIMIT':<9}START"))
        for j in data["resq"]:
            mine = j["user"] in accounts
            row = (f"{j['id']:<12}{j['user']:<11}{j['state']:<10}"
                   f"{j['nodes']:<3}{j['time']:<8}{j['limit']:<9}{short_start(j['start'])}")
            L.append("    " + (c("1;36", row + "  <-- us") if mine else c("0", row)))
    else:
        L.append(c("2", "    (reservation idle - no jobs)"))
    L.append("")
    L.append(c("2", f"  via {accounts[0]}@{login}    {time.strftime('%Y-%m-%d %H:%M:%S')} local"))
    return "\n".join(L)


# ── main ─────────────────────────────────────────────────────────────

def main() -> int:
    ap = argparse.ArgumentParser(description="Leonardo team queue dashboard")
    ap.add_argument("--reservation", default=DEFAULT_RESERVATION)
    ap.add_argument("--accounts", default=",".join(COHORT),
                    help="comma-separated team usernames to flag")
    ap.add_argument("--watch", type=int, metavar="SECS",
                    help="refresh every SECS seconds (Ctrl+C to stop)")
    ap.add_argument("--no-color", action="store_true")
    args = ap.parse_args()

    accounts = [a.strip() for a in args.accounts.split(",") if a.strip()]
    user, pw, login = load_credentials()
    c = C(on=not args.no_color and sys.stdout.isatty())

    def cycle(client):
        data = collect(client, args.reservation, accounts)
        if args.watch and c.on:
            sys.stdout.write("\033[2J\033[H")
        print(render(data, args.reservation, accounts, login, c), flush=True)

    client = None
    try:
        client = connect(user, pw, login)
        if not args.watch:
            cycle(client)
            return 0
        while True:
            try:
                if client is None:
                    client = connect(user, pw, login)
                cycle(client)
            except Exception as e:  # noqa: BLE001
                print(c("31", f"refresh failed ({type(e).__name__}): {e}"))
                try:
                    client.close()
                except Exception:
                    pass
                client = None
            time.sleep(args.watch)
    except KeyboardInterrupt:
        print("\nstopped.")
        return 0
    except Exception as e:  # noqa: BLE001
        print(c("31", f"FATAL ({type(e).__name__}): {e}"))
        return 2
    finally:
        if client is not None:
            try:
                client.close()
            except Exception:
                pass


if __name__ == "__main__":
    raise SystemExit(main())
