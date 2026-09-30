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
        commit, ticket Done (AUTO_MERGE=0 disables). Then follow-ups: the jury's non-blocking
        remarks become one Backlog ticket, and every spec reported under "## Flaky tests" (PR
        description, Merge Doctor notes) a Todo ticket, or a comment on the one already open.
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
A park comment carries what the person needs to start: the PR, the last jury and Merge
Doctor runs, the attempt history, and for a ticket without a PR the worker's Contrabass events.

"In Review" is created on demand with type "completed": Contrabass maps the
Linear state type to its own state ("started" would be re-run as an orphan,
"unstarted" would be picked up again), so "completed" is the only safe type.

Rounds are event-driven: between them the loop probes GitHub (conditional GETs, free on 304)
and Linear (one tiny query) and starts the next round as soon as a PR, the master tests or a
ticket changed. The heartbeat (--interval while something is in flight, --idle-interval
otherwise) only covers what is time-based: grace periods, waiting for a jury run to show up.

Usage: linear_sync.py [--once] [--dry-run] [--interval 60] [--idle-interval 300]
Env:   LINEAR_API_KEY (required), GH_REPO (default starlinkee/new-agent),
       LINEAR_PROJECT_URL (default: project_url in .contrabass/WORKFLOW.md)
"""
import argparse
import datetime as dt
import glob
import json
import os
import re
import signal
import subprocess
import sys
import time
import http.client
import urllib.parse
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
DOCTOR_HEADER = "**AI Merge Doctor (Opus)**"  # first line of every doctor comment (run_merge_doctor.py)
JURY_NO_VERDICT = "**AI jury: no verdict**"  # first words of the jury's no-verdict comment (run_jury.py)
# A doctor or jury run that found the Claude quota used up says when it is back, see claude_cli.limit_marker.
LIMIT_RE = re.compile(r"<!-- ai-usage-limit until=(\d+) -->")
# Lines of a "## Flaky tests" section, as WORKFLOW.md and the doctor prompt ask for them:
#   - tests/<file>.spec.js: "<test title>": <what happened>
FLAKY_RE = re.compile(r"^\s*[-*]\s*`?(tests/[\w./-]+\.spec\.js)`?\s*:?\s*(.*)$", re.M)
# Contrabass's per-run logs (in the repo it runs from) and the event lines worth showing a person.
CB_LOGS = os.path.join(REPO_DIR, "contrabass-*.log")
CB_NOISE = ("agent_event=session.status", "agent_event=item/", "agent_event=turn/started",
            "event=dispatch_skipped")
CB_URL = os.environ.get("CB_URL", "http://localhost:8080")
AUTO_MERGE = os.environ.get("AUTO_MERGE", "1") != "0"
STATE_FILE = os.path.expanduser("~/.cb-linear-sync.json")
HEALTH_FILE = os.path.expanduser("~/.cb-linear-sync.health")  # mtime = last fully successful round
WATCHDOG_MIN = 10  # no successful round for this long = shout in the log and in `cb status`
# Between rounds the loop does not just sleep: it watches for changes (see wait_for_change), so a
# jury verdict, a merge or a person moving a ticket is handled within seconds, not on the next tick.
PROBE_GH_SEC = 15  # conditional GitHub GETs: a 304 is free, so this can be frequent
PROBE_LINEAR_SEC = 30  # one tiny Linear query; Linear's request quota is the scarce one
PROBE_TICK = 5
IDLE_INTERVAL = 300  # heartbeat while nothing is in flight (nothing time-based can be due)
# GitHub resources whose change starts a round: any PR event (opened, pushed, labeled, commented -
# the jury verdict is a comment -, merged, closed) and the master test result.
WATCHED = {
    "pull requests": "repos/{repo}/pulls?state=open&per_page=100",
    "master tests": f"repos/{{repo}}/actions/workflows/master-tests.yml/runs?branch={MASTER}&per_page=10",
}
LINEAR_STAMP = None  # newest ticket update seen at the start of the last round
ORPHAN_EVERY = 120  # seconds between orphan sweeps (see reap_orphans)
ORPHAN_CHECKED = 0.0
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


# WSL's network sometimes loses the first SYNs of a connection; Linux then retransmits at 1, 2, 4, 8
# and 16 s, so one unlucky connect stalls for ~31 s (a `gh` call there took 30-60 s, and every
# ticket paid it). So: reuse connections, and give up on a connect attempt after a few seconds -
# a fresh socket usually connects at once.
CONNECT_TIMEOUT = 4
CONNECT_ATTEMPTS = 5
READ_TIMEOUT = 40
CONNS = {}  # host -> an idle keep-alive connection (the loop is single-threaded)


def connect(host):
    err = None
    for _ in range(CONNECT_ATTEMPTS):
        conn = http.client.HTTPSConnection(host, timeout=CONNECT_TIMEOUT)
        try:
            conn.connect()
        except OSError as e:
            err = e
            conn.close()
            continue
        conn.sock.settimeout(READ_TIMEOUT)
        return conn
    raise OSError(f"cannot connect to {host}: {err}")


def http_request(method, url, headers, body=None, reuse=True):
    """(status, response headers, body bytes). Never raises for an HTTP error status.

    A reused connection the server has closed meanwhile is replaced and the request repeated
    once (it failed before the server saw it). With reuse=False the request always gets a
    fresh connection and is never repeated: for merges and dispatches, which must not run twice.
    """
    u = urllib.parse.urlsplit(url)
    target = u.path + ("?" + u.query if u.query else "")
    for attempt in (0, 1):
        conn = CONNS.pop(u.netloc, None) if reuse else None
        fresh = conn is None
        if fresh:
            conn = connect(u.netloc)
        try:
            conn.request(method, target, body=body, headers=headers)
            r = conn.getresponse()
            data = r.read()
        except (OSError, http.client.HTTPException):
            conn.close()
            if fresh or not reuse or attempt == 1:
                raise
            continue
        if reuse and not r.will_close:
            CONNS[u.netloc] = conn
        else:
            conn.close()
        return r.status, r.headers, data


def gql(query, variables=None):
    status, _, raw = http_request(
        "POST", "https://api.linear.app/graphql",
        {"Authorization": KEY, "Content-Type": "application/json"},
        json.dumps({"query": query, "variables": variables or {}}).encode())
    if status >= 400:
        body = raw.decode(errors="replace")
        # Linear reports its hourly request limit as a 400 with code RATELIMITED.
        if "RATELIMITED" in body:
            raise RateLimited("Linear: " + body[:200])
        raise RuntimeError(f"Linear HTTP {status}: {body[:300]}")
    data = json.loads(raw)
    if data.get("errors"):
        raise RuntimeError(data["errors"][0]["message"])
    return data["data"]


HUMAN_LABEL = {}  # team id -> id of its `needs-human` Linear label
ISSUE_FIELDS = """id identifier title state{name} updatedAt team{id} project{id} labels{nodes{name}}
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


def reap_orphans(dry):
    """Kill omc workers whose worktree Contrabass already deleted.

    Contrabass removes the workspace when a run ends but leaves the `omc team` tmux session
    and its claude worker alive; they idle in a deleted directory and hold a session open.
    """
    global ORPHAN_CHECKED
    if time.time() - ORPHAN_CHECKED < ORPHAN_EVERY or not os.path.isdir("/proc"):
        return
    ORPHAN_CHECKED = time.time()
    root = os.path.join(REPO_DIR, "workspaces")
    try:
        out = subprocess.run(["tmux", "ls", "-F", "#{session_name}"], capture_output=True, text=True, timeout=10)
        for name in out.stdout.split():
            # omc-team-<first 30 chars of the ticket uuid>-<suffix>; the workspace dir is the full uuid
            m = re.match(r"omc-team-([0-9a-f-]{30})-", name)
            if m and not glob.glob(os.path.join(root, m.group(1) + "*")):
                log(f"orphan tmux session {name}: workspace is gone" + (" (dry run)" if dry else ", killing"))
                if not dry:
                    subprocess.run(["tmux", "kill-session", "-t", name], capture_output=True, timeout=10)
        for pid in filter(str.isdigit, os.listdir("/proc")):
            try:
                cwd = os.readlink(f"/proc/{pid}/cwd")
            except OSError:
                continue
            if not (cwd.startswith(root + os.sep) and cwd.endswith(" (deleted)")) or int(pid) == os.getpid():
                continue
            ticket = cwd[len(root) + 1:].split(os.sep)[0].removesuffix(" (deleted)")
            # a recreated workspace leaves stale "(deleted)" cwds behind; only a dir that is gone means orphan
            if not os.path.isdir(os.path.join(root, ticket)):
                log(f"orphan process {pid} runs in deleted {cwd[:-10]}" + (" (dry run)" if dry else ", killing"))
                if not dry:
                    os.kill(int(pid), signal.SIGTERM)
    except Exception as e:  # housekeeping only; never fail a round over it
        log(f"orphan cleanup failed: {e}")


MERGED = set()  # a merged branch never changes again; do not ask GitHub twice
ROUND = {}  # branch -> its PRs, cached for one round
ETAGS = {}  # url -> (etag, parsed body), kept across rounds
GH_TOKEN = None


def gh_token():
    global GH_TOKEN
    if GH_TOKEN is None:
        try:
            GH_TOKEN = subprocess.run(["gh", "auth", "token"], capture_output=True, text=True,
                                      timeout=30).stdout.strip()
        except Exception:
            GH_TOKEN = ""
    return GH_TOKEN


def api_url(path):
    return "https://api.github.com/" + path.format(repo=REPO)


def api(path):
    """GET a GitHub REST path as JSON, cached by ETag across rounds.

    An unchanged resource answers 304, which GitHub does not count against the rate limit,
    and it needs no `gh` process. That makes asking again every round (and polling for
    changes, see api_moved) practically free. Without a token it falls back to `gh api`.
    """
    token = gh_token()
    if not token:
        return json.loads(gh("api", path.format(repo=REPO)) or "null")
    url = api_url(path)
    etag, body = ETAGS.get(url, (None, None))
    headers = {"Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json",
               "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "linear-sync"}
    if etag:
        headers["If-None-Match"] = etag
    for attempt in range(3):
        try:
            status, resp, raw = http_request("GET", url, headers)
        except (OSError, http.client.HTTPException) as e:
            if attempt == 2:
                raise RuntimeError(f"GitHub request failed for {url}: {e}") from None
            time.sleep(1)
            continue
        if status == 304 and etag:
            return body
        if status < 300:
            data = json.loads(raw)
            ETAGS[url] = (resp.get("ETag"), data)
            return data
        text = raw.decode(errors="replace")
        if status in (403, 429) and "rate limit" in text.lower():
            raise RateLimited(f"GitHub: {text[:200]}")
        if status < 500 or attempt == 2:
            raise RuntimeError(f"GitHub HTTP {status} for {url}: {text[:200]}")
        time.sleep(3)


def api_send(method, path, body=None):
    """POST/PUT/DELETE to the GitHub REST API. Not retried: a merge or a dispatch must not run twice.

    `gh` from WSL sometimes stalls for 30-60 s on a trivial call, and these are the calls the
    pipeline waits on (merge, label the doctor, start the jury), so they go direct as well.
    """
    url = api_url(path)
    try:
        status, _, raw = http_request(
            method, url,
            {"Authorization": f"Bearer {gh_token()}", "Accept": "application/vnd.github+json",
             "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json",
             "User-Agent": "linear-sync"},
            None if body is None else json.dumps(body).encode(), reuse=False)
    except (OSError, http.client.HTTPException) as e:
        raise RuntimeError(f"GitHub request failed for {method} {url}: {e}") from None
    if status >= 400:
        text = raw.decode(errors="replace")
        if status in (403, 429) and "rate limit" in text.lower():
            raise RateLimited(f"GitHub: {text[:200]}")
        raise RuntimeError(f"GitHub HTTP {status} for {method} {url}: {text[:200]}")
    return json.loads(raw) if raw else None


def merge_pr(num, head, branch):
    """Squash-merge exactly the reviewed commit (anything pushed after the verdict makes it fail)."""
    if not gh_token():
        return gh("pr", "merge", str(num), "--repo", REPO, "--squash", "--delete-branch",
                  "--match-head-commit", head)
    api_send("PUT", f"repos/{{repo}}/pulls/{num}/merge", {"merge_method": "squash", "sha": head})
    try:
        api_send("DELETE", f"repos/{{repo}}/git/refs/heads/{branch}")
    except RuntimeError as e:  # the merge stands; a leftover branch is harmless
        log(f"{branch}: merged, but could not delete the branch: {e}")


def add_label(num, label):
    if not gh_token():
        return gh("issue", "edit", str(num), "--repo", REPO, "--add-label", label)
    api_send("POST", f"repos/{{repo}}/issues/{num}/labels", {"labels": [label]})


def remove_label(num, label):
    """Raises when the label is not on the issue; callers that do not care catch it."""
    if not gh_token():
        return gh("issue", "edit", str(num), "--repo", REPO, "--remove-label", label)
    api_send("DELETE", f"repos/{{repo}}/issues/{num}/labels/{urllib.parse.quote(label)}")


def dispatch_jury(ref, num):
    """workflow_dispatch runs the workflow and its scripts from `ref` (the base branch)."""
    if not gh_token():
        return gh("workflow", "run", "ai-jury.yml", "--repo", REPO, "--ref", ref, "-f", f"pr={num}")
    api_send("POST", "repos/{repo}/actions/workflows/ai-jury.yml/dispatches",
             {"ref": ref, "inputs": {"pr": str(num)}})


def api_moved(path):
    """True when the resource changed since api() last fetched it. Costs a 304 when it did not."""
    url = api_url(path)
    before = ETAGS.get(url, (None, None))[0]
    api(path)
    return ETAGS.get(url, (None, None))[0] != before


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
    verdict, verdict_body, doctor_notes = None, "", []
    doctor_limit = jury_limit = 0  # the quota is back at this time; 0: the last run was not stopped by it
    for c in api(f"repos/{{repo}}/issues/{num}/comments?per_page=100"):
        body = c["body"] or ""
        if not c["user"]["login"].startswith("github-actions"):
            continue
        m = VERDICT_RE.search(body)
        # Only the jury workflow counts, and only a verdict on exactly this head commit.
        if m and m.group(2) == head:
            verdict, verdict_body = m.group(1), body
        elif body.startswith(DOCTOR_HEADER):
            doctor_notes.append(body)
            lm = LIMIT_RE.search(body)
            doctor_limit = int(lm.group(1)) if lm else 0
        elif body.startswith(JURY_NO_VERDICT) and f"`{head[:7]}`" in body:
            lm = LIMIT_RE.search(body)
            jury_limit = int(lm.group(1)) if lm else 0
    mergeable = {True: "MERGEABLE", False: "CONFLICTING"}.get(pr["mergeable"])
    if mergeable is None:  # GitHub still has not decided (can take hours): ask git itself
        mergeable = local_mergeable(pr["base"]["ref"], branch)
    return {"status": "open", "number": num, "mergeable": mergeable, "head": head,
            "head_at": head_at, "branch": branch, "base": pr["base"]["ref"], "verdict": verdict,
            "verdict_body": verdict_body, "body": pr["body"] or "", "doctor_notes": doctor_notes,
            "doctor_limit": doctor_limit, "jury_limit": jury_limit,
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


def set_state(issue, name, states, dry, why, details=""):
    log(f"{issue['identifier']}: {issue['state']['name']} -> {name} ({why})")
    if dry:
        if details:
            log(f"{issue['identifier']}: comment details:\n{details}")
        return
    gql(
        """mutation($i:String!,$s:String!){issueUpdate(id:$i,input:{stateId:$s}){success}}""",
        {"i": issue["id"], "s": states[name]},
    )
    if name == "Backlog":  # say why a ticket stopped moving
        try:
            linear_comment(issue["id"], f"Moved to Backlog by the reconciler: {why}."
                           + (f"\n\n{details}" if details else ""))
        except Exception as e:
            log(f"{issue['identifier']}: could not comment: {e}")


def linear_comment(issue_id, body):
    gql("""mutation($i:String!,$b:String!){commentCreate(input:{issueId:$i,body:$b}){success}}""",
        {"i": issue_id, "b": body})


def forget(ident, memory):
    for k in (ident, "doctor:" + ident, "jury:" + ident):
        memory.pop(k, None)


def recent_runs(workflow, title, n=3):
    """The newest runs of `workflow` with this run-name (html_url, status, conclusion, created_at)."""
    return [r for r in workflow_runs(workflow, 50) if r["display_title"] == title][:n]


def workflow_runs(workflow, n):
    return api(f"repos/{{repo}}/actions/workflows/{workflow}/runs?per_page={n}")["workflow_runs"]


def cb_events(issue_id, n=25):
    """The ticket's last Contrabass events (dispatches, finishes, errors), oldest first.

    Contrabass logs no agent output, only events keyed by the Linear issue id, and it deletes
    the workspace after a run, so these lines are all that is left of a run without a PR.
    """
    lines = []
    for path in sorted(glob.glob(CB_LOGS), key=os.path.getmtime):
        try:
            with open(path, encoding="utf-8", errors="replace") as f:
                lines += [l.rstrip().replace(f"issue_id={issue_id} ", "") for l in f
                          if issue_id in l and not any(x in l for x in CB_NOISE)]
        except OSError:
            continue
    return "\n".join(lines[-n:])


def park_details(issue, info, memory):
    """What a person needs to pick a parked ticket up: links, attempt history, worker events."""
    ident = issue["identifier"]
    prs = branch_prs("symphony/" + ident.lower())  # newest first
    out = []
    if prs:
        out.append("**Pull requests:** " + ", ".join(
            f"[#{p['number']}]({p['html_url']}) ({'merged' if p.get('merged_at') else p['state']})"
            for p in prs))
        num = prs[0]["number"]
        for name, workflow, title in (("AI jury", "ai-jury.yml", f"AI Jury PR #{num}"),
                                      ("Merge Doctor", "merge-doctor.yml", f"Merge Doctor PR #{num}")):
            runs = recent_runs(workflow, title)
            out.append(f"**Last {name} runs on #{num}:** " + (", ".join(
                f"[{r['conclusion'] or r['status']} {r['created_at'][:16].replace('T', ' ')}]({r['html_url']})"
                for r in runs) or "none"))
    history = []
    if info.get("head"):
        history.append(f"current head `{info['head'][:7]}`, jury verdict on it: {info['verdict'] or 'none'}")
    doctor, jury = memory.get("doctor:" + ident), memory.get("jury:" + ident)
    if doctor:
        history.append(f"Merge Doctor runs started: {doctor['n']}")
    if isinstance(jury, dict):
        history.append(f"jury re-runs without a verdict on `{jury['head'][:7]}`: {jury['n']}")
    if memory.get(ident):
        history.append(f"redos (new worker runs): {memory[ident]}")
    if history:
        out.append("**Attempts:** " + "; ".join(history) + ".")
    if info.get("status") != "open":
        events = cb_events(issue["id"])
        out.append("**Worker runs (Contrabass events, oldest first):**\n\n```text\n" + events + "\n```"
                   if events else "No Contrabass events for this ticket on the machine running the reconciler.")
    if any(p["state"] == "open" for p in prs):
        out.append("**What to do next**\n\n"
                   "- **Fixed it** (the PR, the ticket or master) → move the ticket to Todo. The jury and "
                   "the Merge Doctor retry the same PR with a fresh budget.\n"
                   "- **Start over** → close the PR, then move the ticket to Todo. A new worker "
                   "implements the ticket from scratch.")
    else:
        out.append("**What to do next:** improve the ticket if it was the problem, then move it to Todo. "
                   "A new worker implements it from scratch with a fresh budget.")
    out.append(f"Moving the ticket to Todo is the decision: the reconciler then removes the `{NEEDS_HUMAN}` "
               "label (here and on the PR) and resets the retry budgets. Removing only the label "
               "makes it an ordinary Backlog ticket again.")
    return "\n\n".join(out)


def park(issue, states, memory, dry, why, info):
    """Backlog for a person, with everything they need. Never promoted automatically; see unpark."""
    try:
        details = park_details(issue, info, memory)
    except RateLimited:
        raise
    except Exception as e:  # park anyway: a thin comment beats a ticket that keeps retrying
        log(f"{issue['identifier']}: could not collect park details: {e}")
        details = ""
    set_state(issue, "Backlog", states, dry, f"{why} - needs a human", details)
    parked = memory.setdefault("parked", [])
    if issue["identifier"] not in parked:
        parked.append(issue["identifier"])
    if not dry:
        try:
            gql("""mutation($i:String!,$l:String!){issueAddLabel(id:$i,labelId:$l){success}}""",
                {"i": issue["id"], "l": human_label(issue["team"]["id"])})
        except Exception as e:  # the local list still keeps it parked on this machine
            log(f"{issue['identifier']}: could not add the {NEEDS_HUMAN} label: {e}")


def section(text, name):
    """The body of the markdown section `## <name>` (or `# <name>`), "" if there is none."""
    m = re.search(rf"^#{{1,2}}\s+{re.escape(name)}\s*$(.*?)(?=^#{{1,2}}\s|\Z)", text or "", re.M | re.S | re.I)
    return m.group(1).strip() if m else ""


def flaky_reports(texts):
    """{spec file: [what was seen, ...]} from the `## Flaky tests` sections of these texts."""
    out = {}
    for text in texts:
        for spec, what in FLAKY_RE.findall(section(text, "Flaky tests")):
            out.setdefault(spec, []).append(what.strip() or "(no details)")
    return out


def create_ticket(source, states, dry, title, desc, todo=False, priority=0):
    """A ticket in the source ticket's team and project, related to it.

    Created in Backlog and moved to Todo only after the relation exists, so a worker never
    picks up a half-made ticket.
    """
    log(f"{source['identifier']}: creating '{title}' in {'Todo' if todo else 'Backlog'}")
    if dry:
        return
    new = gql(
        """mutation($i:IssueCreateInput!){issueCreate(input:$i){issue{id identifier}}}""",
        {"i": {"teamId": source["team"]["id"], "projectId": source["project"]["id"],
               "stateId": states["Backlog"], "priority": priority, "title": title, "description": desc}},
    )["issueCreate"]["issue"]
    gql("""mutation($a:String!,$b:String!){issueRelationCreate(input:{issueId:$a,relatedIssueId:$b,type:related}){success}}""",
        {"a": new["id"], "b": source["id"]})
    if todo:
        gql("""mutation($i:String!,$s:String!){issueUpdate(id:$i,input:{stateId:$s}){success}}""",
            {"i": new["id"], "s": states["Todo"]})
    log(f"{source['identifier']}: created {new['identifier']}")


def file_followups(issue, info, states, dry):
    """After a merge, keep what the pipeline noticed but did not act on.

    The jury's non-blocking remarks become one Backlog ticket (a person decides whether it
    runs). Every spec reported flaky becomes a Todo ticket, or a comment on the one still open.
    """
    ident, num = issue["identifier"], info["number"]
    link = f"https://github.com/{REPO}/pull/{num}"
    remarks = re.sub(r"_Reviewed head `[0-9a-f]+`\._", "", section(info["verdict_body"], "Non-blocking")).strip()
    if remarks:
        title = f"Follow-up to {ident}: jury remarks on PR #{num}"
        if not issues({"title": {"eq": title}}):
            create_ticket(issue, states, dry, title, (
                f"**Goal.** Address the AI jury's non-blocking remarks on {link} ({ident}), which "
                "merged without them.\n\n**Scope**\n\n* Judge each remark on its merits: fix it (with a "
                "test when behavior changes) or decline it and say why in the PR description. "
                "Stay within the code the remarks name.\n\n"
                f"**Remarks**\n\n{remarks}\n\n"
                "**Acceptance:** every remark above is fixed or explicitly declined in the PR "
                "description; `npm run test:ai` passes.\n\n---\n\n"
                "Created by the reconciler. It stays in Backlog until a person moves it to Todo."))
    for spec, seen in flaky_reports([info["body"], *info["doctor_notes"]]).items():
        report = "\n".join(f"- {s}" for s in seen)
        title = f"Fix flaky test: {spec}"
        found = issues({"title": {"eq": title}, "state": {"type": {"neq": "canceled"}, "name": {"neq": "Done"}}})
        if found:
            log(f"{ident}: {spec} reported flaky again, commenting on {found[0]['identifier']}")
            if not dry:
                linear_comment(found[0]["id"], f"Reported flaky again in {link} ({ident}):\n\n{report}")
            continue
        create_ticket(issue, states, dry, title, (
            f"**Goal.** `{spec}` fails intermittently. Make it deterministic.\n\n"
            f"**Reports**\n\nFrom {link} ({ident}):\n\n{report}\n\n"
            "**Scope**\n\n* Find why the test depends on timing, randomness or shared state (the live "
            "simulation on /world is a usual suspect) and fix the test or the code under test. Never "
            "skip or delete it, add retries, or loosen what it checks.\n\n"
            f"**Acceptance:** `npx playwright test {spec} --repeat-each=20 --workers=1` passes, and "
            "`npm run test:ai` passes.\n\n---\n\nCreated by the reconciler from a flaky-test report."),
            todo=True, priority=2)


def is_parked(issue, memory):
    """Parked for a person: the Linear label is the record; the local list covers older parks."""
    return (NEEDS_HUMAN in {label["name"] for label in issue["labels"]["nodes"]}
            or issue["identifier"] in memory.get("parked", []))


def human_label(team_id):
    """Id of the team's `needs-human` Linear label, created on first use."""
    if team_id not in HUMAN_LABEL:
        nodes = gql("""query($n:String!){issueLabels(filter:{name:{eq:$n}}){nodes{id team{id}}}}""",
                    {"n": NEEDS_HUMAN})["issueLabels"]["nodes"]
        found = next((n["id"] for n in nodes if not n["team"] or n["team"]["id"] == team_id), None)
        if not found:
            found = gql(
                """mutation($t:String!,$n:String!){issueLabelCreate(input:{teamId:$t,name:$n,color:"#B60205",
                description:"Parked by the reconciler: the AI pipeline gave up, a person decides"})
                {issueLabel{id}}}""", {"t": team_id, "n": NEEDS_HUMAN})["issueLabelCreate"]["issueLabel"]["id"]
        HUMAN_LABEL[team_id] = found
    return HUMAN_LABEL[team_id]


def unpark(issue, memory, dry):
    """A person moved a parked ticket to Todo: that is the decision to continue.

    Reset its retry budgets and drop `needs-human` from the ticket and its open PR, so the
    pipeline does not park it again straight away.
    """
    ident = issue["identifier"]
    if ident in memory.get("parked", []):
        memory["parked"].remove(ident)
    forget(ident, memory)
    log(f"{ident}: moved out of Backlog by a person, retry budgets reset, {NEEDS_HUMAN} removed")
    if dry:
        return
    if any(label["name"] == NEEDS_HUMAN for label in issue["labels"]["nodes"]):
        gql("""mutation($i:String!,$l:String!){issueRemoveLabel(id:$i,labelId:$l){success}}""",
            {"i": issue["id"], "l": human_label(issue["team"]["id"])})
    for p in branch_prs("symphony/" + ident.lower()):
        if p["state"] == "open" and any(label["name"] == NEEDS_HUMAN for label in p["labels"]):
            remove_label(p["number"], NEEDS_HUMAN)
    ROUND.pop("symphony/" + ident.lower(), None)  # labels changed; look the PR up again


def wait_for_blockers(issue, waiting, states, dry):
    set_state(issue, "Backlog", states, dry, f"waiting for {', '.join(waiting)} to be merged")


def workflow_running(workflow, title):
    """True while a run of `workflow` with this run-name is queued or in progress."""
    return any(r["display_title"] == title and r["status"] != "completed"
               for r in workflow_runs(workflow, 30))


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
    if wait_for_quota(rec, info["jury_limit"], ident, "jury"):
        return
    if rec["n"] >= MAX_JURY:
        park(issue, states, memory, dry,
             f"PR #{num}: the AI jury gave no verdict for head {head[:7]} in {rec['n']} runs (see the ai-jury runs)", info)
        return
    log(f"{ident}: no jury verdict for head {head[:7]}, starting the jury on PR #{num} (run {rec['n'] + 1})")
    memory[key] = {**rec, "head": head, "n": rec["n"] + 1, "at": time.time()}
    if not dry:
        dispatch_jury(info["base"], num)


def wait_for_quota(rec, until, ident, what):
    """True while the last `what` run was stopped by the Claude usage limit and the quota is not back.

    Such a run is no attempt: once the quota is back, its count is given back (once per limit
    time, so a run that never starts still counts) and the retry starts at once. The caller
    stores `rec` again when this changes it.
    """
    if not until:
        return False
    if time.time() < until:
        log(f"{ident}: {what} waits for the Claude usage limit to reset "
            f"({dt.datetime.fromtimestamp(until, dt.timezone.utc):%Y-%m-%d %H:%M} UTC)")
        return True
    if rec.get("limit") != until:
        rec["n"] = max(rec["n"] - 1, 0)
        rec["limit"] = until
    return False


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
    if wait_for_quota(rec, info["doctor_limit"], ident, "Merge Doctor"):
        memory[key] = rec  # the refund
        return
    if rec["n"] >= MAX_DOCTOR:
        park(issue, states, memory, dry, f"PR #{num}: conflicts/jury rejection, Merge Doctor ran {rec['n']} times (the limit) and it still is not mergeable", info)
        return
    log(f"{ident}: PR #{num} needs the Merge Doctor (attempt {rec['n'] + 1})")
    memory[key] = {**rec, "n": rec["n"] + 1, "at": time.time()}
    if not dry:
        # The issues endpoints, not the PR ones: `gh pr edit` fails on the Projects (classic) deprecation.
        # Remove then add, so the `labeled` event fires even when the label was left behind.
        try:
            remove_label(num, NEEDS_DOCTOR)
        except RateLimited:
            raise
        except Exception:  # removing a label that is not there fails; harmless
            pass
        add_label(num, NEEDS_DOCTOR)


def handle_open_pr(issue, info, states, memory, dry, fix):
    """One decision, one Linear write, so tickets never flap between states.

    `fix` is the ticket allowed to merge while master's tests fail (None: master is green).
    """
    ident, num, cur = issue["identifier"], info["number"], issue["state"]["name"]
    if NEEDS_HUMAN in info["labels"]:
        park(issue, states, memory, dry, f"PR #{num} is labeled {NEEDS_HUMAN}: the Merge Doctor gave up "
             "(see its last comment on the PR). You can also merge the PR by hand", info)
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
            merge_pr(num, info["head"], info["branch"])
        set_state(issue, "Done", states, dry, f"PR #{num} merged")
        forget(ident, memory)
        try:
            file_followups(issue, info, states, dry)
        except RateLimited:
            raise
        except Exception as e:  # the merge stands; only the follow-ups are lost
            log(f"{ident}: could not file follow-up tickets: {e}")
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
        runs = api(WATCHED["master tests"])["workflow_runs"]
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
    sha = last["head_sha"][:7]
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
            f"**Goal.** `npm run test:ai` fails on `{MASTER}` at `{sha}` ({last['html_url']}). Make it pass again.\n\n"
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
    memory["master_red"] = {"ident": ident, "sha": last["head_sha"]}
    return ident


def reconcile_issue(issue, states, memory, dry, activity, open_branches, fix):
    ident, cur = issue["identifier"], issue["state"]["name"]
    branch = "symphony/" + ident.lower()
    if cur in ("Todo", "In Progress") and is_parked(issue, memory):
        unpark(issue, memory, dry)
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
            park(issue, states, memory, dry, f"no merged/open PR after {n} redos", info)
        else:
            set_state(issue, "Todo", states, dry, f"no PR ({pr}); redo #{n + 1}")
            memory[ident] = n + 1


def promote_unblocked(states, memory, dry):
    """Backlog tickets whose blockers are all merged become Todo (parked ones stay)."""
    global LOOKUP_FAILS
    for issue in issues({"state": {"name": {"eq": "Backlog"}}}):
        ident = issue["identifier"]
        if is_parked(issue, memory):
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


def linear_stamp():
    """When the project's newest ticket changed: one tiny query, the change detector for Linear."""
    nodes = gql("""query($f:IssueFilter){issues(first:1,orderBy:updatedAt,filter:$f){nodes{updatedAt}}}""",
                {"f": {"project": {"slugId": {"eq": PROJECT_SLUG}}}})["issues"]["nodes"]
    return nodes[0]["updatedAt"] if nodes else ""


def in_flight(tickets, open_branches):
    """True while something time-based can come due: a PR to review, a run, a redo grace period."""
    for t in tickets:
        cur, branch = t["state"]["name"], "symphony/" + t["identifier"].lower()
        if cur in ("In Progress", "In Review") or (cur == "Todo" and branch in open_branches):
            return True
        if cur == "Done" and not is_merged(branch):
            return True
    return False


def reconcile(dry):
    """One pass over the project. Returns True while something is in flight (see in_flight)."""
    global LOOKUP_FAILS, LINEAR_STAMP
    LOOKUP_FAILS = 0
    ROUND.clear()
    LINEAR_STAMP = linear_stamp()  # taken first: a change during the round starts the next one
    team_id, states = get_states()
    ensure_in_review(team_id, states, dry)
    reap_orphans(dry)
    memory = load_state()
    try:
        activity = cb_activity()
        open_branches = {p["head"]["ref"] for p in api(WATCHED["pull requests"])}
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
        return in_flight(tickets, open_branches)
    finally:
        if not dry:
            save_state(memory)


def mark_round(ok, last_ok, dry=False):
    """Health heartbeat: a round only counts when Linear and every GitHub lookup worked."""
    now = time.time()
    if ok:
        if not dry:  # a dry run must not make a dead reconciler look healthy
            with open(HEALTH_FILE, "w") as f:
                f.write("ok")
        return now
    if now - last_ok > WATCHDOG_MIN * 60:
        log(f"WATCHDOG: no successful round for {int((now - last_ok) / 60)} min - "
            "tickets are NOT being reconciled (rejected PRs stay Done)")
    return last_ok


def wait_for_change(seconds):
    """Sleep up to `seconds`, waking early - and saying why - when GitHub or Linear moved.

    GitHub is probed with conditional GETs (a 304 costs no quota), Linear with one tiny
    query, so reacting within seconds costs about the same as the fixed sleep it replaces.
    Returns the reason, or None when the time simply ran out.
    """
    start = time.time()
    end = start + seconds
    next_gh, next_linear = start + PROBE_GH_SEC, start + PROBE_LINEAR_SEC
    while time.time() < end:
        now = time.time()
        try:
            if now >= next_gh:
                next_gh = now + PROBE_GH_SEC
                for name, path in WATCHED.items():
                    if api_moved(path):
                        return f"{name} changed on GitHub"
            if now >= next_linear:
                next_linear = now + PROBE_LINEAR_SEC
                if LINEAR_STAMP is not None and linear_stamp() != LINEAR_STAMP:
                    return "a ticket changed in Linear"
        except RateLimited:
            return "rate limited while probing"  # the round reports it and backs off
        except Exception as e:  # a probe hiccup only costs the early wake-up; the heartbeat covers it
            log(f"probe failed: {e}")
        time.sleep(min(PROBE_TICK, max(0.0, end - time.time())))
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--once", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--interval", type=int, default=60,
                    help="heartbeat in seconds while something is in flight")
    ap.add_argument("--idle-interval", type=int, default=IDLE_INTERVAL,
                    help="heartbeat in seconds while nothing is in flight")
    a = ap.parse_args()
    if not KEY:
        sys.exit("LINEAR_API_KEY is not set")
    last_ok = time.time()
    while True:
        ok, wait, busy = False, a.interval, True
        try:
            busy = reconcile(a.dry_run)
            ok = LOOKUP_FAILS == 0
            wait = a.interval if busy or not ok else a.idle_interval
        except RateLimited as e:
            log(f"rate limit hit ({e}); sleeping {RATE_LIMIT_SLEEP}s")
            wait = RATE_LIMIT_SLEEP
        except Exception as e:
            log(f"sync error: {e}")
        last_ok = mark_round(ok, last_ok, a.dry_run)
        if a.once:
            return
        if wait == RATE_LIMIT_SLEEP:
            time.sleep(wait)  # probing would only burn more quota
        else:
            why = wait_for_change(wait)
            if why:
                log(f"waking early: {why}")


if __name__ == "__main__":
    main()
