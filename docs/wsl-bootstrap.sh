#!/usr/bin/env bash
# Bootstrap a fresh WSL Ubuntu for the Contrabass pipeline.
# Usage (inside WSL):  bash wsl-bootstrap.sh
set -euo pipefail

REPO_URL="https://github.com/starlinkee/new-agent.git"
GIT_NAME="viktor"
GIT_EMAIL="vikbobinski@gmail.com"

echo "==> System packages"
sudo apt-get update
sudo apt-get install -y tmux git curl build-essential golang-go

echo "==> Node 22 (NodeSource)"
if ! command -v node >/dev/null || [ "$(node -v | cut -d. -f1 | tr -d v)" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi

echo "==> GitHub CLI"
if ! command -v gh >/dev/null; then
  sudo mkdir -p -m 755 /etc/apt/keyrings
  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg |
    sudo tee /etc/apt/keyrings/githubcli-archive-keyring.gpg >/dev/null
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" |
    sudo tee /etc/apt/sources.list.d/github-cli.list >/dev/null
  sudo apt-get update && sudo apt-get install -y gh
fi

echo "==> Claude Code, oh-my-claudecode (omc), Contrabass"
sudo npm i -g @anthropic-ai/claude-code oh-my-claude-sisyphus
go install github.com/junhoyeo/contrabass/cmd/contrabass@latest
grep -q 'go/bin' ~/.bashrc || echo 'export PATH="$PATH:$HOME/go/bin"' >> ~/.bashrc
export PATH="$PATH:$HOME/go/bin"

echo "==> Git identity + repo"
git config --global user.name "$GIT_NAME"
git config --global user.email "$GIT_EMAIL"
[ -d ~/new-agent ] || git clone "$REPO_URL" ~/new-agent

echo "==> tmux size + Claude prompts"
grep -q default-size ~/.tmux.conf 2>/dev/null || echo 'set -g default-size 220x60' >> ~/.tmux.conf
grep -q '.local/bin' ~/.bashrc || echo 'export PATH="$PATH:$HOME/.local/bin"' >> ~/.bashrc
mkdir -p ~/.claude
python3 - <<'PY'
import json, os
p = os.path.expanduser('~/.claude/settings.json')
d = json.load(open(p)) if os.path.exists(p) else {}
d['skipDangerousModePermissionPrompt'] = True
json.dump(d, open(p, 'w'), indent=2)
PY

echo "==> Verify"
for c in tmux node npm gh claude omc contrabass git; do
  printf '%-12s' "$c"; command -v "$c" || echo MISSING
done

cat <<'EOF'

Manual steps left (interactive, cannot be scripted):
  1. gh auth login
  2. claude            # complete the login, then exit
  3. export the Linear API key in ~/.bashrc (see docs/WSL_SETUP.md)
  4. run `claude --dangerously-skip-permissions` once in a scratch folder under
     ~/new-agent and answer the one-time prompts (folder trust: see docs/WSL_SETUP.md)
  5. cd ~/new-agent && tmux new -s cb "env -u TMUX -u TMUX_PANE contrabass --config .contrabass/WORKFLOW.md --port 8080"
EOF
