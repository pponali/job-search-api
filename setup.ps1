# One-command setup for Windows (PowerShell 5.1+ / 7+).
# Usage:
#   powershell -ExecutionPolicy Bypass -File .\setup.ps1
$ErrorActionPreference = 'Stop'

Write-Host "==> Setup for Windows"

# ---------- 1. Prerequisite checks ----------
function Require-Cmd($cmd, $hint) {
  if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
    Write-Error "MISSING: $cmd — install it first ($hint)"
  }
}
Require-Cmd node    "https://nodejs.org/ (>=18)"
Require-Cmd npm     "comes with Node"
Require-Cmd python  "https://www.python.org/ (>=3.10)"
Require-Cmd git     "https://git-scm.com/"

$nodeMajor = [int]((node -v) -replace 'v','' -replace '\..*','')
if ($nodeMajor -lt 18) { Write-Error "Node 18+ required (found $(node -v))" }

$pyOk = (python -c "import sys;print(1 if sys.version_info>=(3,10) else 0)").Trim()
if ($pyOk -ne "1") { Write-Error "Python 3.10+ required" }

# ---------- 2. Node deps ----------
Write-Host "==> Installing Node deps..."
npm install --silent

# ---------- 3. Python venv + Playwright (optional) ----------
$ans = Read-Host "Set up Python venv with Playwright (for /apply endpoints)? [y/N]"
if ($ans -match '^[Yy]$') {
  Write-Host "==> Creating .venv ..."
  python -m venv .venv
  & .\.venv\Scripts\python.exe -m pip install --quiet --upgrade pip
  & .\.venv\Scripts\pip.exe install --quiet playwright pyyaml requests selenium undetected-chromedriver
  & .\.venv\Scripts\python.exe -m playwright install chromium
  Write-Host "==> Python venv ready at .venv\  (activate: .\.venv\Scripts\Activate.ps1)"
}

# ---------- 4. JobSpy MCP server (optional) ----------
$jobspyDir = if ($env:JOBSPY_DIR) { $env:JOBSPY_DIR } else { Join-Path $HOME "jobspy-mcp-server" }
if (-not (Test-Path $jobspyDir)) {
  $ans = Read-Host "Clone JobSpy MCP server into $jobspyDir? [y/N]"
  if ($ans -match '^[Yy]$') {
    git clone https://github.com/borgius/jobspy-mcp-server $jobspyDir
    Push-Location $jobspyDir; npm install --silent; Pop-Location
    pip install --quiet python-jobspy
    Write-Host "==> JobSpy MCP server installed at $jobspyDir"
  }
}

# ---------- 5. .env ----------
if (-not (Test-Path .env)) {
  Copy-Item .env.example .env
  Write-Host "==> Created .env (edit it now: set NOTION_KEY + NOTION_DB_ID at minimum)"
} else {
  Write-Host "==> .env already exists, leaving it alone"
}

# ---------- 6. Done ----------
Write-Host @"

==================================================================
 Setup complete.

 Next:
   1. Edit .env — set NOTION_KEY and NOTION_DB_ID
   2. (Optional) Install Claude CLI for /evaluate, /tailor-resume:
        npm install -g @anthropic-ai/claude-code; claude
   3. Start servers (use Git Bash or WSL — start-all.sh is bash):
        bash ./start-all.sh
      Or run the two services manually in separate PowerShell windows:
        node `$env:JOBSPY_DIR\src\index.js
        node server.mjs
   4. Trigger discovery:
        node discover-once.mjs
==================================================================
"@
