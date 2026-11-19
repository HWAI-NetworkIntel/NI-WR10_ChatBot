"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.stripComments = stripComments;
exports.guardSql = guardSql;
/**
 * SQL guard for LLM-written queries.
 *
 * Defense in depth. This is layer 2 of 3:
 *   1. The database login is read-only and can only SELECT the allowed tables (sql/create_readonly_login.sql).
 *   2. This guard: one SELECT statement, allowlisted tables only, no writes/side effects/system objects.
 *   3. Execution limits: SET ROWCOUNT cap + request timeout (see db.ts).
 *
 * Fail closed: anything the parser cannot read is rejected, and the LLM is asked to rewrite it.
 */
const node_sql_parser_1 = require("node-sql-parser");
const parser = new node_sql_parser_1.Parser();
const PARSE_OPT = { database: 'TransactSQL' };
// Keywords that never belong in a read-only analytics query.
const FORBIDDEN = [
    'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'DROP', 'ALTER', 'CREATE', 'TRUNCATE', 'GRANT', 'REVOKE', 'DENY',
    'EXEC', 'EXECUTE', 'DECLARE', 'SET', 'USE', 'WAITFOR', 'BACKUP', 'RESTORE', 'DBCC', 'SHUTDOWN', 'KILL',
    'OPENROWSET', 'OPENQUERY', 'OPENDATASOURCE', 'OPENXML', 'BULK', 'RECONFIGURE', 'INTO',
];
const FORBIDDEN_RE = new RegExp(`\\b(${FORBIDDEN.join('|')})\\b`, 'i');
/** Remove comments, keeping string literals intact. */
function stripComments(sql) {
    let out = '';
    let i = 0;
    while (i < sql.length) {
        const ch = sql[i];
        const next = sql[i + 1];
        if (ch === "'") {
            // copy a string literal, handling '' escapes
            let j = i + 1;
            while (j < sql.length) {
                if (sql[j] === "'" && sql[j + 1] === "'")
                    j += 2;
                else if (sql[j] === "'")
                    break;
                else
                    j += 1;
            }
            out += sql.slice(i, j + 1);
            i = j + 1;
        }
        else if (ch === '-' && next === '-') {
            while (i < sql.length && sql[i] !== '\n')
                i += 1;
        }
        else if (ch === '/' && next === '*') {
            const end = sql.indexOf('*/', i + 2);
            i = end === -1 ? sql.length : end + 2;
            out += ' ';
        }
        else {
            out += ch;
            i += 1;
        }
    }
    return out;
}
/** Replace string literal contents so keyword checks don't trip on values like 'Insert Health Plan'. */
function blankLiterals(sql) {
    return sql.replace(/N?'(?:[^']|'')*'/g, "''");
}
function cleanCodeFence(text) {
    return text.trim().replace(/^```(?:sql)?\s*/i, '').replace(/\s*```$/, '').trim();
}
function guardSql(input, options) {
    let sql = stripComments(cleanCodeFence(input)).trim();
    sql = sql.replace(/;\s*$/, '').trim(); // one trailing semicolon is fine
    if (!sql)
        return { ok: false, reason: 'Empty query.' };
    if (sql.length > 8000)
        return { ok: false, reason: 'Query is too long.' };
    const code = blankLiterals(sql);
    if (code.includes(';'))
        return { ok: false, reason: 'Only one statement is allowed.' };
    if (!/^\s*(SELECT|WITH)\b/i.test(code))
        return { ok: false, reason: 'Only SELECT queries are allowed.' };
    const forbidden = code.match(FORBIDDEN_RE);
    if (forbidden)
        return { ok: false, reason: `Keyword "${forbidden[1].toUpperCase()}" is not allowed.` };
    if (/\b(xp|sp)_\w+/i.test(code))
        return { ok: false, reason: 'System procedures are not allowed.' };
    if (/@@|@\w/.test(code))
        return { ok: false, reason: 'Variables and system functions (@, @@) are not allowed.' };
    if (/#\w/.test(code))
        return { ok: false, reason: 'Temporary tables are not allowed.' };
    if (/\b(sys|INFORMATION_SCHEMA)\s*\./i.test(code))
        return { ok: false, reason: 'System catalog views are not allowed.' };
    let ast;
    try {
        ast = parser.astify(sql, PARSE_OPT);
    }
    catch {
        return {
            ok: false,
            reason: 'The query could not be parsed. Use plain T-SQL SELECT; avoid EXCEPT/INTERSECT (use NOT EXISTS) and OFFSET/FETCH (use TOP).',
        };
    }
    const statements = (Array.isArray(ast) ? ast : [ast]);
    if (statements.length !== 1)
        return { ok: false, reason: 'Only one statement is allowed.' };
    const stmt = statements[0];
    if (stmt.type !== 'select')
        return { ok: false, reason: 'Only SELECT queries are allowed.' };
    if (stmt.into && stmt.into.expr)
        return { ok: false, reason: 'SELECT INTO is not allowed.' };
    const cteNames = new Set((stmt.with ?? []).map((w) => String(w?.name?.value ?? w?.name ?? '').toLowerCase()).filter(Boolean));
    const allowed = new Map(options.allowedTables.map((t) => [t.toLowerCase(), t]));
    const used = new Set();
    let entries;
    try {
        entries = parser.tableList(sql, PARSE_OPT);
    }
    catch {
        return { ok: false, reason: 'The query could not be parsed.' };
    }
    for (const entry of entries) {
        const [action, schemaPart, tablePart] = entry.split('::');
        if (action.toLowerCase() !== 'select')
            return { ok: false, reason: `Operation "${action}" is not allowed.` };
        const table = tablePart.replace(/^\[|\]$/g, '');
        const schema = (schemaPart ?? 'null').replace(/[[\]]/g, '');
        const schemaOk = schema === 'null' || /^dbo$/i.test(schema) || schema.toLowerCase() === `${options.database.toLowerCase()}.dbo`;
        if (!schemaOk)
            return { ok: false, reason: `Only tables in ${options.database}.dbo can be queried (got "${schema}").` };
        if (schema === 'null' && cteNames.has(table.toLowerCase()))
            continue;
        const canonical = allowed.get(table.toLowerCase());
        if (!canonical)
            return { ok: false, reason: `Table "${table}" is not available. Use only the tables in the reference.` };
        used.add(canonical);
    }
    if (used.size === 0 && entries.length === 0 && /\bFROM\b/i.test(code)) {
        return { ok: false, reason: 'Could not identify the tables in the query.' };
    }
    const texas = texasScopeIssue(sql, used);
    if (texas)
        return { ok: false, reason: texas };
    return { ok: true, sql, tables: [...used].sort() };
}
/** Tables whose rows are tied to a state or county. Lookup tables with no geography are not listed. */
const GEO_TABLES = new Set([
    'providerscoredetails', 'languagegeographymapping', 'providerlocation', 'hospitaldetails',
    'state', 'county', 'enrollmentdetails', 'milesindividual_10', 'mileshospital_10',
    'networkcountbyfips', 'mileshospital_30', 'networkcountbyzip', 'milesindividual_30',
    'mileshospital_60', 'milesindividual_60', 'provideraddresscount', 'geographyplanfilters',
    'npiquickfiltermapping',
]);
const TEXAS_REASON = 'Only Texas data is available. Filter geographic tables with StateCode = \'TX\' or FIPS / NPI_FIPS / Isochrone_FIPS LIKE \'48%\'. Do not query any other state.';
function quotedValues(text) {
    return [...text.matchAll(/N?'([^']*(?:''[^']*)*)'/gi)].map((match) => match[1].replace(/''/g, "'"));
}
function isTexasFips(value) {
    return /^48[%_\d]*$/.test(value);
}
/** Reject geographic queries that are not limited to Texas, and any explicit non-Texas state or FIPS. */
function texasScopeIssue(sql, tables) {
    const readsGeography = [...tables].some((table) => GEO_TABLES.has(String(table).toLowerCase()));
    let texas = false;
    let otherState = false;
    for (const match of sql.matchAll(/\[?StateCode\]?\s*=\s*N?'([A-Za-z]{2})'/gi)) {
        if (match[1].toUpperCase() === 'TX')
            texas = true;
        else
            otherState = true;
    }
    for (const match of sql.matchAll(/\[?StateCode\]?\s+IN\s*\(([^)]*)\)/gi)) {
        const codes = quotedValues(match[1]).map((value) => value.toUpperCase());
        if (codes.length === 1 && codes[0] === 'TX')
            texas = true;
        else if (codes.length)
            otherState = true;
    }
    if (/\[?StateCode\]?\s*(?:<>|!=|LIKE|NOT\s+LIKE)\s*N?'/i.test(sql))
        otherState = true;
    for (const match of sql.matchAll(/\[?StateName\]?\s*=\s*N?'([^']*)'/gi)) {
        if (/^texas$/i.test(match[1]))
            texas = true;
        else
            otherState = true;
    }
    let otherFips = false;
    for (const match of sql.matchAll(/\[?(?:NPI_FIPS|Isochrone_FIPS|FIPS)\]?\s*(=|<>|!=|LIKE|NOT\s+LIKE|IN)\s*(N?'(?:[^']|'')*'|\([^)]*\))/gi)) {
        const operator = match[1].toUpperCase().replace(/\s+/g, ' ');
        const values = quotedValues(match[2]);
        if (operator === '=' || operator === 'LIKE' || operator === 'IN') {
            if (values.length && values.every(isTexasFips))
                texas = true;
            else
                otherFips = true;
        }
        else {
            otherFips = true;
        }
    }
    if (otherState || otherFips || (readsGeography && !texas))
        return TEXAS_REASON;
    return '';
}
