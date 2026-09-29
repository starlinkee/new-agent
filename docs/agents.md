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

Backlog holds four kinds of tickets:

- ideas nobody queued (no blockers): never started automatically;
- tickets waiting for blockers: promoted automatically;
- tickets parked for a person: labeled `needs-human` in Linear, with a reconciler comment saying why (redo limit, Merge Doctor limit, the jury giving no verdict, or a PR labeled `needs-human`), links to the PR and its last jury / Merge Doctor runs, the attempt history, and for a ticket without a PR its Contrabass events. These are never promoted automatically. Two ways out:
  - **Fixed it** (the PR, the ticket or master): move the ticket to Todo. The jury and Merge Doctor retry the same PR with a fresh budget.
  - **Start over**: close the PR, then move the ticket to Todo. A new worker implements it from scratch.

  Moving the ticket to Todo is the decision: the reconciler removes `needs-human` from the ticket and the PR and resets the retry budgets. Removing only the label turns it into an ordinary Backlog ticket.
- follow-ups filed by the reconciler after a merge: "Follow-up to NEW-N: jury remarks on PR #M" holds the jury's non-blocking remarks. It starts only when a person moves it to Todo.

## After the PR

- **AI jury** (`ai-jury.yml`): runs the whole suite on the PR merged with master, without secrets, then Opus reviews the diff against the ticket. The verdict comment names the head commit it reviewed and counts for exactly that commit, and maps every acceptance item to its test. When it cannot give a verdict it says why on the PR, with a link to the run.
- **Reconciler**: merges an approved head (only that commit), sends rejections and conflicts to the **Merge Doctor** (`merge-doctor.yml`, Opus, same branch), and parks the ticket if the doctor gives up. After a merge it files the jury's non-blocking remarks as a Backlog follow-up, and every test reported under `## Flaky tests` (in the PR description or a Merge Doctor comment) as a "Fix flaky test: tests/<file>.spec.js" ticket in Todo, or as a comment on the one already open.
- **Master tests** (`master-tests.yml`) run after every merge. While they are red, auto-merge pauses and a "Fix failing tests on master" ticket is queued; re-run the workflow to clear a flaky failure.
