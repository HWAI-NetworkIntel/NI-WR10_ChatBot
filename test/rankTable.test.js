'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { buildRankTable, normalizeTableSpec } = require('../services/rankTable')
const { planQuestion, planFromRules, historyFromBody } = require('../services/conversationPlanner')

const row = (county, payor, planType, value, rank) => ({
  county, state: 'TX', fips: '', payor, planType, metric: 'Network score', value, asOf: '2026', network: `${payor} net`, publishedRank: rank,
})
const rankings = [
  row('Harris', 'Humana Inc.', 'HMO', 80, 1),
  row('Harris', 'Molina Healthcare, Inc.', 'HMO', 60, 2),
  row('Harris', 'CVS Health Corporation', 'HMO', 50, 3),
  row('Dallas', 'Molina Healthcare, Inc.', 'HMO', 70, 1),
  row('Dallas', 'Humana Inc.', 'HMO', 65, 2),
  row('Dallas', 'Humana Inc.', 'PPO', 90, 1),
]
const deps = { loadData: () => ({ rankings, roster: [] }) }
const dashboard = {
  payors: ['Molina Healthcare, Inc.'],
  payorsCrossPlanTypes: [{ payor: 'Molina Healthcare, Inc.', planType: 'HMO' }],
}

test('unknown columns and fields from the model are dropped', () => {
  const spec = normalizeTableSpec({ columns: ['County', 'score', 'enrollment', 'DROP TABLE'], pivot: { rows: 'county', columns: 'county' } })
  assert.deepEqual(spec.columns, ['county', 'value'])
  assert.equal(spec.pivot, null)
})

test('our rank in every county, with the columns the user asked for', () => {
  const table = buildRankTable({ columns: ['county', 'rank', 'payorsRanked', 'value', 'network'] }, dashboard, deps)
  assert.equal(table.kind, 'data')
  assert.deepEqual(table.columns, ['County', 'Rank', 'Ranked networks', 'Network score', 'Network'])
  assert.deepEqual(table.rows, [
    ['Dallas', 1, 3, 70, 'Molina Healthcare, Inc. net'],
    ['Harris', 2, 3, 60, 'Molina Healthcare, Inc. net'],
  ])
})

test('all payors pivoted: counties down, payors across, rank in cells', () => {
  const table = buildRankTable({ scope: 'all', filters: { planType: ['HMO'] }, pivot: { rows: 'county', columns: 'payor', value: 'rank' } }, dashboard, deps)
  assert.deepEqual(table.columns, ['County', 'CVS Health Corporation', 'Humana Inc.', 'Molina Healthcare, Inc.'])
  assert.deepEqual(table.rows, [
    ['Dallas', null, 2, 1],
    ['Harris', 3, 1, 2],
  ])
})

test('a named payor and rank filter override the dashboard scope', () => {
  const table = buildRankTable({ columns: ['county', 'planType', 'rank'], filters: { payor: ['Humana'], rankMax: 1 } }, dashboard, deps)
  assert.deepEqual(table.rows, [['Dallas', 'PPO', 1], ['Harris', 'HMO', 1]])
})

test('the screenshot question builds a table from the real rankings file', async () => {
  const plan = await planQuestion({ question: 'prepare a table which shows for all county and theor respective rankings', ...dashboard }, { chat: null })
  assert.equal(plan.route, 'table')
  const table = buildRankTable(plan.table, dashboard)
  assert.ok(table.rows.length > 10, `expected many counties, got ${table.rows.length}`)
  assert.ok(table.columns.length > 2)
  assert.ok(table.rows.every((cells) => cells[1] === 'Molina Healthcare, Inc.'))
})

test('the model plan carries the conversation into a follow-up', async () => {
  let seen = null
  const plan = await planQuestion({
    question: 'add the network score and network name too',
    history: [{ role: 'user', content: 'show our rank in every county' }, { role: 'assistant', content: '| County | Rank |' }],
    ...dashboard,
  }, {
    chat: async (request) => {
      seen = JSON.parse(request.messages[0].content)
      return JSON.stringify({
        route: 'table',
        standalone: 'Show our rank, network score and network name in every Texas county.',
        table: { columns: ['county', 'rank', 'value', 'network'] },
      })
    },
  })
  assert.equal(seen.conversation.length, 2)
  assert.equal(plan.route, 'table')
  assert.deepEqual(plan.table.columns, ['county', 'rank', 'value', 'network'])
})

test('a bad model reply falls back to the wording rules', async () => {
  const plan = await planQuestion({ question: 'what if we drop Baylor' }, { chat: async () => 'not json' })
  assert.equal(plan, null)
  assert.equal(planFromRules('list rankings for every county for all payors').table.scope, 'all')
})

test('history comes from messages before the last user turn', () => {
  const history = historyFromBody({ messages: [
    { role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' },
  ] })
  assert.deepEqual(history.map((turn) => turn.content), ['a', 'b'])
})
