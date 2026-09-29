---
name: plan-feature
description: Come up with a brand-new feature (new subpage, new functionality) for a project, split it into a dependency tree of tickets sized for autonomous agents, and add them to Linear safely for the Contrabass queue.
argument-hint: "[project path or Linear project URL] [optional feature idea or theme]"
disable-model-invocation: true
---

# Plan a new feature and queue it in Linear

Arguments: `$ARGUMENTS`
- A path to a repo and/or a Linear project URL. Defaults: the current repo, and `project_url` from `.contrabass/WORKFLOW.md`.
- An optional idea or theme. Without one, invent the feature yourself; do not ask.

Every ticket you create is picked up by an autonomous AI worker (Contrabass) **within seconds of leaving Backlog**. Most of the rules below exist because of that.

## 1. Understand the project first

Read, don't guess:
- `docs/agents.md` (ticket rules) and `.contrabass/WORKFLOW.md` (what the worker does: the "Zero" blocker precheck, rework, merge phase).
- The app: server entry and routing, layout/nav, existing pages and features, static client modules, existing registries/extension points (e.g. `src/static/panels/index.js`), API conventions (validation, status codes, body limits), `package.json` scripts, and the `tests/` layout.
- The format of recent Linear tickets in the project, so new ones match. Query them via the API.

## 2. Pick the feature

- It must be **entirely new**: a new subpage with its own functionality, not an extension of an existing page and not overlapping existing features.
- It must be buildable with the project's stack and dependencies (no new services, databases or build steps unless the project already has them).
- It should break down naturally into a foundation plus several independent features.

## 3. Design the dependency tree

Shape: **foundation -> shell with an extension point -> parallel leaves**. Keep it at most 2-3 levels deep, because long chains stall the queue.

- **Foundation** (no blockers): the server-side model and API in new files, wired in with one line. It should expose a real hook the leaves build on, such as `store.subscribe(listener)`. That hook must be used and tested, never a stub.
- **Shell** (blocked by the foundation): the page, route and nav link, the core interaction, a `window.__<feature>` test handle, and a **plugin registry** in the same style as `panels/index.js`. Each leaf then adds exactly one import line and one array entry, and a failing plugin must not break the page.
- **Leaves** (blocked only by the shell, so they run in parallel): each one is mostly new files (a plugin module, a server module that subscribes to the hook), plus one line in the registry and at most one line in the server entry. If a leaf has to edit a shared file, name that edit explicitly as "the only change allowed outside the new files".
- Aim for about 5-8 tickets, each one agent-sized with its own PR and its own `tests/<feature>-<part>.spec.js`.

Think through the cross-ticket traps before writing the tickets:
- **Shared server state.** All specs run against one server, so specs must not assume a blank or initial state. They make a change and assert that change.
- **Features that restrict other features** (rate limits, auth, quotas) must not break the other tickets' specs. Scope them per client (for example a cookie: each Playwright context has its own cookie jar), allow bursts, and make limits configurable through handler options.
- Timing-based UI (countdowns, animations, replays) must be testable: use a mocked response with short delays (`page.route`) or a fixed total duration.
- **Interfaces that several tickets share** (the foundation's hook and event shapes, the shell's plugin `ctx`, route ownership, which ticket owns which DOM element or id, where styles go). Workers never talk to each other, and a later ticket builds on whatever an earlier one actually shipped. If two tickets would each have to guess the other's side, write a **contract** (see step 4). For small features with one obvious interface, the Scope alone is enough; do not add a contract just to have one.

## 4. Write the tickets

Use the same format as the existing tickets:

```
**Goal.** <one or two sentences>

**Scope**

* <new files with their exact paths, exported functions, routes, element ids, status codes>

**Acceptance:** spec `tests/<name>.spec.js`: <concrete, checkable behaviours incl. error paths>

**Blocked by:** {{<blocker key>}} (<short name>). **Blocks:** {{<key>}}, ...

---

**Conventions (see docs/agents.md):** one PR for this ticket only; prefer new files over editing shared ones; one Playwright spec file `tests/<name>.spec.js` for user-visible behavior; verify with `npm run test:ai`. <feature-specific note, e.g. shared state: never assume a blank board>
```

- Title: `<Feature> <i>/<n>: <what>`, numbered in dependency order.
- Refer to other tickets **only** as `{{key}}` placeholders. The script replaces them with the real `NEW-<N>` identifiers. The worker's "Zero" precheck reads blockers from the description, so a blocker written as "Pixels 2/7" alone is not caught. The script refuses a blocked ticket that does not mention its blocker.
- Be specific: file paths, ids, API shapes, limits, status codes. The worker has no other context.
- **Contracts (when cooperation matters).** Put each shared interface in a `**Contract: <name>**` section between Scope and Acceptance. Copy the text word for word into every ticket that provides or uses it: the ticket that defines it and every ticket that depends on it. Keep the text in one variable in your generator so the copies cannot drift. Say who defines it and who uses it, and say "implement it exactly; if it seems wrong, still implement it as written and explain the problem in the PR Notes", so no worker changes it quietly. Cover exact signatures and shapes (e.g. `subscribe(listener)` events, `ctx` members and when they are called), who owns what (routes, DOM containers that get re-rendered, reserved ids per plugin, CSS files), and rules that keep tickets independent (plugins do not import each other, order does not matter). Give behaviour that two tickets could both implement to exactly one of them (example: the page, not the countdown plugin, disables closed poll buttons).

## 5. Push to Linear with the script, not by hand

Write the spec to the scratchpad as JSON (`{"project_url": ..., "tickets": [{key, title, description}], "edges": [[blocker, blocked], ...]}`, UTF-8), then:

1. Dry run: `python3 .claude/skills/plan-feature/linear_batch.py <spec.json> --dry-run`. Check the order and the blockers.
2. Real run: the same command without `--dry-run`.

The script creates **everything in Backlog first**, fills in the identifiers, adds the relations, and only then moves the **root tickets (no blockers)** to `Todo`. **Dependent tickets stay in Backlog.** `scripts/linear_sync.py` (`promote_unblocked`) moves each one to Todo once every blocker's PR is merged on GitHub.

Do not activate dependents yourself. In the Pixels run (2026-09-29), dependents in Todo were started anyway: Contrabass does not count a blocker in Backlog or In Review as open. The worker's "Zero" precheck then stopped each run (`task failed`, 0 tokens), and Contrabass retried it over and over. Never use In Progress either: the reconciler treats an In Progress ticket without a Contrabass run as abandoned. The script is idempotent by title and re-checks Linear before retrying a failed create, because Linear often times out or returns 503 and the create may have succeeded anyway. If it fails partway, **just re-run it**; never create tickets with ad-hoc calls.

`LINEAR_API_KEY` lives in WSL's `~/.bashrc` and is not in the Windows environment. On this machine, run the script through WSL:
`wsl -d Ubuntu -e bash -ic 'cd /mnt/c/<repo path> && python3 .claude/skills/plan-feature/linear_batch.py /mnt/c/<spec path>'`
(`-i` is needed, because `.bashrc` is not read by non-interactive shells).

## 6. Verify and report

- Check the script's final table: every ticket is in the expected state with the expected blockers.
- A minute later, check that only the root tickets started: run the Linear query again, and `wsl -d Ubuntu -e bash -ic 'cd <repo> && bash scripts/cb status'`. If a dependent is running or is showing repeated `task failed` retries, move it back to Backlog and tell the user.
- Report to the user: the feature idea in two or three sentences, the tree as an ASCII diagram with the identifiers, why it is shaped that way (parallel leaves, conflict avoidance), and anything that went wrong along the way.
