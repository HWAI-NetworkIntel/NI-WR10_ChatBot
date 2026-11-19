"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.databaseConfig = databaseConfig;
exports.getCatalog = getCatalog;
exports.getSchemaContext = getSchemaContext;
exports.getRenderedSchema = getRenderedSchema;
exports.schemaPanel = schemaPanel;
exports.formatDrift = formatDrift;
exports.refreshLiveSchema = refreshLiveSchema;
exports.startSchemaRefresh = startSchemaRefresh;
/** Live schema cache: catalog merged with INFORMATION_SCHEMA, refreshed every 10 minutes. */
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const config_1 = require("../config/config");
const db_1 = require("../dataaccess/db");
const schemaContext_1 = require("../utils/schemaContext");
const REFRESH_MS = 10 * 60 * 1000;
function databaseConfig() {
    return {
        server: config_1.config.DB_SERVER,
        database: config_1.config.DB_DATABASE,
        user: config_1.config.DB_USER,
        password: config_1.config.DB_PASSWORD,
        port: config_1.config.DB_PORT,
        encrypt: config_1.config.DB_ENCRYPT,
        trustServerCertificate: config_1.config.DB_TRUST_CERT,
    };
}
function loadCatalog() {
    const file = (0, node_path_1.join)(__dirname, '..', 'docs', 'schema_catalog.json');
    const raw = JSON.parse((0, node_fs_1.readFileSync)(file, 'utf8'));
    if (!raw || typeof raw !== 'object')
        throw new Error('docs/schema_catalog.json is not an object');
    const catalog = raw;
    if (!Array.isArray(catalog.tables) || !Array.isArray(catalog.joinPaths) || !Array.isArray(catalog.pitfalls)) {
        throw new Error('docs/schema_catalog.json is missing tables, joinPaths, or pitfalls');
    }
    return catalog;
}
const catalog = loadCatalog();
let snapshot = null;
let timer = null;
let driftPrinted = false;
function getCatalog() {
    return catalog;
}
function getSchemaContext() {
    return snapshot?.context ?? null;
}
/** Prompt text from the latest successful merge. Empty until the first refresh. */
function getRenderedSchema() {
    return snapshot?.text ?? '';
}
function schemaPanel(ctx) {
    return {
        tables: ctx.tables.map((table) => ({
            table: table.table,
            description: table.description,
            columns: table.columns.map((column) => ({
                name: column.name,
                type: column.type,
                ...(column.references ? { references: column.references } : {}),
                ...(column.note ? { note: column.note } : {}),
            })),
        })),
    };
}
function formatDrift(drift) {
    const sections = [
        ['Missing tables', drift.missingTables],
        ['Missing columns', drift.missingColumns],
        ['Undocumented columns', drift.undocumentedColumns],
    ];
    const lines = ['Schema drift:'];
    for (const [label, items] of sections) {
        lines.push(`${label} (${items.length}):`);
        if (items.length === 0)
            lines.push('  (none)');
        else
            for (const item of items)
                lines.push(`  - ${item}`);
    }
    return lines.join('\n');
}
function safeErrorMessage(err) {
    const message = err instanceof Error ? err.message : 'Schema refresh failed';
    return message.split(config_1.config.DB_PASSWORD).join('[redacted]').split(config_1.config.LLM_API_KEY).join('[redacted]').slice(0, 300);
}
async function refreshLiveSchema() {
    const pool = await (0, db_1.getPool)(databaseConfig());
    const live = await (0, db_1.readLiveSchema)(pool);
    const context = (0, schemaContext_1.mergeSchema)(catalog, live);
    snapshot = { context, text: (0, schemaContext_1.renderSchema)(context, catalog) };
    return context;
}
/** Load the schema now, print drift once, then refresh every 10 minutes. */
async function startSchemaRefresh() {
    try {
        const context = await refreshLiveSchema();
        if (!driftPrinted) {
            console.log(formatDrift(context.drift));
            driftPrinted = true;
        }
    }
    catch (err) {
        console.error(JSON.stringify({ event: 'schema_refresh', message: safeErrorMessage(err) }));
    }
    if (timer)
        return;
    timer = setInterval(() => {
        void refreshLiveSchema().catch((err) => {
            console.error(JSON.stringify({ event: 'schema_refresh', message: safeErrorMessage(err) }));
        });
    }, REFRESH_MS);
    timer.unref();
}
