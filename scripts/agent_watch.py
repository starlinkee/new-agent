#!/usr/bin/env python3
"""Live, merged view of what the agents are doing (run inside WSL; `cb watch`).

Sources, all read-only:
  workers      Claude Code transcripts of every omc worker:
               ~/.claude/projects/<workspace path, / -> ->/*.jsonl
               (assistant text, tool calls and short tool results)
  manager      the omc team runtime in each workspace:
               workspaces/<id>/.omc/state/team/<team>/events.jsonl and the
               instructions it writes to workers/<worker>/inbox.md
  contrabass   run lifecycle per ticket: .contrabass/state/workflow-timeline/<id>.jsonl

Usage: agent_watch.py [NEW-34 ...] [--recent MIN] [--lines N] [--full] [--no-results]
"""
import argparse
import glob
import json
import os
import re
import sys
import time
from datetime import datetime

REPO = os.environ.get("CB_REPO", os.path.expanduser("~/new-agent"))
WORKSPACES = os.path.join(REPO, "workspaces")
TIMELINE = os.path.join(REPO, ".contrabass/state/workflow-timeline")
PROJECTS = os.path.expanduser("~/.claude/projects")
TRANSCRIPT_PREFIX = re.sub(r"[^A-Za-z0-9]", "-", WORKSPACES) + "-"
WS_ID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")

COLORS = [36, 33, 35, 32, 34, 91, 96, 93, 95, 92]
tty = sys.stdout.isatty()


def paint(code, s):
    return f"\033[{code}m{s}\033[0m" if tty else s


def parse_time(iso):
    try:
        return datetime.fromisoformat(iso.replace("Z", "+00:00")).astimezone()
    except (ValueError, AttributeError):
        return datetime.now().astimezone()


class Watcher:
    def __init__(self, args):
        self.args = args
        self.tickets = {}  # workspace id -> NEW-N
        self.offsets = {}  # path -> bytes read
        self.inboxes = {}  # path -> last content
        self.workers = {}  # transcript path -> worker name
        self.color = {}
        self.backlog = None  # during the startup scan: entries to print sorted by time

    # ---------- labels ----------
    def ticket(self, ws):
        if ws not in self.tickets:
            try:
                with open(os.path.join(TIMELINE, ws + ".jsonl")) as f:
                    for line in f:
                        ident = json.loads(line).get("run_summary", {}).get("issue_identifier")
                        if ident:
                            self.tickets[ws] = ident
                            break
            except (OSError, ValueError):
                pass
        return self.tickets.get(ws, ws[:8])

    def wanted(self, ws):
        return not self.args.tickets or self.ticket(ws).upper() in self.args.tickets

    def emit(self, ts, ws, who, text, dim=False):
        when = parse_time(ts)
        if self.backlog is not None:
            self.backlog.append((when, len(self.backlog), ws, who, text, dim))
        else:
            self.print(when, ws, who, text, dim)

    def print(self, when, ws, who, text, dim):
        t = self.ticket(ws)
        c = self.color.setdefault(t, COLORS[len(self.color) % len(COLORS)])
        lines = text.rstrip().splitlines() or [""]
        if not self.args.full and len(lines) > self.args.max_lines:
            lines = lines[: self.args.max_lines] + [f"... (+{len(lines) - self.args.max_lines} lines)"]
        head = paint(c, f"{when:%H:%M:%S} {t:<7} {who:<10}") + " "
        pad = " " * (8 + 1 + 7 + 1 + 10 + 1)
        for i, line in enumerate(lines):
            if not self.args.full and len(line) > 220:
                line = line[:220] + "..."
            print((head if i == 0 else pad) + (paint(2, line) if dim else line))
        sys.stdout.flush()

    # ---------- tailing ----------
    def new_lines(self, path, backfill):
        """Complete lines appended since the last call; on first sight, the last `backfill` lines."""
        try:
            size = os.path.getsize(path)
        except OSError:
            return []
        first = path not in self.offsets
        start = 0 if first else self.offsets[path]
        if size < start:  # truncated / replaced
            start = 0
        if size == start:
            self.offsets[path] = start
            return []
        with open(path, "rb") as f:
            f.seek(start)
            data = f.read()
        end = data.rfind(b"\n") + 1
        self.offsets[path] = start + end
        lines = data[:end].decode("utf-8", "replace").splitlines()
        return lines[-backfill:] if first and backfill else lines

    def fresh(self, path, startup):
        """At startup only files touched within --recent minutes (older ones are followed from
        their current end); files that appear later are shown from the start."""
        if path in self.offsets or not startup:
            return True
        try:
            if time.time() - os.path.getmtime(path) < self.args.recent * 60:
                return True
            self.offsets[path] = os.path.getsize(path)
        except OSError:
            pass
        return False

    # ---------- workers ----------
    def worker_name(self, path):
        """omc starts each worker with "Read .../workers/<name>/inbox.md"; find it near the top."""
        if path not in self.workers:
            name = "agent-" + os.path.basename(path)[:4]
            try:
                with open(path, encoding="utf-8", errors="replace") as f:
                    for _, line in zip(range(50), f):
                        m = re.search(r"workers/([\w-]+)/inbox", line)
                        if m:
                            name = m.group(1)
                            break
            except OSError:
                pass
            self.workers[path] = name
        return self.workers[path]

    def transcript(self, path, lines):
        ws = WS_ID.search(os.path.basename(os.path.dirname(path)))
        ws = ws.group(0) if ws else "?"
        if not self.wanted(ws):
            return
        for line in lines:
            try:
                e = json.loads(line)
            except ValueError:
                continue
            kind, ts = e.get("type"), e.get("timestamp")
            if kind not in ("user", "assistant"):
                continue
            who = self.worker_name(path)
            content = e.get("message", {}).get("content")
            if isinstance(content, str):
                if kind == "user" and not e.get("isMeta"):
                    self.emit(ts, ws, who, "» " + content)
                continue
            for c in content or []:
                t = c.get("type")
                if t == "text" and c.get("text", "").strip():
                    self.emit(ts, ws, who, ("» " if kind == "user" else "") + c["text"])
                elif t == "tool_use":
                    self.emit(ts, ws, who, "→ " + tool_summary(c.get("name"), c.get("input") or {}))
                elif t == "tool_result" and not self.args.no_results:
                    body = c.get("content")
                    if isinstance(body, list):
                        body = "\n".join(x.get("text", "") for x in body if isinstance(x, dict))
                    body = str(body or "").strip()
                    first = body.splitlines()[0] if body else "(empty)"
                    n = body.count("\n")
                    tag = "← ERROR " if c.get("is_error") else "← "
                    self.emit(ts, ws, who, tag + first + (f"  (+{n} lines)" if n else ""), dim=not c.get("is_error"))

    # ---------- manager (omc team runtime) ----------
    def team_events(self, path, lines):
        ws = WS_ID.search(path).group(0)
        if not self.wanted(ws):
            return
        for line in lines:
            try:
                e = json.loads(line)
            except ValueError:
                continue
            parts = [e.get("type", "?").replace("_", " ")]
            if e.get("task_id"):
                parts.append(f"task {e['task_id']}")
            if e.get("worker"):
                parts.append(f"({e['worker']})")
            if e.get("reason"):
                parts.append("- " + str(e["reason"]))
            self.emit(e.get("created_at"), ws, "manager", "◆ " + " ".join(parts))

    def inbox(self, path, startup):
        ws = WS_ID.search(path).group(0)
        if not self.wanted(ws):
            return
        try:
            with open(path) as f:
                text = f.read()
            mtime = os.path.getmtime(path)
        except OSError:
            return
        if self.inboxes.get(path) == text:
            return
        seen = path in self.inboxes
        self.inboxes[path] = text
        if seen or not startup or time.time() - mtime < self.args.recent * 60:
            worker = os.path.basename(os.path.dirname(path))
            ts = datetime.fromtimestamp(mtime).astimezone().isoformat()
            self.emit(ts, ws, "manager", f"✉ to {worker}:\n{text}")

    # ---------- contrabass ----------
    def timeline(self, path, lines):
        ws = os.path.basename(path)[:-6]
        if not self.wanted(ws):
            return
        for line in lines:
            try:
                e = json.loads(line)
            except ValueError:
                continue
            if "run_summary" in e:
                r = e["run_summary"]
                self.tickets.setdefault(ws, r.get("issue_identifier") or ws[:8])
                msg = f"■ run {r.get('run_id', '').split(':')[-1]} {r.get('status')} - {r.get('title', '')}"
            elif "node_summary" in e:
                n = e["node_summary"]
                msg = f"■ {n.get('title') or n.get('kind')} [{n.get('status')}]"
                if n.get("summary"):
                    msg += f": {n['summary']}"
                if n.get("error"):
                    msg += f"\n  error: {n['error']}"
            else:
                continue
            self.emit(e.get("timestamp"), ws, "contrabass", msg, dim="node_summary" in e and not e["node_summary"].get("error"))

    # ---------- main loop ----------
    def scan(self, startup=False):
        back = self.args.lines if startup else 0
        for path in sorted(glob.glob(os.path.join(TIMELINE, "*.jsonl")), key=os.path.getmtime):
            if self.fresh(path, startup):
                self.timeline(path, self.new_lines(path, back))
        for path in glob.glob(os.path.join(WORKSPACES, "*/.omc/state/team/*/events.jsonl")):
            if self.fresh(path, startup):
                self.team_events(path, self.new_lines(path, back))
        for path in glob.glob(os.path.join(WORKSPACES, "*/.omc/state/team/*/workers/*/inbox.md")):
            self.inbox(path, startup)
        for path in sorted(glob.glob(os.path.join(PROJECTS, TRANSCRIPT_PREFIX + "*/*.jsonl")), key=os.path.getmtime):
            if self.fresh(path, startup):
                self.transcript(path, self.new_lines(path, back))

    def run(self):
        scope = ", ".join(sorted(self.args.tickets)) or "all tickets"
        print(paint(1, f"watching {scope} (activity from the last {self.args.recent} min, then live; Ctrl-C to quit)"), flush=True)
        self.backlog = []
        self.scan(startup=True)
        backlog, self.backlog = sorted(self.backlog, key=lambda e: e[:2]), None
        cutoff = time.time() - self.args.recent * 60
        for when, _, *rest in backlog:
            if when.timestamp() >= cutoff:
                self.print(when, *rest)
        while True:
            time.sleep(1)
            self.scan()


def tool_summary(name, inp):
    for key in ("command", "file_path", "pattern", "url", "prompt", "description", "query"):
        if inp.get(key):
            val = str(inp[key]).strip().replace("\n", " ⏎ ")
            if name == "Bash" and inp.get("description"):
                val = f"{val}   # {inp['description']}"
            return f"{name}: {val}"
    return f"{name}: {json.dumps(inp)[:200]}"


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("tickets", nargs="*", help="only these tickets, e.g. NEW-34")
    p.add_argument("--recent", type=float, default=30, help="at startup, show files active in the last MIN minutes (default 30)")
    p.add_argument("--lines", type=int, default=20, help="at startup, backfill N entries per file (default 20)")
    p.add_argument("--max-lines", type=int, default=8, help="lines shown per message unless --full (default 8)")
    p.add_argument("--full", action="store_true", help="never truncate messages")
    p.add_argument("--no-results", action="store_true", help="hide tool results, show only text and tool calls")
    args = p.parse_args()
    args.tickets = {t.upper() for t in args.tickets}
    try:
        Watcher(args).run()
    except KeyboardInterrupt:
        pass
    except BrokenPipeError:  # e.g. piped into head
        os.dup2(os.open(os.devnull, os.O_WRONLY), sys.stdout.fileno())


if __name__ == "__main__":
    main()
