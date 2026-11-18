"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const strict_1 = __importDefault(require("node:assert/strict"));
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const sqlGuard_1 = require("../utils/sqlGuard");
const catalog = JSON.parse((0, node_fs_1.readFileSync)((0, node_path_1.join)(__dirname, '..', 'docs', 'schema_catalog.json'), 'utf8'));
const opts = { allowedTables: catalog.tables.map((t) => t.table), database: 'NI_hackathon_data' };
const ok = (sql) => {
    const r = (0, sqlGuard_1.guardSql)(sql, opts);
    strict_1.default.equal(r.ok, true, `expected OK, got: ${r.ok ? '' : r.reason}\n${sql}`);
    return r;
};
const blocked = (sql, why) => {
    const r = (0, sqlGuard_1.guardSql)(sql, opts);
    strict_1.default.equal(r.ok, false, `expected BLOCKED:\n${sql}`);
    if (why && !r.ok)
        strict_1.default.match(r.reason, why);
};
(0, node_test_1.test)('allows realistic network comparison queries and reports tables used', () => {
    const r = ok(`SELECT TOP 20 po.ParentOrganizationName, COUNT(DISTINCT pl.NPI) AS providers
    FROM dbo.NetworkProviderMapping npm
    JOIN ProviderLocation pl ON pl.ProviderLocationId = npm.ProviderLocationId
    JOIN [ParentOrganization] po ON po.ParentOrganizationId = npm.ParentOrganizationId
    WHERE pl.FIPS = '48113' GROUP BY po.ParentOrganizationName ORDER BY providers DESC`);
    strict_1.default.deepEqual(r.tables, ['NetworkProviderMapping', 'ParentOrganization', 'ProviderLocation']);
});
(0, node_test_1.test)('allows CTEs, CAST joins, window functions, three-part names in the right database', () => {
    ok("WITH a AS (SELECT DISTINCT pl.NPI FROM ProviderLocation pl WHERE pl.FIPS = '48113') SELECT COUNT(*) FROM a");
    ok("SELECT hd.HosptitalName FROM ProviderHospitalAffiliation pha JOIN HospitalDetails hd ON hd.HospitalNPI = CAST(pha.HospitalNPI AS varchar(10)) WHERE hd.FIPS LIKE '48%'");
    ok("SELECT c.FIPS, ROW_NUMBER() OVER (PARTITION BY c.StateCode ORDER BY c.FIPS) rn FROM County c WHERE c.StateCode = 'TX'");
    ok("SELECT COUNT(*) FROM NI_hackathon_data.dbo.County WHERE StateCode = 'TX'");
    ok("```sql\nSELECT TOP 5 * FROM County WHERE StateCode = 'TX';\n```");
});
(0, node_test_1.test)('values that look like keywords inside strings are fine', () => {
    ok("SELECT * FROM ParentOrganization WHERE ParentOrganizationName LIKE '%Insert Health; DROP%'");
});
(0, node_test_1.test)('blocks writes and multiple statements', () => {
    blocked('DELETE FROM County', /SELECT/);
    blocked('SELECT 1; DROP TABLE County', /one statement/);
    blocked("UPDATE County SET CountyName = 'x'");
    blocked('SELECT * INTO #t FROM County', /INTO|Temporary/);
    blocked('SELECT * INTO County_copy FROM County', /INTO/);
    blocked('WITH x AS (SELECT 1 a) DELETE FROM County');
    blocked('TRUNCATE TABLE County');
});
(0, node_test_1.test)('blocks side effects, system objects and other databases', () => {
    blocked('SELECT name FROM sys.tables', /System catalog/);
    blocked('SELECT * FROM INFORMATION_SCHEMA.COLUMNS', /System catalog/);
    blocked("SELECT * FROM OPENROWSET('SQLNCLI','x','select 1')", /OPENROWSET/);
    blocked("EXEC xp_cmdshell 'dir'");
    blocked('SELECT 1 WHERE 1=1 WAITFOR DELAY \'00:00:10\'', /WAITFOR/);
    blocked('SELECT @@VERSION', /@/);
    blocked('SELECT * FROM OtherDb.dbo.Users', /Only tables/);
    blocked('SELECT * FROM LinkedSrv.OtherDb.dbo.Users');
    blocked('SELECT * FROM master.dbo.sysdatabases');
});
(0, node_test_1.test)('blocks tables outside the allowlist, including excluded client config tables', () => {
    blocked('SELECT * FROM ClientDetails', /not available/);
    blocked('SELECT * FROM LobbyUserConfig', /not available/);
    blocked('SELECT * FROM SomeRandomTable', /not available/);
    blocked('SELECT * FROM County c JOIN (SELECT * FROM ClientNetworkMapping) x ON 1=1', /not available/);
});
(0, node_test_1.test)('comments are stripped before checks and execution', () => {
    strict_1.default.equal((0, sqlGuard_1.stripComments)("SELECT 1 -- DROP TABLE x\nFROM County /* hi */").replace(/\s+/g, ' ').trim(), 'SELECT 1 FROM County');
    const r = ok("SELECT TOP 1 * FROM County WHERE StateCode = 'TX' -- ; DROP TABLE County");
    strict_1.default.ok(!r.sql.includes('DROP'));
    strict_1.default.equal((0, sqlGuard_1.stripComments)("SELECT '--not a comment' FROM County"), "SELECT '--not a comment' FROM County");
});
(0, node_test_1.test)('geographic queries are limited to Texas', () => {
    ok("SELECT * FROM County WHERE StateCode = 'TX'");
    ok("SELECT * FROM GeographyPlanFilters WHERE FIPS LIKE '48%'");
    ok("SELECT * FROM ProviderLocation WHERE FIPS IN ('48113', '48201')");
    ok('SELECT PlanType FROM PlanType');
    blocked('SELECT * FROM County', /Texas/);
    blocked("SELECT * FROM County WHERE StateCode = 'CA'", /Texas/);
    blocked("SELECT * FROM County WHERE StateCode IN ('TX', 'OK')", /Texas/);
    blocked("SELECT * FROM ProviderLocation WHERE FIPS = '06037'", /Texas/);
    blocked("SELECT * FROM MilesIndividual_30 WHERE Isochrone_FIPS LIKE '48%' AND NPI_FIPS = '40109'", /Texas/);
});
(0, node_test_1.test)('unsupported syntax fails closed with a hint the LLM can act on', () => {
    blocked('SELECT FIPS FROM County EXCEPT SELECT FIPS FROM ProviderLocation', /NOT EXISTS/);
    blocked('SELECT FIPS FROM County ORDER BY FIPS OFFSET 0 ROWS FETCH NEXT 5 ROWS ONLY', /TOP/);
});
