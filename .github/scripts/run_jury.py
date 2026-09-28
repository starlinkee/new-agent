import json
import os
import re
import sys
import subprocess
import urllib.request

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

MAX_REWORK = 3  # same cap as scripts/linear_sync.py


def linear(query, variables):
    req = urllib.request.Request(
        "https://api.linear.app/graphql",
        data=json.dumps({"query": query, "variables": variables}).encode(),
        headers={"Authorization": os.environ["LINEAR_API_KEY"], "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        data = json.load(r)
    if data.get("errors"):
        raise RuntimeError(data["errors"][0]["message"])
    return data["data"]


def push_rejection_to_linear():
    """Move the ticket to Todo right away so Contrabass reworks it, without waiting for
    the reconciler's GitHub polling (which stalls when the API quota runs out).

    Best effort: the reconciler stays as the backup, so any failure here is only logged.
    """
    m = re.fullmatch(r"symphony/(new-\d+)", os.environ.get("HEAD_REF", ""))
    if not m or not os.environ.get("LINEAR_API_KEY"):
        return
    ident = m.group(1).upper()
    num = int(ident.split("-")[1])
    comments = subprocess.run(
        ["gh", "pr", "view", os.environ["PR_NUMBER"], "--json", "comments", "--jq",
         "[.comments[] | select(.author.login | startswith(\"github-actions\")) | "
         "select(.body | test(\"STATUS: *REJECTED\"))] | length"],
        capture_output=True, text=True, check=True).stdout.strip()
    rejections = int(comments or 1)
    issue = linear(
        """query($n:Float!){issues(filter:{number:{eq:$n}}){nodes{id identifier state{name}
        team{states{nodes{id name}}}}}}""", {"n": num})["issues"]["nodes"]
    issue = next((i for i in issue if i["identifier"] == ident), None)
    if not issue:
        return
    cur = issue["state"]["name"]
    if cur not in ("Done", "In Review"):  # In Progress = a worker is already reworking it
        print(f"{ident} is {cur}; leaving it alone")
        return
    target = "Backlog" if rejections > MAX_REWORK else "Todo"
    state_id = next(s["id"] for s in issue["team"]["states"]["nodes"] if s["name"] == target)
    linear("mutation($i:String!,$s:String!){issueUpdate(id:$i,input:{stateId:$s}){success}}",
           {"i": issue["id"], "s": state_id})
    if target == "Backlog":
        linear("mutation($i:String!,$b:String!){commentCreate(input:{issueId:$i,body:$b}){success}}",
               {"i": issue["id"], "b": f"Jury rejected PR #{os.environ['PR_NUMBER']} {rejections} times - needs a human."})
    print(f"{ident}: {cur} -> {target} (jury REJECTED, rejection #{rejections})")


if "STATUS: REJECTED" in verdict:
    try:
        push_rejection_to_linear()
    except Exception as e:  # never hide the verdict because Linear is down
        print(f"could not update Linear: {e}")
    sys.exit(1)
sys.exit(0)
