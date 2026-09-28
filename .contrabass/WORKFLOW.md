---
max_concurrency: 5
poll_interval_ms: 2000
max_retry_backoff_ms: 240000
model: claude-sonnet-5
project_url: https://linear.app/new-agent/project/new-agent-linear-dea87a9266f5
agent_timeout_ms: 1800000
stall_timeout_ms: 600000
tracker:
  type: linear
agent:
  type: omc
omc:
  binary_path: omc
  team_spec: "1:claude"
  startup_timeout_ms: 180000
team:
  worker_mode: goroutine
---
# New Agent - Autonomous Delivery Workflow

You are working inside an isolated git worktree on one ticket from the
"New Agent" product backlog. This Linear project is used as a general
queue for the whole application, not a single feature - do not assume
the ticket is scoped to any particular epic.

Issue title: {{ issue.title }}
Issue description: {{ issue.description }}
Issue URL: {{ issue.url }}

## First: is this a rework of an existing PR?

You start with an empty context, so check before writing anything:

1. Find this ticket's branch and PR: `gh pr list --head symphony/<ticket-id-lowercase> --state open --json number,url`
   (the branch is `symphony/new-<N>` for ticket NEW-<N>).
2. If an open PR exists, this is a **rework**, not a new implementation:
   - `git fetch origin && git checkout -B symphony/new-<N> origin/symphony/new-<N>`
   - Read every comment on the PR (`gh pr view <number> --comments`). The newest
     comment starting with `STATUS: REJECTED` is the AI jury's verdict: it lists
     the blocking issues. Also check whether the PR reports merge conflicts.
   - Fix exactly those findings (and rebase onto `origin/master` if there are
     conflicts), keep the existing work, add tests for the fixed behavior, run
     `npm run test:ai`, then `git push --force-with-lease` to the same branch.
     Do NOT open a new PR and do NOT start over from scratch.
   - After pushing, the jury re-reviews automatically; you are done.
3. If no PR exists, continue with the normal flow below.

## How to work

The omc team runs its own plan, implement and verify stages; do not add
custom roles on top of it.

- Implement the ticket with clean code only: no `TODO`s, no mocked/stubbed
  data, no half-finished branches.
- If the ticket changes user-visible behavior, add or update a Playwright
  test that covers it. Use one spec file per feature (e.g.
  `tests/name.spec.js`) so parallel tickets do not edit the same file. A
  behavior change without a test is not done.
- If the ticket has no user-visible behavior (docs, config, CI, pure
  refactor), do not invent a test; state in the PR description why none
  was needed. The existing suite must still pass.
- Stay inside the scope of this ticket. Other tickets run in parallel in
  their own worktrees, so prefer adding new files over rewriting shared
  ones, to keep the later rebase conflict-free.
- Verify with `npm run test:ai` (run `npm ci && npx playwright install
  chromium` first if `node_modules` is missing). Headless only, never
  `--ui`. Read the output yourself; the run counts as verified only if at
  least one test ran and all passed.
- If verification fails, fix and re-run. Stop after 4 failed fix loops and
  escalate (see "If everything fails" below).

## Merge phase: rebase before you open a PR

Once verification passes, do **not** open a PR straight away. First make sure your
branch actually merges cleanly:

1. `git fetch origin && git rebase origin/master`
2. If the rebase is clean, run `npm run test:ai` one more time to confirm
   nothing broke, then open the PR normally. Paste the final test summary
   line into the PR description.
3. If there are conflicts:
   a. Resolve them in the code (not by blindly taking
      "ours"/"theirs" - understand what both sides changed).
   b. Continue the rebase, then re-run the tests.
   c. Repeat up to 2 times total.
4. If you still cannot get a clean rebase + passing tests after 2 attempts,
   stop trying to force it yourself.

## If everything fails: escalate, don't guess

If you hit the fix-loop limit, or you cannot get a
clean rebase after 2 attempts in the Merge phase:

1. Open the PR anyway, in whatever state it is in (even with the
   conflicting/failing state described in the PR body).
2. Add the label `needs-expert-review` to the PR
   (`gh issue edit <number> --add-label needs-expert-review`). Use `gh issue edit`, not `gh pr edit`: the latter fails on the
   Projects (classic) GraphQL deprecation error and would not add the label.
3. In the PR description, clearly state what you tried, what failed, and
   the exact error/conflict output. This is read by a separate, more
   capable reviewer model - give it everything it needs to pick up where
   you left off, not a vague summary.
4. Do not keep retrying past this point - stop and hand off.
