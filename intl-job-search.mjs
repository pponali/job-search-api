import 'dotenv/config';

const JOBSPY_URL = process.env.JOBSPY_URL || 'http://localhost:9423';
const API_URL = process.env.API_URL || 'http://localhost:9500';

const COUNTRIES = [
  { name: 'USA', countryIndeed: 'USA', location: 'United States' },
  { name: 'UK', countryIndeed: 'UK', location: 'United Kingdom' },
  { name: 'Canada', countryIndeed: 'Canada', location: 'Canada' },
  { name: 'Germany', countryIndeed: 'Germany', location: 'Germany' },
  { name: 'Netherlands', countryIndeed: 'Netherlands', location: 'Netherlands' },
  { name: 'Australia', countryIndeed: 'Australia', location: 'Australia' },
  { name: 'Singapore', countryIndeed: 'Singapore', location: 'Singapore' },
  { name: 'UAE', countryIndeed: 'UAE', location: 'United Arab Emirates' },
];

const AI_TERMS = [
  'AI Engineer',
  'ML Engineer',
  'AI Platform Engineer',
  'Staff AI Engineer',
  'LLM Engineer',
];

const RESUME_TERMS = [
  'Staff Engineer',
  'Principal Engineer',
  'Platform Architect',
];

const TITLE_BLACKLIST = /junior|intern|fresher|\.net|php|ios developer|android developer|salesforce|sap\b|web3|blockchain|frontend developer/i;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function searchJobs(country, searchTerm) {
  const body = {
    siteNames: 'indeed,linkedin,glassdoor',
    searchTerm,
    location: country.location,
    resultsWanted: 10,
    countryIndeed: country.countryIndeed,
    hoursOld: 6,
    isRemote: false,
    descriptionFormat: 'markdown',
    linkedinFetchDescription: true,
  };

  try {
    const res = await fetch(`${JOBSPY_URL}/api`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      console.error(`  JobSpy error ${res.status} for ${country.name}/${searchTerm}`);
      return [];
    }
    const data = await res.json();
    return (data.jobs || []).map(j => ({ ...j, _country: country.name, _searchType: AI_TERMS.includes(searchTerm) ? 'ai' : 'resume' }));
  } catch (err) {
    console.error(`  JobSpy fetch failed for ${country.name}/${searchTerm}: ${err.message}`);
    return [];
  }
}

async function checkDuplicate(company, role) {
  try {
    const params = new URLSearchParams({ company, role });
    const res = await fetch(`${API_URL}/notion/exists?${params}`);
    const data = await res.json();
    return data.exists;
  } catch {
    return false;
  }
}

async function evaluateJob(jdText, jdUrl) {
  try {
    const res = await fetch(`${API_URL}/evaluate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jd_text: jdText, jd_url: jdUrl }),
      signal: AbortSignal.timeout(300000),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    console.error(`  Evaluation failed: ${err.message}`);
    return null;
  }
}

async function saveToNotion(job, evalResult) {
  const location = [job.city, job.state, job._country].filter(Boolean).join(', ');
  const body = {
    role: job.jobTitle,
    company: job.companyName,
    score: evalResult?.score || 0,
    status: 'Evaluated',
    archetype: evalResult?.archetype || '',
    recommendation: evalResult?.recommendation || 'skip',
    location,
    job_url: job.jobUrl || job.jobUrlDirect,
    job_type: job.jobType || '',
    is_remote: job.isRemote || false,
    salary_min: job.minAmount || null,
    salary_max: job.maxAmount || null,
    currency: job.salaryCurrency || '',
    source: job._searchType === 'ai' ? 'AI Search' : 'Resume Match',
    date_found: new Date().toISOString().split('T')[0],
    notes: evalResult?.notes || `[${job._searchType.toUpperCase()}] ${job._country} | ${job.workFromHomeType || job.jobType || ''}`,
  };

  try {
    const res = await fetch(`${API_URL}/notion/add`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function main() {
  console.log(`\n=== International AI Job Search ===`);
  console.log(`Started: ${new Date().toISOString()}\n`);

  const allTerms = [...AI_TERMS, ...RESUME_TERMS];
  let allJobs = [];

  // Search all country/term combinations
  for (const country of COUNTRIES) {
    for (const term of allTerms) {
      console.log(`Searching: ${country.name} / "${term}"...`);
      const jobs = await searchJobs(country, term);
      console.log(`  Found ${jobs.length} jobs`);
      allJobs.push(...jobs);
      await sleep(2000); // rate limit
    }
  }

  // Deduplicate by jobUrl
  const seen = new Set();
  const unique = [];
  for (const job of allJobs) {
    const key = job.jobUrl || `${job.companyName}:${job.jobTitle}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(job);
    }
  }
  console.log(`\nTotal: ${allJobs.length} raw → ${unique.length} unique`);

  // Filter blacklisted titles
  const filtered = unique.filter(j => j.jobTitle && !TITLE_BLACKLIST.test(j.jobTitle));
  console.log(`After title filter: ${filtered.length} jobs`);

  // Check duplicates and evaluate
  let added = 0;
  let skipped = 0;

  for (const job of filtered) {
    const isDup = await checkDuplicate(job.companyName, job.jobTitle);
    if (isDup) {
      skipped++;
      continue;
    }

    console.log(`\nEvaluating: ${job.jobTitle} @ ${job.companyName} (${job._country})`);
    const evalResult = await evaluateJob(job.description || job.jobSummary || '', job.jobUrl);

    if (evalResult) {
      console.log(`  Score: ${evalResult.score}, Rec: ${evalResult.recommendation}`);
    } else {
      console.log(`  Evaluation failed, saving with score 0`);
    }

    const saved = await saveToNotion(job, evalResult);
    if (saved) {
      added++;
      console.log(`  Saved to Notion`);
    }

    await sleep(3000); // rate limit between evaluations
  }

  console.log(`\n=== Summary ===`);
  console.log(`Jobs found: ${unique.length}`);
  console.log(`After filter: ${filtered.length}`);
  console.log(`Duplicates skipped: ${skipped}`);
  console.log(`New jobs added: ${added}`);
  console.log(`Completed: ${new Date().toISOString()}\n`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
