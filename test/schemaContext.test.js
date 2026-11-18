"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const strict_1 = __importDefault(require("node:assert/strict"));
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const schemaContext_1 = require("../utils/schemaContext");
const prompts_1 = require("../services/prompts");
const docs = (0, node_path_1.join)(__dirname, '..', 'docs');
const catalog = JSON.parse((0, node_fs_1.readFileSync)((0, node_path_1.join)(docs, 'schema_catalog.json'), 'utf8'));
const { examples } = JSON.parse((0, node_fs_1.readFileSync)((0, node_path_1.join)(docs, 'examples.json'), 'utf8'));
/** Pretend the live DB matches the design, except for a few realistic differences. */
function fakeLive() {
    const live = [];
    for (const t of catalog.tables) {
        if (t.table === 'NPIQuickFilterMapping')
            continue; // table not built yet
        for (const c of t.columns) {
            if (t.table === 'HospitalDetails' && c.name === 'HosptitalName') {
                live.push({ table: 'HospitalDetails', column: 'HospitalName', dataType: 'varchar', maxLength: 100 }); // typo fixed in DB
                continue;
            }
            live.push({ table: t.table, column: c.name, dataType: 'varchar', maxLength: 50 });
        }
    }
    live.push({ table: 'ClientDetails', column: 'ClientName', dataType: 'varchar', maxLength: 100 }); // visible but excluded
    return live;
}
(0, node_test_1.test)('live schema wins and drift is reported', () => {
    const ctx = (0, schemaContext_1.mergeSchema)(catalog, fakeLive());
    strict_1.default.ok(!ctx.allowedTables.includes('NPIQuickFilterMapping'));
    strict_1.default.ok(!ctx.allowedTables.includes('ClientDetails'), 'excluded tables never become allowed');
    strict_1.default.deepEqual(ctx.drift.missingTables, ['NPIQuickFilterMapping']);
    strict_1.default.ok(ctx.drift.missingColumns.includes('HospitalDetails.HosptitalName'));
    strict_1.default.ok(ctx.drift.undocumentedColumns.includes('HospitalDetails.HospitalName'));
    const hd = ctx.tables.find((t) => t.table === 'HospitalDetails');
    strict_1.default.ok(hd.columns.some((c) => c.name === 'HospitalName'));
});
(0, node_test_1.test)('full prompt stays small enough to send on every question', () => {
    const ctx = (0, schemaContext_1.mergeSchema)(catalog, fakeLive());
    const prompt = (0, prompts_1.textToSqlSystemPrompt)((0, schemaContext_1.renderSchema)(ctx, catalog), examples, 500);
    const approxTokens = Math.round(prompt.length / 4);
    console.log(`prompt chars=${prompt.length} (~${approxTokens} tokens), tables=${ctx.tables.length}`);
    strict_1.default.ok(approxTokens < 12000);
});
(0, node_test_1.test)('chat answers stay on provider networks', () => {
    const prompt = (0, prompts_1.networkChatSystemPrompt)('You are a helpful assistant.');
    strict_1.default.match(prompt, /provider networks/);
    strict_1.default.match(prompt, /Houston County, Texas/);
    strict_1.default.match(prompt, /in-network providers, hospitals, or enrollment/);
    strict_1.default.match(prompt, /Caller instructions:\nYou are a helpful assistant\./);
});
(0, node_test_1.test)('parses model JSON, with or without a code fence', () => {
    strict_1.default.equal((0, prompts_1.parseSqlDraft)('```json\n{"sql":"SELECT 1","explanation":"x","assumptions":["TX"]}\n```')?.assumptions[0], 'TX');
    strict_1.default.equal((0, prompts_1.parseSqlDraft)('not json'), null);
    strict_1.default.equal((0, prompts_1.parseSqlDraft)('{"explanation":"no sql"}'), null);
});
