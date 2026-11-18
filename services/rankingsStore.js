"use strict";
/** Load rankings and entity-reach rosters from CSV. Extra columns are ignored. */
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseCsv = parseCsv;
exports.parseRankings = parseRankings;
exports.parseRoster = parseRoster;
exports.loadRankData = loadRankData;
exports.RANK_FILE_HELP = void 0;

exports.RANK_FILE_HELP = {
    'data/rankings.csv': ['county', 'state', 'payor', 'planType', 'metric', 'value', 'asOf'],
    'data/roster.csv': ['entityType', 'name', 'county', 'state', 'payor', 'planType', 'reach', 'overlap'],
};

const RANK_ALIASES = {
    county: ['county', 'countyname', 'geography'],
    state: ['state', 'statecode'],
    fips: ['fips', 'countyfips'],
    payor: ['payor', 'payer', 'parentorganization', 'parentorganizationname', 'carrier'],
    planType: ['plantype', 'plan_type', 'product'],
    metric: ['metric', 'metricname', 'measure'],
    value: ['value', 'reach', 'beneficiaryreach', 'metricvalue'],
    asOf: ['asof', 'as_of', 'asofdate', 'date', 'rosterdate'],
    network: ['network', 'networkname'],
};

const ROSTER_ALIASES = {
    entityType: ['entitytype', 'type', 'kind'],
    name: ['name', 'entity', 'healthsystem', 'groupname', 'system'],
    county: ['county', 'countyname', 'geography'],
    state: ['state', 'statecode'],
    fips: ['fips', 'countyfips'],
    payor: ['payor', 'payer', 'parentorganization', 'carrier'],
    planType: ['plantype', 'plan_type', 'product'],
    reach: ['reach', 'value', 'beneficiaryreach'],
    overlap: ['overlap', 'overlapfraction', 'alreadycovered'],
};

function parseCsv(text) {
    const source = String(text).replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const rows = [];
    let row = [];
    let cell = '';
    let inQuotes = false;
    for (let i = 0; i < source.length; i += 1) {
        const ch = source[i];
        if (inQuotes) {
            if (ch === '"') {
                if (source[i + 1] === '"') {
                    cell += '"';
                    i += 1;
                }
                else inQuotes = false;
            }
            else cell += ch;
        }
        else if (ch === '"') inQuotes = true;
        else if (ch === ',') {
            row.push(cell);
            cell = '';
        }
        else if (ch === '\n') {
            row.push(cell);
            rows.push(row);
            row = [];
            cell = '';
        }
        else cell += ch;
    }
    if (cell.length || row.length) {
        row.push(cell);
        rows.push(row);
    }
    return rows.filter((cells) => cells.some((value) => value.trim()));
}

function headerKey(value) {
    return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function pickColumns(headers, aliases) {
    const keys = headers.map(headerKey);
    const index = {};
    for (const [field, names] of Object.entries(aliases)) {
        const found = keys.findIndex((key) => names.includes(key));
        if (found >= 0) index[field] = found;
    }
    return index;
}

function cell(row, index, field) {
    if (index[field] == null) return '';
    return String(row[index[field]] ?? '').trim();
}

function numberCell(value) {
    if (!value) return null;
    const parsed = Number(String(value).replace(/,/g, ''));
    return Number.isFinite(parsed) ? parsed : null;
}

function entityTypeOf(value, headers) {
    const text = String(value || '').toLowerCase().replace(/[^a-z]+/g, ' ').trim();
    if (/group/.test(text)) return 'group';
    if (/system|hospital/.test(text)) return 'health_system';
    const keys = headers.map(headerKey);
    if (!value && keys.includes('groupname')) return 'group';
    if (!value && keys.includes('healthsystem')) return 'health_system';
    return 'health_system';
}

function mapTable(text, aliases, build) {
    const table = parseCsv(text);
    if (!table.length) return [];
    const [headers, ...body] = table;
    const index = pickColumns(headers, aliases);
    return body.map((row) => build(row, index, headers)).filter(Boolean);
}

function parseRankings(text) {
    return mapTable(text, RANK_ALIASES, (row, index) => {
        const payor = cell(row, index, 'payor');
        const county = cell(row, index, 'county');
        const value = numberCell(cell(row, index, 'value'));
        if (!payor || !county || value == null) return null;
        return {
            county,
            state: (cell(row, index, 'state') || 'TX').toUpperCase(),
            fips: cell(row, index, 'fips'),
            payor,
            planType: cell(row, index, 'planType'),
            metric: cell(row, index, 'metric') || 'BeneficiaryReach',
            value,
            asOf: cell(row, index, 'asOf'),
            network: cell(row, index, 'network'),
        };
    });
}

function parseRoster(text) {
    return mapTable(text, ROSTER_ALIASES, (row, index, headers) => {
        const name = cell(row, index, 'name');
        const county = cell(row, index, 'county');
        const reach = numberCell(cell(row, index, 'reach'));
        if (!name || !county || reach == null) return null;
        const overlapText = cell(row, index, 'overlap');
        const overlap = overlapText ? numberCell(overlapText) : null;
        return {
            entityType: entityTypeOf(cell(row, index, 'entityType'), headers),
            name,
            county,
            state: (cell(row, index, 'state') || 'TX').toUpperCase(),
            fips: cell(row, index, 'fips'),
            payor: cell(row, index, 'payor'),
            planType: cell(row, index, 'planType'),
            reach,
            overlap,
        };
    });
}

function readIfPresent(file) {
    if (!(0, node_fs_1.existsSync)(file)) return null;
    return (0, node_fs_1.readFileSync)(file, 'utf8');
}

function loadRankData(directory) {
    const rankingsFile = (0, node_path_1.join)(directory, 'rankings.csv');
    const rosterFile = (0, node_path_1.join)(directory, 'roster.csv');
    const rankingsText = readIfPresent(rankingsFile);
    const rosterText = readIfPresent(rosterFile);
    return {
        rankings: rankingsText ? parseRankings(rankingsText) : [],
        roster: rosterText ? parseRoster(rosterText) : [],
        files: { rankings: Boolean(rankingsText), roster: Boolean(rosterText) },
    };
}
