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

test('with no payor named, the list answer is unchanged and nothing is highlighted', async () => {
  resetRankSessions()
  const result = await answerRank({ ...scope, message: 'dallas county' })
  assert.match(result.answer, /^Ranked HMO payors in Dallas County, Texas/)
  assert.ok(result.standings.every((row) => !row.focal))
})
