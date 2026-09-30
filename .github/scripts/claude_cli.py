import datetime as dt
import os
import re
import subprocess
import sys
import time
from zoneinfo import ZoneInfo

# Never visible to Claude or to the code it runs: the Merge Doctor's agent executes
# agent-written code (npm test, node), and one `node -e` would be enough to push with a
# GitHub token or rewrite Linear. The trusted scripts keep these for their own calls.
# ANTHROPIC_* go too: an API key would take priority over the subscription token.
SECRETS = ("GH_TOKEN", "GITHUB_TOKEN", "LINEAR_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_WORKSPACE_ID")


def clean_env():
    """os.environ without SECRETS, for Claude and for any agent-written code."""
    return {k: v for k, v in os.environ.items() if k not in SECRETS}


LIMIT_RE = re.compile(r"hit your .{0,40}limit", re.I)
RESET_RE = re.compile(r"resets\s+(?:([A-Za-z]{3})[a-z]*\s+(\d{1,2}),?\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)"
                      r"(?:\s*\(([^)]+)\))?", re.I)
LIMIT_FALLBACK_MIN = 30  # the CLI's message gave no usable reset time
LIMIT_MARGIN_MIN = 2  # let the quota window actually open before retrying


class UsageLimit(RuntimeError):
    """The Claude subscription is out of quota. `until` is the epoch second it should be back."""

    def __init__(self, output, until):
        super().__init__(f"Claude usage limit hit: {output.strip()[-300:]}")
        self.until = until


def limit_marker(until):
    """Hidden marker for a PR comment: the quota is back at this epoch second.

    scripts/linear_sync.py parses the same marker (LIMIT_RE there); keep them in sync.
    """
    return f"<!-- ai-usage-limit until={int(until)} -->"


def usage_limit_reset(text, now=None):
    """Epoch second the quota returns if `text` is a usage-limit message, else None.

    The CLI says e.g. "You've hit your session limit · resets 2:20am (UTC)"; a weekly limit
    adds a date ("resets Oct 3, 2:20am (UTC)"). An unreadable time falls back to a short wait.
    """
    if not LIMIT_RE.search(text or ""):
        return None
    now = now or time.time()
    m = RESET_RE.search(text)
    if m:
        try:
            zone = ZoneInfo(m.group(6) or "UTC")
            local = dt.datetime.fromtimestamp(now, zone)
            hour = int(m.group(3)) % 12 + (12 if m.group(5).lower() == "pm" else 0)
            at = local.replace(hour=hour, minute=int(m.group(4) or 0), second=0, microsecond=0)
            if m.group(1):
                month = dt.datetime.strptime(m.group(1).title(), "%b").month
                at = at.replace(month=month, day=int(m.group(2)))
                if at < local:
                    at = at.replace(year=at.year + 1)
            elif at <= local:
                at += dt.timedelta(days=1)
            return at.timestamp() + LIMIT_MARGIN_MIN * 60
        except (ValueError, KeyError, OSError):  # unknown zone name, impossible date
            pass
    return now + LIMIT_FALLBACK_MIN * 60


def ask_claude(system_prompt, user_prompt, model="opus"):
    """Single-shot, tool-less Claude call through the Claude Code CLI.

    Authenticates with CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token`), so
    usage counts against the Claude subscription instead of API credits.
    Raises RuntimeError when the CLI fails or answers nothing (UsageLimit, a RuntimeError,
    when the subscription is out of quota).
    """
    out = subprocess.run(
        ["claude", "-p", "--model", model, "--tools", "",
         "--system-prompt", system_prompt],
        input=user_prompt, capture_output=True, text=True, env=clean_env(), timeout=900,
    )
    if out.returncode != 0 or not out.stdout.strip():
        until = usage_limit_reset(out.stdout + out.stderr)
        if until:
            raise UsageLimit(out.stdout + out.stderr, until)
        raise RuntimeError(f"claude CLI failed (exit {out.returncode}):\n{out.stdout}\n{out.stderr}")
    return out.stdout.strip()


def run_claude_agent(system_prompt, user_prompt, allowed_tools, model="opus", timeout=2700):
    """Agentic Claude Code run in the current directory (edits files, runs commands).

    Only `allowed_tools` may run; anything else is denied because there is nobody
    to approve it. Same subscription-token auth as ask_claude. Returns the final text.
    Raises UsageLimit when the subscription is out of quota; exits 1 on any other failure.
    """
    out = subprocess.run(
        ["claude", "-p", "--model", model, "--permission-mode", "acceptEdits",
         "--allowedTools", ",".join(allowed_tools), "--system-prompt", system_prompt],
        input=user_prompt, capture_output=True, text=True, env=clean_env(), timeout=timeout,
    )
    if out.returncode != 0:
        until = usage_limit_reset(out.stdout + out.stderr)
        if until:
            raise UsageLimit(out.stdout + out.stderr, until)
        print(f"claude agent failed (exit {out.returncode}):\n{out.stdout}\n{out.stderr}",
              file=sys.stderr)
        sys.exit(1)
    return out.stdout.strip()
