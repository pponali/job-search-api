#!/usr/bin/env bash
# One-command setup for Linux + macOS.
# Usage: ./setup.sh
set -euo pipefail

OS="$(uname -s)"
case "$OS" in
  Linux*)   PLATFORM=linux ;;
  Darwin*)  PLATFORM=mac ;;
  *)        echo "Unsupported OS: $OS (use setup.ps1 on Windows)"; exit 1 ;;
esac

echo "==> Setup for $PLATFORM"

# ---------- 1. Prerequisite checks ----------
need() {
  command -v "$1" >/dev/null 2>&1 || { echo "MISSING: $1 — install it first ($2)"; exit 1; }
}
need node    "https://nodejs.org/ (>=18)"
need npm     "comes with Node"
need python3 "https://www.python.org/ (>=3.10)"
need git     "https://git-scm.com/"

NODE_MAJOR="$(node -v | sed 's/v//;s/\..*//')"
[[ "$NODE_MAJOR" -ge 18 ]] || { echo "Node 18+ required (found $(node -v))"; exit 1; }

PY_OK="$(python3 -c 'import sys;print(1 if sys.version_info>=(3,10) else 0)')"
[[ "$PY_OK" == "1" ]] || { echo "Python 3.10+ required"; exit 1; }

# ---------- 2. Node deps ----------
echo "==> Installing Node deps..."
npm install --silent

# ---------- 3. Python venv + deps (optional, for /apply* endpoints) ----------
read -r -p "Set up Python venv with Playwright (for /apply endpoints)? [y/N] " ans
if [[ "${ans:-N}" =~ ^[Yy]$ ]]; then
  echo "==> Creating .venv ..."
  python3 -m venv .venv
  # shellcheck disable=SC1091
  source .venv/bin/activate
  pip install --quiet --upgrade pip
  pip install --quiet playwright pyyaml requests selenium undetected-chromedriver
  python -m playwright install chromium
  deactivate
  echo "==> Python venv ready at .venv/  (activate: source .venv/bin/activate)"
fi

# ---------- 4. JobSpy MCP server (optional) ----------
JOBSPY_DIR="${JOBSPY_DIR:-$HOME/jobspy-mcp-server}"
if [[ ! -d "$JOBSPY_DIR" ]]; then
  read -r -p "Clone JobSpy MCP server into $JOBSPY_DIR? [y/N] " ans
  if [[ "${ans:-N}" =~ ^[Yy]$ ]]; then
    git clone https://github.com/borgius/jobspy-mcp-server "$JOBSPY_DIR"
    (cd "$JOBSPY_DIR" && npm install --silent)
    pip3 install --quiet python-jobspy || python3 -m pip install --user python-jobspy
    echo "==> JobSpy MCP server installed at $JOBSPY_DIR"
  fi
fi

# ---------- 5. .env ----------
if [[ ! -f .env ]]; then
  cp .env.example .env
  echo "==> Created .env (edit it now: set NOTION_KEY + NOTION_DB_ID at minimum)"
else
  echo "==> .env already exists, leaving it alone"
fi

# ---------- 6. Done ----------
cat <<EOF

==================================================================
 Setup complete.

 Next:
   1. Edit .env — set NOTION_KEY and NOTION_DB_ID
   2. (Optional) Install Claude CLI for /evaluate, /tailor-resume:
        npm install -g @anthropic-ai/claude-code && claude
   3. Start servers:
        ./start-all.sh
   4. Trigger discovery (in another terminal):
        node discover-once.mjs
==================================================================
EOF
