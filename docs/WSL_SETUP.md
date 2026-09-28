# Contrabass + WSL setup

Status as of 2026-09-28. Explains where the pipeline runs, how to set it up
from scratch, the fixes that were needed, and how to inspect a running instance.

## Quick start on a fresh WSL (4 steps)

1. Create WSL: `wsl --install -d Ubuntu` (PowerShell), then open Ubuntu.
2. Run the bootstrap (installs tmux, node 22, gh, claude, omc, contrabass,
   git identity, clones the repo):
   ```bash
   bash /mnt/c/Users/shiva/Desktop/new-agent/docs/wsl-bootstrap.sh
   ```
   The bootstrap has not been tested end to end. It installs Contrabass via
   `go install github.com/junhoyeo/contrabass/cmd/contrabass@latest`; check
   that module path first if the install fails.
3. Interactive logins and secrets (cannot be scripted):
   ```bash
   gh auth login
   claude                      # complete the login, then exit
   echo 'export LINEAR_API_KEY="lin_api_..."' >> ~/.bashrc
   echo 'export PATH="$PATH:$HOME/.local/bin:$HOME/go/bin"' >> ~/.bashrc
   source ~/.bashrc
   ```
4. Start it (see "Start / restart" for why it is written this way):
   ```bash
   cd ~/new-agent
   tmux new -s cb "env -u TMUX -u TMUX_PANE contrabass --config .contrabass/WORKFLOW.md --port 8080"
   ```

Then put a ticket in Todo in the Linear project "New Agent".

## Architecture

- Contrabass runs inside **WSL Ubuntu**, not on Windows, from `~/new-agent`
  (WSL home). This is a separate clone from
  `C:\Users\shiva\Desktop\new-agent`, and each has its own
  `.contrabass/state/` and `workspaces/`.
- tmux session `cb` holds the TUI. In `goroutine` worker mode the agents run
  as `omc` teams, which create their own tmux sessions (`omc-team-...`).
- Agent runner is `omc` (`agent.type: omc`, `omc.team_spec: "2:claude"`).
  Each ticket runs `omc team 2:claude "<task>"` in an isolated workspace.
- Tracker: Linear, project "New Agent". Model: `claude-sonnet-5`.
- Repo: `https://github.com/starlinkee/new-agent`.

## Required config in `.contrabass/WORKFLOW.md`

```yaml
omc:
  binary_path: omc
  team_spec: "2:claude"
  startup_timeout_ms: 180000   # REQUIRED, default 15 s kills the start
team:
  worker_mode: goroutine       # REQUIRED, see below
```

**Why `worker_mode: goroutine`:** Contrabass 0.5.1 defaults to
`worker_mode: tmux`. In that mode it starts a pane running a bare `omc team`
with no spec and no task, so `omc` only prints its usage and the run ends in
about 3 seconds with `success_unverified_branch_unchanged`. With `goroutine`
it uses the OMC runner, which calls `omc team 2:claude "<task>"`.

**Why `startup_timeout_ms: 180000`:** Contrabass kills `omc team` after 15 s
by default, but starting two Claude workers takes longer. The run then fails
with `signal: killed` and is retried in a loop, opening and closing
`omc-team-*` sessions.

**Role keys in `.claude/omc.jsonc`** must be valid omc roles (orchestrator,
planner, analyst, architect, executor, debugger, critic, code-reviewer,
security-reviewer, test-engineer, designer, writer, code-simplifier, explore,
document-specialist). `lead`/`qa` are rejected with
`team.roleRouting: unknown role`. The file must be **committed**, because
agent workspaces are git worktrees and do not see uncommitted changes.

## Requirements in WSL

| Item | Notes |
|------|-------|
| tmux, git, node 22, npm | plain apt / NodeSource |
| `omc` | npm package `oh-my-claude-sisyphus` (5.5.0 verified) |
| `claude` | Claude Code CLI, installed to `~/.local/bin`. Log in once |
| `gh` | `gh auth login`, needed for the merge phase and PRs |
| `contrabass` | in `~/go/bin` (v0.5.1) |
| `LINEAR_API_KEY` | see the gotcha below |

`omc` launches every `claude` worker with `--dangerously-skip-permissions`,
so no permission prompts appear. If `ANTHROPIC_API_KEY` is set it also adds
`--bare`, which skips the interactive login.

## Gotchas

- **Claude Code asks interactive questions once per folder/install**, and
  worker panes wait on them forever (`worker_startup_evidence_missing`,
  `panes=0`). Pre-answer them once:
  ```bash
  python3 - <<'EOF'
  import json, os
  p = os.path.expanduser('~/.claude.json'); d = json.load(open(p))
  for k in ['/home/shiva/new-agent', '/home/shiva/new-agent/workspaces']:
      d.setdefault('projects', {}).setdefault(k, {})['hasTrustDialogAccepted'] = True
  json.dump(d, open(p, 'w'), indent=2)
  p = os.path.expanduser('~/.claude/settings.json')
  d = json.load(open(p)) if os.path.exists(p) else {}
  d['skipDangerousModePermissionPrompt'] = True
  json.dump(d, open(p, 'w'), indent=2)
  EOF
  ```
  Then start `claude --dangerously-skip-permissions --model sonnet` once in a
  workspace folder, answer the remaining one-time prompts (for example the
  "fullscreen renderer" notice, answer 2), and exit. Later starts are clean.
- **Start Contrabass without `$TMUX`.** If it runs inside the `cb` tmux
  session, `omc` adopts that window as its leader and tries to split panes in
  the TUI, and the workers never start. Use
  `env -u TMUX -u TMUX_PANE contrabass ...`.
- **tmux default size:** `omc` sessions are created detached at 80x24.
  `set -g default-size 220x60` in `~/.tmux.conf` avoids split-pane failures.
- **Do not `rm -rf workspaces/*` alone.** Workspaces are git worktrees.
  Remove them with `git worktree remove --force <dir>`, then
  `git worktree prune` and `git branch -D symphony/<ticket>`, or every retry
  fails with `a branch named 'symphony/...' already exists`.

- **`~/.bashrc` is not read by non-interactive shells.** `LINEAR_API_KEY`
  and the PATH additions placed there are invisible to `wsl -e bash -c ...`
  and to processes started that way. Contrabass then exits with
  `linear api key required`. When starting it from a script, load them
  explicitly:
  ```bash
  export PATH="$PATH:$HOME/.local/bin:$HOME/go/bin"
  eval "$(grep -E '^export LINEAR_' ~/.bashrc)"
  ```
- **`claude` lives in `~/.local/bin`**, which is not on the default PATH.
  If the process cannot find it, runs die immediately.
- **Sessions started from a one-shot `wsl -e` call die** when the command
  exits, unless detached with `setsid nohup`.
- **Default branch** is `master`; `WORKFLOW.md` now says `origin/master`
  in the rebase step.
- **GitHub secrets:** `ANTHROPIC_API_KEY` must exist. If the key is not
  scoped to a workspace, also add `ANTHROPIC_WORKSPACE_ID` (the scripts send
  it as the `anthropic-workspace-id` header). Without it the AI Jury job
  fails with `This API key is not scoped to a workspace`.
- The label `needs-expert-review` must exist in the repo (it does).
- **Adding the label:** use `gh issue edit <n> --add-label needs-expert-review`
  (or the REST API). `gh pr edit --add-label` fails on gh 2.46 with a
  Projects (classic) GraphQL deprecation error and adds nothing.
- **Merge doctor must use `pull_request_target`.** GitHub does not run
  `pull_request` workflows for a PR with merge conflicts, so the doctor would
  never fire on the PRs it exists for. It diffs against the merge base
  (`origin/<base>...pr-head`) and never executes PR code.
- Tested on 2026-09-28 with a throwaway conflicting PR: the label triggers the
  workflow, it checks out, diffs and reads the PR body; the comment step was
  verified with a stubbed Anthropic client. A real Opus reply still needs the
  workspace secret.
- **Two clones drift apart** (WSL and Windows). Work in WSL, sync via GitHub,
  and keep `WORKFLOW.md` identical in both.
- **Playwright QA** (`npm run test:ai`): the WSL clone has no `package.json`
  yet. When the app exists, run `npx playwright install --with-deps chromium`.

## Security

Workers run with all permissions bypassed, and inside WSL that includes your
`gh` token and read/write access to Windows files under `/mnt/c`.

- Keep the working clone in the WSL home, not on `/mnt/c`.
- Use a `gh` token limited to this one repository.
- Optionally disable the Windows mount in `/etc/wsl.conf`
  (`[automount] enabled=false`) if you do not need it.
- Enable branch protection on `master` so agents can only open PRs.

## Shortcut: the `cb` command

`scripts/cb` wraps everything below (loads the Linear key, unsets `$TMUX`,
runs detached in tmux). One-time install in WSL:

```bash
ln -sf ~/new-agent/scripts/cb ~/.local/bin/cb
```

| Command | Effect |
|---------|--------|
| `cb` | start if needed, then open the TUI (detach with `Ctrl-b d`, never `q`) |
| `cb start` / `cb stop` / `cb restart` | control the pipeline |
| `cb status` | sessions and the TUI header (agents, tokens, errors) |
| `cb agents` | list `omc-team-*` agent sessions; `cb agents <session>` attaches |
| `cb clean` | stop and wipe workspaces, worktrees, state and `symphony/*` branches (asks first) |

From Windows: `wsl -d Ubuntu -e bash -lc "cb status"`, or `wsl -d Ubuntu -e bash -lc cb`
to open the TUI.

## Start / restart (manual, what `cb` does)

```bash
tmux kill-session -t cb 2>/dev/null
cd ~/new-agent
# only to reset stale runs:
git worktree remove --force workspaces/* ; git worktree prune
git branch -D symphony/<ticket> 2>/dev/null   # only if it has no commits
rm -rf .contrabass/state
export PATH="$PATH:$HOME/.local/bin:$HOME/go/bin"
eval "$(grep -E '^export LINEAR_' ~/.bashrc)"
setsid nohup tmux new-session -d -s cb -x 200 -y 50 \
  "env -u TMUX -u TMUX_PANE contrabass --config .contrabass/WORKFLOW.md --port 8080; sleep 600" \
  >/dev/null 2>&1 </dev/null &
tmux attach -t cb
```

The trailing `sleep 600` keeps the pane open so an error message stays
readable if Contrabass exits.

## Verify the setup

```bash
command -v claude omc tmux gh node contrabass   # all must resolve
claude --version && gh auth status
mkdir /tmp/t && cd /tmp/t && git init -q && git commit -q --allow-empty -m init
omc team 1:claude --no-decompose "create hello.txt containing hi"
omc team shutdown <team-name> --force           # clean up afterwards
```

Then start Contrabass and confirm a Todo ticket shows `Agents: 1/5` for
more than a few seconds and commits appear on `symphony/<ticket>`.

## Watching agents

- TUI keys: `j`/`k` move, `Enter` opens the detail view, `Tab` switches
  panel, `?` help, `q` quit.
- Agent sessions: `tmux ls`, then `tmux attach -t <omc-team-...>`
  (detach with `Ctrl-b d`).
- Snapshot without attaching: `tmux capture-pane -p -t <pane> -S -200`.
- From Windows: `wsl -d Ubuntu -e bash -lc "tmux capture-pane -p -t cb"`.
  Put multi-line or `$(...)` commands in a script file and run it with
  `wsl -d Ubuntu -e bash /mnt/c/.../script.sh`, because PowerShell mangles `$`.
- Run history: `.contrabass/state/workflow-timeline/<issue-id>.jsonl`.
- Worker events and heartbeats: `.contrabass/state/team/orchestrator/`.

## Diagnosing a failed run

| Symptom | Cause |
|---------|-------|
| `linear api key required` on start | key not loaded, see the `.bashrc` gotcha |
| Run ends in ~3 s, `success_unverified_branch_unchanged` | `worker_mode` is `tmux`, or `claude` is missing/not logged in |
| Pane shows `omc team` usage text | same `worker_mode: tmux` problem |
| TUI shows `Agents: 0/5` and nothing happens | no ticket in a pickup state; move one to Todo in Linear |
| Stuck at `Init` for minutes | check the `omc-team-*` tmux session; usually a Claude prompt (see gotchas) |
| `signal: killed` in `start_failed`, sessions open/close in a loop | `omc.startup_timeout_ms` too low |
| `unknown role "lead"` | old `.claude/omc.jsonc` committed; commit the corrected one |
| `branch ... already exists` on every retry | stale worktree, see gotchas |
| Jury fails: `not scoped to a workspace` | add `ANTHROPIC_WORKSPACE_ID` secret |

Also check `git log master..symphony/<ticket>` in the WSL clone to see
whether the agents produced commits.
