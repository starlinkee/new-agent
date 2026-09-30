import datetime as dt
import json
import os
import subprocess
import sys

from claude_cli import UsageLimit, clean_env, limit_marker, run_claude_agent
from linear_ticket import ticket_text
from verdict import MARKER_RE

# Runs in a checkout of the PR branch (the scripts themselves come from the base
# branch, see merge-doctor.yml). Fires when the PR is labeled "needs-expert-review":
# by the worker when it could not finish, or by the reconciler when the PR conflicts
# or the jury rejected its current head. The label is removed when the run ends.
#
# Opus rebases the branch onto the base branch, resolves the conflicts, fixes
# whatever breaks and addresses the jury's blocking findings, if the last verdict is a
# rejection. This script then re-checks the result itself (on top of base,
# no conflict markers, test suite green) and only then pushes with
# --force-with-lease. Neither the agent nor the code it runs sees any credential
# (claude_cli.clean_env). After the push this script starts the jury on the new head,
# and the reconciler merges the PR once that head is approved.
# When the Claude subscription is out of quota the run says so in a comment carrying the time it
# comes back (claude_cli.limit_marker). That is not an attempt: the reconciler waits until then and
# retries without counting it.
# If the doctor can neither fix nor refute a rejection, it labels the PR `needs-human`
# and the reconciler parks the ticket for a person instead of retrying.

PR = os.environ["PR_NUMBER"]
BASE = os.environ["BASE_REF"]
HEAD = os.environ["HEAD_REF"]
REPO = os.environ["GITHUB_REPOSITORY"]
TOKEN = os.environ["GH_TOKEN"]
RUN_URL = (f"{os.environ.get('GITHUB_SERVER_URL', 'https://github.com')}/{REPO}"
           f"/actions/runs/{os.environ.get('GITHUB_RUN_ID', '')}")


def run(*cmd, check=True, env=None):
    return subprocess.run(cmd, capture_output=True, text=True, check=check, env=env)


def comment(body):
    # The header is how the reconciler finds these comments (DOCTOR_HEADER in linear_sync.py).
    subprocess.run(["gh", "pr", "comment", PR, "--body-file", "-"],
                   input=f"**AI Merge Doctor (Opus)**\n\n{body}\n\n_Run: {RUN_URL}_", text=True, check=True)


def tail(text, n=6000):
    return text[-n:]


def crashed(kind, value, tb):
    """An unexpected error (a failed git or gh call, say) still leaves a note on the PR."""
    sys.__excepthook__(kind, value, tb)
    detail = f"{kind.__name__}: {value}"
    if isinstance(value, subprocess.CalledProcessError):
        detail += "\n" + tail(value.stderr or "", 1500)
    try:
        comment("The doctor script crashed; nothing was pushed. The reconciler will retry.\n\n"
                f"```text\n{detail.replace(TOKEN, '***')}\n```")
    except Exception:
        pass


sys.excepthook = crashed


# Commit as the PR's author (a real GitHub account, via its noreply address). An unlinked
# identity makes GitHub treat the push as a first-time contributor and hold the jury
# workflow for manual approval, which would stop the whole automatic flow.
author = run("gh", "pr", "view", PR, "--json", "author", "--jq", ".author.login").stdout.strip()
author_id = run("gh", "api", f"users/{author}", "--jq", ".id").stdout.strip()
run("git", "config", "user.name", author)
run("git", "config", "user.email", f"{author_id}+{author}@users.noreply.github.com")
run("git", "fetch", "origin", BASE)
original_head = run("git", "rev-parse", "HEAD").stdout.strip()
ticket = ticket_text(HEAD)
pr_body = run("gh", "pr", "view", PR, "--json", "body", "--jq", ".body").stdout

def jury_findings():
    """The jury's rejection of the head we start from (its comment body), else empty."""
    comments = json.loads(run("gh", "api", f"repos/{REPO}/issues/{PR}/comments?per_page=100").stdout or "[]")
    for c in reversed(comments):
        m = MARKER_RE.search(c["body"] or "")
        if m and c["user"]["login"].startswith("github-actions") and m.group(2) == original_head:
            return c["body"] if m.group(1) == "REJECTED" else ""
    return ""


def escalate(body):
    """Hand the PR to a person: the reconciler parks a ticket whose PR has this label."""
    run("gh", "label", "create", "needs-human", "--repo", REPO, "--color", "B60205",
        "--description", "The AI pipeline gave up on this PR; a person decides", "--force", check=False)
    run("gh", "issue", "edit", PR, "--repo", REPO, "--add-label", "needs-human", check=False)
    comment(body)


findings = jury_findings()
conflicted = run("git", "rebase", f"origin/{BASE}", check=False).returncode != 0

system_prompt = f"""
You are a Senior Principal Engineer finishing a pull request that an autonomous
coding agent could not get merged. You work in a git checkout of the PR branch.
You cannot push and must not try; your job is to leave the working tree ready to push.

Goal: the branch is rebased on origin/{BASE} (linear history, no merge commits),
contains the PR's intended changes AND the changes that landed on {BASE} in the
meantime, and `npm run test:ai` passes.

Rules:
- Resolve each conflict by understanding what both sides changed and keeping both
  intents. Never blindly take "ours" or "theirs", never drop the PR's feature or
  {BASE}'s new code, never delete or weaken tests to make them pass (the one exception
  is "Changing a test" below).
- If a rebase is in progress: fix the conflicted files, `git add` them, then
  `GIT_EDITOR=true git rebase --continue`. Repeat until the rebase is finished.
- Then run `npm run test:ai` (node_modules is already installed). Read the output.
  If something fails, fix the cause (usually an interaction between the PR and new
  code on {BASE}) and re-run until everything passes.
- If the AI jury's rejection is given below, also fix every BLOCKING finding in it
  (minimal change, plus a test for the fixed behavior) and commit the fix. Non-blocking
  remarks are optional.
- Never run `git push`, never rewrite {BASE}, never use `git merge`.
- If you are convinced a blocking finding is wrong, do not change code for it; explain
  why in your summary. A person then decides.
- Changing a test. Rare, and only you may do it (the worker agent never can). It is
  allowed only when a test cannot pass however the code is fixed: it asserts something
  impossible or contradicting the ticket, needs timing or an environment CI cannot give,
  or checks the wrong thing. Then change or replace that test instead of the code:
  * First try to fix the code. Show that the test is wrong: the failure you saw, and why
    no correct implementation could pass it.
  * The new test must still check the ticket's acceptance item the old one covered (the
    same behavior, checked in a reliable way). Deleting a test outright, or loosening it
    until it asserts nothing, is not allowed. Never change a test to match a bug.
  * Touch only tests that fail for this reason.
  * End your summary with a section `## Test changes`, one line per test:
    `- tests/<file>.spec.js: "<test title>": <what you changed, and why the old one could
    never pass>`. The AI jury, a separate reviewer, reads exactly this section and rejects
    a change it does not find justified. A test change without this section counts as
    tampering and is rejected.
- A test that failed once and passed on a re-run with nothing changed in between is flaky.
  Do not fix it here (out of scope).
- Finish with a short plain-text summary: what conflicted, how you resolved it,
  and the final test result. If you saw a flaky test, end with a section `## Flaky tests`,
  one line per test: `- tests/<file>.spec.js: "<test title>": <what you saw>`. A ticket
  to fix it is filed from these lines, so give the failure message.
"""
state = (
    f"The rebase onto origin/{BASE} STOPPED WITH CONFLICTS and is still in progress. "
    "`git status` lists the conflicted files.\n"
    if conflicted else
    f"The rebase onto origin/{BASE} completed without conflicts; verify the tests.\n"
)
try:
    summary = run_claude_agent(
        system_prompt,
        f"{state}\n"
        + (f"The Linear ticket this PR implements (the original intent; keep it intact):\n\n{ticket}\n\n"
           if ticket else "")
        + f"The worker agent's own account of what it tried:\n\n{pr_body}"
        + (f"\n\nThe AI jury's latest verdict on this PR (a rejection):\n\n{findings}" if findings else ""),
        ["Bash(git *)", "Bash(npm *)", "Bash(npx *)", "Bash(node *)",
         "Read", "Edit", "Write", "Glob", "Grep"],
    )
except UsageLimit as e:
    comment("The Claude usage limit is reached, so I did not start. Nothing was pushed. This is not a "
            "failed attempt: the reconciler retries as soon as the quota is back "
            f"({dt.datetime.fromtimestamp(e.until, dt.timezone.utc):%Y-%m-%d %H:%M} UTC).\n\n"
            + limit_marker(e.until))
    sys.exit(1)
except SystemExit:
    comment("The Opus run itself failed (see the run log below). Nothing was pushed.")
    raise

# Do not trust the agent: verify the result independently before pushing.
problems = []
if os.path.isdir(".git/rebase-merge") or os.path.isdir(".git/rebase-apply"):
    problems.append("the rebase is still in progress")
if run("git", "merge-base", "--is-ancestor", f"origin/{BASE}", "HEAD", check=False).returncode != 0:
    problems.append(f"HEAD is not on top of origin/{BASE}")
markers = run("git", "grep", "-n", "-E", "^(<<<<<<<|>>>>>>>) ", check=False).stdout
if markers.strip():
    problems.append("conflict markers are still in the tree:\n" + tail(markers, 1500))
if not problems:
    result = run("npm", "run", "test:ai", check=False, env=clean_env())
    if result.returncode != 0:
        problems.append("the test suite fails:\n" + tail(result.stdout + result.stderr))

if problems:
    comment("I could not produce a mergeable branch, nothing was pushed.\n\n- "
            + "\n- ".join(problems) + f"\n\nMy notes:\n\n{summary}")
    sys.exit(1)

new_head = run("git", "rev-parse", "HEAD").stdout.strip()
if new_head == original_head:
    if findings:
        # Retrying would only repeat this: the same head, the same rejection, the same answer.
        escalate("The jury rejected this head and I changed nothing, so the rejection stands. "
                 "A person has to decide: fix the PR, or override the jury (merge it by hand). "
                 "Then remove the `needs-human` label and move the Linear ticket back to Todo."
                 f"\n\nMy reasoning:\n\n{summary}")
        sys.exit(1)
    comment(f"The branch already sits on top of `{BASE}` and the tests pass, so there was "
            "nothing to change. A stale `mergeable` flag on GitHub is the likely cause.")
    sys.exit(0)

# --force-with-lease pinned to the sha we started from: if the worker pushed in the
# meantime, the push is refused instead of overwriting their work.
url = f"https://x-access-token:{TOKEN}@github.com/{REPO}.git"
push = run("git", "push", url, f"HEAD:refs/heads/{HEAD}",
           f"--force-with-lease=refs/heads/{HEAD}:{original_head}", check=False)
if push.returncode != 0:
    comment("Push refused (the branch changed while I was working); the reconciler will retry.\n\n"
            f"```\n{tail(push.stderr.replace(TOKEN, '***'), 1500)}\n```")
    sys.exit(1)

# A GITHUB_TOKEN push raises no pull_request event; start the jury on the new head directly.
jury = run("gh", "workflow", "run", "ai-jury.yml", "--repo", REPO, "--ref", BASE, "-f", f"pr={PR}", check=False)
started = "The jury reviews it next" if jury.returncode == 0 else "Could not start the jury (the reconciler will)"
comment(f"Rebased onto `{BASE}`, tests pass, pushed `{new_head[:7]}`. "
        f"{started}; it merges automatically once approved.\n\n{summary}")
