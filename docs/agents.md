# Creating Linear tickets for the agents

Every ticket in the `new-agent` Linear project is picked up by an autonomous AI worker (Contrabass).

## Sizing

- One ticket = one chunk of work that a single agent can finish, with its own PR.
- Prefer new files over edits to shared ones, and one Playwright spec file per feature (`tests/<feature>.spec.js`), so parallel tickets do not conflict.

## State: always Todo, dependencies via "blocked by"

- Create **every** ticket as **Todo**, including tickets that depend on other tickets.
- Express the dependency with a Linear relation: the dependency **blocks** the dependent ticket (`issueRelationCreate`, `type: blocks`, `issueId` = blocker, `relatedIssueId` = blocked).
- Do not park waiting tickets in Backlog. Contrabass skips a Todo ticket while any of its blockers is still Todo or In Progress, so it starts on its own once the blocker is out of those states.
- Backlog is only for ideas that should not be worked on yet.

## Blockers that are In Review

"In Review" has the Linear type `completed`, so Contrabass no longer sees a blocker as open once its PR is up (before it is merged). Two guards cover this:

- `scripts/linear_sync.py` (`demote_blocked`): a Todo / In Progress ticket whose blocker is In Review is moved back to Backlog; `promote_unblocked` moves it to Todo again when every blocker is Done (merged).
- `.contrabass/WORKFLOW.md` ("Zero"): a worker whose blockers have no merged PR stops without changes.

Because of the polling gap (Contrabass 2s, reconciler 20s), a dependent ticket may still start briefly and stop at the precheck. Keep dependency chains short.
