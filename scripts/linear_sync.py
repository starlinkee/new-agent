#!/usr/bin/env python3
"""Reconcile Linear ticket states with GitHub (GitHub is the source of truth).

Why: Contrabass hardcodes "finished run" -> Linear "Done", and also marks
every running ticket "Done" when it shuts down. So tickets become Done while
their PR is unmerged, or while no PR exists at all (work lost on restart).

Rules, per ticket NEW-N with branch symphony/new-n, for tickets in Done or
In Review:
  PR merged                      -> Done
  PR open                        -> In Review, then look at the AI jury verdict:
    verdict REJECTED -> Todo (rework the SAME branch, a fresh worker reads the jury
        comments and rebases if needed), at most MAX_REWORK times, then Backlog
    merge conflicts only -> the PR gets the `needs-expert-review` label, which starts the
        AI Merge Doctor (Opus rebases, resolves, tests, pushes); the ticket stays In Review
        and the jury + auto-merge take it from there. A retry starts as soon as the previous run has
        finished without fixing it; at most MAX_DOCTOR attempts, then Backlog
    verdict APPROVED, PR mergeable -> squash-merge it, ticket Done (AUTO_MERGE=0 disables)
    no verdict for the current head commit yet -> wait
  no PR, ticket Done > GRACE min -> Todo (redo), at most MAX_REDO times, then Backlog
  PR closed unmerged             -> Todo (redo), same cap

In Progress tickets are only touched when Contrabass has no run or retry for them for
ORPHAN_MIN (it parks "needs_review" runs and runs whose worker died, ticket still In
Progress); they then go through the same PR rules as above.
Open PR without a verdict for its head (jury run failed or never started) -> the PR is
reopened once per head, which re-triggers the jury with the current scripts.
Moves to Backlog leave a Linear comment saying why.

"In Review" is created on demand with type "completed": Contrabass maps the
Linear state type to its own state ("started" would be re-run as an orphan,
"unstarted" would be picked up again), so "completed" is the only safe type.

Todo/In Progress tickets whose blocker is In Review go back to Backlog (Contrabass
treats In Review as finished and would start them before the blocker is merged).
Backlog tickets that are "blocked by" other tickets move to Todo once every
blocker is Done (so a dependent ticket starts only after its dependency merged).

Usage: linear_sync.py [--once] [--dry-run] [--interval 60]
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
MAX_DOCTOR = 3  # Merge Doctor runs per conflicting PR before a human is asked
DOCTOR_START_MIN = 3  # a doctor run should show up in Actions within this long after the label
DOCTOR_MAX_MIN = 70  # safety net: workflow timeout is 60 min
MAX_STUCK = 2  # reworks in a row that left the branch head unchanged before a human is asked
TODO_STALE_MIN = 15  # a Todo ticket after a rework that Contrabass has not started for this long is stuck
ORPHAN_MIN = 3  # In Progress with no Contrabass run for this long = abandoned
JURY_WAIT_MIN = 3  # a head commit older than this with no jury run/verdict gets the jury re-triggered
CB_URL = os.environ.get("CB_URL", "http://localhost:8080")
AUTO_MERGE = os.environ.get("AUTO_MERGE", "1") != "0"
STATE_FILE = os.path.expanduser("~/.cb-linear-sync.json")
HEALTH_FILE = os.path.expanduser("~/.cb-linear-sync.health")  # mtime = last fully successful round
WATCHDOG_MIN = 10  # no successful round for this long = shout in the log and in `cb status`
LOOKUP_FAILS = 0  # PR lookups that failed in the current round
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


class RateLimited(RuntimeError):
    pass


RATE_LIMIT_SLEEP = 300


def gh(*args):
    # gh from WSL times out now and then; retry so a Done ticket with an open PR
    # is not left wrong until the next round.
    for attempt in range(3):
        out = subprocess.run(["gh", *args], capture_output=True, text=True, timeout=60)
        if out.returncode == 0:
            return out.stdout
        if "rate limit" in out.stderr.lower():
            raise RateLimited(out.stderr.strip()[:200])  # retrying only burns more quota
        if attempt == 2:
            raise RuntimeError(f"gh: {out.stderr.strip()[:200]}")
        time.sleep(3)


def cb_activity():
    """Text of Contrabass's running + retrying runs, or None if it cannot be asked.

    Contrabass parks a run it cannot verify ("needs_review") or whose worker died
    with the Linear ticket left In Progress, and never looks at it again.
    """
    try:
        with urllib.request.urlopen(CB_URL + "/api/v1/state", timeout=5) as r:
            d = json.load(r)
        return json.dumps([d.get("running"), d.get("backoff")])
    except Exception as e:
        log(f"Contrabass state unavailable ({e}); not touching In Progress tickets")
        return None


MERGED = set()  # a merged branch never changes again; do not ask GitHub twice


def api(path):
    return json.loads(gh("api", path.format(repo=REPO)) or "null")


def pr_info(branch):
    """Status of the PR for a branch, plus the jury verdict for its current head.

    Uses the REST API: `gh pr list --json` is GraphQL, and its 5000/hour quota ran
    dry (every ticket, every round), which froze the whole rework loop.
    """
    if branch in MERGED:
        return {"status": "merged"}
    owner = REPO.split("/")[0]
    prs = api(f"repos/{{repo}}/pulls?state=all&head={owner}:{branch}&per_page=30")
    if any(p.get("merged_at") for p in prs):
        MERGED.add(branch)
        return {"status": "merged"}
    opened = [p for p in prs if p["state"] == "open"]
    if not opened:
        return {"status": "closed" if prs else "none"}
    num = opened[0]["number"]
    pr = api(f"repos/{{repo}}/pulls/{num}")
    commits = api(f"repos/{{repo}}/pulls/{num}/commits?per_page=100")
    head_at = max((c["commit"]["committer"]["date"] for c in commits), default="")
    verdict = None
    for c in api(f"repos/{{repo}}/issues/{num}/comments?per_page=100"):
        m = re.search(r"STATUS:\s*(APPROVED|REJECTED)", c["body"])  # only the jury workflow counts
        if m and c["user"]["login"].startswith("github-actions") and c["created_at"] > head_at:
            verdict = m.group(1)  # latest wins; older verdicts are for older commits
    mergeable = {True: "MERGEABLE", False: "CONFLICTING"}.get(pr["mergeable"], "UNKNOWN")
    return {"status": "open", "number": num, "mergeable": mergeable,
            "head": pr["head"]["sha"], "head_at": head_at, "title": pr["title"], "branch": branch, "verdict": verdict}


def set_state(issue, name, states, dry, why):
    log(f"{issue['identifier']}: {issue['state']['name']} -> {name} ({why})")
    if dry:
        return
    gql(
        """mutation($i:String!,$s:String!){issueUpdate(id:$i,input:{stateId:$s}){success}}""",
        {"i": issue["id"], "s": states[name]},
    )
    if name == "Backlog":  # the reconciler only parks tickets there to ask a human; say why
        try:
            gql("""mutation($i:String!,$b:String!){commentCreate(input:{issueId:$i,body:$b}){success}}""",
                {"i": issue["id"], "b": f"Moved to Backlog by the reconciler: {why}."})
        except Exception as e:
            log(f"{issue['identifier']}: could not comment: {e}")


def retrigger_jury(ident, info, memory, dry):
    """Open, mergeable PR whose current head has no verdict: reopen it, once per head.

    The jury only runs on opened/synchronize/reopened, so a run that failed (or a PR
    that was conflicting when opened) would otherwise wait for a verdict forever.
    A reopen makes GitHub build a fresh merge commit, so the run also picks up the
    current workflow and scripts from master, which "re-run" would not.
    """
    key = "jury:" + ident
    if info["mergeable"] != "MERGEABLE" or memory.get(key) == info["head"]:
        return
    if info["head_at"]:
        age = dt.datetime.now(dt.timezone.utc) - dt.datetime.fromisoformat(
            info["head_at"].replace("Z", "+00:00"))
        if age < dt.timedelta(minutes=JURY_WAIT_MIN):
            return
    runs = json.loads(gh("run", "list", "--repo", REPO, "--workflow", "ai-jury.yml",
                         "--branch", info["branch"], "--limit", "10",
                         "--json", "headSha,status") or "[]")
    if any(r["headSha"] == info["head"] and r["status"] != "completed" for r in runs):
        return  # still running
    log(f"{ident}: no jury verdict for head {info['head'][:7]}, reopening PR #{info['number']}")
    memory[key] = info["head"]
    if not dry:
        gh("pr", "close", str(info["number"]), "--repo", REPO)
        gh("pr", "reopen", str(info["number"]), "--repo", REPO)


def doctor_running(pr_title):
    """True while a Merge Doctor run for this PR is queued or in progress.

    The workflow is pull_request_target, so its runs belong to the base branch; the
    run title is the PR title, which is the only thing tying a run to its PR.
    """
    runs = json.loads(gh("run", "list", "--repo", REPO, "--workflow", "merge-doctor.yml",
                         "--limit", "20", "--json", "status,displayTitle") or "[]")
    return any(r["displayTitle"] == pr_title and r["status"] != "completed" for r in runs)


def call_doctor(issue, info, states, memory, dry):
    """Conflicting PR: let the Merge Doctor (Opus, in GitHub Actions) fix it.

    The workflow starts on the `labeled` event, so a retry has to remove and re-add the
    label. Retries start as soon as the previous run has finished without fixing the
    conflict; there is no fixed waiting time.
    """
    ident, num, cur = issue["identifier"], info["number"], issue["state"]["name"]
    key = "doctor:" + ident
    rec = memory.get(key) or {"n": 0, "at": 0}
    if cur != "In Review":
        set_state(issue, "In Review", states, dry, f"PR #{num} conflicts, Merge Doctor is on it")
    since = time.time() - rec["at"]
    if since < DOCTOR_START_MIN * 60:
        return  # label just added; the run is not listed yet
    if since < DOCTOR_MAX_MIN * 60 and doctor_running(info["title"]):
        return
    if rec["n"] >= MAX_DOCTOR:
        set_state(issue, "Backlog", states, dry,
                  f"PR #{num}: merge conflicts, Merge Doctor failed {rec['n']} times - needs a human")
        memory.pop(key, None)
        return
    log(f"{ident}: PR #{num} still conflicts, calling Merge Doctor (attempt {rec['n'] + 1})")
    memory[key] = {"n": rec["n"] + 1, "at": time.time()}
    if not dry:
        # gh issue edit, not gh pr edit: the latter fails on the Projects (classic) deprecation
        for op in ("--remove-label", "--add-label"):
            try:
                gh("issue", "edit", str(num), "--repo", REPO, op, "needs-expert-review")
            except RateLimited:
                raise
            except Exception:  # removing a label that is not there fails; harmless
                if op == "--add-label":
                    raise


def handle_open_pr(issue, info, states, memory, dry):
    """One decision, one Linear write, so tickets never flap between states."""
    ident, num, cur = issue["identifier"], info["number"], issue["state"]["name"]
    reason = None
    if info["verdict"] == "REJECTED":
        reason = "jury REJECTED"
    elif info["mergeable"] == "CONFLICTING":
        return call_doctor(issue, info, states, memory, dry)
    key = "rework:" + ident
    rec = memory.get(key)
    if not isinstance(rec, dict):
        rec = {"n": rec or 0, "head": None}
    if reason:
        # Reworks in a row that left the branch where it was: the worker made no
        # progress. One such round can be bad luck (Contrabass killed the run), so
        # allow MAX_STUCK before retrying would just loop.
        stuck = rec.get("stuck", 0) + 1 if rec["head"] == info["head"] else 0
        if stuck >= MAX_STUCK:
            set_state(issue, "Backlog", states, dry,
                      f"PR #{num}: {reason}, worker pushed nothing in {stuck} rework rounds - needs a human")
            memory.pop(key, None)
        elif rec["n"] >= MAX_REWORK:
            set_state(issue, "Backlog", states, dry,
                      f"PR #{num}: {reason} after {rec['n']} rework rounds - needs a human")
            memory.pop(key, None)
        else:
            set_state(issue, "Todo", states, dry, f"PR #{num}: {reason}; rework #{rec['n'] + 1}")
            memory[key] = {"n": rec["n"] + 1, "head": info["head"], "stuck": stuck}
    elif info["verdict"] == "APPROVED" and info["mergeable"] == "MERGEABLE" and AUTO_MERGE:
        log(f"{ident}: jury APPROVED, merging PR #{num}")
        if not dry:
            gh("pr", "merge", str(num), "--repo", REPO, "--squash", "--delete-branch")
            set_state(issue, "Done", states, dry, f"PR #{num} merged")
        memory.pop(key, None)
        memory.pop("doctor:" + ident, None)
    else:
        if cur != "In Review":
            set_state(issue, "In Review", states, dry, "PR open, awaiting jury/merge")
        if info["verdict"] is None:
            retrigger_jury(ident, info, memory, dry)


def demote_blocked(states, dry):
    """Todo / In Progress tickets with a blocker In Review (PR open, not merged) go to Backlog.

    Contrabass only holds a ticket while its blockers are Todo or In Progress; once a
    blocker is In Review (type "completed") it looks finished and the dependent starts
    on a master that lacks the blocker's code. Parking it here closes that gap;
    promote_unblocked moves it back to Todo when the blockers are merged (Done).
    """
    d = gql(
        """query($k:String!){issues(first:100,filter:{team:{key:{eq:$k}},
        state:{name:{in:["Todo","In Progress"]}}}){nodes{id identifier state{name}
        inverseRelations{nodes{type issue{identifier state{name}}}}}}}""",
        {"k": TEAM_KEY},
    )
    for issue in d["issues"]["nodes"]:
        blockers = [r["issue"] for r in issue["inverseRelations"]["nodes"]
                    if r["type"] == "blocks"]
        waiting = [b["identifier"] for b in blockers if b["state"]["name"] == "In Review"]
        if waiting:
            set_state(issue, "Backlog", states, dry,
                      f"waiting for {', '.join(waiting)} to be merged")


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
    global LOOKUP_FAILS
    LOOKUP_FAILS = 0
    team_id, states = get_states()
    ensure_in_review(team_id, states, dry)
    d = gql(
        """query($k:String!){issues(first:100,filter:{team:{key:{eq:$k}},
        state:{name:{in:["Done","In Review","In Progress","Todo"]}}}){nodes{id identifier
        state{name} updatedAt}}}""",
        {"k": TEAM_KEY},
    )
    memory = load_state()
    activity = cb_activity()
    for issue in d["issues"]["nodes"]:
        ident = issue["identifier"]
        branch = "symphony/" + ident.lower()
        cur = issue["state"]["name"]
        if cur == "In Progress":
            # Only tickets Contrabass has dropped: no run, no retry queued, for a while.
            idle = dt.datetime.now(dt.timezone.utc) - dt.datetime.fromisoformat(
                issue["updatedAt"].replace("Z", "+00:00"))
            if (activity is None or ident in activity
                    or idle < dt.timedelta(minutes=ORPHAN_MIN)):
                continue
            log(f"{ident}: In Progress but Contrabass has no run for it")
        elif cur == "Todo":
            # Only tickets this reconciler sent to Todo for a rework that Contrabass then
            # never started (it parks a run it could not verify and does not retry it).
            idle = dt.datetime.now(dt.timezone.utc) - dt.datetime.fromisoformat(
                issue["updatedAt"].replace("Z", "+00:00"))
            if ("rework:" + ident not in memory or activity is None or ident in activity
                    or idle < dt.timedelta(minutes=TODO_STALE_MIN)):
                continue
            log(f"{ident}: Todo for {int(idle.total_seconds() / 60)} min after a rework, Contrabass has no run for it")
        try:
            info = pr_info(branch)
        except RateLimited:
            raise  # every further lookup would fail too; main() backs off
        except Exception as e:  # keep going, retry next round
            log(f"{ident}: PR lookup failed: {e}")
            LOOKUP_FAILS += 1
            continue
        pr = info["status"]
        if pr == "merged":
            if cur != "Done":
                set_state(issue, "Done", states, dry, "PR merged")
        elif pr == "open":
            if cur == "Todo":
                if info["mergeable"] == "CONFLICTING":
                    call_doctor(issue, info, states, memory, dry)
                continue
            handle_open_pr(issue, info, states, memory, dry)
        elif cur in ("Done", "In Progress"):  # none / closed; Contrabass's own Done, or a dropped run
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
    demote_blocked(states, dry)
    promote_unblocked(states, dry)


def mark_round(ok, last_ok):
    """Health heartbeat: a round only counts when Linear and every GitHub lookup worked."""
    now = time.time()
    if ok:
        with open(HEALTH_FILE, "w") as f:
            f.write("ok")
        return now
    if now - last_ok > WATCHDOG_MIN * 60:
        log(f"WATCHDOG: no successful round for {int((now - last_ok) / 60)} min - "
            "tickets are NOT being reconciled (rejected PRs stay Done)")
    return last_ok


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--once", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--interval", type=int, default=60)
    a = ap.parse_args()
    if not KEY:
        sys.exit("LINEAR_API_KEY is not set")
    last_ok = time.time()
    while True:
        ok, wait = False, a.interval
        try:
            reconcile(a.dry_run)
            ok = LOOKUP_FAILS == 0
        except RateLimited as e:
            log(f"GitHub rate limit hit ({e}); sleeping {RATE_LIMIT_SLEEP}s")
            wait = RATE_LIMIT_SLEEP
        except Exception as e:
            log(f"sync error: {e}")
        last_ok = mark_round(ok, last_ok)
        if a.once:
            return
        time.sleep(wait)


if __name__ == "__main__":
    main()
