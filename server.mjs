import 'dotenv/config';
import express from 'express';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const execFileAsync = promisify(execFile);

const app = express();
app.use(express.json({ limit: '1mb' }));

const PORT = process.env.API_PORT || 9500;
const CAREER_OPS_DIR = process.env.CAREER_OPS_DIR || '';
const AIHAWK_DIR = process.env.AIHAWK_DIR || '';
const NOTION_KEY = process.env.NOTION_KEY || '';
const NOTION_DB_ID = process.env.NOTION_DB_ID || '';

if (!NOTION_KEY || !NOTION_DB_ID) {
  console.error('FATAL: NOTION_KEY and NOTION_DB_ID env vars are required. Copy .env.example to .env and fill in.');
  process.exit(1);
}

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', services: ['career-ops', 'aihawk', 'jobspy'] });
});

// ============================================================
// 1. CAREER-OPS EVALUATION API
// ============================================================

app.post('/evaluate', async (req, res) => {
  const { jd_text, jd_url } = req.body;
  if (!jd_text && !jd_url) {
    return res.status(400).json({ error: 'Provide jd_text or jd_url' });
  }

  try {
    // Determine next report number
    const reportsDir = path.join(CAREER_OPS_DIR, 'reports');
    if (!existsSync(reportsDir)) await mkdir(reportsDir, { recursive: true });

    const reportNum = await getNextReportNum(reportsDir);
    const date = new Date().toISOString().slice(0, 10);
    const paddedNum = String(reportNum).padStart(3, '0');

    // Write JD to temp file if text provided
    let jdSource = jd_url || '';
    const jdDir = path.join(CAREER_OPS_DIR, 'jds');
    if (!existsSync(jdDir)) await mkdir(jdDir, { recursive: true });

    if (jd_text) {
      const jdFile = path.join(jdDir, `n8n-${paddedNum}.txt`);
      await writeFile(jdFile, jd_text, 'utf-8');
      jdSource = jd_text.slice(0, 3000);
    }

    // Build the evaluation prompt
    const prompt = buildEvalPrompt(jdSource, jd_url, paddedNum, date);

    // Run claude -p in career-ops directory
    const result = await runClaude(prompt, CAREER_OPS_DIR, 300000);

    // Parse score from the output
    const parsed = parseEvaluation(result.stdout);

    res.json({
      success: true,
      report_num: paddedNum,
      date,
      ...parsed,
      raw_output: result.stdout,
    });
  } catch (error) {
    console.error('Evaluation error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// 2. AIHAWK RESUME GENERATION API
// ============================================================

app.post('/generate-resume', async (req, res) => {
  const { job_url, action = 'resume' } = req.body;
  if (!job_url) {
    return res.status(400).json({ error: 'Provide job_url' });
  }

  try {
    const validActions = ['resume', 'cover_letter', 'both'];
    if (!validActions.includes(action)) {
      return res.status(400).json({ error: `action must be one of: ${validActions.join(', ')}` });
    }

    const result = await execFileAsync('python3', [
      path.join(AIHAWK_DIR, 'main.py'),
      '--job-url', job_url,
      '--action', action,
      '--headless',
    ], {
      cwd: AIHAWK_DIR,
      timeout: 180000,
      env: { ...process.env, PYTHONPATH: AIHAWK_DIR },
    });

    res.json({
      success: true,
      output: result.stdout,
      action,
      job_url,
    });
  } catch (error) {
    console.error('AIHawk error:', error.message);
    res.status(500).json({ error: error.message, stderr: error.stderr });
  }
});

// ============================================================
// 3. CAREER-OPS PDF GENERATION API
// ============================================================

app.post('/generate-pdf', async (req, res) => {
  const { report_num, company, role } = req.body;
  if (!report_num) {
    return res.status(400).json({ error: 'Provide report_num' });
  }

  try {
    const prompt = `Read the evaluation report reports/${report_num}-*.md. Generate an ATS-optimized PDF for this role using the cv-template.html template and generate-pdf.mjs script. Output the PDF path when done.`;

    const result = await runClaude(prompt, CAREER_OPS_DIR, 120000);

    res.json({
      success: true,
      report_num,
      output: result.stdout,
    });
  } catch (error) {
    console.error('PDF generation error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// 4. CAREER-OPS TRACKER API
// ============================================================

app.get('/tracker', async (req, res) => {
  try {
    const trackerPath = path.join(CAREER_OPS_DIR, 'data', 'applications.md');
    if (!existsSync(trackerPath)) {
      return res.json({ applications: [] });
    }
    const content = await readFile(trackerPath, 'utf-8');
    const applications = parseTracker(content);
    res.json({ count: applications.length, applications });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// 5. NOTION TRACKER API
// ============================================================

// Add a job to Notion tracker (dedup-aware: update-or-insert)
app.post('/notion/add', async (req, res) => {
  const { role, company, score, status, archetype, recommendation, location,
          job_url, job_type, is_remote, salary_min, salary_max, currency,
          source, report_num, date_found, notes } = req.body;

  if (!role || !company) {
    return res.status(400).json({ error: 'Provide at least role and company' });
  }

  try {
    const dedupKey = normalizeUrl(job_url) || `${company.toLowerCase()}::${role.toLowerCase()}`;
    const region = tagRegion(location, is_remote);

    const existing = await notionFindByDedupKey(dedupKey, company, role);
    if (existing) {
      const refreshed = await notionUpdate(existing.id, buildJobProperties({
        role, company, score, status, archetype, recommendation, location,
        job_url, job_type, is_remote, salary_min, salary_max, currency,
        source, report_num, date_found, notes, region, dedup_key: dedupKey,
      }, { skipTitle: true }));
      return res.json({ success: true, page_id: refreshed.id, url: refreshed.url, deduped: true });
    }

    const result = await notionAddJob({
      role, company, score, status, archetype, recommendation, location,
      job_url, job_type, is_remote, salary_min, salary_max, currency,
      source, report_num, date_found, notes, region, dedup_key: dedupKey,
    });
    res.json({ success: true, page_id: result.id, url: result.url, deduped: false });
  } catch (error) {
    console.error('Notion add error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Update job status in Notion
app.patch('/notion/update', async (req, res) => {
  const { page_id, status, notes, date_applied } = req.body;
  if (!page_id) {
    return res.status(400).json({ error: 'Provide page_id' });
  }

  try {
    const properties = {};
    if (status) properties['Status'] = { select: { name: status } };
    if (notes) properties['Notes'] = { rich_text: [{ text: { content: notes } }] };
    if (date_applied) properties['Date Applied'] = { date: { start: date_applied } };

    const result = await notionUpdate(page_id, properties);
    res.json({ success: true, page_id: result.id });
  } catch (error) {
    console.error('Notion update error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Query Notion tracker
app.get('/notion/jobs', async (req, res) => {
  const { status, min_score } = req.query;
  try {
    const result = await notionQuery(status, min_score ? parseFloat(min_score) : null);
    res.json({ count: result.length, jobs: result });
  } catch (error) {
    console.error('Notion query error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Check for duplicate before adding
app.get('/notion/exists', async (req, res) => {
  const { company, role } = req.query;
  if (!company || !role) {
    return res.status(400).json({ error: 'Provide company and role' });
  }
  try {
    const exists = await notionCheckDuplicate(company, role);
    res.json({ exists, company, role });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// HELPERS
// ============================================================

async function notionFetch(endpoint, method = 'GET', body = null) {
  const options = {
    method,
    headers: {
      'Authorization': `Bearer ${NOTION_KEY}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json',
    },
  };
  if (body) options.body = JSON.stringify(body);
  const resp = await fetch(`https://api.notion.com/v1${endpoint}`, options);
  if (!resp.ok) {
    const err = await resp.json();
    throw new Error(`Notion API: ${err.message}`);
  }
  return resp.json();
}

function buildJobProperties(job, opts = {}) {
  const properties = {};
  if (!opts.skipTitle && job.role) {
    properties['Role'] = { title: [{ text: { content: job.role } }] };
  }
  if (job.company) properties['Company'] = { rich_text: [{ text: { content: job.company } }] };
  if (job.score != null) properties['Score'] = { number: job.score };
  if (job.status) properties['Status'] = { select: { name: job.status } };
  if (job.archetype) properties['Archetype'] = { select: { name: job.archetype } };
  if (job.recommendation) properties['Recommendation'] = { select: { name: job.recommendation } };
  if (job.location) properties['Location'] = { rich_text: [{ text: { content: job.location } }] };
  if (job.job_url) properties['Job URL'] = { url: job.job_url };
  if (job.job_type) properties['Job Type'] = { select: { name: job.job_type } };
  if (job.is_remote != null) properties['Remote'] = { checkbox: !!job.is_remote };
  if (job.salary_min != null) properties['Salary Min'] = { number: job.salary_min };
  if (job.salary_max != null) properties['Salary Max'] = { number: job.salary_max };
  if (job.currency) properties['Currency'] = { rich_text: [{ text: { content: job.currency } }] };
  if (job.source) properties['Source'] = { select: { name: job.source } };
  if (job.report_num) properties['Report #'] = { rich_text: [{ text: { content: job.report_num } }] };
  if (job.date_found) properties['Date Found'] = { date: { start: job.date_found } };
  if (job.notes) properties['Notes'] = { rich_text: [{ text: { content: job.notes.slice(0, 2000) } }] };
  if (job.region) properties['Region'] = { select: { name: job.region } };
  if (job.dedup_key) properties['Dedup Key'] = { rich_text: [{ text: { content: job.dedup_key } }] };
  return properties;
}

async function notionAddJob(job) {
  return notionFetch('/pages', 'POST', {
    parent: { database_id: NOTION_DB_ID },
    properties: buildJobProperties(job),
  });
}

function normalizeUrl(url) {
  if (!url) return '';
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    const keep = new Set(['jobid', 'currentjobid', 'gh_jid', 'jk', 'job_id']);
    const params = [];
    for (const [k, v] of u.searchParams.entries()) {
      if (keep.has(k.toLowerCase())) params.push(`${k.toLowerCase()}=${v}`);
    }
    params.sort();
    const path = u.pathname.toLowerCase().replace(/\/$/, '');
    return `${host}${path}${params.length ? '?' + params.join('&') : ''}`;
  } catch {
    return url.toLowerCase().trim();
  }
}

function tagRegion(location, isRemote) {
  const loc = (location || '').toLowerCase().trim();
  // India: country code "IN" suffix or city/state token
  if (/(^|,\s|\s)in(\s|$)/.test(loc)) return 'India';
  if (/,\s*india(\s|$)/.test(loc) || loc === 'india') return 'India';
  const indiaTokens = ['india', 'bangalore', 'bengaluru', 'hyderabad', 'pune', 'mumbai',
                       'delhi', 'chennai', 'gurgaon', 'gurugram', 'noida', 'kolkata',
                       'ahmedabad', 'kochi', 'trivandrum', 'jaipur'];
  if (indiaTokens.some(t => loc.includes(t))) return 'India';
  // US: country code "US" suffix or state code or city
  if (/,\s*us(\s|$)/.test(loc) || /,\s*usa(\s|$)/.test(loc)) return 'US';
  const usTokens = ['united states', 'california', 'new york', 'texas',
                    'seattle', 'san francisco', 'boston', 'austin', 'chicago'];
  if (usTokens.some(t => loc.includes(t))) return 'US';
  // EU
  if (/,\s*(uk|gb|de|fr|nl|ie|es|pl|it|se|fi|no|dk)(\s|$)/.test(loc)) return 'EU';
  const euTokens = ['united kingdom', 'london', 'germany', 'berlin', 'amsterdam',
                    'netherlands', 'france', 'paris', 'ireland', 'dublin', 'spain',
                    'madrid', 'poland', 'warsaw'];
  if (euTokens.some(t => loc.includes(t))) return 'EU';
  // Remote
  if (isRemote && !loc) return 'Remote-Global';
  if (loc.includes('remote')) return 'Remote-Global';
  return 'Other';
}

async function notionFindByDedupKey(dedupKey, company, role) {
  if (dedupKey) {
    const r = await notionFetch(`/databases/${NOTION_DB_ID}/query`, 'POST', {
      filter: { property: 'Dedup Key', rich_text: { equals: dedupKey } },
      page_size: 1,
    });
    if (r.results[0]) return r.results[0];
  }
  if (company && role) {
    const r = await notionFetch(`/databases/${NOTION_DB_ID}/query`, 'POST', {
      filter: {
        and: [
          { property: 'Company', rich_text: { equals: company } },
          { property: 'Role', title: { equals: role } },
        ],
      },
      page_size: 1,
    });
    if (r.results[0]) return r.results[0];
  }
  return null;
}

async function notionUpdate(pageId, properties) {
  return notionFetch(`/pages/${pageId}`, 'PATCH', { properties });
}

async function notionQuery(status, minScore) {
  const filters = [];
  if (status) filters.push({ property: 'Status', select: { equals: status } });
  if (minScore) filters.push({ property: 'Score', number: { greater_than_or_equal_to: minScore } });

  const filter = filters.length > 1
    ? { and: filters }
    : filters.length === 1 ? filters[0] : undefined;

  const body = { sorts: [{ property: 'Score', direction: 'descending' }] };
  if (filter) body.filter = filter;

  const result = await notionFetch(`/databases/${NOTION_DB_ID}/query`, 'POST', body);

  return result.results.map(page => {
    const p = page.properties;
    return {
      page_id: page.id,
      role: p['Role']?.title?.[0]?.plain_text || '',
      company: p['Company']?.rich_text?.[0]?.plain_text || '',
      score: p['Score']?.number,
      status: p['Status']?.select?.name || '',
      archetype: p['Archetype']?.select?.name || '',
      recommendation: p['Recommendation']?.select?.name || '',
      location: p['Location']?.rich_text?.[0]?.plain_text || '',
      job_url: p['Job URL']?.url || '',
      source: p['Source']?.select?.name || '',
      date_found: p['Date Found']?.date?.start || '',
      notes: p['Notes']?.rich_text?.[0]?.plain_text || '',
      job_type: p['Job Type']?.select?.name || '',
      is_remote: p['Remote']?.checkbox || false,
      salary_min: p['Salary Min']?.number || null,
      salary_max: p['Salary Max']?.number || null,
      currency: p['Currency']?.rich_text?.[0]?.plain_text || '',
      report_num: p['Report #']?.rich_text?.[0]?.plain_text || '',
      date_added: page.created_time ? page.created_time.slice(0, 10) : '',
    };
  });
}

async function notionCheckDuplicate(company, role) {
  const result = await notionFetch(`/databases/${NOTION_DB_ID}/query`, 'POST', {
    filter: {
      and: [
        { property: 'Company', rich_text: { equals: company } },
        { property: 'Role', title: { equals: role } },
      ],
    },
  });
  return result.results.length > 0;
}

async function runClaude(prompt, cwd, timeout = 120000) {
  return new Promise((resolve, reject) => {
    const child = spawn('claude', ['-p', '--output-format', 'text'], {
      cwd,
      timeout,
      env: { ...process.env },
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => { stdout += data.toString(); });
    child.stderr.on('data', (data) => { stderr += data.toString(); });

    child.stdin.write(prompt);
    child.stdin.end();

    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`claude exited with code ${code}: ${stderr}`));
      } else {
        resolve({ stdout, stderr });
      }
    });

    child.on('error', reject);
  });
}

function buildEvalPrompt(jdSource, jdUrl, reportNum, date) {
  const urlLine = jdUrl ? `\n**URL:** ${jdUrl}` : '';
  return `You are a career-ops evaluation worker. Read cv.md, config/profile.yml, and modes/_profile.md first.

Evaluate this job offer using the A-F block system from modes/_shared.md and modes/oferta.md.
${urlLine}

**Job Description:**
${jdSource}

**Instructions:**
1. Read cv.md and article-digest.md (if exists) for candidate profile
2. Read modes/_shared.md for scoring system
3. Detect archetype
4. Run all 6 blocks (A through F)
5. Output a global score (1-5)
6. Save the report to reports/${reportNum}-eval-${date}.md

**CRITICAL: At the very end of your response, output a JSON summary on a single line starting with EVAL_JSON:**
EVAL_JSON:{"score": <number>, "company": "<name>", "role": "<title>", "archetype": "<type>", "recommendation": "<apply|skip|caution>"}`;
}

function parseEvaluation(output) {
  const jsonMatch = output.match(/EVAL_JSON:\s*(\{[^}]+\})/);
  if (jsonMatch) {
    try {
      const data = JSON.parse(jsonMatch[1]);
      return {
        score: data.score,
        company: data.company,
        role: data.role,
        archetype: data.archetype,
        recommendation: data.recommendation,
      };
    } catch (e) {
      // Fall through to regex parsing
    }
  }

  // Fallback: try to extract score from output
  const scoreMatch = output.match(/(?:global|score|puntuaci[oó]n)[:\s]*(\d+\.?\d*)\s*\/\s*5/i);
  return {
    score: scoreMatch ? parseFloat(scoreMatch[1]) : null,
    company: null,
    role: null,
    archetype: null,
    recommendation: null,
  };
}

async function getNextReportNum(reportsDir) {
  const { readdir } = await import('node:fs/promises');
  try {
    const files = await readdir(reportsDir);
    const nums = files
      .map(f => parseInt(f.match(/^(\d+)/)?.[1] || '0'))
      .filter(n => n > 0);
    return nums.length > 0 ? Math.max(...nums) + 1 : 1;
  } catch {
    return 1;
  }
}

function parseTracker(content) {
  const lines = content.split('\n').filter(l => l.startsWith('|') && !l.includes('---'));
  if (lines.length < 2) return [];

  const headers = lines[0].split('|').map(h => h.trim().toLowerCase()).filter(Boolean);
  return lines.slice(1).map(line => {
    const cells = line.split('|').map(c => c.trim()).filter(Boolean);
    const obj = {};
    headers.forEach((h, i) => { obj[h] = cells[i] || ''; });
    return obj;
  }).filter(obj => obj['#'] && obj['#'] !== '#');
}

// ============================================================
// 6a. SYNC TAILORED RESUME (Notion button webhook)
// ============================================================
// Notion button → "Send webhook" to: POST /tailor-resume?page_id=<page_id>
// Or pass {"data":{"id":"<page_id>"}} body — Notion sends page context.
// Synchronous: blocks until PDF generated + URL written back to Notion.

app.post('/tailor-resume', async (req, res) => {
  const pageId = req.query.page_id || req.body?.page_id || req.body?.data?.id;
  if (!pageId) return res.status(400).json({ error: 'page_id required (query or body.data.id)' });

  const startedAt = Date.now();
  try {
    // 1. Read page
    const page = await notionFetch(`/pages/${pageId}`);
    const p = page.properties;
    const role = p['Role']?.title?.[0]?.plain_text || '';
    const company = p['Company']?.rich_text?.[0]?.plain_text || '';
    const reportNum = p['Report #']?.rich_text?.[0]?.plain_text || '';
    const jobUrl = p['Job URL']?.url || '';
    const notes = p['Notes']?.rich_text?.[0]?.plain_text || '';

    if (!role || !company) {
      return res.status(400).json({ error: 'Page missing Role or Company' });
    }

    // 2. Mark Generating
    await notionUpdate(pageId, {
      'Resume Status': { select: { name: 'Generating' } },
      'Resume Error': { rich_text: [{ text: { content: '' } }] },
    });

    // 3. If no Report # yet, run /evaluate-style call inline (use notes as JD if present)
    let effectiveReportNum = reportNum;
    if (!effectiveReportNum) {
      const reportsDir = path.join(CAREER_OPS_DIR, 'reports');
      if (!existsSync(reportsDir)) await mkdir(reportsDir, { recursive: true });
      const num = await getNextReportNum(reportsDir);
      effectiveReportNum = String(num).padStart(3, '0');
      const date = new Date().toISOString().slice(0, 10);
      const jdText = notes || `Job: ${role} at ${company}. URL: ${jobUrl}`;
      const evalPrompt = buildEvalPrompt(jdText.slice(0, 3000), jobUrl, effectiveReportNum, date);
      await runClaude(evalPrompt, CAREER_OPS_DIR, 300000);
      await notionUpdate(pageId, {
        'Report #': { rich_text: [{ text: { content: effectiveReportNum } }] },
      });
    }

    // 4. Generate PDF synchronously
    const pdfPrompt = `Read the evaluation report reports/${effectiveReportNum}-*.md. Generate an ATS-optimized tailored resume PDF for ${company} - ${role} using cv-template.html template and generate-pdf.mjs. The PDF must be saved to output/ directory. Print only the absolute output PDF path on the last line.`;
    await runClaude(pdfPrompt, CAREER_OPS_DIR, 300000);

    const pdfPath = await findGeneratedPdf(effectiveReportNum, company);
    if (!existsSync(pdfPath)) throw new Error(`PDF not found at ${pdfPath}`);

    // 5. Commit + push to GitHub
    const stamp = new Date().toISOString().slice(0, 10);
    const slug = `${company.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${role.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`.replace(/^-|-$/g, '');
    const fileName = `${stamp}-${slug}.pdf`;
    const fileUrl = await commitToGithub(pdfPath, fileName);

    // 6. Write back to Notion
    await notionUpdate(pageId, {
      'Resume File': { files: [{ name: fileName, external: { url: fileUrl } }] },
      'Resume Generated At': { date: { start: new Date().toISOString() } },
      'Resume Status': { select: { name: 'Ready' } },
      'Generate Resume': { checkbox: false },
      'Tailor Resume Now': { checkbox: false },
    });

    const elapsedMs = Date.now() - startedAt;
    res.json({
      success: true, page_id: pageId, role, company, report_num: effectiveReportNum,
      resume_url: fileUrl, file_name: fileName, elapsed_ms: elapsedMs,
    });
  } catch (error) {
    console.error('Tailor-resume error:', error.message);
    try {
      await notionUpdate(pageId, {
        'Resume Status': { select: { name: 'Failed' } },
        'Resume Error': { rich_text: [{ text: { content: error.message.slice(0, 1500) } }] },
        'Tailor Resume Now': { checkbox: false },
      });
    } catch {}
    res.status(500).json({ error: error.message });
  }
});

// Helpers shared with resume-worker (inline copies)
async function findGeneratedPdf(reportNum, company) {
  const { readdir } = await import('node:fs/promises');
  const outputDir = path.join(CAREER_OPS_DIR, 'output');
  const files = (await readdir(outputDir)).filter(f => f.endsWith('.pdf'));
  const slug = (company || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const matched = files.find(f => f.toLowerCase().includes(slug));
  if (matched) return path.join(outputDir, matched);
  // most recent
  const stats = await Promise.all(files.map(async f => ({ f, m: (await import('node:fs/promises')).stat(path.join(outputDir, f)) })));
  return path.join(outputDir, files[0]);
}

async function commitToGithub(pdfPath, fileName) {
  const RESUMES_REPO = process.env.RESUMES_REPO;
  const RESUMES_RAW_BASE = process.env.RESUMES_RAW_BASE;
  if (!RESUMES_REPO || !RESUMES_RAW_BASE) {
    throw new Error('RESUMES_REPO and RESUMES_RAW_BASE env vars must be set to push tailored resumes.');
  }
  const targetDir = path.join(RESUMES_REPO, 'resumes');
  await execFileAsync('mkdir', ['-p', targetDir]);
  await execFileAsync('cp', [pdfPath, path.join(targetDir, fileName)]);
  await execFileAsync('git', ['add', `resumes/${fileName}`], { cwd: RESUMES_REPO });
  try { await execFileAsync('git', ['commit', '-m', `resume: add ${fileName}`], { cwd: RESUMES_REPO }); } catch {}
  await execFileAsync('git', ['push'], { cwd: RESUMES_REPO });
  return `${RESUMES_RAW_BASE}/${fileName}`;
}

// ============================================================
// 6b. SEMI-AUTO INDEED APPLY (stops at submit, returns URL)
// ============================================================
// Notion button → POST /apply-semi?page_id=<page_id>
// Reads Job URL + Resume File from page, opens Indeed in headed browser,
// fills form, PAUSES BEFORE SUBMIT, returns the submit-page URL + screenshot.

app.post('/apply-semi', async (req, res) => {
  const pageId = req.query.page_id || req.body?.page_id || req.body?.data?.id;
  if (!pageId) return res.status(400).json({ error: 'page_id required' });

  try {
    const page = await notionFetch(`/pages/${pageId}`);
    const p = page.properties;
    const jobUrl = p['Job URL']?.url || '';
    const resumeUrl = p['Resume File']?.files?.[0]?.external?.url || p['Resume File']?.files?.[0]?.file?.url || '';
    const coverLetter = p['Cover Letter']?.rich_text?.[0]?.plain_text || '';
    const role = p['Role']?.title?.[0]?.plain_text || '';
    const company = p['Company']?.rich_text?.[0]?.plain_text || '';

    if (!jobUrl) return res.status(400).json({ error: 'No Job URL on page' });
    if (!resumeUrl) return res.status(400).json({ error: 'No Resume File on page (run /tailor-resume first)' });

    await notionUpdate(pageId, { 'Apply Status': { select: { name: 'Filling' } } });

    const PYTHON = path.join(AIHAWK_DIR, 'venv', 'bin', 'python3');
    const SCRIPT = path.join(__dirname, 'indeed_semi_auto.py');
    const result = await execFileAsync(PYTHON, [
      SCRIPT,
      '--job-url', jobUrl,
      '--resume-url', resumeUrl,
      '--cover-letter', coverLetter || '',
      '--role', role,
      '--company', company,
    ], { cwd: __dirname, timeout: 180000, env: { ...process.env } });

    const parsed = JSON.parse(result.stdout.split('\n').filter(Boolean).pop());

    await notionUpdate(pageId, {
      'Apply Status': { select: { name: parsed.status === 'awaiting_submit' ? 'Awaiting Submit' : 'Failed' } },
      'Apply Submit URL': { url: parsed.submit_url || null },
      'Apply Logs': { rich_text: [{ text: { content: (parsed.log || '').slice(0, 2000) } }] },
    });

    res.json({ success: true, page_id: pageId, ...parsed });
  } catch (error) {
    console.error('Apply-semi error:', error.message);
    try {
      await notionUpdate(pageId, {
        'Apply Status': { select: { name: 'Failed' } },
        'Apply Logs': { rich_text: [{ text: { content: error.message.slice(0, 2000) } }] },
      });
    } catch {}
    res.status(500).json({ error: error.message, stderr: error.stderr });
  }
});

// ============================================================
// 6. AUTO-APPLY API
// ============================================================

app.post('/apply', async (req, res) => {
  const { job_url, jobs, min_score = 4.0 } = req.body;

  if (!job_url && !jobs) {
    return res.status(400).json({ error: 'Provide job_url (single) or jobs (array)' });
  }

  try {
    const PYTHON = path.join(AIHAWK_DIR, 'venv', 'bin', 'python3');
    const SCRIPT = path.join(__dirname, 'auto_apply.py');
    const args = [SCRIPT, '--headless'];

    // Add LinkedIn credentials from env
    if (process.env.LINKEDIN_EMAIL) {
      args.push('--linkedin-email', process.env.LINKEDIN_EMAIL);
    }
    if (process.env.LINKEDIN_PASSWORD) {
      args.push('--linkedin-password', process.env.LINKEDIN_PASSWORD);
    }

    if (job_url) {
      // Single job apply
      args.push('--job-url', job_url);
      const result = await execFileAsync(PYTHON, args, {
        cwd: __dirname,
        timeout: 120000,
        env: { ...process.env },
      });
      const parsed = JSON.parse(result.stdout);
      res.json({ success: true, result: parsed });

    } else {
      // Batch apply
      const jobsFile = `/tmp/apply_batch_${Date.now()}.json`;
      const outputFile = `/tmp/apply_results_${Date.now()}.json`;
      await writeFile(jobsFile, JSON.stringify(jobs), 'utf-8');
      args.push('--jobs-file', jobsFile, '--min-score', String(min_score), '--output', outputFile);

      const result = await execFileAsync(PYTHON, args, {
        cwd: __dirname,
        timeout: 600000, // 10 min for batch
        env: { ...process.env },
      });

      let summary;
      try {
        const outputData = await readFile(outputFile, 'utf-8');
        summary = JSON.parse(outputData);
      } catch {
        summary = JSON.parse(result.stdout);
      }

      // Clean up temp files
      try { await unlink(jobsFile); } catch {}
      try { await unlink(outputFile); } catch {}

      res.json({ success: true, summary });
    }
  } catch (error) {
    console.error('Auto-apply error:', error.message);
    res.status(500).json({ error: error.message, stderr: error.stderr });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Job Search API running on http://0.0.0.0:${PORT}`);
  console.log(`  POST /evaluate         - Career-ops job evaluation`);
  console.log(`  POST /generate-resume  - AIHawk resume generation`);
  console.log(`  POST /generate-pdf     - Career-ops PDF generation`);
  console.log(`  POST /apply            - Auto-apply (LinkedIn Easy Apply + Playwright fallback)`);
  console.log(`  POST /tailor-resume    - SYNC tailored resume (Notion button webhook)`);
  console.log(`  POST /apply-semi       - SEMI-AUTO Indeed apply (pauses at submit)`);
  console.log(`  GET  /tracker          - Career-ops application tracker`);
  console.log(`  POST /notion/add       - Add job to Notion tracker`);
  console.log(`  PATCH /notion/update   - Update job status in Notion`);
  console.log(`  GET  /notion/jobs      - Query Notion tracker`);
  console.log(`  GET  /notion/exists    - Check duplicate in Notion`);
  console.log(`  GET  /health           - Health check`);
});
