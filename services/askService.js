"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.askRequestSchema = exports.ASK_ERROR_MESSAGE = void 0;
exports.loadExamples = loadExamples;
exports.convertCell = convertCell;
exports.numbersMatchAnswer = numbersMatchAnswer;
exports.answerQuestion = answerQuestion;
exports.formatAskIssues = formatAskIssues;
/** Text-to-SQL pipeline: write one SELECT, check it, run it, then explain the rows. */
const node_fs_1 = require("node:fs");
const promises_1 = require("node:fs/promises");
const node_path_1 = require("node:path");
const zod_1 = require("zod");
const config_1 = require("../config/config");
const schemaService_1 = require("./schemaService");
const db_1 = require("../dataaccess/db");
const llm_1 = require("./llm");
const prompts_1 = require("./prompts");
const sqlGuard_1 = require("../utils/sqlGuard");
const schemaContext_1 = require("../utils/schemaContext");
exports.ASK_ERROR_MESSAGE = "I couldn't build a valid query for that. Try naming the payer, county or specialty.";
const payorName = zod_1.z.string().trim().min(1, 'payor is required').max(200);
const planTypeName = zod_1.z.string().trim().min(1, 'planType is required').max(25);
const payorPlanTypeSchema = zod_1.z.object({
    payor: payorName,
    planType: planTypeName,
});
exports.askRequestSchema = zod_1.z.object({
    question: zod_1.z.string().max(500, 'question must be at most 500 characters').transform((value) => value.trim()).pipe(zod_1.z.string().min(1, 'question is required')),
    payors: zod_1.z.array(payorName, { error: 'payors is required' }).min(1, 'payors is required'),
    payorsCrossPlanTypes: zod_1.z.array(payorPlanTypeSchema, { error: 'payors cross planTypes is required' }).min(1, 'payors cross planTypes is required'),
    context: zod_1.z.object({
        county: zod_1.z.string().trim().max(200).optional(),
        state: zod_1.z.string().trim().max(200).optional(),
        system: zod_1.z.string().trim().max(200).optional(),
    }).optional(),
}).superRefine((value, ctx) => {
    const listed = new Map(value.payors.map((payor) => [payor.toLowerCase(), payor]));
    const covered = new Set();
    const seenPairs = new Set();
    const seenPayors = new Set();
    value.payors.forEach((payor, index) => {
        const key = payor.toLowerCase();
        if (seenPayors.has(key)) {
            ctx.addIssue({ code: 'custom', path: ['payors', index], message: `duplicate payor "${payor}"` });
        }
        seenPayors.add(key);
    });
    value.payorsCrossPlanTypes.forEach((pair, index) => {
        const payorKey = pair.payor.toLowerCase();
        if (!listed.has(payorKey)) {
            ctx.addIssue({
                code: 'custom',
                path: ['payorsCrossPlanTypes', index, 'payor'],
                message: `payor "${pair.payor}" must be listed in payors`,
            });
        }
        else {
            covered.add(payorKey);
        }
        const pairKey = `${payorKey}|${pair.planType.toLowerCase()}`;
        if (seenPairs.has(pairKey)) {
            ctx.addIssue({
                code: 'custom',
                path: ['payorsCrossPlanTypes', index],
                message: `duplicate payor and planType "${pair.payor}" / "${pair.planType}"`,
            });
        }
        seenPairs.add(pairKey);
    });
    value.payors.forEach((payor, index) => {
        if (!covered.has(payor.toLowerCase())) {
            ctx.addIssue({
                code: 'custom',
                path: ['payors', index],
                message: `payor "${payor}" needs at least one planType in payorsCrossPlanTypes`,
            });
        }
    });
    const state = value.context?.state;
    if (state && !/^(tx|texas)$/i.test(state)) {
        ctx.addIssue({ code: 'custom', path: ['context', 'state'], message: 'only Texas data is available' });
    }
});
/** Tables that carry a payor and the payor × plan type cross. */
const SCOPE_TABLES = ['ParentOrganization', 'GeographyPlanFilters', 'PlanType'];
function sqlIncludes(sql, value) {
    return sql.toLowerCase().includes(value.toLowerCase().replace(/'/g, "''"));
}
/** Reject SQL that is not limited to the request's payors and payor × plan type pairs. */
function payorScopeIssue(sql, tables, input) {
    const have = new Set(tables.map((table) => table.toLowerCase()));
    const missingTables = SCOPE_TABLES.filter((table) => !have.has(table.toLowerCase()));
    const missingPayors = input.payors.filter((payor) => !sqlIncludes(sql, payor));
    const planTypes = [...new Set(input.payorsCrossPlanTypes.map((pair) => pair.planType))];
    const missingPlanTypes = planTypes.filter((planType) => !sqlIncludes(sql, planType));
    if (!missingTables.length && !missingPayors.length && !missingPlanTypes.length)
        return '';
    const parts = ['Every query must filter to the required payors and the payor × plan type cross (ParentOrganization JOIN GeographyPlanFilters JOIN PlanType).'];
    if (missingTables.length)
        parts.push(`Missing tables: ${missingTables.join(', ')}.`);
    if (missingPayors.length)
        parts.push(`Missing payor filters: ${missingPayors.join(', ')}.`);
    if (missingPlanTypes.length)
        parts.push(`Missing plan type filters: ${missingPlanTypes.join(', ')}.`);
    parts.push('Keep each payor only for the plan types paired with it.');
    return parts.join(' ');
}
let cachedExamples = null;
function loadExamples() {
    if (cachedExamples)
        return cachedExamples;
    const raw = JSON.parse((0, node_fs_1.readFileSync)((0, node_path_1.join)(__dirname, '..', 'docs', 'examples.json'), 'utf8'));
    cachedExamples = raw.examples;
    return cachedExamples;
}
function redact(text) {
    return text.split(config_1.config.DB_PASSWORD).join('[redacted]').split(config_1.config.LLM_API_KEY).join('[redacted]').slice(0, 500);
}
function errorText(err) {
    const message = err instanceof Error ? err.message : 'Query failed';
    return redact(message);
}
/** Dates and byte strings become text. Numbers stay numbers so the answer check can see them. */
function convertCell(value) {
    if (value instanceof Date)
        return value.toISOString();
    if (typeof Buffer !== 'undefined' && Buffer.isBuffer(value))
        return value.toString('utf8');
    if (typeof value === 'bigint') {
        const asNumber = Number(value);
        return Number.isSafeInteger(asNumber) ? asNumber : value.toString();
    }
    return value;
}
function numericValues(text) {
    const found = text.match(/-?\d[\d,]*(?:\.\d+)?%?/g) ?? [];
    return found
        .map((raw) => Number(raw.replace(/,/g, '').replace(/%/g, '')))
        .filter((value) => Number.isFinite(value));
}
/** Every number in the answer must already appear in the rows or the question. Commas and % are ignored. */
function numbersMatchAnswer(answer, question, rows) {
    const allowed = numericValues(`${question}\n${JSON.stringify(rows)}`);
    return numericValues(answer).every((value) => allowed.some((candidate) => Math.abs(candidate - value) < 1e-6));
}
function templateAnswer(columns, rows) {
    const lines = [`Here are the results (${rows.length} rows).`];
    for (const row of rows.slice(0, 3)) {
        const parts = columns.map((column, index) => `${column}: ${row[index] == null ? '' : String(row[index])}`);
        lines.push(`- ${parts.join(', ')}`);
    }
    return lines.join('\n');
}
function scenarioLine(context) {
    if (!context)
        return '';
    const parts = ['county', 'state', 'system']
        .filter((key) => context[key])
        .map((key) => `${key}=${context[key]}`);
    return parts.length ? `Current scenario: ${parts.join(', ')}` : '';
}
function scopeLine(input) {
    const pairs = input.payorsCrossPlanTypes.map((pair) => `${pair.payor} × ${pair.planType}`).join('; ');
    return [
        `Required payors: ${input.payors.join(', ')}`,
        `Required payors cross plan types: ${pairs}`,
        'Required state: TX. Only Texas rows are allowed (StateCode = \'TX\' or FIPS LIKE \'48%\').',
        'Payors, the payor × plan type cross, and Texas are mandatory.',
    ].join('\n');
}
function userText(input) {
    const parts = [input.question, scopeLine(input)];
    const line = scenarioLine(input.context);
    if (line)
        parts.push(line);
    return parts.join('\n');
}
function referencesFor(tables, schema) {
    const byName = new Map(schema.tables.map((table) => [table.table.toLowerCase(), table.description]));
    return tables.map((table) => ({ table, description: byName.get(table.toLowerCase()) ?? '' }));
}
async function writeAuditFile(entry) {
    const dir = (0, node_path_1.join)(__dirname, '..', 'logs');
    await (0, promises_1.mkdir)(dir, { recursive: true });
    const line = {
        time: entry.time,
        question: entry.question,
        sql: entry.sql,
        guard: entry.guard,
        rowCount: entry.rowCount,
        ms: entry.ms,
        ...(entry.error ? { error: entry.error } : {}),
    };
    await (0, promises_1.appendFile)((0, node_path_1.join)(dir, 'ask.jsonl'), `${JSON.stringify(line)}\n`, 'utf8');
}
async function record(deps, entry) {
    try {
        await (deps.audit ?? writeAuditFile)(entry);
    }
    catch (err) {
        deps.log?.(JSON.stringify({ event: 'ask_audit', message: errorText(err) }));
    }
}
function createDefaultDeps() {
    const schema = (0, schemaService_1.getSchemaContext)();
    if (!schema)
        throw new Error('Schema is not loaded');
    return {
        chat: llm_1.chat,
        query: async (sql) => (0, db_1.runGuardedQuery)(await (0, db_1.getPool)((0, schemaService_1.databaseConfig)()), sql),
        schema,
        catalog: (0, schemaService_1.getCatalog)(),
        examples: loadExamples(),
        database: config_1.config.DB_DATABASE,
        log: (line) => console.error(line),
    };
}
async function answerQuestion(input, deps = createDefaultDeps()) {
    const started = Date.now();
    const system = (0, prompts_1.textToSqlSystemPrompt)((0, schemaContext_1.renderSchema)(deps.schema, deps.catalog), deps.examples, db_1.MAX_ROWS);
    const questionText = userText(input);
    let messages = [{ role: 'user', content: questionText }];
    let llmMs = 0;
    let dbMs = 0;
    let lastSql = '';
    let lastGuard = 'not run';
    let lastError = '';
    const elapsed = () => Date.now() - started;
    const audit = (extra) => record(deps, {
        time: new Date().toISOString(),
        question: input.question,
        sql: extra.sql,
        guard: extra.guard,
        rowCount: extra.rowCount,
        ms: elapsed(),
        ...(extra.error ? { error: extra.error } : {}),
    });
    for (let attempt = 0; attempt < 2; attempt += 1) {
        const llmStarted = Date.now();
        const raw = await deps.chat({ system, messages: messages.map((message) => ({ ...message })), json: true });
        llmMs += Date.now() - llmStarted;
        const draft = (0, prompts_1.parseSqlDraft)(raw);
        if (!draft) {
            lastError = 'The model did not return valid SQL JSON.';
            lastGuard = 'rejected';
            if (attempt === 0) {
                messages = [...messages, { role: 'user', content: (0, prompts_1.repairMessage)(lastSql, lastError) }];
                continue;
            }
            break;
        }
        if (!draft.sql.trim()) {
            await audit({ sql: '', guard: 'cannot_answer', rowCount: 0 });
            return { kind: 'cannot_answer', explanation: draft.explanation };
        }
        const guard = (0, sqlGuard_1.guardSql)(draft.sql, { allowedTables: deps.schema.allowedTables, database: deps.database });
        const scopeIssue = guard.ok ? payorScopeIssue(guard.sql, guard.tables, input) : '';
        if (!guard.ok || scopeIssue) {
            lastSql = guard.ok ? guard.sql : draft.sql;
            lastGuard = guard.ok ? scopeIssue : guard.reason;
            lastError = lastGuard;
            if (attempt === 0) {
                messages = [
                    { role: 'user', content: questionText },
                    { role: 'assistant', content: raw },
                    { role: 'user', content: (0, prompts_1.repairMessage)(lastSql, lastError) },
                ];
                continue;
            }
            break;
        }
        lastSql = guard.sql;
        lastGuard = 'ok';
        const queryStarted = Date.now();
        let result;
        try {
            result = await deps.query(guard.sql);
            dbMs += result.ms;
        }
        catch (err) {
            dbMs += Date.now() - queryStarted;
            lastError = errorText(err);
            deps.log?.(JSON.stringify({ event: 'ask_sql_error', message: lastError }));
            if (attempt === 0) {
                await audit({ sql: guard.sql, guard: 'ok', rowCount: 0, error: lastError });
                messages = [
                    { role: 'user', content: questionText },
                    { role: 'assistant', content: raw },
                    { role: 'user', content: (0, prompts_1.repairMessage)(guard.sql, lastError) },
                ];
                continue;
            }
            break;
        }
        return finishData(deps, input, draft, guard, result, llmMs, dbMs, elapsed, audit);
    }
    await audit({ sql: lastSql, guard: lastGuard, rowCount: 0, error: lastError || exports.ASK_ERROR_MESSAGE });
    return { kind: 'error', message: exports.ASK_ERROR_MESSAGE };
}
async function finishData(deps, input, draft, guard, result, llmMs, dbMs, elapsed, audit) {
    const columns = result.columns;
    const rows = result.rows.slice(0, db_1.MAX_ROWS).map((row) => row.map(convertCell));
    const llmStarted = Date.now();
    let answer = '';
    try {
        answer = await deps.chat({
            system: (0, prompts_1.answerSystemPrompt)(),
            messages: [{ role: 'user', content: (0, prompts_1.answerUserMessage)(input.question, draft, columns, rows, result.rowLimitHit) }],
        });
    }
    catch (err) {
        deps.log?.(JSON.stringify({ event: 'ask_answer', message: errorText(err) }));
        answer = '';
    }
    llmMs += Date.now() - llmStarted;
    if (!answer.trim() || !numbersMatchAnswer(answer, input.question, rows))
        answer = templateAnswer(columns, rows);
    const totalMs = elapsed();
    await audit({ sql: guard.sql, guard: 'ok', rowCount: rows.length });
    return {
        kind: 'data',
        answer,
        explanation: draft.explanation,
        assumptions: draft.assumptions,
        columns,
        rows,
        rowLimitHit: result.rowLimitHit,
        sql: guard.sql,
        references: referencesFor(guard.tables, deps.schema),
        timings: { llmMs, dbMs, totalMs },
    };
}
function formatAskIssues(error) {
    return error.issues.map((issue) => {
        const field = issue.path.length ? issue.path.map(String).join('.') : 'body';
        return `${field}: ${issue.message}`;
    }).join('; ');
}
