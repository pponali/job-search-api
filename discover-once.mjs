// One-shot discovery: JobSpy → /notion/add (with dedup + region tagging via server.mjs).
// Usage:
//   node discover-once.mjs                        # default: all target archetypes
//   node discover-once.mjs "Staff Engineer" 10    # single term, count
//   node discover-once.mjs --terms "A,B,C" 8      # multi-term
import 'dotenv/config';

const DEFAULT_TERMS = [
  'Staff Engineer',
  'Principal Engineer',
  'Platform Architect',
  'Solution Architect',
  'Solutions Architect',
];

let SEARCH_TERMS, RESULTS;
if (process.argv[2] === '--terms') {
  SEARCH_TERMS = process.argv[3].split(',').map(s => s.trim());
  RESULTS = parseInt(process.argv[4] || '8', 10);
} else if (process.argv[2]) {
  SEARCH_TERMS = [process.argv[2]];
  RESULTS = parseInt(process.argv[3] || '5', 10);
} else {
  SEARCH_TERMS = DEFAULT_TERMS;
  RESULTS = 8;
}
const JOBSPY_URL = 'http://localhost:9423/api';
const NOTION_ADD_URL = 'http://localhost:9500/notion/add';

async function jobspy(searchTerm, results) {
  console.log(`Querying JobSpy: ${searchTerm} (${results} results, India, indeed+naukri)`);
  const r = await fetch(JOBSPY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      siteNames: 'indeed,linkedin',
      searchTerm,
      location: 'India',
      resultsWanted: results,
      countryIndeed: 'India',
      hoursOld: 168,
      isRemote: false,
      descriptionFormat: 'markdown',
    }),
  });
  if (!r.ok) throw new Error(`JobSpy ${r.status}: ${await r.text()}`);
  return r.json();
}

async function addToNotion(job) {
  const payload = {
    role: job.title,
    company: job.company,
    location: job.location || '',
    job_url: job.jobUrl || job.jobUrlDirect || '',
    job_type: job.jobType,
    is_remote: job.isRemote,
    salary_min: job.minAmount,
    salary_max: job.maxAmount,
    currency: job.currency,
    source: job.site,
    date_found: new Date().toISOString().slice(0, 10),
    status: 'Discovered',
    notes: (job.description || '').slice(0, 1500),
  };
  const r = await fetch(NOTION_ADD_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const out = await r.json();
  if (!r.ok) throw new Error(`Notion add ${r.status}: ${JSON.stringify(out)}`);
  return out;
}

async function main() {
  let totalAdded = 0, totalDeduped = 0, totalErrors = 0;

  for (const term of SEARCH_TERMS) {
    console.log(`\n=== ${term} ===`);
    let data;
    try {
      data = await jobspy(term, RESULTS);
    } catch (e) {
      console.error(`  JobSpy ERR: ${e.message}`);
      continue;
    }
    const jobs = data.jobs || [];
    console.log(`Got ${jobs.length} jobs`);

    for (const job of jobs) {
      try {
        const result = await addToNotion(job);
        if (result.deduped) { totalDeduped++; }
        else { totalAdded++; }
        console.log(`  ${result.deduped ? 'DEDUP' : 'ADD  '}  ${job.company} / ${job.title}`);
      } catch (e) {
        totalErrors++;
        console.error(`  ERR    ${job.company} / ${job.title}: ${e.message}`);
      }
    }
  }

  console.log(`\n=== SUMMARY ===`);
  console.log(`Added: ${totalAdded}  |  Deduped: ${totalDeduped}  |  Errors: ${totalErrors}`);
}

main().catch(e => { console.error(e); process.exit(1); });
