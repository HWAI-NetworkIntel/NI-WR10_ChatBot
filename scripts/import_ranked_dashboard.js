/**
 * Collapse the provider dashboard ranked extract into data/rankings.csv.
 * One row per county, plan type, and payor. Rank is rank_payor_plantype.
 * Network score is taken from the payor's plan with the highest July 2026 enrollment.
 *
 * Usage: node scripts/import_ranked_dashboard.js "path/to/provider_dashboard_data_demo TX_ranked.csv"
 */
const fs = require('node:fs');
const path = require('node:path');
const { parseCsv } = require('../services/rankingsStore');

const source = process.argv[2];
if (!source) {
    console.error('Pass the ranked dashboard CSV path.');
    process.exit(1);
}

function numberValue(value) {
    if (value == null || String(value).trim() === '') return null;
    const parsed = Number(String(value).replace(/,/g, ''));
    return Number.isFinite(parsed) ? parsed : null;
}

function csvCell(value) {
    const text = value == null ? '' : String(value);
    if (/[",\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
    return text;
}

const table = parseCsv(fs.readFileSync(source, 'utf8'));
const [headers, ...body] = table;
const index = Object.fromEntries(headers.map((header, position) => [header, position]));
const groups = new Map();

for (const row of body) {
    const county = String(row[index.county_name] || '').trim();
    const planType = String(row[index.Plan_Type] || '').trim();
    const payor = String(row[index.Parent_Organization] || '').trim();
    const rank = numberValue(row[index.rank_payor_plantype]);
    const score = numberValue(row[index.network_score]);
    if (!county || !planType || !payor || rank == null || rank <= 0 || score == null) continue;
    const enrollment = numberValue(row[index.July_2026]) ?? -1;
    const key = `${county.toLowerCase()}|${planType.toLowerCase()}|${payor.toLowerCase()}`;
    const current = groups.get(key);
    if (current && (enrollment < current.enrollment || (enrollment === current.enrollment && score <= current.score))) continue;
    groups.set(key, {
        county,
        state: 'TX',
        fips: String(row[index['FIPS State County Code']] || '').trim(),
        payor,
        planType,
        metric: 'Network score',
        value: score,
        asOf: '2026',
        network: String(row[index.network_name] || '').trim(),
        rank,
        enrollment,
    });
}

const rows = [...groups.values()].sort((a, b) =>
    a.county.localeCompare(b.county)
    || a.planType.localeCompare(b.planType)
    || a.rank - b.rank
    || a.payor.localeCompare(b.payor));
const header = ['county', 'state', 'fips', 'payor', 'planType', 'metric', 'value', 'asOf', 'network', 'rank'];
const lines = [header.join(',')];
for (const row of rows) {
    lines.push(header.map((column) => csvCell(row[column])).join(','));
}

const destination = path.join(__dirname, '..', 'data', 'rankings.csv');
fs.mkdirSync(path.dirname(destination), { recursive: true });
fs.writeFileSync(destination, `${lines.join('\n')}\n`, 'utf8');
console.log(JSON.stringify({ rows: rows.length, destination }));
