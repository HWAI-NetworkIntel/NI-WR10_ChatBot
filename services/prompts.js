"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.textToSqlSystemPrompt = textToSqlSystemPrompt;
exports.networkChatSystemPrompt = networkChatSystemPrompt;
exports.repairMessage = repairMessage;
exports.answerSystemPrompt = answerSystemPrompt;
exports.answerUserMessage = answerUserMessage;
exports.parseSqlDraft = parseSqlDraft;
function textToSqlSystemPrompt(schemaText, examples, maxRows) {
    return [
        'You write one Microsoft SQL Server (T-SQL) SELECT query that answers a question about Medicare Advantage provider networks in the NI database.',
        '',
        'Hard rules:',
        '- Output JSON only: {"sql": "...", "explanation": "one sentence in plain English", "assumptions": ["..."]}.',
        '- One SELECT statement (a WITH ... SELECT is fine). No INSERT/UPDATE/DELETE/DDL, no temp tables, no variables, no comments.',
        '- Use only the tables and columns listed in SCHEMA. Never guess a column name.',
        `- Return at most ${maxRows} rows: use TOP and an ORDER BY that puts the most useful rows first.`,
        '- Do not use EXCEPT, INTERSECT or OFFSET/FETCH. Use NOT EXISTS and TOP instead.',
        '- Aggregate in SQL (COUNT DISTINCT, SUM) instead of returning raw rows when the question asks "how many", "compare" or "which most".',
        '- Give result columns readable aliases (Providers, Enrollment, Payer).',
        '- Data access is Texas only. Every geographic table (anything with StateCode or FIPS) must be limited to Texas: StateCode = \'TX\', or FIPS / NPI_FIPS / Isochrone_FIPS LIKE \'48%\'. Texas county FIPS codes start with 48.',
        '- If the question asks about any state other than Texas, return {"sql": "", "explanation": "Only Texas data is available.", "assumptions": []}.',
        '- "Rank", "compare", "how many", and "which" mean a provider-network comparison: in-network providers, hospitals, or enrollment for the named Texas county. Houston County means Houston County, Texas.',
        '- Match names loosely: payer names with LIKE \'%humana%\', specialties via HWAISpecialtyDescription LIKE \'%cardio%\', counties with CountyName LIKE \'Houston%\' plus StateCode = \'TX\'.',
        '- SCOPE is mandatory on every question. Filter to the listed payors only, and for each payor only the plan types paired with it.',
        '- Always join ParentOrganization po to GeographyPlanFilters gpf ON gpf.ParentOrganizationId = po.ParentOrganizationId, then PlanType pt ON pt.PlanTypeId = gpf.PlanTypeId. That join is the payor × plan type cross. Examples that omit it are incomplete; add it anyway.',
        '- If the question cannot be answered from SCHEMA, return {"sql": "", "explanation": "why not", "assumptions": []}.',
        '- Put every interpretation you made (which state, which year, which payer name) in "assumptions".',
        '',
        'SCHEMA:',
        schemaText,
        '',
        'EXAMPLES:',
        ...examples.map((e) => `Q: ${e.question}\nSQL:\n${e.sql}\n`),
    ].join('\n');
}
/** Keep /llm/chat on Medicare Advantage provider networks. Caller instructions still control output format. */
function networkChatSystemPrompt(callerSystem) {
    const domain = [
        'You advise health-plan analysts on Medicare Advantage provider networks in Texas.',
        'The subject is always provider networks: payors, plan types, the payor × plan type cross, in-network providers, hospitals, specialties, enrollment, and Texas counties.',
        'A county name means that county in Texas. Houston County means Houston County, Texas.',
        'Rank, compare, how many, which, and list mean a network comparison. Rank payors or networks by in-network providers, hospitals, or enrollment.',
        'If the metric, payor, or plan type is missing, ask only for those. Stay on provider networks.',
        'Do not invent provider, hospital, or enrollment counts. Counts come from the Texas network data.',
        'When the caller instructions require a specific output format, such as JSON, follow that format. These rules decide the subject.',
        ...require('./terminology').GLOSSARY,
    ].join('\n');
    const extra = typeof callerSystem === 'string' ? callerSystem.trim() : '';
    return extra ? `${domain}\n\nCaller instructions:\n${extra}` : domain;
}
function repairMessage(previousSql, error) {
    return `That query failed: ${error}\nPrevious SQL:\n${previousSql}\nReturn corrected JSON in the same format. Use only tables and columns from SCHEMA.`;
}
function answerSystemPrompt() {
    return [
        'You explain the result of a database query to a health plan network analyst.',
        '- Answer the question in 2-5 sentences of plain English, then up to 5 bullets with the key comparisons.',
        '- Use only numbers that appear in RESULT. Keep thousands separators. Never estimate or extrapolate.',
        '- If RESULT is empty, say no matching data was found and suggest one way to broaden the question.',
        '- If ROW_LIMIT_HIT is true, say the list was cut off at the row limit.',
        '- Mention the assumptions briefly if they affect the answer.',
        '- Do not mention SQL, tables or column names; the UI shows those separately as references.',
        ...require('./terminology').GLOSSARY,
    ].join('\n');
}
function answerUserMessage(question, draft, columns, rows, rowLimitHit) {
    return JSON.stringify({ QUESTION: question, ASSUMPTIONS: draft.assumptions, COLUMNS: columns, RESULT: rows.slice(0, 50), ROW_LIMIT_HIT: rowLimitHit });
}
/** Parse the model's JSON reply into a SqlDraft, tolerating a code fence. */
function parseSqlDraft(text) {
    try {
        const value = JSON.parse(text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
        if (typeof value?.sql !== 'string' || typeof value?.explanation !== 'string')
            return null;
        const assumptions = Array.isArray(value.assumptions) ? value.assumptions.filter((a) => typeof a === 'string') : [];
        return { sql: value.sql, explanation: value.explanation, assumptions };
    }
    catch {
        return null;
    }
}
