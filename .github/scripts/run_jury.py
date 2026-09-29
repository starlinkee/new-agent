import os
import sys
import subprocess

from claude_cli import ask_claude

with open("pr_diff.txt", "r") as file:
    diff_content = file.read()

if not diff_content.strip():
    sys.exit(0)

system_prompt = """
You are an uncompromising Senior Principal Engineer reviewing a Pull Request.
Criteria: 1. Security (SQLi, XSS, secrets) 2. Architecture (layer bypassing) 3. Performance (N+1, memory).
If violations exist, output "STATUS: REJECTED" and list issues.
If clean, output "STATUS: APPROVED".
"""

verdict = ask_claude(system_prompt, f"Review this PR diff:\n\n{diff_content}")

subprocess.run(
    ["gh", "pr", "comment", os.environ["PR_NUMBER"], "--body-file", "-"],
    input=verdict,
    text=True,
    check=True,
)

# A rejection fails the check. Routing it (the Merge Doctor fixes the findings) is the
# reconciler's job: scripts/linear_sync.py.
if "STATUS: REJECTED" in verdict:
    sys.exit(1)
sys.exit(0)
