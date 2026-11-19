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

/** Provider counts and "rated High" counts used to explain and improve a rank (data/network_ratings.csv). */
const RATING_COLUMNS = [
    'pcp_npi_count_without_low_exclude_hosp',
    'spe_npi_count_without_low_exclude_hosp',
    'other_npi_count_without_low_exclude_hosp',
    'PCP_Cost Score rating',
    'PCP_FFS Utilization Score category',
    'PCP_MA Utilization Score category',
    'PCP_Quality Score rating',
    'Spe_Cost Score rating',
    'Spe_FFS Utilization Score category',
    'Spe_MA Utilization Score category',
    'Spe_Quality Score rating',
    'Hosp_Cost Score rating',
    'Hosp_FFS Utilization Score category',
    'Hosp_MA Utilization Score category',
    'Hosp_Quality Score rating',
    'Modified Hwai Rating',
    // Share of providers rated High on quality: this, not the count, is what the network score uses.
    'PCP_Quality Score %',
    'Spe_Quality Score %',
    'Hosp_Quality Score %',
];

const table = parseCsv(fs.readFileSync(source, 'utf8'));
const [headers, ...body] = table;
const index = Object.fromEntries(headers.map((header, position) => [header, position]));

// Every parent organization in the extract, ranked or not, so a question about any of them is recognised.
const payorCounts = new Map();
for (const row of body) {
    const payor = String(row[index.Parent_Organization] || '').trim();
    if (!payor) continue;
    const entry = payorCounts.get(payor) || { rows: 0, rankedRows: 0 };
    entry.rows += 1;
    if (numberValue(row[index.rank_payor_plantype]) > 0 && numberValue(row[index.network_score]) != null) entry.rankedRows += 1;
    payorCounts.set(payor, entry);
}
const groups = new Map();
const rankScores = new Map();

for (const row of body) {
    const county = String(row[index.county_name] || '').trim();
    const planType = String(row[index.Plan_Type] || '').trim();
    const payor = String(row[index.Parent_Organization] || '').trim();
    const rank = numberValue(row[index.rank_payor_plantype]);
    const score = numberValue(row[index.network_score]);
    if (!county || !planType || !payor || rank == null || rank <= 0 || score == null) continue;
    const enrollment = numberValue(row[index.July_2026]) ?? -1;
    const key = `${county.toLowerCase()}|${planType.toLowerCase()}|${payor.toLowerCase()}`;
    // The rank uses an enrollment-weighted score over all of the payor's plans (Stage2_dynamic.rank_table).
    const totals = rankScores.get(key) || { weight: 0, weighted: 0, sum: 0, count: 0 };
    const weight = Math.max(enrollment, 0);
    totals.weight += weight;
    totals.weighted += weight * score;
    totals.sum += score;
    totals.count += 1;
    rankScores.set(key, totals);
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
        planId: String(row[index.PlanID] || '').trim(),
        ratings: Object.fromEntries(RATING_COLUMNS.map((column) => [column, numberValue(row[index[column]])])),
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

// Same representative plan as the rank above, so the ratings explain that rank.
const ratingsHeader = ['county', 'fips', 'payor', 'planType', 'planId', 'network', 'enrollment', 'networkScore', 'rankScore', 'rank', ...RATING_COLUMNS];
const ratingLines = [ratingsHeader.map(csvCell).join(',')];
for (const row of rows) {
    const totals = rankScores.get(`${row.county.toLowerCase()}|${row.planType.toLowerCase()}|${row.payor.toLowerCase()}`);
    const rankScore = totals.weight > 0 ? totals.weighted / totals.weight : totals.sum / totals.count;
    const values = { ...row, networkScore: row.value, rankScore, enrollment: row.enrollment < 0 ? '' : row.enrollment, ...row.ratings };
    ratingLines.push(ratingsHeader.map((column) => csvCell(values[column])).join(','));
}
const payorLines = ['payor,rows,rankedRows'];
for (const [payor, entry] of [...payorCounts.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    payorLines.push([payor, entry.rows, entry.rankedRows].map(csvCell).join(','));
}
const payorsDestination = path.join(__dirname, '..', 'data', 'payors.csv');
fs.writeFileSync(payorsDestination, `${payorLines.join('\n')}\n`, 'utf8');
console.log(JSON.stringify({ payors: payorCounts.size, destination: payorsDestination }));

const ratingsDestination = path.join(__dirname, '..', 'data', 'network_ratings.csv');
fs.writeFileSync(ratingsDestination, `${ratingLines.join('\n')}\n`, 'utf8');
console.log(JSON.stringify({ rows: rows.length, destination: ratingsDestination }));
