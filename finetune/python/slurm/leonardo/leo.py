"""Non-interactive SSH to Leonardo for the hackathon.

Reads creds from ~/keys.txt so no secret ever lands on a command line.
Account select: LEO_ACCT=1 (default, a08trc01 = devops/decepticon) or LEO_ACCT=2
(a08trc02 = real fine-tune runs). Usage:
    python leo.py "remote command"          # run a command, print stdout/stderr
    python leo.py --put LOCAL REMOTE         # sftp upload a file
    python leo.py --get REMOTE LOCAL         # sftp download a file
    LEO_ACCT=2 python leo.py "..."           # use the second account
Host defaults to login01-ext; override with LEO_HOST env.
"""
import os
import sys
import paramiko

HOST = os.environ.get("LEO_HOST", "login01-ext.leonardo.cineca.it")


def creds():
    acct = os.environ.get("LEO_ACCT", "1")
    ukey = "LEONARDO_USERNAME==NAME=" if acct == "1" else f"LEONARDO_USERNAME==NAME_{acct}="
    pkey = "LEONARDO_PASSWORD=" if acct == "1" else f"LEONARDO_PASSWORD_{acct}="
    u = p = None
    with open(os.path.expanduser("~/keys.txt"), encoding="utf-8", errors="ignore") as fh:
        for line in fh:
            if line.startswith(ukey):
                u = line.split("=", 1)[1].strip()
            elif line.startswith(pkey):
                p = line.split("=", 1)[1].strip()
    if not (u and p):
        sys.exit(f"missing creds for LEO_ACCT={acct} in ~/keys.txt")
    return u, p


def connect():
    u, p = creds()
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    try:
        c.connect(HOST, 22, username=u, password=p, look_for_keys=False,
                  allow_agent=False, timeout=30, banner_timeout=30, auth_timeout=30)
        return c
    except paramiko.AuthenticationException:
        t = paramiko.Transport((HOST, 22))
        t.start_client(timeout=30)
        t.auth_interactive(u, lambda title, instr, prompts: [p for _ in prompts])
        c._transport = t
        return c


def main():
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass
    args = sys.argv[1:]
    c = connect()
    if args and args[0] == "--put":
        sftp = c.open_sftp(); sftp.put(args[1], args[2]); sftp.close()
        print(f"PUT ok: {args[1]} -> {args[2]}"); return
    if args and args[0] == "--get":
        sftp = c.open_sftp(); sftp.get(args[1], args[2]); sftp.close()
        print(f"GET ok: {args[1]} -> {args[2]}"); return
    cmd = args[0] if args else "echo connected as $(whoami)"
    _in, out, err = c.exec_command(cmd, timeout=180)
    o = out.read().decode(errors="replace")
    e = err.read().decode(errors="replace")
    sys.stdout.write(o)
    if e.strip():
        sys.stderr.write("\n[STDERR]\n" + e)
    c.close()


if __name__ == "__main__":
    main()
