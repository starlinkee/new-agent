# Creating Linear tickets for the agents

Every ticket in the `new-agent` Linear project is picked up by an autonomous AI worker (Contrabass) within seconds of reaching Todo.

## Sizing

- One ticket = one chunk of work that a single agent can finish, with its own PR.
- Prefer new files over edits to shared ones, and one Playwright spec file per feature (`tests/<feature>.spec.js`), so parallel tickets do not conflict.
- Write acceptance criteria that can be checked: the AI jury reviews each PR against the ticket's Goal, Scope and Acceptance.

## States and dependencies

- Create tickets with `/plan-feature` or its script `.claude/skills/plan-feature/linear_batch.py`, never by hand. The script creates every ticket in **Backlog**, adds the relations, and only then moves the root tickets (no blockers) to **Todo**.
- Express a dependency twice: as a Linear relation (the blocker **blocks** the dependent; `issueRelationCreate`, `type: blocks`, `issueId` = blocker, `relatedIssueId` = blocked), and as `NEW-<N>` in the dependent's description, because the worker's "Zero" precheck reads the description.
- Dependents stay in Backlog. `scripts/linear_sync.py` moves a ticket to Todo once every blocker's PR is **merged on GitHub**, and moves a Todo / In Progress ticket without an open PR back to Backlog while any blocker is unmerged. Linear's Done is not used for this, because Contrabass sets Done when a run ends, before anything is merged. A canceled blocker no longer blocks.
- A blocker finished by hand without a `symphony/new-<N>` PR never counts as merged: remove the relation.
- Keep dependency chains short (foundation, then a shell, then parallel leaves); every level waits for a full review and merge.

## Backlog

Backlog holds three kinds of tickets:

- ideas nobody queued (no blockers): never started automatically;
- tickets waiting for blockers: promoted automatically;
- tickets parked for a person, with a comment from the reconciler saying why (redo limit, Merge Doctor limit, the jury giving no verdict, or a PR labeled `needs-human`). These are never promoted automatically. Resolve the problem, remove `needs-human` from the PR if it is there, and move the ticket to Todo; it starts with a fresh retry budget.

## After the PR

- **AI jury** (`ai-jury.yml`): runs the whole suite on the PR merged with master, without secrets, then Opus reviews the diff against the ticket. The verdict comment names the head commit it reviewed and counts for exactly that commit.
- **Reconciler**: merges an approved head (only that commit), sends rejections and conflicts to the **Merge Doctor** (`merge-doctor.yml`, Opus, same branch), and parks the ticket if the doctor gives up.
- **Master tests** (`master-tests.yml`) run after every merge. While they are red, auto-merge pauses and a "Fix failing tests on master" ticket is queued; re-run the workflow to clear a flaky failure.
