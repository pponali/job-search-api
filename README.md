# Job Search API

Manually-triggered job discovery + tracking pipeline. Pulls jobs from
[JobSpy](https://github.com/Bunsly/JobSpy) (LinkedIn, Indeed, Naukri, Glassdoor),
deduplicates them, tags region, and writes them to a Notion database. Optional
modules add LLM-based job evaluation, ATS-tailored resume generation, and
semi-automated application filling.

> **No scheduler / no n8n.** Every step is a CLI command. Run discovery when
> you want; review results in Notion.

---

## Architecture

```
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│ discover-once   │───▶│ Job Search API   │───▶│ Notion Database │
│ (CLI trigger)   │    │  (Express :9500) │    │   (your jobs)   │
└────────┬────────┘    └──────────────────┘    └─────────────────┘
         │                       │
         │                       ├──▶ career-ops    (optional, /evaluate)
         ▼                       ├──▶ AIHawk        (optional, /apply)
┌─────────────────┐              └──▶ Playwright    (optional, /apply-semi)
│ JobSpy MCP      │
│ Server (:9423)  │
└─────────────────┘
```

**Required:** Node 18+, Notion integration + DB.
**Optional:**
- Python 3.10+, Playwright (for `/apply*` endpoints)
- [JobSpy MCP server](https://github.com/borgius/jobspy-mcp-server) (for live discovery)
- [Claude Code CLI](https://docs.claude.com/claude-code) — required for `/evaluate`, `/generate-pdf`, `/tailor-resume`. The server shells out to the `claude` binary; auth is whatever the CLI is logged into (Pro/Max subscription or `ANTHROPIC_API_KEY`). No API key handling in this codebase.
- [career-ops](https://github.com/) repo, [AIHawk](https://github.com/feder-cr/Jobs_Applier_AI_Agent_AIHawk)

---

## Quick start

Clone the repo, then run the one-command setup script for your OS.

### Linux / macOS

```bash
git clone https://github.com/pponali/job-search-api.git
cd job-search-api
./setup.sh
```

### Windows (PowerShell)

```powershell
git clone https://github.com/pponali/job-search-api.git
cd job-search-api
powershell -ExecutionPolicy Bypass -File .\setup.ps1
```

The setup script:
1. Verifies Node 18+, Python 3.10+, git
2. Runs `npm install`
3. Optionally creates a Python venv with Playwright (for `/apply*` endpoints)
4. Optionally clones the JobSpy MCP server
5. Copies `.env.example` → `.env`

After it finishes, edit `.env` (set `NOTION_KEY` + `NOTION_DB_ID`), then:

```bash
./start-all.sh                  # macOS/Linux
bash ./start-all.sh             # Windows (Git Bash / WSL)
node discover-once.mjs          # trigger discovery (any OS)
```

---

## Notion database setup

Create a Notion database and share it with your integration. The schema below
matches what the API reads/writes. Add only the columns for the features you
plan to use.

### Required columns

| Property name | Type        | Notes                               |
|---------------|-------------|-------------------------------------|
| Role          | Title       | The job title                       |
| Company       | Rich text   |                                     |
| Job URL       | URL         | Used for deduplication              |
| Status        | Select      | `Discovered`, `Applied`, `Rejected` |
| Date Found    | Date        |                                     |
| Source        | Select      | `linkedin`, `indeed`, `naukri`...   |
| Region        | Select      | `India`, `US`, `EU`, `Remote-Global`|
| Dedup Key     | Rich text   | Auto-filled, do not edit            |

### Optional columns (used by specific endpoints)

| Property name        | Type      | Used by                           |
|----------------------|-----------|-----------------------------------|
| Score                | Number    | `/evaluate`                       |
| Archetype            | Select    | `/evaluate`                       |
| Recommendation       | Select    | `/evaluate`                       |
| Report #             | Rich text | `/evaluate`, `/tailor-resume`     |
| Notes                | Rich text |                                   |
| Location             | Rich text |                                   |
| Job Type             | Select    |                                   |
| Remote               | Checkbox  |                                   |
| Salary Min           | Number    |                                   |
| Salary Max           | Number    |                                   |
| Currency             | Rich text |                                   |
| Date Applied         | Date      |                                   |
| Resume File          | Files     | `/tailor-resume`, `/apply-semi`   |
| Resume Status        | Select    | `/tailor-resume`                  |
| Resume Generated At  | Date      | `/tailor-resume`                  |
| Resume Error         | Rich text | `/tailor-resume`                  |
| Cover Letter         | Rich text | `/apply-semi`                     |
| Apply Status         | Select    | `/apply-semi`                     |
| Apply Submit URL     | URL       | `/apply-semi`                     |
| Apply Logs           | Rich text | `/apply-semi`                     |
| Generate Resume      | Checkbox  | `resume-worker.mjs`               |
| Tailor Resume Now    | Checkbox  | `/tailor-resume` (Notion button)  |

---

## Manual triggers

### Discovery

Pulls from JobSpy and writes new rows to Notion (dedup-aware).

```bash
# Default: 8 results per archetype across Staff/Principal/Architect roles
node discover-once.mjs

# Single search term
node discover-once.mjs "Senior Backend Engineer" 10

# Multiple terms
node discover-once.mjs --terms "Staff Engineer,Principal Engineer" 5
```

### International search

```bash
node intl-job-search.mjs
```

### Batch evaluation (requires `CAREER_OPS_DIR`)

```bash
node evaluate-batch.mjs 10        # 10 unscored India rows
node evaluate-batch.mjs 10 all    # 10 unscored, all regions
```

### Cleanup duplicates

```bash
node cleanup-dupes.mjs            # dry run
node cleanup-dupes.mjs --apply    # archive duplicates + backfill keys
```

### Recompute regions

```bash
node retag-regions.mjs            # dry run
node retag-regions.mjs --apply
```

### Resume worker (long-running, optional)

Polls Notion for rows where `Generate Resume = true`, generates PDFs, and writes
back the URL. Run only when you want it active.

```bash
node resume-worker.mjs
```

---

## API reference

Health: `GET /health`

| Method | Path               | Purpose                                      |
|--------|--------------------|----------------------------------------------|
| POST   | /notion/add        | Add or update a job (dedup-aware)            |
| PATCH  | /notion/update     | Update status / notes / date                 |
| GET    | /notion/jobs       | Query jobs (`?status=...&min_score=...`)     |
| GET    | /notion/exists     | Duplicate check (`?company=...&role=...`)    |
| POST   | /evaluate          | LLM evaluation (requires `CAREER_OPS_DIR`)   |
| POST   | /generate-resume   | AIHawk resume gen (requires `AIHAWK_DIR`)    |
| POST   | /generate-pdf      | Career-ops PDF gen                           |
| POST   | /tailor-resume     | Synchronous tailored resume + push to GitHub |
| POST   | /apply             | Headless auto-apply (LinkedIn / Playwright)  |
| POST   | /apply-semi        | Semi-auto Indeed apply (pauses at submit)    |
| GET    | /tracker           | Read career-ops `applications.md`            |

---

## Optional integrations

These modules are wired in but disabled until their env vars / external repos
are set up. The core discovery → Notion flow works without any of them.

- **Claude Code CLI** — install with `npm i -g @anthropic-ai/claude-code` then run `claude` once to log in. Needed only for evaluation/resume endpoints.
- **career-ops** — Markdown-based CV + role evaluation pipeline. Set `CAREER_OPS_DIR`.
- **AIHawk** — Auto-apply agent. Set `AIHAWK_DIR` and place credentials in
  `$AIHAWK_DIR/data_folder/secrets.yaml`.
- **Tailored resume publishing** — Set `RESUMES_REPO` (local git repo with push
  rights) and `RESUMES_RAW_BASE` (public raw URL prefix).

---

## Security notes

- `.env` is gitignored. `linkedin_*`, `indeed_session.json`, and `*.log` are
  also gitignored — sessions and logs may contain PII.
- The `/apply*` endpoints execute headless browsers using your real accounts.
  Run only on a host you trust.
- The `/evaluate`, `/generate-pdf`, and `/tailor-resume` endpoints shell out to
  the `claude` CLI and to local repos. Treat the API as **localhost-only** —
  do not expose port 9500 publicly.

---

## License

MIT — see [LICENSE](./LICENSE).
