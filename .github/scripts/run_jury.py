import os
import re
import subprocess
import sys

from claude_cli import ask_claude
from linear_ticket import ticket_text
from verdict import marker

# The last gate before the reconciler merges automatically; no human looks after it.
# Runs from a trusted checkout of the base branch (ai-jury.yml) and never executes PR code.
# Inputs prepared by the workflow, in the current directory:
#   pr_diff.txt            what the PR changes, measured from the merge base
#   tests/outcome.txt      "passed", "failed" or "conflict": the tests job ran the suite on the
#                          PR head merged with the base branch, without any secrets
#   tests/test_output.txt  that run's output
# Posts exactly one verdict for HEAD_SHA (format: verdict.py), or none if it cannot judge,
# in which case the reconciler starts the jury again.

PR = os.environ["PR_NUMBER"]
SHA = os.environ["HEAD_SHA"]
HEAD = os.environ["HEAD_REF"]
BASE = os.environ["BASE_REF"]
MAX_DIFF = 300_000
RUN_URL = (f"{os.environ.get('GITHUB_SERVER_URL', 'https://github.com')}/{os.environ.get('GH_REPO', '')}"
           f"/actions/runs/{os.environ.get('GITHUB_RUN_ID', '')}")


def read(path):
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            return f.read()
    except OSError:
        return None


def set_status(state, description):
    """The required `jury-review` check (branch protection on master), set on the reviewed head.

    Under pull_request_target the job's own check run belongs to the base commit, so it
    cannot satisfy the PR; a commit status on HEAD_SHA does, and only for that commit.
    """
    subprocess.run(["gh", "api", f"repos/{os.environ['GH_REPO']}/statuses/{SHA}",
                    "-f", f"state={state}", "-f", "context=jury-review",
                    "-f", f"description={description}"], capture_output=True, text=True)


def post(status, body):
    set_status("success" if status == "APPROVED" else "failure", f"AI jury: {status.lower()}")
    subprocess.run(
        ["gh", "pr", "comment", PR, "--body-file", "-"],
        input=f"{marker(status, SHA)}\nSTATUS: {status}\n\n{body.strip()}\n\n_Reviewed head `{SHA[:7]}`._",
        text=True, check=True,
    )
    # A rejection fails the check. Routing it (the Merge Doctor fixes the findings) is the
    # reconciler's job: scripts/linear_sync.py.
    sys.exit(1 if status == "REJECTED" else 0)


def no_verdict(reason, details=""):
    """Give no verdict, but say why on the PR, so a person reading it later is not left guessing.

    Not a verdict comment (no marker): the reconciler starts the jury again for this head.
    """
    set_status("error", "AI jury: no verdict")
    subprocess.run(
        ["gh", "pr", "comment", PR, "--body-file", "-"],
        input=(f"**AI jury: no verdict** for head `{SHA[:7]}`: {reason}.\n\n"
               + (f"{fenced(details[-3000:])}\n\n" if details.strip() else "")
               + f"Run: {RUN_URL}\n\nThe reconciler starts the jury again, up to 3 times per head, "
                 "then parks the ticket for a person."),
        text=True,
    )
    sys.exit(1)


def fenced(text):
    return "```text\n" + text.replace("```", "'''") + "\n```"


set_status("pending", "AI jury: reviewing")
outcome = (read("tests/outcome.txt") or "").strip()
test_log = read("tests/test_output.txt") or ""
if outcome not in ("passed", "failed", "conflict"):
    print(f"the tests job left no outcome ({outcome!r}); no verdict", file=sys.stderr)
    no_verdict(f"the tests job left no result ({outcome or 'no artifact'}), so the suite's outcome "
               "is unknown; see the `tests` job in the run")
if outcome == "conflict":
    post("REJECTED", f"## Blocking\n\n1. The branch does not merge cleanly into `{BASE}`. "
                     f"Rebase it onto `origin/{BASE}` and resolve the conflicts.")
# Playwright prints "N passed"; a green exit without it means no test ran at all.
if outcome == "failed" or not re.search(r"\b[1-9]\d* passed\b", test_log):
    post("REJECTED", f"## Blocking\n\n1. `npm run test:ai` does not pass on this branch merged with "
                     f"`{BASE}` (or ran no test). Fix the cause; never skip, delete or weaken tests. "
                     f"End of the output:\n\n{fenced(test_log[-8000:])}")

diff = read("pr_diff.txt") or ""
if not diff.strip():
    post("REJECTED", f"## Blocking\n\n1. The PR changes nothing relative to `{BASE}`. "
                     "If its work already landed there, the PR should be closed.")
if len(diff) > MAX_DIFF:
    diff = diff[:MAX_DIFF] + f"\n\n[diff truncated at {MAX_DIFF} characters]"

system_prompt = """
You are the final gate before an autonomous coding agent's pull request is merged
automatically into the product. No human reviews it after you. The full Playwright suite
has already passed on this branch merged with the base branch.

You get the Linear ticket (the specification), the PR description and the diff.

Reject only for BLOCKING problems:
1. The diff does not deliver the ticket's Goal / Scope / Acceptance, delivers something
   else, or changes things far outside the ticket's scope.
2. User-visible behaviour is added or changed without a Playwright test that checks it;
   tests are weakened, skipped, or assert nothing meaningful; the test script is gamed.
3. Security: injection, XSS, secrets in code, missing input validation at the API boundary.
4. Correctness bugs you would not ship; TODOs, stubs, mocked data, dead code paths.
5. Architecture or performance problems that will clearly hurt: bypassed layers,
   unbounded growth, needless O(n^2) work in hot paths.
Style, naming, taste and optional improvements are NOT blocking.

Every remark is either Blocking or Non-blocking; there is no third category such as
"should fix". A correctness bug you would not ship is Blocking (rule 4).

Answer in exactly this format:
- Line 1: `STATUS: APPROVED` or `STATUS: REJECTED`, nothing else on the line.
- A section `## Acceptance coverage`, always. Its first line is `PR description mapping:
  present` or `PR description mapping: missing` (whether the PR description lists each
  acceptance item with the test that covers it; a missing mapping alone is not blocking).
  Then one line per acceptance item of the ticket: the item, then the test in the diff that
  checks it (file and test title), or `no test`. An item with user-visible behavior and
  `no test` is Blocking under rule 2. Without a ticket, map the PR description's claims.
- If rejected: a section `## Blocking` with numbered findings, each with file:line,
  the problem, and the fix you expect. Another agent fixes exactly these.
- Optionally: a section `## Non-blocking` with short suggestions. They never cause a
  rejection. After the merge they become a follow-up ticket for another agent, so make
  each one self-contained: file:line, the problem, the suggested fix.
"""

ticket = ticket_text(HEAD)
pr = subprocess.run(["gh", "pr", "view", PR, "--json", "title,body", "--jq", '.title + "\\n\\n" + .body'],
                    capture_output=True, text=True).stdout
summary = next((l for l in reversed(test_log.splitlines()) if re.search(r"\bpassed\b", l)), "")
prompt = (
    (f"## Linear ticket\n\n{ticket}\n\n" if ticket else
     "## Linear ticket\n\n(not found: judge the diff against the PR description)\n\n")
    + f"## Pull request\n\n{pr}\n\n"
    + f"## Tests\n\n`npm run test:ai` passed: {summary.strip()}\n\n"
    + f"## Diff (against the merge base with {BASE}; package-lock.json omitted)\n\n{diff}"
)


def status_of(answer):
    first = next((l for l in answer.splitlines() if l.strip()), "")
    m = re.fullmatch(r"STATUS:\s*(APPROVED|REJECTED)", first.strip().strip("*`# ").strip())
    return m and m.group(1)


failures = []
for attempt in range(2):
    try:
        answer = ask_claude(system_prompt, prompt)
    except RuntimeError as e:
        print(e, file=sys.stderr)
        failures.append(f"attempt {attempt + 1}: the Claude call failed:\n{str(e)[-1200:]}")
        continue
    status = status_of(answer)
    if status:
        post(status, answer.split("\n", 1)[1] if "\n" in answer else "")
    print(f"unparseable verdict (attempt {attempt + 1}):\n{answer[:1000]}", file=sys.stderr)
    failures.append(f"attempt {attempt + 1}: the answer did not start with a STATUS line; it began:\n{answer[:1200]}")
no_verdict("both review attempts failed", "\n\n".join(failures))
