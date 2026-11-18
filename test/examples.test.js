"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const strict_1 = __importDefault(require("node:assert/strict"));
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const node_sql_parser_1 = require("node-sql-parser");
const sqlGuard_1 = require("../utils/sqlGuard");
const docs = (0, node_path_1.join)(__dirname, '..', 'docs');
const catalog = JSON.parse((0, node_fs_1.readFileSync)((0, node_path_1.join)(docs, 'schema_catalog.json'), 'utf8'));
const { examples } = JSON.parse((0, node_fs_1.readFileSync)((0, node_path_1.join)(docs, 'examples.json'), 'utf8'));
const opts = { allowedTables: catalog.tables.map((t) => t.table), database: 'NI_hackathon_data' };
const columns = new Map(catalog.tables.map((t) => [t.table.toLowerCase(), new Set(t.columns.map((c) => c.name.toLowerCase()))]));
(0, node_test_1.test)('every example passes the guard', () => {
    for (const ex of examples) {
        const r = (0, sqlGuard_1.guardSql)(ex.sql, opts);
        strict_1.default.equal(r.ok, true, `${ex.question}: ${r.ok ? '' : r.reason}`);
    }
});
(0, node_test_1.test)('every qualified column in the examples exists in the documented schema', () => {
    const parser = new node_sql_parser_1.Parser();
    for (const ex of examples) {
        // alias -> table map from FROM/JOIN clauses
        const aliases = new Map();
        for (const m of ex.sql.matchAll(/\b(?:FROM|JOIN)\s+(?:dbo\.)?\[?(\w+)\]?\s+(?:AS\s+)?(\w+)/gi))
            aliases.set(m[2].toLowerCase(), m[1].toLowerCase());
        const missing = [];
        for (const m of ex.sql.matchAll(/\b(\w+)\.(\w+)\b/g)) {
            const table = aliases.get(m[1].toLowerCase());
            if (!table || !columns.has(table))
                continue; // CTE alias or dbo prefix
            if (!columns.get(table).has(m[2].toLowerCase()))
                missing.push(`${m[1]}.${m[2]} (${table})`);
        }
        strict_1.default.deepEqual(missing, [], `${ex.question}: unknown columns ${missing.join(', ')}`);
        parser.astify(ex.sql, { database: 'TransactSQL' });
    }
});
