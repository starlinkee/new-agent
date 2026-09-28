import os
import sys
import subprocess
from anthropic import Anthropic

with open("pr_diff.txt", "r") as file:
    diff_content = file.read()

if not diff_content.strip():
    sys.exit(0)

client = Anthropic(api_key=os.environ.get("ANTHROPIC_API_KEY"))
system_prompt = """
You are an uncompromising Senior Principal Engineer reviewing a Pull Request.
Criteria: 1. Security (SQLi, XSS, secrets) 2. Architecture (layer bypassing) 3. Performance (N+1, memory).
If violations exist, output "STATUS: REJECTED" and list issues.
If clean, output "STATUS: APPROVED".
"""

response = client.messages.create(
    model="claude-opus-5",
    max_tokens=1024,
    system=system_prompt,
    messages=[{"role": "user", "content": f"Review this PR diff:\n\n{diff_content}"}]
)

verdict = response.content[0].text

subprocess.run(
    ["gh", "pr", "comment", os.environ["PR_NUMBER"], "--body-file", "-"],
    input=verdict,
    text=True,
    check=True,
)

if "STATUS: REJECTED" in verdict:
    sys.exit(1)
sys.exit(0)
