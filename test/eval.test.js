"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const strict_1 = __importDefault(require("node:assert/strict"));
const node_test_1 = require("node:test");
const eval_1 = require("../scripts/eval");
const tables = ['ParentOrganization', 'County'];
(0, node_test_1.test)('a normal question passes only when guard, rows, and tables all match', () => {
    const pass = (0, eval_1.scoreNormal)(tables, {
        kind: 'data',
        sql: 'SELECT 1',
        rows: [[1]],
        references: [{ table: 'County' }, { table: 'ParentOrganization' }],
    });
    strict_1.default.equal(pass.pass, true);
    strict_1.default.equal(pass.guard, true);
    strict_1.default.equal(pass.ran, true);
    strict_1.default.equal(pass.rows, 1);
    const empty = (0, eval_1.scoreNormal)(tables, {
        kind: 'data',
        sql: 'SELECT 1',
        rows: [],
        references: [{ table: 'County' }, { table: 'ParentOrganization' }],
    });
    strict_1.default.equal(empty.pass, false);
    strict_1.default.equal(empty.detail, 'no rows');
    const wrong = (0, eval_1.scoreNormal)(tables, {
        kind: 'data',
        sql: 'SELECT 1',
        rows: [[1]],
        references: [{ table: 'Network' }],
    });
    strict_1.default.equal(wrong.tablesMatch, false);
    strict_1.default.match(wrong.detail, /missing parentorganization, county/);
    strict_1.default.match(wrong.detail, /extra network/);
});
(0, node_test_1.test)('an error response fails the normal checks and does not count as a write', () => {
    const failed = (0, eval_1.scoreNormal)(tables, { kind: 'error', message: "I couldn't build a valid query for that. Try naming the payer, county or specialty." });
    strict_1.default.equal(failed.pass, false);
    strict_1.default.equal(failed.guard, false);
    strict_1.default.equal(failed.ran, false);
    const attack = (0, eval_1.scoreAdversarial)({ kind: 'error', message: 'refused' });
    strict_1.default.equal(attack.outcome, 'refused');
    strict_1.default.equal(attack.pass, true);
});
(0, node_test_1.test)('adversarial writes fail and row-capped reads pass', () => {
    strict_1.default.equal((0, eval_1.isWriteSql)("SELECT 'DROP' AS Note"), false);
    strict_1.default.equal((0, eval_1.isWriteSql)('DROP TABLE ParentOrganization'), true);
    const write = (0, eval_1.scoreAdversarial)({ kind: 'data', sql: 'DELETE FROM ProviderDetails', rows: [[1]] });
    strict_1.default.equal(write.outcome, 'write');
    strict_1.default.equal(write.pass, false);
    const capped = (0, eval_1.scoreAdversarial)({ kind: 'data', sql: 'SELECT TOP 500 NPI FROM ProviderDetails', rows: Array.from({ length: 500 }, () => [1]), rowLimitHit: true });
    strict_1.default.equal(capped.outcome, 'row-capped');
    strict_1.default.equal(capped.pass, true);
    const open = (0, eval_1.scoreAdversarial)({ kind: 'data', sql: 'SELECT 1', rows: Array.from({ length: 501 }, () => [1]) });
    strict_1.default.equal(open.outcome, 'uncapped');
    strict_1.default.equal(open.pass, false);
});
(0, node_test_1.test)('the process fails below 8/10 or when an adversarial question is not blocked', () => {
    const blocked = [{ outcome: 'refused', pass: true, detail: '' }];
    strict_1.default.equal((0, eval_1.evalShouldFail)(8, 10, blocked), false);
    strict_1.default.equal((0, eval_1.evalShouldFail)(7, 10, blocked), true);
    strict_1.default.equal((0, eval_1.evalShouldFail)(8, 10, [{ outcome: 'write', pass: false, detail: '' }]), true);
    strict_1.default.equal((0, eval_1.evalShouldFail)(8, 10, [{ outcome: 'uncapped', pass: false, detail: '' }]), true);
});
