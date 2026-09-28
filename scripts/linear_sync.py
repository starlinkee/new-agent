#!/usr/bin/env python3
"""Reconcile Linear ticket states with GitHub (GitHub is the source of truth).

Why: Contrabass hardcodes "finished run" -> Linear "Done", and also marks
every running ticket "Done" when it shuts down. So tickets become Done while
their PR is unmerged, or while no PR exists at all (work lost on restart).

Rules, per ticket NEW-N with branch symphony/new-n, for tickets in Done or
In Review:
  PR merged                      -> Done
  PR open                        -> In Review, then look at the AI jury verdict:
    verdict REJECTED (or PR has merge conflicts) -> Todo (rework the SAME branch,
        a fresh worker reads the jury comments), at most MAX_REWORK times, then Backlog
    verdict APPROVED, PR mergeable -> squash-merge it, ticket Done (AUTO_MERGE=0 disables)
    no verdict for the current head commit yet -> wait
  no PR, ticket Done > GRACE min -> Todo (redo), at most MAX_REDO times, then Backlog
  PR closed unmerged             -> Todo (redo), same cap

"In Review" is created on demand with type "completed": Contrabass maps the
Linear state type to its own state ("started" would be re-run as an orphan,
"unstarted" would be picked up again), so "completed" is the only safe type.

Backlog tickets that are "blocked by" other tickets move to Todo once every
blocker is Done (so a dependent ticket starts only after its dependency merged).

Usage: linear_sync.py [--once] [--dry-run] [--interval 20]
Env:   LINEAR_API_KEY (required), GH_REPO (default starlinkee/new-agent)
"""
import argparse
import datetime as dt
import json
import os
import re
import subprocess
import sys
import time
import urllib.request

REPO = os.environ.get("GH_REPO", "starlinkee/new-agent")
TEAM_KEY = os.environ.get("LINEAR_TEAM_KEY", "NEW")
GRACE_MIN = 10
MAX_REDO = 2
MAX_REWORK = 3
AUTO_MERGE = os.environ.get("AUTO_MERGE", "1") != "0"
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


def gh(*args):
    # gh from WSL times out now and then; retry so a Done ticket with an open PR
    # is not left wrong until the next round.
    for attempt in range(3):
        out = subprocess.run(["gh", *args], capture_output=True, text=True, timeout=60)
        if out.returncode == 0:
            return out.stdout
        if attempt == 2:
            raise RuntimeError(f"gh: {out.stderr.strip()[:200]}")
        time.sleep(3)


def pr_info(branch):
    """Status of the PR for a branch, plus the jury verdict for its current head."""
    prs = json.loads(gh(
        "pr", "list", "--repo", REPO, "--head", branch, "--state", "all",
        "--json", "number,state,mergeable,commits,comments") or "[]")
    if any(p["state"] == "MERGED" for p in prs):
        return {"status": "merged"}
    opened = [p for p in prs if p["state"] == "OPEN"]
    if not opened:
        return {"status": "closed" if prs else "none"}
    pr = opened[0]
    head_at = max((c["committedDate"] for c in pr["commits"]), default="")
    verdict = None
    for c in pr["comments"]:  # only the jury workflow's own comments count
        m = re.search(r"STATUS:\s*(APPROVED|REJECTED)", c["body"])
        if m and c["author"]["login"].startswith("github-actions") and c["createdAt"] > head_at:
            verdict = m.group(1)  # latest wins; older verdicts are for older commits
    return {"status": "open", "number": pr["number"], "mergeable": pr["mergeable"],
            "verdict": verdict}


def set_state(issue, name, states, dry, why):
    log(f"{issue['identifier']}: {issue['state']['name']} -> {name} ({why})")
    if dry:
        return
    gql(
        """mutation($i:String!,$s:String!){issueUpdate(id:$i,input:{stateId:$s}){success}}""",
        {"i": issue["id"], "s": states[name]},
    )


def handle_open_pr(issue, info, states, memory, dry):
    ident, num = issue["identifier"], info["number"]
    reason = None
    if info["verdict"] == "REJECTED":
        reason = "jury REJECTED"
    elif info["mergeable"] == "CONFLICTING":
        reason = "merge conflicts with master"
    if reason:
        key = "rework:" + ident
        n = memory.get(key, 0)
        if n >= MAX_REWORK:
            set_state(issue, "Backlog", states, dry,
                      f"PR #{num}: {reason} after {n} rework rounds - needs a human")
        else:
            set_state(issue, "Todo", states, dry, f"PR #{num}: {reason}; rework #{n + 1}")
            memory[key] = n + 1
    elif info["verdict"] == "APPROVED" and info["mergeable"] == "MERGEABLE" and AUTO_MERGE:
        log(f"{ident}: jury APPROVED, merging PR #{num}")
        if not dry:
            gh("pr", "merge", str(num), "--repo", REPO, "--squash", "--delete-branch")
            set_state(issue, "Done", states, dry, f"PR #{num} merged")


def promote_unblocked(states, dry):
    """Backlog tickets whose blockers are all Done become Todo."""
    d = gql(
        """query($k:String!){issues(first:100,filter:{team:{key:{eq:$k}},
        state:{name:{eq:"Backlog"}}}){nodes{id identifier state{name}
        inverseRelations{nodes{type issue{identifier state{name}}}}}}}""",
        {"k": TEAM_KEY},
    )
    for issue in d["issues"]["nodes"]:
        blockers = [r["issue"] for r in issue["inverseRelations"]["nodes"]
                    if r["type"] == "blocks"]
        if blockers and all(b["state"]["name"] == "Done" for b in blockers):
            names = ", ".join(b["identifier"] for b in blockers)
            set_state(issue, "Todo", states, dry, f"unblocked ({names} Done)")


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
            info = pr_info(branch)
        except Exception as e:  # keep going, retry next round
            log(f"{ident}: PR lookup failed: {e}")
            continue
        pr = info["status"]
        if pr == "merged":
            if cur != "Done":
                set_state(issue, "Done", states, dry, "PR merged")
        elif pr == "open":
            if cur != "In Review":
                set_state(issue, "In Review", states, dry, "PR open, not merged")
            handle_open_pr(issue, info, states, memory, dry)
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
    promote_unblocked(states, dry)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--once", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--interval", type=int, default=20)
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
