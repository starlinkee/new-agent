import os
import sys
import subprocess
from anthropic import Anthropic

# This only fires when the worker labeled the PR "needs-expert-review"
# after failing to get a clean rebase + passing QA after 2 attempts
# (see .contrabass/WORKFLOW.md). It reads the PR body (where the worker
# recorded what it tried and the exact conflict/error output) plus the
# current diff, and posts an expert comment.
#
# Deliberately comment-only, not auto-push: pushing an LLM-authored fix
# directly onto someone's PR branch without review is a destructive-ish
# action or the kind of automation surprise the "measure twice" default
# is meant to avoid. If you want this to also push a fix commit, that's
# a separate, explicit opt-in - ask before enabling it.

with open("pr_diff.txt", "r") as file:
    diff_content = file.read()

if not diff_content.strip():
    sys.exit(0)

pr_number = os.environ["PR_NUMBER"]
pr_body = subprocess.run(
    ["gh", "pr", "view", pr_number, "--json", "body", "--jq", ".body"],
    capture_output=True, text=True, check=True,
).stdout

# Keys that are not scoped to a workspace need the workspace id header.
workspace_id = os.environ.get("ANTHROPIC_WORKSPACE_ID")
client = Anthropic(
    api_key=os.environ.get("ANTHROPIC_API_KEY"),
    default_headers={"anthropic-workspace-id": workspace_id} if workspace_id else None,
)
system_prompt = """
You are a Senior Principal Engineer brought in to unblock a PR that an
autonomous coding agent could not finish on its own (failed rebase onto
main, or a fix loop that didn't converge). The agent's account of what
it tried is in the PR description.

Diagnose the actual root cause of the conflict/failure, and give the
concrete next step a human (or a follow-up agent run) should take to
resolve it: which side's changes should win where they conflict, what
code needs to change, and any risk you see in the current diff. Be
specific - reference file paths and the conflicting logic, not generic
advice. If the diff looks fine and the failure was likely a flaky test
or environment issue, say that plainly instead of inventing a conflict.
"""

response = client.messages.create(
    model="claude-opus-5",
    max_tokens=2048,
    system=system_prompt,
    messages=[{
        "role": "user",
        "content": (
            f"Agent's own account of what it tried:\n\n{pr_body}\n\n"
            f"Current PR diff against the base branch:\n\n{diff_content}"
        ),
    }],
)

advice = response.content[0].text

subprocess.run(
    ["gh", "pr", "comment", pr_number, "--body-file", "-"],
    input=f"**AI Merge Doctor (Opus 5)**\n\n{advice}",
    text=True,
    check=True,
)
