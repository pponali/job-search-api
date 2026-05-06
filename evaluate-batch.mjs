// Batch evaluator: find unscored Notion rows, run /evaluate, write back Score/Archetype/Recommendation/Report#/Status.
// Usage:
//   node evaluate-batch.mjs               # default: 5 unscored India rows
//   node evaluate-batch.mjs 10            # 10 unscored
//   node evaluate-batch.mjs 10 all        # all regions
import 'dotenv/config';

const KEY = process.env.NOTION_KEY;
const DB = process.env.NOTION_DB_ID;
const EVALUATE_URL = process.env.EVALUATE_URL || 'http://localhost:9500/evaluate';
const LIMIT = parseInt(process.argv[2] || '5', 10);
const SCOPE = process.argv[3] || 'india'; // 'india' | 'all'

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
  return r.json();
}

async function findUnscored() {
  const filters = [{ property: 'Score', number: { is_empty: true } }];
  if (SCOPE === 'india') {
    filters.push({ property: 'Region', select: { equals: 'India' } });
  }
  const r = await notionFetch(`/databases/${DB}/query`, 'POST', {
    filter: filters.length > 1 ? { and: filters } : filters[0],
    page_size: LIMIT,
  });
  return r.results;
}

async function evaluate(jdText, jdUrl) {
  const r = await fetch(EVALUATE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jd_text: jdText, jd_url: jdUrl }),
  });
  if (!r.ok) throw new Error(`evaluate ${r.status}: ${await r.text()}`);
  return r.json();
}

async function patch(pageId, props) {
  return notionFetch(`/pages/${pageId}`, 'PATCH', { properties: props });
}

async function main() {
  console.log(`Scope: ${SCOPE}  |  Limit: ${LIMIT}`);
  const rows = await findUnscored();
  console.log(`Unscored rows: ${rows.length}`);
  if (!rows.length) return;

  let scored = 0, errors = 0;
  for (const page of rows) {
    const p = page.properties;
    const role = p.Role?.title?.[0]?.plain_text || '';
    const company = p.Company?.rich_text?.[0]?.plain_text || '';
    const jdText = p.Notes?.rich_text?.[0]?.plain_text || '';
    const jdUrl = p['Job URL']?.url || '';

    if (!jdText && !jdUrl) {
      console.log(`  SKIP   ${company} / ${role} (no JD)`);
      continue;
    }

    console.log(`  EVAL   ${company} / ${role} ...`);
    try {
      const ev = await evaluate(jdText || '', jdUrl);
      const score = typeof ev.score === 'number' ? ev.score : null;
      const archetype = ev.archetype || null;
      const recommendation = ev.recommendation || null;
      const reportNum = ev.report_num || null;

      const props = {};
      if (score != null) props['Score'] = { number: score };
      if (archetype) props['Archetype'] = { select: { name: archetype } };
      if (recommendation) props['Recommendation'] = { select: { name: recommendation } };
      if (reportNum) props['Report #'] = { rich_text: [{ text: { content: reportNum } }] };
      props['Status'] = { select: { name: score >= 4 ? 'Evaluated' : 'SKIP' } };

      await patch(page.id, props);
      scored++;
      console.log(`         → score=${score} archetype=${archetype} rec=${recommendation} report=${reportNum}`);
    } catch (e) {
      errors++;
      console.error(`         ERR ${e.message.slice(0, 200)}`);
    }
  }

  console.log(`\nScored: ${scored}  |  Errors: ${errors}`);
}

main().catch(e => { console.error(e); process.exit(1); });
