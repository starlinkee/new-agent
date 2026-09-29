import os
import subprocess
import sys


def ask_claude(system_prompt, user_prompt, model="opus"):
    """Single-shot, tool-less Claude call through the Claude Code CLI.

    Authenticates with CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token`), so
    usage counts against the Claude subscription instead of API credits.
    """
    env = dict(os.environ)
    # An API key would take priority over the subscription token.
    env.pop("ANTHROPIC_API_KEY", None)
    env.pop("ANTHROPIC_WORKSPACE_ID", None)
    out = subprocess.run(
        ["claude", "-p", "--model", model, "--tools", "",
         "--system-prompt", system_prompt],
        input=user_prompt, capture_output=True, text=True, env=env, timeout=900,
    )
    if out.returncode != 0 or not out.stdout.strip():
        print(f"claude CLI failed (exit {out.returncode}):\n{out.stdout}\n{out.stderr}",
              file=sys.stderr)
        sys.exit(1)
    return out.stdout.strip()


def run_claude_agent(system_prompt, user_prompt, allowed_tools, model="opus", timeout=2700):
    """Agentic Claude Code run in the current directory (edits files, runs commands).

    Only `allowed_tools` may run; anything else is denied because there is nobody
    to approve it. Same subscription-token auth as ask_claude. Returns the final text.
    """
    env = dict(os.environ)
    env.pop("ANTHROPIC_API_KEY", None)
    env.pop("ANTHROPIC_WORKSPACE_ID", None)
    out = subprocess.run(
        ["claude", "-p", "--model", model, "--permission-mode", "acceptEdits",
         "--allowedTools", ",".join(allowed_tools), "--system-prompt", system_prompt],
        input=user_prompt, capture_output=True, text=True, env=env, timeout=timeout,
    )
    if out.returncode != 0:
        print(f"claude agent failed (exit {out.returncode}):\n{out.stdout}\n{out.stderr}",
              file=sys.stderr)
        sys.exit(1)
    return out.stdout.strip()
