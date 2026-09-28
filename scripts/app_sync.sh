#!/usr/bin/env bash
# Runs the app from master at http://localhost:$PORT and keeps it current: when origin/master
# moves (a PR was merged), fast-forward this clone and restart the server.
# Started and stopped by `cb` (tmux session "app"); `cb app-log` shows this output.
# It runs from its own clean clone (never the working clone: that one has local edits and
# Contrabass worktrees, so a fast-forward there would fail or disturb the agents).
SRC="${CB_REPO:-$HOME/new-agent}"
APP_DIR="${APP_DIR:-$HOME/new-agent-app}"
if [ ! -d "$APP_DIR/.git" ]; then
  git clone -q "$(git -C "$SRC" remote get-url origin)" "$APP_DIR" || exit 1
fi
cd "$APP_DIR" || exit 1
export PORT="${PORT:-3000}"
INTERVAL="${APP_SYNC_INTERVAL:-30}"
pid=""
log() { echo "$(date +%H:%M:%S) $*"; }
start_app() { node src/server.js & pid=$!; log "app started (pid $pid, $(git rev-parse --short HEAD))"; }
stop_app() { [ -n "$pid" ] && kill "$pid" 2>/dev/null && wait "$pid" 2>/dev/null; pid=""; }
trap 'stop_app; exit 0' TERM INT HUP

start_app
failed_at=""
while sleep "$INTERVAL"; do
  kill -0 "$pid" 2>/dev/null || { log "app exited, restarting"; start_app; }
  git fetch -q origin master 2>/dev/null || continue  # network hiccup: try next round
  new=$(git rev-parse origin/master)
  [ "$(git rev-parse HEAD)" = "$new" ] && continue
  [ "$failed_at" = "$new" ] && continue  # already reported, do not spam
  if [ "$(git branch --show-current)" = master ] && git merge -q --ff-only origin/master; then
    stop_app; start_app
  else
    failed_at="$new"
    log "cannot fast-forward to ${new:0:7} (not on master, or local changes in the way) - app left on old code"
  fi
done
