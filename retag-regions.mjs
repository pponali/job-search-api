// Recompute Region for all rows using current tagger (e.g. after tagger fix).
// Usage: node retag-regions.mjs [--apply]
import 'dotenv/config';

const KEY = process.env.NOTION_KEY;
const DB = process.env.NOTION_DB_ID;
const APPLY = process.argv.includes('--apply');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

if (!KEY || !DB) { console.error('NOTION_KEY and NOTION_DB_ID required'); process.exit(1); }

async function notionFetch(endpoint, method = 'GET', body = null) {
  const opts = {
    method,
    headers: {
      'Authorization': `Bearer ${KEY}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json',
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(`https://api.notion.com/v1${endpoint}`, opts);
  if (!r.ok) throw new Error(`Notion ${method} ${endpoint}: ${r.status} ${await r.text()}`);
  await sleep(350);
  return r.json();
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

async function main() {
  console.log(`Mode: ${APPLY ? 'APPLY' : 'DRY RUN'}`);
  let cursor, rows = [];
  do {
    const body = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    const r = await notionFetch(`/databases/${DB}/query`, 'POST', body);
    rows.push(...r.results);
    cursor = r.has_more ? r.next_cursor : undefined;
  } while (cursor);
  console.log(`Total rows: ${rows.length}`);

  let changed = 0, sameRegion = 0, errors = 0;
  const regionStats = {};
  for (const p of rows) {
    const pr = p.properties;
    const loc = pr.Location?.rich_text?.[0]?.plain_text || '';
    const remote = pr.Remote?.checkbox || false;
    const oldRegion = pr.Region?.select?.name || '';
    const newRegion = tagRegion(loc, remote);
    regionStats[newRegion] = (regionStats[newRegion] || 0) + 1;
    if (oldRegion === newRegion) { sameRegion++; continue; }
    console.log(`  ${oldRegion || '(none)'} → ${newRegion}: ${pr.Company?.rich_text?.[0]?.plain_text} | ${loc}`);
    if (APPLY) {
      try {
        await notionFetch(`/pages/${p.id}`, 'PATCH', {
          properties: { 'Region': { select: { name: newRegion } } },
        });
        changed++;
      } catch (e) {
        errors++;
        console.error(`  ERR ${p.id}: ${e.message}`);
      }
    } else {
      changed++;
    }
  }
  console.log(`\nChanged: ${changed}  |  Same: ${sameRegion}  |  Errors: ${errors}`);
  console.log(`Region distribution: ${JSON.stringify(regionStats)}`);
  if (!APPLY) console.log('\nDry run only. Re-run with --apply to commit.');
}

main().catch(e => { console.error(e); process.exit(1); });
