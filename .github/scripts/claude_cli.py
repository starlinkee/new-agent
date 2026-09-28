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
