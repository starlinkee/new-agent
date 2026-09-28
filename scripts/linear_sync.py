#!/usr/bin/env python3
"""Reconcile Linear ticket states with GitHub (GitHub is the source of truth).

Why: Contrabass hardcodes "finished run" -> Linear "Done", and also marks
every running ticket "Done" when it shuts down. So tickets become Done while
their PR is unmerged, or while no PR exists at all (work lost on restart).

Rules, per ticket NEW-N with branch symphony/new-n, for tickets in Done or
In Review:
  PR merged                      -> Done
  PR open                        -> In Review
  no PR, ticket Done > GRACE min -> Todo (redo), at most MAX_REDO times, then Backlog
  PR closed unmerged             -> Todo (redo), same cap

"In Review" is created on demand with type "completed": Contrabass maps the
Linear state type to its own state ("started" would be re-run as an orphan,
"unstarted" would be picked up again), so "completed" is the only safe type.

Usage: linear_sync.py [--once] [--dry-run] [--interval 60]
Env:   LINEAR_API_KEY (required), GH_REPO (default starlinkee/new-agent)
"""
import argparse
import datetime as dt
import json
import os
import subprocess
import sys
import time
import urllib.request

REPO = os.environ.get("GH_REPO", "starlinkee/new-agent")
TEAM_KEY = os.environ.get("LINEAR_TEAM_KEY", "NEW")
GRACE_MIN = 10
MAX_REDO = 2
STATE_FILE = os.path.expanduser("~/.cb-linear-sync.json")
KEY = os.environ.get("LINEAR_API_KEY", "")


def log(msg):
    print(f"{time.strftime('%H:%M:%S')} {msg}", flush=True)


def gql(query, variables=None):
    req = urllib.request.Request(
        "https://api.linear.app/graphql",
        data=json.dumps({"query": query, "variables": variables or {}}).encode(),
        headers={"Authorization": KEY, "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=40) as r:
        data = json.load(r)
    if data.get("errors"):
        raise RuntimeError(data["errors"][0]["message"])
    return data["data"]


def load_state():
    try:
        return json.load(open(STATE_FILE))
    except (OSError, ValueError):
        return {}


def save_state(state):
    json.dump(state, open(STATE_FILE, "w"), indent=2)


def get_states():
    d = gql(
        """query($k:String!){teams(filter:{key:{eq:$k}}){nodes{id
        states{nodes{id name type}}}}}""",
        {"k": TEAM_KEY},
    )
    team = d["teams"]["nodes"][0]
    return team["id"], {s["name"]: s["id"] for s in team["states"]["nodes"]}


def ensure_in_review(team_id, states, dry):
    if "In Review" in states:
        return
    log("creating Linear state 'In Review' (type completed)")
    if dry:
        states["In Review"] = "dry-run"
        return
    d = gql(
        """mutation($t:String!){workflowStateCreate(input:{teamId:$t,name:"In Review",
        type:"completed",color:"#0f783c",description:"Run finished; PR open, not merged"})
        {success workflowState{id}}}""",
        {"t": team_id},
    )
    states["In Review"] = d["workflowStateCreate"]["workflowState"]["id"]


def pr_for(branch):
    out = subprocess.run(
        ["gh", "pr", "list", "--repo", REPO, "--head", branch, "--state", "all",
         "--json", "number,state,mergedAt"],
        capture_output=True, text=True, timeout=60,
    )
    if out.returncode != 0:
        raise RuntimeError(f"gh: {out.stderr.strip()[:200]}")
    prs = json.loads(out.stdout or "[]")
    if any(p["state"] == "MERGED" for p in prs):
        return "merged"
    if any(p["state"] == "OPEN" for p in prs):
        return "open"
    return "closed" if prs else "none"


def set_state(issue, name, states, dry, why):
    log(f"{issue['identifier']}: {issue['state']['name']} -> {name} ({why})")
    if dry:
        return
    gql(
        """mutation($i:String!,$s:String!){issueUpdate(id:$i,input:{stateId:$s}){success}}""",
        {"i": issue["id"], "s": states[name]},
    )


def reconcile(dry):
    team_id, states = get_states()
    ensure_in_review(team_id, states, dry)
    d = gql(
        """query($k:String!){issues(first:100,filter:{team:{key:{eq:$k}},
        state:{name:{in:["Done","In Review"]}}}){nodes{id identifier
        state{name} updatedAt}}}""",
        {"k": TEAM_KEY},
    )
    memory = load_state()
    for issue in d["issues"]["nodes"]:
        ident = issue["identifier"]
        branch = "symphony/" + ident.lower()
        cur = issue["state"]["name"]
        try:
            pr = pr_for(branch)
        except Exception as e:  # keep going, retry next round
            log(f"{ident}: PR lookup failed: {e}")
            continue
        if pr == "merged":
            if cur != "Done":
                set_state(issue, "Done", states, dry, "PR merged")
        elif pr == "open":
            if cur != "In Review":
                set_state(issue, "In Review", states, dry, "PR open, not merged")
        elif cur == "Done":  # none / closed, only Contrabass's own Done is suspicious
            age = dt.datetime.now(dt.timezone.utc) - dt.datetime.fromisoformat(
                issue["updatedAt"].replace("Z", "+00:00"))
            if pr == "none" and age < dt.timedelta(minutes=GRACE_MIN):
                continue
            n = memory.get(ident, 0)
            if n >= MAX_REDO:
                set_state(issue, "Backlog", states, dry,
                          f"no merged/open PR after {n} redos - needs a human")
            else:
                set_state(issue, "Todo", states, dry, f"no PR ({pr}); redo #{n + 1}")
                memory[ident] = n + 1
    if not dry:
        save_state(memory)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--once", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--interval", type=int, default=60)
    a = ap.parse_args()
    if not KEY:
        sys.exit("LINEAR_API_KEY is not set")
    while True:
        try:
            reconcile(a.dry_run)
        except Exception as e:
            log(f"sync error: {e}")
        if a.once:
            return
        time.sleep(a.interval)


if __name__ == "__main__":
    main()
