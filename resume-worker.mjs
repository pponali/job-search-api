// Resume worker — polls Notion for `Generate Resume = true`, generates tailored PDF,
// uploads to GitHub raw, writes URL back to `Resume File` column.
//
// Run: node resume-worker.mjs
// Or: pm2 start resume-worker.mjs --name resume-worker
import 'dotenv/config';
import { spawn } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const NOTION_KEY = process.env.NOTION_KEY;
const NOTION_DB_ID = process.env.NOTION_DB_ID;
const CAREER_OPS_DIR = process.env.CAREER_OPS_DIR;
const RESUMES_REPO = process.env.RESUMES_REPO;
const RESUMES_REPO_PATH = 'resumes';
const RESUMES_RAW_BASE = process.env.RESUMES_RAW_BASE;
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || '30000', 10);

const missing = ['NOTION_KEY', 'NOTION_DB_ID', 'CAREER_OPS_DIR', 'RESUMES_REPO', 'RESUMES_RAW_BASE']
  .filter(k => !process.env[k]);
if (missing.length) {
  console.error(`Missing required env vars: ${missing.join(', ')}`);
  process.exit(1);
}

async function notionFetch(endpoint, method = 'GET', body = null) {
  const opts = {
    method,
    headers: {
      'Authorization': `Bearer ${NOTION_KEY}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json',
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(`https://api.notion.com/v1${endpoint}`, opts);
  if (!r.ok) {
    const e = await r.text();
    throw new Error(`Notion ${method} ${endpoint}: ${r.status} ${e}`);
  }
  return r.json();
}

async function findResumeJobs() {
  const result = await notionFetch(`/databases/${NOTION_DB_ID}/query`, 'POST', {
    filter: {
      and: [
        { property: 'Generate Resume', checkbox: { equals: true } },
        {
          or: [
            { property: 'Resume Status', select: { is_empty: true } },
            { property: 'Resume Status', select: { equals: 'Pending' } },
          ],
        },
      ],
    },
    page_size: 25,
  });
  return result.results;
}

async function setStatus(pageId, status, extra = {}) {
  const properties = { 'Resume Status': { select: { name: status } } };
  if (extra.error) properties['Resume Error'] = { rich_text: [{ text: { content: extra.error.slice(0, 1500) } }] };
  if (extra.fileUrl) {
    properties['Resume File'] = {
      files: [{ name: extra.fileName || 'resume.pdf', external: { url: extra.fileUrl } }],
    };
    properties['Resume Generated At'] = { date: { start: new Date().toISOString() } };
  }
  if (extra.clearTrigger) properties['Generate Resume'] = { checkbox: false };
  await notionFetch(`/pages/${pageId}`, 'PATCH', { properties });
}

function readPageProps(page) {
  const p = page.properties;
  return {
    pageId: page.id,
    role: p['Role']?.title?.[0]?.plain_text || '',
    company: p['Company']?.rich_text?.[0]?.plain_text || '',
    reportNum: p['Report #']?.rich_text?.[0]?.plain_text || '',
    jobUrl: p['Job URL']?.url || '',
    score: p['Score']?.number,
  };
}

function runClaude(prompt, cwd, timeout = 300000) {
  return new Promise((resolve, reject) => {
    const child = spawn('claude', ['-p', '--output-format', 'text'], { cwd, timeout });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`claude exit ${code}: ${stderr}`));
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

function execCmd(cmd, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${cmd} exit ${code}: ${stderr}`));
    });
  });
}

async function findGeneratedPdf(reportNum, company) {
  const outputDir = path.join(CAREER_OPS_DIR, 'output');
  const { stdout } = await execCmd('ls', ['-1t', outputDir]);
  const files = stdout.split('\n').filter(Boolean).filter(f => f.endsWith('.pdf'));
  const slug = (company || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const matched = files.find(f => f.toLowerCase().includes(slug));
  if (matched) return path.join(outputDir, matched);
  return path.join(outputDir, files[0]);
}

async function commitToGithub(pdfPath, fileName) {
  const targetDir = path.join(RESUMES_REPO, RESUMES_REPO_PATH);
  await execCmd('mkdir', ['-p', targetDir]);
  await execCmd('cp', [pdfPath, path.join(targetDir, fileName)]);
  await execCmd('git', ['add', `${RESUMES_REPO_PATH}/${fileName}`], RESUMES_REPO);
  await execCmd('git', ['commit', '-m', `resume: add ${fileName}`], RESUMES_REPO).catch(() => {});
  await execCmd('git', ['push'], RESUMES_REPO);
  return `${RESUMES_RAW_BASE}/${fileName}`;
}

async function processOne(page) {
  const { pageId, role, company, reportNum } = readPageProps(page);
  console.log(`[${new Date().toISOString()}] processing ${company} / ${role} (report ${reportNum || 'none'})`);

  if (!reportNum) {
    await setStatus(pageId, 'Failed', { error: 'No Report # set on row — run /evaluate first' });
    return;
  }

  await setStatus(pageId, 'Generating');

  try {
    const prompt = `Read the evaluation report reports/${reportNum}-*.md. Generate an ATS-optimized tailored resume PDF for ${company} - ${role} using cv-template.html template and generate-pdf.mjs. The PDF must be saved to output/ directory. Print only the absolute output PDF path on the last line.`;
    await runClaude(prompt, CAREER_OPS_DIR, 300000);

    const pdfPath = await findGeneratedPdf(reportNum, company);
    if (!existsSync(pdfPath)) throw new Error(`PDF not found at ${pdfPath}`);

    const stamp = new Date().toISOString().slice(0, 10);
    const slug = `${(company || 'company').toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${(role || 'role').toLowerCase().replace(/[^a-z0-9]+/g, '-')}`.replace(/^-|-$/g, '');
    const fileName = `${stamp}-${slug}.pdf`;

    const url = await commitToGithub(pdfPath, fileName);
    await setStatus(pageId, 'Ready', { fileUrl: url, fileName, clearTrigger: true });
    console.log(`  ready: ${url}`);
  } catch (err) {
    console.error(`  failed: ${err.message}`);
    await setStatus(pageId, 'Failed', { error: err.message });
  }
}

async function loop() {
  try {
    const jobs = await findResumeJobs();
    if (jobs.length) console.log(`[${new Date().toISOString()}] ${jobs.length} resume job(s) queued`);
    for (const page of jobs) {
      await processOne(page);
    }
  } catch (err) {
    console.error('poll error:', err.message);
  }
}

console.log(`Resume worker started. Polling every ${POLL_INTERVAL_MS / 1000}s. DB=${NOTION_DB_ID}`);
loop();
setInterval(loop, POLL_INTERVAL_MS);
