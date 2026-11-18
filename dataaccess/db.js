"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAX_ROWS = void 0;
exports.getPool = getPool;
exports.readLiveSchema = readLiveSchema;
exports.runGuardedQuery = runGuardedQuery;
/** SQL Server access for the chatbot: read-only login, row cap, timeout. */
const mssql_1 = __importDefault(require("mssql"));
exports.MAX_ROWS = 500;
const REQUEST_TIMEOUT_MS = 15_000;
let pool = null;
async function getPool(cfg) {
    if (pool?.connected)
        return pool;
    pool = await new mssql_1.default.ConnectionPool({
        server: cfg.server,
        database: cfg.database,
        user: cfg.user,
        password: cfg.password,
        port: cfg.port ?? 1433,
        requestTimeout: REQUEST_TIMEOUT_MS,
        connectionTimeout: 10_000,
        pool: { max: 5, min: 0, idleTimeoutMillis: 30_000 },
        options: { encrypt: cfg.encrypt ?? true, trustServerCertificate: cfg.trustServerCertificate ?? false },
    }).connect();
    return pool;
}
/** Column list for the tables this login can see. */
async function readLiveSchema(p) {
    const r = await p.request().query(`
    SELECT TABLE_NAME AS [table], COLUMN_NAME AS [column], DATA_TYPE AS dataType, CHARACTER_MAXIMUM_LENGTH AS maxLength
    FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = 'dbo' ORDER BY TABLE_NAME, ORDINAL_POSITION`);
    return r.recordset;
}
/**
 * Run a query that already passed guardSql. SET ROWCOUNT caps rows server-side;
 * READ UNCOMMITTED avoids blocking ETL loads on the hackathon database.
 */
async function runGuardedQuery(p, guardedSql) {
    const started = Date.now();
    const request = p.request();
    const batch = `SET NOCOUNT ON; SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED; SET ROWCOUNT ${exports.MAX_ROWS + 1};\n${guardedSql}\n;SET ROWCOUNT 0;`;
    const result = await request.query(batch);
    const recordset = result.recordset ?? [];
    const columns = Object.keys(recordset.columns ?? {});
    const rows = recordset.slice(0, exports.MAX_ROWS).map((r) => columns.map((c) => r[c]));
    return { columns, rows, rowLimitHit: recordset.length > exports.MAX_ROWS, ms: Date.now() - started };
}
