'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { improveRank, METRICS } = require('../services/rankImprove')
const { planFromRules } = require('../services/conversationPlanner')

function ratingRow(county, payor, rank, score, values = {}) {
  const metrics = { ...Object.fromEntries(METRICS.map((metric) => [metric.column, 10])), ...values }
  return { county, fips: '', payor, planType: 'HMO', network: `${payor} net`, networkScore: score, rank, metrics }
}

const SPE = 'spe_npi_count_without_low_exclude_hosp'
const HOSP_Q = 'Hosp_Quality Score rating'
const PCP = 'pcp_npi_count_without_low_exclude_hosp'
const HWAI = 'Modified Hwai Rating'
const COST = 'PCP_Cost Score rating'
const rows = [
  ratingRow('Harris', 'Leader Inc.', 1, 85, { [SPE]: 3000, [PCP]: 1703, [HOSP_Q]: 10, [HWAI]: 3.93 }),
  ratingRow('Harris', 'Next Health', 2, 70, { [SPE]: 2932, [PCP]: 1411, [HOSP_Q]: 9, [HWAI]: 3, [COST]: 99 }),
  ratingRow('Harris', 'Molina Healthcare, Inc.', 3, 62, { [SPE]: 2767, [PCP]: 1369, [HOSP_Q]: 7, [HWAI]: 3.45 }),
  ratingRow('Dallas', 'Molina Healthcare, Inc.', 1, 80, { [SPE]: 70 }),
  ratingRow('Dallas', 'Next Health', 2, 75, { [SPE]: 65, [PCP]: 12 }),
]
const deps = { loadRatings: () => rows }
const dashboard = {
  payors: ['Molina Healthcare, Inc.'],
  payorsCrossPlanTypes: [{ payor: 'Molina Healthcare, Inc.', planType: 'HMO' }],
}

test('a county answer gives one side-by-side table per competitor, improvable measures only', () => {
  const result = improveRank({ county: 'Harris' }, dashboard, deps)
  assert.equal(result.kind, 'improvement')
  assert.equal(result.answer, 'Molina Healthcare, Inc. (HMO) is rank 3 of 3 in Harris County.')
  assert.equal(result.columns, undefined)
  assert.equal(result.markdown, undefined)
  const [pass, leader] = result.tables
  assert.equal(pass.title, 'What can be improved to pass Next Health (HMO) (rank 2)')
  assert.deepEqual(pass.columns, ['Measure', 'Molina Healthcare, Inc. (HMO)', 'Next Health (HMO)', 'Needed'])
  assert.deepEqual(pass.rows, [
    ['High quality Hospitals', '7', '9', 'add 2'],
    ['Physician groups in network', '2,767', '2,932', 'add 165'],
    ['Network breadth (PCPs)', '1,369', '1,411', 'add 42'],
  ])
  assert.equal(leader.title, 'To reach the leader, Leader Inc. (HMO) (rank 1)')
  assert.deepEqual(leader.rows.find((row) => row[0] === 'Star rating'), ['Star rating', '★★★½☆ 3.45', '★★★★☆ 3.93', 'raise by 0.48 stars'])
  // We are ahead of Next Health on HWAI, so it is not an improvement item there; cost is never a lever.
  assert.ok(!pass.rows.some((row) => row[0] === 'Star rating'))
  assert.doesNotMatch(JSON.stringify(result.tables), /network score|specialist|cost/i)
})

test('a payor at rank 1 is told how to keep the lead', () => {
  const result = improveRank({ county: 'Dallas' }, dashboard, deps)
  assert.match(result.tables[0].title, /To keep the lead over Next Health \(HMO\) \(rank 2\)/)
  assert.deepEqual(result.tables[0].rows, [['Network breadth (PCPs)', '10', '12', 'add 2']])
})

test('without a county, the answer names the most common improvements and closest counties', () => {
  const result = improveRank({}, dashboard, deps)
  assert.equal(result.kind, 'improvement')
  assert.equal(result.rows, undefined)
  assert.match(result.answer, /ranked in 2 Texas counties and is rank 1 in 1\./)
  assert.match(result.answer, /What to improve most often to pass the next network:\n• /)
  assert.match(result.answer, /• Harris: rank 3 of 3, next is Next Health \(HMO\)/)
  assert.doesNotMatch(result.answer, /network score|points/i)
})

test('an unclear payor asks instead of guessing', () => {
  const result = improveRank({}, { payorsCrossPlanTypes: [
    { payor: 'Molina Healthcare, Inc.', planType: 'HMO' }, { payor: 'Next Health', planType: 'HMO' },
  ] }, deps)
  assert.equal(result.kind, 'clarify')
  assert.equal(result.suggestionField, 'payor')
})

test('wording rules route improvement questions without the model', () => {
  assert.equal(planFromRules('How can we make our rankings better in Harris County?').route, 'improve')
  assert.equal(planFromRules('How can we make our rankings better in Harris County?').improve.county, 'Harris')
  assert.equal(planFromRules('what if we remove Baylor to improve our rank'), null)
})

test('the real ratings file explains Molina HMO in Anderson County', () => {
  const result = improveRank({ county: 'Anderson' }, dashboard)
  assert.equal(result.kind, 'improvement')
  // HMO and PPO compete in one county list: the network just ahead is UnitedHealth PPO.
  assert.match(result.answer, /rank 3 of 12 in Anderson County/)
  assert.match(result.tables[0].title, /pass UnitedHealth Group, Inc\. \(PPO\) \(rank 2\)/)
  assert.doesNotMatch(result.answer + JSON.stringify(result.tables), /network score/i)
})

test('quality rows compare the quality score and show the count rated High', () => {
  const withScores = [
    ratingRow('Travis', 'Ahead Health', 1, 80, { [HOSP_Q]: 10, 'Hosp_Quality Score %': 90.90909, [PCP]: 50 }),
    // More health systems rated High (12) but a lower share: the score, not the count, decides the gap.
    ratingRow('Travis', 'Molina Healthcare, Inc.', 2, 60, { [HOSP_Q]: 12, 'Hosp_Quality Score %': 63.63636, [PCP]: 50 }),
  ]
  const result = improveRank({ county: 'Travis' }, dashboard, { loadRatings: () => withScores })
  assert.deepEqual(result.tables[0].rows, [
    ['High quality Hospitals', '63.6% (12 rated High)', '90.9% (10 rated High)', 'raise by 27.3 pts'],
  ])
})
