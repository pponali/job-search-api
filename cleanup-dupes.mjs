// Cleanup duplicate Notion rows + backfill Region + Dedup Key.
// Usage:
//   node cleanup-dupes.mjs                 # dry run
//   node cleanup-dupes.mjs --apply         # actually archive dupes + backfill
//
// Strategy:
//   1. Page through all rows.
//   2. For each row: compute normalized URL (or fallback company::role), set as dedup key.
//   3. Compute Region from Location + Remote.
//   4. Group by dedup key. Keep oldest (created_time). Archive rest.
//   5. Backfill Region + Dedup Key on the survivor.
import 'dotenv/config';

const NOTION_KEY = process.env.NOTION_KEY;
const NOTION_DB_ID = process.env.NOTION_DB_ID;
const APPLY = process.argv.includes('--apply');

if (!NOTION_KEY || !NOTION_DB_ID) { console.error('NOTION_KEY and NOTION_DB_ID required'); process.exit(1); }

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function notionFetch(endpoint, method = 'GET', body = null, retries = 3) {
  const opts = {
    method,
    headers: {
      'Authorization': `Bearer ${NOTION_KEY}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json',
    },
  };
  if (body) opts.body = JSON.stringify(body);
  for (let attempt = 0; attempt <= retries; attempt++) {
    const r = await fetch(`https://api.notion.com/v1${endpoint}`, opts);
    if (r.status === 429 || r.status >= 500) {
      const wait = 1000 * Math.pow(2, attempt);
      console.warn(`  retry ${attempt + 1} after ${wait}ms (${r.status})`);
      await sleep(wait);
      continue;
    }
    if (!r.ok) throw new Error(`Notion ${method} ${endpoint}: ${r.status} ${await r.text()}`);
    await sleep(350); // rate-limit safe (3 req/s)
    return r.json();
  }
  throw new Error(`Notion ${method} ${endpoint}: exhausted retries`);
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
  if (/(^|,\s|\s)in(\s|$)/.test(loc)) return 'India';
  if (/,\s*india(\s|$)/.test(loc) || loc === 'india') return 'India';
  const indiaTokens = ['india', 'bangalore', 'bengaluru', 'hyderabad', 'pune', 'mumbai',
                       'delhi', 'chennai', 'gurgaon', 'gurugram', 'noida', 'kolkata',
                       'ahmedabad', 'kochi', 'trivandrum', 'jaipur'];
  if (indiaTokens.some(t => loc.includes(t))) return 'India';
  if (/,\s*us(\s|$)/.test(loc) || /,\s*usa(\s|$)/.test(loc)) return 'US';
  const usTokens = ['united states', 'california', 'new york', 'texas',
                    'seattle', 'san francisco', 'boston', 'austin', 'chicago'];
  if (usTokens.some(t => loc.includes(t))) return 'US';
  if (/,\s*(uk|gb|de|fr|nl|ie|es|pl|it|se|fi|no|dk)(\s|$)/.test(loc)) return 'EU';
  const euTokens = ['united kingdom', 'london', 'germany', 'berlin', 'amsterdam',
                    'netherlands', 'france', 'paris', 'ireland', 'dublin', 'spain',
                    'madrid', 'poland', 'warsaw'];
  if (euTokens.some(t => loc.includes(t))) return 'EU';
  if (isRemote && !loc) return 'Remote-Global';
  if (loc.includes('remote')) return 'Remote-Global';
  return 'Other';
}

async function fetchAllRows() {
  const rows = [];
  let cursor = undefined;
  do {
    const body = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    const r = await notionFetch(`/databases/${NOTION_DB_ID}/query`, 'POST', body);
    rows.push(...r.results);
    cursor = r.has_more ? r.next_cursor : undefined;
  } while (cursor);
  return rows;
}

function summarize(page) {
  const p = page.properties;
  return {
    id: page.id,
    created: page.created_time,
    role: p['Role']?.title?.[0]?.plain_text || '',
    company: p['Company']?.rich_text?.[0]?.plain_text || '',
    location: p['Location']?.rich_text?.[0]?.plain_text || '',
    remote: p['Remote']?.checkbox || false,
    url: p['Job URL']?.url || '',
    region: p['Region']?.select?.name || '',
    dedupKey: p['Dedup Key']?.rich_text?.[0]?.plain_text || '',
  };
}

async function archive(pageId) {
  return notionFetch(`/pages/${pageId}`, 'PATCH', { archived: true });
}

async function patchProps(pageId, properties) {
  return notionFetch(`/pages/${pageId}`, 'PATCH', { properties });
}

async function main() {
  console.log(`Mode: ${APPLY ? 'APPLY' : 'DRY RUN'}`);
  const rows = await fetchAllRows();
  console.log(`Total rows: ${rows.length}`);

  const groups = new Map();
  for (const page of rows) {
    const s = summarize(page);
    const key = normalizeUrl(s.url) || `${s.company.toLowerCase()}::${s.role.toLowerCase()}`;
    if (!key || key === '::') continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ page, s, key });
  }

  if (rows.length > 600) {
    console.error(`Too many rows (${rows.length}). Sanity abort. Re-check or increase limit manually.`);
    process.exit(2);
  }

  // Secondary pass: re-group by company+role to catch same-job-different-URL dupes.
  const companyRoleKey = (s) => `${(s.company||'').toLowerCase().trim()}::${(s.role||'').toLowerCase().trim()}`;
  const crGroups = new Map();
  for (const items of groups.values()) {
    for (const item of items) {
      const ck = companyRoleKey(item.s);
      if (!ck || ck === '::') continue;
      if (!crGroups.has(ck)) crGroups.set(ck, []);
      crGroups.get(ck).push(item);
    }
  }
  // Replace groups with company+role grouping (more aggressive)
  groups.clear();
  for (const [k, items] of crGroups) groups.set(k, items);

  let dupes = 0, kept = 0, backfilled = 0, errors = 0;
  for (const [key, items] of groups) {
    items.sort((a, b) => a.page.created_time.localeCompare(b.page.created_time));
    const [survivor, ...rest] = items;
    kept++;

    const region = tagRegion(survivor.s.location, survivor.s.remote);
    const needsBackfill = !survivor.s.region || !survivor.s.dedupKey;
    if (needsBackfill) {
      console.log(`  backfill ${survivor.s.company}/${survivor.s.role} → region=${region}`);
      if (APPLY) {
        try {
          await patchProps(survivor.page.id, {
            'Region': { select: { name: region } },
            'Dedup Key': { rich_text: [{ text: { content: key } }] },
          });
          backfilled++;
        } catch (e) {
          errors++;
          console.error(`  ERR backfill ${survivor.page.id}: ${e.message}`);
        }
      } else {
        backfilled++;
      }
    }

    for (const dup of rest) {
      console.log(`  dupe → archive ${dup.s.company}/${dup.s.role} (${dup.page.id})`);
      if (APPLY) {
        try {
          await archive(dup.page.id);
          dupes++;
        } catch (e) {
          errors++;
          console.error(`  ERR archive ${dup.page.id}: ${e.message}`);
        }
      } else {
        dupes++;
      }
    }
  }

  console.log(`\nSurvivors: ${kept}  |  Duplicates archived: ${dupes}  |  Backfilled: ${backfilled}  |  Errors: ${errors}`);
  if (!APPLY) console.log('\nDry run only. Re-run with --apply to commit.');
}

main().catch(e => { console.error(e); process.exit(1); });
