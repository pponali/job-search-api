#!/bin/bash
# Start JobSpy MCP server + Job Search API together.
# Pipeline runs MANUALLY — no scheduler/cron. Trigger discovery via:
#   node discover-once.mjs
# See README.md for full setup.

set -e

JOBSPY_DIR="${JOBSPY_DIR:-$HOME/jobspy-mcp-server}"
JOBSPY_PORT="${JOBSPY_PORT:-9423}"
API_PORT="${API_PORT:-9500}"

if [[ ! -d "$JOBSPY_DIR" ]]; then
  echo "ERR: jobspy-mcp-server not found at $JOBSPY_DIR"
  echo "     Set JOBSPY_DIR env var or clone https://github.com/borgius/jobspy-mcp-server"
  exit 1
fi

echo "Starting JobSpy MCP Server on port $JOBSPY_PORT..."
cd "$JOBSPY_DIR"
JOBSPY_SCRIPT="$JOBSPY_DIR/jobspy/main.py" \
  PYTHON_CMD=python3 \
  JOBSPY_HOST=0.0.0.0 \
  JOBSPY_PORT="$JOBSPY_PORT" \
  ENABLE_SSE=1 \
  node src/index.js &
JOBSPY_PID=$!

echo "Starting Job Search API on port $API_PORT..."
cd "$(dirname "$0")"
API_PORT="$API_PORT" node server.mjs &
API_PID=$!

echo ""
echo "Services started:"
echo "  JobSpy MCP Server: PID $JOBSPY_PID  (http://localhost:$JOBSPY_PORT)"
echo "  Job Search API:    PID $API_PID  (http://localhost:$API_PORT)"
echo ""
echo "Trigger discovery: node discover-once.mjs"

trap 'kill $JOBSPY_PID $API_PID 2>/dev/null' EXIT INT TERM
wait
