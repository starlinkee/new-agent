import json
import os
import re
import sys
import urllib.request


def ticket_text(head_ref):
    """Title and description of the Linear ticket a branch (symphony/new-N) implements.

    The description is the specification the PR must meet. Best effort: without the key,
    for another branch name, or on any error, this returns "" and callers work from the PR.
    """
    m = re.fullmatch(r"symphony/(new-\d+)", head_ref or "")
    if not m or not os.environ.get("LINEAR_API_KEY"):
        return ""
    ident = m.group(1).upper()
    try:
        req = urllib.request.Request(
            "https://api.linear.app/graphql",
            data=json.dumps({"query": "query($n:Float!){issues(filter:{number:{eq:$n}})"
                             "{nodes{identifier title description}}}",
                             "variables": {"n": int(ident.split("-")[1])}}).encode(),
            headers={"Authorization": os.environ["LINEAR_API_KEY"],
                     "Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=30) as r:
            nodes = json.load(r)["data"]["issues"]["nodes"]
        issue = next(i for i in nodes if i["identifier"] == ident)
        return f"{ident}: {issue['title']}\n\n{issue['description'] or '(no description)'}"
    except Exception as e:
        print(f"could not read the Linear ticket: {e}", file=sys.stderr)
        return ""
