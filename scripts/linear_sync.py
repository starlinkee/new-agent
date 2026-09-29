#!/usr/bin/env python3
"""Reconcile Linear ticket states with GitHub (GitHub is the source of truth).

Why: Contrabass hardcodes "finished run" -> Linear "Done", and also marks
every running ticket "Done" when it shuts down. So tickets become Done while
their PR is unmerged, or while no PR exists at all (work lost on restart).

Rules, per ticket NEW-N with branch symphony/new-n, for the tickets of the Linear project
named in .contrabass/WORKFLOW.md (Done tickets only while updated in the last DONE_DAYS):
  PR merged                      -> Done
  PR open                        -> In Review, then look at the AI jury verdict for the PR's
                                    current head commit (the jury workflow also runs the tests):
    verdict REJECTED or merge conflicts -> the PR gets the `needs-expert-review` label, which
        starts the AI Merge Doctor (Opus rebases, fixes the jury's findings, tests, pushes,
        starts the jury on the new head). At most MAX_DOCTOR attempts, then Backlog.
    verdict APPROVED, PR mergeable, no doctor pending -> squash-merge exactly the reviewed
        commit, ticket Done (AUTO_MERGE=0 disables)
    no verdict for the current head -> wait; when none comes, start the jury again
        (workflow_dispatch), at most MAX_JURY times per head, then Backlog
    PR labeled `needs-human` (the doctor gave up) -> Backlog
  Todo ticket that already has an open PR -> same PR rules (it is not waiting for a worker)
  no PR, ticket Done / In Review > GRACE min -> Todo (redo), at most MAX_REDO times, then Backlog
  PR closed unmerged             -> Todo (redo), same cap

Blockers ("blocked by" relations): a ticket without an open PR may only be Todo / In
Progress while every blocker's PR is merged on GitHub (a canceled blocker no longer
blocks); otherwise it waits in Backlog, and it moves to Todo once they are merged.
Linear's Done is never trusted for this: Contrabass sets it before anything is merged.
A run that stopped at the worker's blocker precheck goes back to waiting, not to a redo.

Master health: master-tests.yml runs the suite after every merge. While its latest result
is red, auto-merge and the Merge Doctor pause and one "Fix failing tests on master" ticket
is queued; only that ticket's PR may merge until master is green again.

In Progress tickets are only touched when Contrabass has no run or retry for them for
ORPHAN_MIN (it parks "needs_review" runs and runs whose worker died, ticket still In
Progress); they then go through the same PR rules as above.

Every move to Backlog leaves a Linear comment saying why. Tickets parked for a human are
never promoted automatically; moving one back to Todo by hand gives it a fresh retry budget.

"In Review" is created on demand with type "completed": Contrabass maps the
Linear state type to its own state ("started" would be re-run as an orphan,
"unstarted" would be picked up again), so "completed" is the only safe type.

Usage: linear_sync.py [--once] [--dry-run] [--interval 60]
Env:   LINEAR_API_KEY (required), GH_REPO (default starlinkee/new-agent),
       LINEAR_PROJECT_URL (default: project_url in .contrabass/WORKFLOW.md)
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
REPO_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TEAM_KEY = os.environ.get("LINEAR_TEAM_KEY", "NEW")
MASTER = os.environ.get("BASE_BRANCH", "master")
GRACE_MIN = 10
MAX_REDO = 2
MAX_DOCTOR = 3  # Merge Doctor runs per conflicting PR before a human is asked
MAX_JURY = 3  # jury runs for one head that end without a verdict before a human is asked
DOCTOR_START_MIN = 3  # a doctor run should show up in Actions within this long after the label
DOCTOR_MAX_MIN = 70  # safety net: workflow timeout is 60 min
ORPHAN_MIN = 3  # In Progress with no Contrabass run for this long = abandoned
JURY_WAIT_MIN = 3  # a head commit older than this with no jury run/verdict gets the jury re-triggered
DONE_DAYS = 14  # Done tickets older than this are settled; not looked at again
NEEDS_DOCTOR = "needs-expert-review"  # label: a doctor run is pending or running
NEEDS_HUMAN = "needs-human"  # label: the doctor gave up on the PR
# The jury's verdict marker, see .github/scripts/verdict.py; keep the two in sync.
VERDICT_RE = re.compile(r"<!-- ai-jury verdict=(APPROVED|REJECTED) sha=([0-9a-f]{40}) -->")
CB_URL = os.environ.get("CB_URL", "http://localhost:8080")
AUTO_MERGE = os.environ.get("AUTO_MERGE", "1") != "0"
STATE_FILE = os.path.expanduser("~/.cb-linear-sync.json")
HEALTH_FILE = os.path.expanduser("~/.cb-linear-sync.health")  # mtime = last fully successful round
WATCHDOG_MIN = 10  # no successful round for this long = shout in the log and in `cb status`
LOOKUP_FAILS = 0  # lookups that failed in the current round
KEY = os.environ.get("LINEAR_API_KEY", "")


def log(msg):
    print(f"{time.strftime('%H:%M:%S')} {msg}", flush=True)


def project_slug():
    url = os.environ.get("LINEAR_PROJECT_URL")
    if not url:
        with open(os.path.join(REPO_DIR, ".contrabass", "WORKFLOW.md"), encoding="utf-8") as f:
            m = re.search(r"^project_url:\s*(\S+)", f.read(), re.M)
        if not m:
            sys.exit("no project_url in .contrabass/WORKFLOW.md")
        url = m.group(1)
    return url.rstrip("/").split("/")[-1].split("-")[-1]


PROJECT_SLUG = project_slug()


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


ISSUE_FIELDS = """id identifier title state{name} updatedAt
    inverseRelations{nodes{type issue{identifier state{name type}}}}"""


def issues(filt):
    """Every ticket of the project matching the Linear IssueFilter `filt`, all pages."""
    out, after = [], None
    while True:
        d = gql(
            f"""query($f:IssueFilter,$a:String){{issues(first:100,after:$a,filter:$f)
            {{nodes{{{ISSUE_FIELDS}}} pageInfo{{hasNextPage endCursor}}}}}}""",
            {"f": {"project": {"slugId": {"eq": PROJECT_SLUG}}, **filt}, "a": after},
        )["issues"]
        out += d["nodes"]
        if not d["pageInfo"]["hasNextPage"]:
            return out
        after = d["pageInfo"]["endCursor"]


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
ROUND = {}  # branch -> its PRs, cached for one round


def api(path):
    return json.loads(gh("api", path.format(repo=REPO)) or "null")


def branch_prs(branch):
    if branch not in ROUND:
        owner = REPO.split("/")[0]
        ROUND[branch] = api(f"repos/{{repo}}/pulls?state=all&head={owner}:{branch}&per_page=30")
    return ROUND[branch]


def is_merged(branch):
    if branch in MERGED:
        return True
    if any(p.get("merged_at") for p in branch_prs(branch)):
        MERGED.add(branch)
        return True
    return False


def unmerged_blockers(issue):
    """Identifiers of the ticket's blockers whose PR is not merged (canceled ones do not block)."""
    return [r["issue"]["identifier"] for r in issue["inverseRelations"]["nodes"]
            if r["type"] == "blocks" and r["issue"]["state"]["type"] != "canceled"
            and not is_merged("symphony/" + r["issue"]["identifier"].lower())]


def pr_info(branch):
    """Status of the PR for a branch, plus the jury verdict for its current head.

    Uses the REST API: `gh pr list --json` is GraphQL, and its 5000/hour quota ran
    dry (every ticket, every round), which froze the whole loop.
    """
    if is_merged(branch):
        return {"status": "merged"}
    prs = branch_prs(branch)
    opened = [p for p in prs if p["state"] == "open"]
    if not opened:
        return {"status": "closed" if prs else "none"}
    num = opened[0]["number"]
    pr = api(f"repos/{{repo}}/pulls/{num}")
    # GitHub computes mergeability lazily: null until something asks and the test merge
    # finishes. Ask again a few times; a still-unknown PR is simply looked at next round.
    for _ in range(3):
        if pr["mergeable"] is not None:
            break
        time.sleep(3)
        pr = api(f"repos/{{repo}}/pulls/{num}")
    head = pr["head"]["sha"]
    commits = api(f"repos/{{repo}}/pulls/{num}/commits?per_page=100")
    head_at = max((c["commit"]["committer"]["date"] for c in commits), default="")
    verdict = None
    for c in api(f"repos/{{repo}}/issues/{num}/comments?per_page=100"):
        m = VERDICT_RE.search(c["body"] or "")
        # Only the jury workflow counts, and only a verdict on exactly this head commit.
        if m and c["user"]["login"].startswith("github-actions") and m.group(2) == head:
            verdict = m.group(1)
    mergeable = {True: "MERGEABLE", False: "CONFLICTING"}.get(pr["mergeable"])
    if mergeable is None:  # GitHub still has not decided (can take hours): ask git itself
        mergeable = local_mergeable(pr["base"]["ref"], branch)
    return {"status": "open", "number": num, "mergeable": mergeable, "head": head,
            "head_at": head_at, "branch": branch, "base": pr["base"]["ref"], "verdict": verdict,
            "labels": {label["name"] for label in pr["labels"]}}


def local_mergeable(base, branch):
    """MERGEABLE / CONFLICTING by trial-merging in this clone; UNKNOWN if git cannot tell."""
    try:
        subprocess.run(["git", "fetch", "-q", "origin", base, branch], cwd=REPO_DIR,
                       capture_output=True, timeout=60, check=True)
        out = subprocess.run(["git", "merge-tree", "--write-tree", f"origin/{base}", f"origin/{branch}"],
                             cwd=REPO_DIR, capture_output=True, timeout=60)
    except Exception as e:
        log(f"{branch}: local merge check failed: {e}")
        return "UNKNOWN"
    return {0: "MERGEABLE", 1: "CONFLICTING"}.get(out.returncode, "UNKNOWN")


def set_state(issue, name, states, dry, why):
    log(f"{issue['identifier']}: {issue['state']['name']} -> {name} ({why})")
    if dry:
        return
    gql(
        """mutation($i:String!,$s:String!){issueUpdate(id:$i,input:{stateId:$s}){success}}""",
        {"i": issue["id"], "s": states[name]},
    )
    if name == "Backlog":  # say why a ticket stopped moving
        try:
            gql("""mutation($i:String!,$b:String!){commentCreate(input:{issueId:$i,body:$b}){success}}""",
                {"i": issue["id"], "b": f"Moved to Backlog by the reconciler: {why}."})
        except Exception as e:
            log(f"{issue['identifier']}: could not comment: {e}")


def forget(ident, memory):
    for k in (ident, "doctor:" + ident, "jury:" + ident):
        memory.pop(k, None)


def park(issue, states, memory, dry, why):
    """Backlog for a person. Never promoted automatically; see unpark."""
    set_state(issue, "Backlog", states, dry, f"{why} - needs a human. Move the ticket back to Todo "
              "when it can continue; it then starts with a fresh retry budget")
    parked = memory.setdefault("parked", [])
    if issue["identifier"] not in parked:
        parked.append(issue["identifier"])


def unpark(ident, memory):
    """A person moved a parked ticket back out of Backlog: reset its retry budgets."""
    memory["parked"].remove(ident)
    forget(ident, memory)
    log(f"{ident}: back from Backlog by hand, retry budgets reset")


def wait_for_blockers(issue, waiting, states, dry):
    set_state(issue, "Backlog", states, dry, f"waiting for {', '.join(waiting)} to be merged")


def workflow_running(workflow, title):
    """True while a run of `workflow` with this run-name is queued or in progress."""
    runs = json.loads(gh("run", "list", "--repo", REPO, "--workflow", workflow,
                         "--limit", "30", "--json", "status,displayTitle") or "[]")
    return any(r["displayTitle"] == title and r["status"] != "completed" for r in runs)


def retrigger_jury(issue, info, states, memory, dry):
    """Open, mergeable PR whose current head has no verdict: start the jury again.

    Covers a jury run that failed, was cancelled, or never started. workflow_dispatch runs
    the workflow and scripts from master. After MAX_JURY runs without a verdict for the
    same head, a person looks at the workflow logs.
    """
    ident, num, head = issue["identifier"], info["number"], info["head"]
    key = "jury:" + ident
    rec = memory.get(key)
    if not (isinstance(rec, dict) and rec.get("head") == head):
        rec = {"head": head, "n": 0, "at": 0}
    if info["mergeable"] != "MERGEABLE":
        return
    if info["head_at"]:
        age = dt.datetime.now(dt.timezone.utc) - dt.datetime.fromisoformat(
            info["head_at"].replace("Z", "+00:00"))
        if age < dt.timedelta(minutes=JURY_WAIT_MIN):
            return
    if time.time() - rec["at"] < JURY_WAIT_MIN * 60:
        return  # just dispatched; the run may not be listed yet
    if workflow_running("ai-jury.yml", f"AI Jury PR #{num}"):
        return
    if rec["n"] >= MAX_JURY:
        park(issue, states, memory, dry,
             f"PR #{num}: the AI jury gave no verdict for head {head[:7]} in {rec['n']} runs (see the ai-jury logs)")
        return
    log(f"{ident}: no jury verdict for head {head[:7]}, starting the jury on PR #{num} (run {rec['n'] + 1})")
    memory[key] = {"head": head, "n": rec["n"] + 1, "at": time.time()}
    if not dry:
        gh("workflow", "run", "ai-jury.yml", "--repo", REPO, "--ref", info["base"], "-f", f"pr={num}")


def call_doctor(issue, info, states, memory, dry):
    """Conflicting or jury-rejected PR: let the Merge Doctor (Opus, in GitHub Actions) fix it.

    The workflow starts on the `labeled` event and removes the label when it ends, so a
    retry adds it again. Retries start as soon as the previous run has finished without
    fixing the PR; there is no fixed waiting time.
    """
    ident, num, cur = issue["identifier"], info["number"], issue["state"]["name"]
    key = "doctor:" + ident
    rec = memory.get(key) or {"n": 0, "at": 0}
    if cur != "In Review":
        set_state(issue, "In Review", states, dry, f"PR #{num} conflicts or was rejected, Merge Doctor is on it")
    since = time.time() - rec["at"]
    if since < DOCTOR_START_MIN * 60:
        return  # label just added; the run is not listed yet
    if since < DOCTOR_MAX_MIN * 60 and workflow_running("merge-doctor.yml", f"Merge Doctor PR #{num}"):
        return
    if rec["n"] >= MAX_DOCTOR:
        park(issue, states, memory, dry, f"PR #{num}: conflicts/jury rejection, Merge Doctor failed {rec['n']} times")
        return
    log(f"{ident}: PR #{num} needs the Merge Doctor (attempt {rec['n'] + 1})")
    memory[key] = {"n": rec["n"] + 1, "at": time.time()}
    if not dry:
        # gh issue edit, not gh pr edit: the latter fails on the Projects (classic) deprecation
        for op in ("--remove-label", "--add-label"):
            try:
                gh("issue", "edit", str(num), "--repo", REPO, op, NEEDS_DOCTOR)
            except RateLimited:
                raise
            except Exception:  # removing a label that is not there fails; harmless
                if op == "--add-label":
                    raise


def handle_open_pr(issue, info, states, memory, dry, fix):
    """One decision, one Linear write, so tickets never flap between states.

    `fix` is the ticket allowed to merge while master's tests fail (None: master is green).
    """
    ident, num, cur = issue["identifier"], info["number"], issue["state"]["name"]
    if NEEDS_HUMAN in info["labels"]:
        park(issue, states, memory, dry, f"PR #{num} is labeled {NEEDS_HUMAN} (the Merge Doctor gave up; "
             f"see its last comment). Fix the PR or merge it by hand, and remove the label")
        return
    held = fix is not None and ident != fix  # master is red: nothing else merges or gets doctored
    if (info["verdict"] == "REJECTED" or info["mergeable"] == "CONFLICTING") and not held:
        # Opus fixes the jury's findings and rebases on the same branch; no detour via Todo.
        return call_doctor(issue, info, states, memory, dry)
    if (info["verdict"] == "APPROVED" and info["mergeable"] == "MERGEABLE" and AUTO_MERGE
            and not held and NEEDS_DOCTOR not in info["labels"]):
        log(f"{ident}: jury APPROVED {info['head'][:7]}, merging PR #{num}")
        if not dry:
            # Exactly the reviewed commit: anything pushed after the verdict makes this fail.
            gh("pr", "merge", str(num), "--repo", REPO, "--squash", "--delete-branch",
               "--match-head-commit", info["head"])
        set_state(issue, "Done", states, dry, f"PR #{num} merged")
        forget(ident, memory)
        return
    if cur != "In Review":
        set_state(issue, "In Review", states, dry,
                  "PR open, merges paused while master's tests fail" if held else "PR open, awaiting jury/merge")
    if info["verdict"] is None:
        retrigger_jury(issue, info, states, memory, dry)


def master_health(team_id, states, memory, dry):
    """The ticket allowed to merge while master's tests fail, or None while master is green.

    Two PRs that each passed against their own master can still break it together, and
    merging more on top would bury the cause. So on red: pause, and queue one fix ticket.
    """
    try:
        runs = json.loads(gh("run", "list", "--repo", REPO, "--workflow", "master-tests.yml",
                             "--branch", MASTER, "--limit", "10",
                             "--json", "headSha,status,conclusion,url") or "[]")
    except RateLimited:
        raise
    except Exception as e:
        log(f"master test status unknown ({e}); treating master as green")
        return None
    last = next((r for r in runs if r["status"] == "completed"
                 and r["conclusion"] in ("success", "failure")), None)
    rec = memory.get("master_red")
    if not last or last["conclusion"] == "success":
        if rec:
            log("master tests are green again; auto-merge resumes")
            memory.pop("master_red")
        return None
    if rec:
        return rec["ident"]
    sha = last["headSha"][:7]
    title = f"Fix failing tests on master ({sha})"
    log(f"master tests FAIL at {sha}: pausing auto-merge, queueing '{title}'")
    if dry:
        return "dry-run"
    found = issues({"title": {"eq": title}})
    if found:
        ident = found[0]["identifier"]
    else:
        pid = gql("""query($s:String!){projects(filter:{slugId:{eq:$s}}){nodes{id}}}""",
                  {"s": PROJECT_SLUG})["projects"]["nodes"][0]["id"]
        desc = (
            f"**Goal.** `npm run test:ai` fails on `{MASTER}` at `{sha}` ({last['url']}). Make it pass again.\n\n"
            "**Scope**\n\n* Find the cause, most likely two recently merged PRs that each passed alone but "
            f"break together (`git log origin/{MASTER}`). Fix the code; never delete, skip or weaken tests.\n\n"
            f"**Acceptance:** `npm run test:ai` passes on this branch merged with `{MASTER}`.\n\n---\n\n"
            "Created by the reconciler. Every other PR's auto-merge is paused until this one is merged "
            "and the master tests are green again."
        )
        ident = gql(
            """mutation($i:IssueCreateInput!){issueCreate(input:$i){issue{identifier}}}""",
            {"i": {"teamId": team_id, "projectId": pid, "stateId": states["Todo"], "priority": 1,
                   "title": title, "description": desc}},
        )["issueCreate"]["issue"]["identifier"]
    memory["master_red"] = {"ident": ident, "sha": last["headSha"]}
    return ident


def reconcile_issue(issue, states, memory, dry, activity, open_branches, fix):
    ident, cur = issue["identifier"], issue["state"]["name"]
    branch = "symphony/" + ident.lower()
    if cur in ("Todo", "In Progress") and ident in memory.get("parked", []):
        unpark(ident, memory)
    if cur in ("Todo", "In Progress") and branch not in open_branches:
        waiting = unmerged_blockers(issue)
        if waiting:
            return wait_for_blockers(issue, waiting, states, dry)
        if cur == "Todo":
            return  # ready, waiting for a worker
    if cur == "In Progress":
        # Only tickets Contrabass has dropped: no run, no retry queued, for a while.
        idle = dt.datetime.now(dt.timezone.utc) - dt.datetime.fromisoformat(
            issue["updatedAt"].replace("Z", "+00:00"))
        if activity is None or ident in activity or idle < dt.timedelta(minutes=ORPHAN_MIN):
            return
        log(f"{ident}: In Progress but Contrabass has no run for it")
    info = pr_info(branch)
    pr = info["status"]
    if pr == "merged":
        if cur != "Done":
            set_state(issue, "Done", states, dry, "PR merged")
        forget(ident, memory)
    elif pr == "open":
        handle_open_pr(issue, info, states, memory, dry, fix)
    elif cur != "Todo":  # none / closed: Contrabass's own Done, a dropped run, or a closed PR
        age = dt.datetime.now(dt.timezone.utc) - dt.datetime.fromisoformat(
            issue["updatedAt"].replace("Z", "+00:00"))
        if pr == "none" and age < dt.timedelta(minutes=GRACE_MIN):
            return
        waiting = unmerged_blockers(issue)
        if waiting:  # the worker stopped at its blocker precheck; that is not a failed attempt
            return wait_for_blockers(issue, waiting, states, dry)
        n = memory.get(ident, 0)
        if n >= MAX_REDO:
            park(issue, states, memory, dry, f"no merged/open PR after {n} redos")
        else:
            set_state(issue, "Todo", states, dry, f"no PR ({pr}); redo #{n + 1}")
            memory[ident] = n + 1


def promote_unblocked(states, memory, dry):
    """Backlog tickets whose blockers are all merged become Todo (parked ones stay)."""
    global LOOKUP_FAILS
    for issue in issues({"state": {"name": {"eq": "Backlog"}}}):
        ident = issue["identifier"]
        if ident in memory.get("parked", []):
            continue
        blockers = [r for r in issue["inverseRelations"]["nodes"] if r["type"] == "blocks"]
        if not blockers:
            continue  # an idea nobody queued yet
        try:
            waiting = unmerged_blockers(issue)
        except RateLimited:
            raise
        except Exception as e:
            log(f"{ident}: blocker lookup failed: {e}")
            LOOKUP_FAILS += 1
            continue
        if not waiting:
            names = ", ".join(r["issue"]["identifier"] for r in blockers)
            set_state(issue, "Todo", states, dry, f"unblocked ({names} merged)")


def reconcile(dry):
    global LOOKUP_FAILS
    LOOKUP_FAILS = 0
    ROUND.clear()
    team_id, states = get_states()
    ensure_in_review(team_id, states, dry)
    memory = load_state()
    try:
        activity = cb_activity()
        open_branches = {p["head"]["ref"] for p in api("repos/{repo}/pulls?state=open&per_page=100")}
        fix = master_health(team_id, states, memory, dry)
        since = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=DONE_DAYS)).isoformat()
        tickets = (issues({"state": {"name": {"in": ["Todo", "In Progress", "In Review"]}}})
                   + issues({"state": {"name": {"eq": "Done"}}, "updatedAt": {"gt": since}}))
        for issue in tickets:
            try:
                reconcile_issue(issue, states, memory, dry, activity, open_branches, fix)
            except RateLimited:
                raise  # every further lookup would fail too; main() backs off
            except Exception as e:  # keep going, retry next round
                log(f"{issue['identifier']}: {e}")
                LOOKUP_FAILS += 1
        promote_unblocked(states, memory, dry)
    finally:
        if not dry:
            save_state(memory)


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
