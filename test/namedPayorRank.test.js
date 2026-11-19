'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { answerRank, resetRankSessions } = require('../services/rankService')

const scope = {
  payors: ['Centene Corporation', 'Humana Inc.'],
  payorsCrossPlanTypes: [
    { payor: 'Centene Corporation', planType: 'HMO' },
    { payor: 'Humana Inc.', planType: 'HMO' },
    { payor: 'Humana Inc.', planType: 'PPO' },
  ],
}

test('a named payor gets its own rank, and is highlighted in the full list', async () => {
  resetRankSessions()
  const result = await answerRank({ ...scope, message: 'what is the centene ranking in dallas county' })
  assert.equal(result.kind, 'baseline')
  assert.equal(result.answer, 'Centene Corporation (HMO) is rank 4 of 16 in Dallas County, Texas.')
  const focal = result.standings.filter((row) => row.focal)
  assert.deepEqual(focal.map((row) => [row.rank, row.payor]), [[4, 'Centene Corporation (HMO)']])
  assert.ok(result.standings.length > 1, 'the full list is still there for the chart and table')
})

test('a payor with HMO and PPO gets one line per plan type', async () => {
  resetRankSessions()
  const result = await answerRank({ ...scope, message: 'what is the humana ranking in dallas county' })
  assert.equal(result.answer, 'Humana Inc. (PPO) is rank 5 of 16 in Dallas County, Texas. Humana Inc. (HMO) is rank 8 of 16 in Dallas County, Texas.')
  assert.equal(result.standings.filter((row) => row.focal).length, 2)
})

test('a misspelled payor is still found', async () => {
  resetRankSessions()
  const result = await answerRank({ ...scope, message: 'what is cenetne ranking in dallas county' })
  assert.equal(result.answer, 'Centene Corporation (HMO) is rank 4 of 16 in Dallas County, Texas.')
})

test('with no county, the current rank is a short summary plus a county table from the published ranks', async () => {
  resetRankSessions()
  const result = await answerRank({
    message: 'what is centene ranking',
    payors: ['Centene Corporation'],
    payorsCrossPlanTypes: [{ payor: 'Centene Corporation', planType: 'HMO' }],
  })
  assert.equal(result.kind, 'baseline')
  assert.match(result.answer, /^Centene Corporation \(HMO\) is ranked in \d+ Texas counties\. Rank 1 in \d+, top 3 in \d+/)
  assert.ok(result.answer.length < 400, 'no county-by-county text dump')
  assert.deepEqual(result.columns, ['County', 'Rank', 'Ranked networks'])
  // Same rank as the county answer: HMO and PPO compete in one list.
  assert.deepEqual(result.rows.find((row) => row[0] === 'Dallas'), ['Dallas', 4, 16])
})

test('"for HMO and PPO both plan types" answers each plan type in the county, typo included', async () => {
  resetRankSessions()
  const uhc = {
    payors: ['UnitedHealth Group, Inc.'],
    payorsCrossPlanTypes: [{ payor: 'UnitedHealth Group, Inc.', planType: 'PPO' }],
  }
  const result = await answerRank({ ...uhc, message: 'UnitedHealth Group, Inc. for HMP and PPO both plan types', county: 'Harris' })
  const lines = result.answer.split(' UnitedHealth')
  assert.equal(lines.length, 2, result.answer)
  assert.match(result.answer, /UnitedHealth Group, Inc\. \(HMO\) is rank \d+ of \d+ in Harris County, Texas\./)
  assert.match(result.answer, /UnitedHealth Group, Inc\. \(PPO\) is rank \d+ of \d+ in Harris County, Texas\./)
  assert.equal(result.standings.filter((row) => row.focal).length, 2)
})

test('both plan types with no county gives one statewide table per plan type', async () => {
  resetRankSessions()
  const result = await answerRank({
    message: 'what is centene ranking for both plan types',
    payors: ['Centene Corporation'],
    payorsCrossPlanTypes: [{ payor: 'Centene Corporation', planType: 'HMO' }],
  })
  assert.equal(result.kind, 'baseline')
  assert.deepEqual(result.tables.map((table) => table.title), ['Centene Corporation (HMO)', 'Centene Corporation (PPO)'])
  assert.match(result.answer, /Centene Corporation \(HMO\) is ranked in 204 Texas counties/)
  assert.match(result.answer, /Centene Corporation \(PPO\) is ranked in 41 Texas counties/)
})

test('"where do we rank" focuses on our payor from the request scope', async () => {
  resetRankSessions()
  const result = await answerRank({
    message: 'where do we rank in dallas county',
    payors: ['Health Care Service Corporation'],
    payorsCrossPlanTypes: [{ payor: 'Health Care Service Corporation', planType: 'HMO' }],
  })
  assert.match(result.answer, /^Health Care Service Corporation \(PPO\) is rank 3 of 16 in Dallas County, Texas\. Health Care Service Corporation \(HMO\) is rank 6 of 16/)
})

test('with no payor named, the list answer is unchanged and nothing is highlighted', async () => {
  resetRankSessions()
  const result = await answerRank({ ...scope, message: 'dallas county' })
  assert.match(result.answer, /^Ranked HMO payors in Dallas County, Texas/)
  assert.ok(result.standings.every((row) => !row.focal))
})
