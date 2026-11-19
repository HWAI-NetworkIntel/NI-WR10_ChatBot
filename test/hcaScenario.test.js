'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { answerFromStage2 } = require('../services/stage2Chat')
const { scenarioResult } = require('../services/scenarioRanks')

test('removing HCA Healthcare for UnitedHealthcare returns the latest Harris rankings', async () => {
  let ran = false
  const result = await answerFromStage2({
    payors: [],
    message: 'What if HCA Healthcare terminated for United Healthcare Inc?',
  }, {
    chat: null,
    lookupsReady: () => false,
    runStage2: async () => {
      ran = true
      return { ok: false, error: 'Python should not run' }
    },
  })

  assert.equal(ran, false)
  assert.equal(result.kind, 'prediction')
  assert.equal(result.scenario.payor, 'UnitedHealth Group, Inc.')
  assert.equal(result.scenario.healthSystem, 'HCA Healthcare')
  assert.equal(result.scenario.healthSystemIncrease, false)
  assert.equal(result.scenario.county, 'Harris')

  const hmo = result.rows.find((row) => row.payor === 'UnitedHealth Group, Inc.' && row.planType === 'HMO')
  const ppo = result.rows.find((row) => row.payor === 'UnitedHealth Group, Inc.' && row.planType === 'PPO')
  assert.equal(hmo.rankBefore, 9)
  assert.equal(hmo.rank, 10)
  assert.equal(ppo.rankBefore, 2)
  assert.equal(ppo.rank, 5)
  assert.match(result.answer, /moves from rank 9 to rank 10/)
  assert.match(result.answer, /moves from rank 2 to rank 5/)
  assert.match(result.answer, /\| Payor \| Plan type \| Rank before \| New rank \|\n/)
  // The network score is never shown in the chat answer or its rows.
  assert.doesNotMatch(result.answer, /network score/i)
  assert.ok(result.rows.every((row) => !('value' in row)))
  assert.ok(result.rows.some((row) => row.payor === 'CVS Health Corporation' && row.rank === 1))
})

test('remove HCA on a United dashboard payor uses the same Harris rankings', async () => {
  const result = await answerFromStage2({
    payors: ['UnitedHealth Group, Inc.'],
    payorsCrossPlanTypes: [{ payor: 'UnitedHealth Group, Inc.', planType: 'HMO' }],
    planType: 'HMO',
    message: 'What are the latest HMO rankings if we remove HCA Healthcare?',
  }, { chat: null, lookupsReady: () => false })

  assert.equal(result.kind, 'prediction')
  assert.equal(result.scenario.plantype, 'HMO')
  assert.ok(result.rows.every((row) => row.planType === 'HMO'))
  assert.equal(result.rows.find((row) => row.payor === 'UnitedHealth Group, Inc.').rank, 10)
})

test('removing HCA for a different payor does not use the United scenario file', async () => {
  const result = await answerFromStage2({
    payors: ['Devoted Health, Inc.'],
    message: 'What happens to our rank if HCA Healthcare terminates?',
  }, {
    chat: null,
    lookupsReady: () => false,
    runStage2: async () => { throw new Error('Python should not run') },
  })
  assert.equal(result.answer, undefined)
  assert.equal(result.change.action, 'remove')
  assert.match(result.change.name, /HCA/i)
})

test('a named county other than Harris is read from the same scenario file', async () => {
  const result = await answerFromStage2({
    payors: ['UnitedHealth Group, Inc.'],
    message: 'What if HCA Healthcare terminated for UnitedHealthcare in Dallas County?',
  }, { chat: null, lookupsReady: () => false })
  assert.equal(result.scenario.county, 'Dallas')
  assert.ok(result.rows.length > 0)
  assert.ok(result.rows.every((row) => row.county === 'Dallas'))
  assert.match(result.answer, /Dallas County/)
})

test('the predict API returns the scored HCA removal without the rank script', () => {
  const result = scenarioResult({
    payor: 'United Healthcare Inc',
    plantype: 'PPO',
    healthSystem: 'HCA Healthcare',
    healthSystemIncrease: false,
    physicianGroup: '',
    county: 'Harris',
  })
  assert.equal(result.ok, true)
  assert.ok(result.rows.length > 1)
  assert.ok(result.rows.every((row) => row.planType === 'PPO' && row.county === 'Harris'))
  const united = result.rows.find((row) => row.payor === 'UnitedHealth Group, Inc.')
  assert.equal(united.rank, 5)
  assert.equal(united.rankBefore, 2)
})

function liveResult(scenario) {
  const row = (county, payor, planType, rankBefore, rank) => ({ county, payor, planType, rankBefore, rank })
  const all = [
    row('Brazoria', 'CVS Health Corporation', 'HMO', 1, 1),
    row('Brazoria', 'UnitedHealth Group, Inc.', 'HMO', 4, 12),
    row('Brazoria', 'UnitedHealth Group, Inc.', 'PPO', 5, 11),
    row('Harris', 'CVS Health Corporation', 'PPO', 1, 1),
    row('Harris', 'UnitedHealth Group, Inc.', 'PPO', 2, 5),
    row('Harris', 'UnitedHealth Group, Inc.', 'HMO', 9, 10),
  ]
  return {
    ok: true,
    rankColumn: 'rank_payor_plantype',
    affectedCounties: ['Brazoria', 'Harris'],
    countyRanks: scenario.county ? all.filter((item) => item.county === scenario.county) : all,
    rows: [],
  }
}

test('with lookups, removing HCA for United is recomputed live, not read from the file', async () => {
  const runs = []
  const result = await answerFromStage2({
    payors: [],
    message: 'What if HCA Healthcare terminated for United Healthcare Inc?',
  }, {
    chat: null,
    lookupsReady: () => true,
    runStage2: async (scenario) => {
      runs.push(scenario)
      return liveResult(scenario)
    },
  })
  assert.equal(runs.length, 1)
  assert.equal(runs[0].payor, 'UnitedHealth Group, Inc.')
  assert.equal(runs[0].healthSystem, 'HCA Healthcare')
  assert.equal(runs[0].healthSystemIncrease, false)
  assert.equal(runs[0].plantype, '')
  assert.equal(result.kind, 'prediction')
  // No county named: the county where United moves the most.
  assert.equal(result.scenario.county, 'Brazoria')
  assert.match(result.answer, /HMO moves from rank 4 to rank 12/)
  assert.match(result.answer, /Rankings also change in Harris County/)
  assert.doesNotMatch(result.answer, /Inc\.\./)
  assert.ok(result.rows.every((row) => row.county === 'Brazoria'))
})

test('with lookups, a named county and plan type scope the live run and the table', async () => {
  const runs = []
  const result = await answerFromStage2({
    payors: ['UnitedHealth Group, Inc.'],
    message: 'What are the latest PPO rankings if we remove HCA Healthcare in Harris County?',
  }, {
    chat: null,
    lookupsReady: () => true,
    runStage2: async (scenario) => {
      runs.push(scenario)
      return liveResult(scenario)
    },
  })
  assert.equal(runs[0].county, 'Harris')
  assert.equal(runs[0].plantype, 'PPO')
  assert.equal(result.scenario.county, 'Harris')
  assert.ok(result.rows.every((row) => row.planType === 'PPO'))
  assert.equal(result.rows.find((row) => row.payor === 'UnitedHealth Group, Inc.').rank, 5)
})

const { explainWhatIf } = require('../services/stage2Chat')

function withMeasures(scenario) {
  return {
    ...liveResult(scenario),
    countyMeasures: [{
      county: 'Brazoria',
      payor: 'UnitedHealth Group, Inc.',
      planType: 'HMO',
      before: { highQualityHospitals: 1, hospitalQualityPct: 100, pcps: 323 },
      after: { highQualityHospitals: 0, hospitalQualityPct: 0, pcps: 323 },
    }],
  }
}

const whatIfTurns = [
  { role: 'user', content: 'What if HCA Healthcare terminated for United Healthcare Inc?' },
  { role: 'assistant', content: 'Removing HCA Healthcare from UnitedHealth Group, Inc. Latest rankings in Brazoria County.' },
]

test('"why did United drop" after the HCA what-if explains that what-if, not the published rank', async () => {
  const runs = []
  const question = "why did United's ranking dropped in Brazoria county?"
  const result = await explainWhatIf({
    message: question,
    messages: [...whatIfTurns, { role: 'user', content: question }],
  }, {
    chat: null,
    lookupsReady: () => true,
    runStage2: async (scenario) => {
      runs.push(scenario)
      return withMeasures(scenario)
    },
  })
  assert.equal(runs.length, 1)
  assert.equal(runs[0].healthSystem, 'HCA Healthcare')
  assert.equal(runs[0].payor, 'UnitedHealth Group, Inc.')
  assert.equal(result.kind, 'prediction')
  assert.match(result.answer, /HMO falls from rank 4 to rank 12 in Brazoria County/)
  assert.equal(result.tables.length, 1)
  const rows = result.tables[0].rows
  assert.deepEqual(rows[0], ['High quality Hospitals', '1', '0', '−1'])
  // Unchanged measures are left out.
  assert.ok(rows.every((row) => row[0] !== 'Network breadth (PCPs)'))
})

test('a payor that rose is explained by the removed payor falling', async () => {
  const question = 'why did CVS go up in Brazoria County?'
  const result = await explainWhatIf({
    message: question,
    messages: [...whatIfTurns, { role: 'user', content: question }],
  }, { chat: null, lookupsReady: () => true, runStage2: async (scenario) => withMeasures(scenario) })
  assert.match(result.answer, /CVS Health Corporation's own network does not change/)
})

test('a why question with no earlier removal is left to the normal routes', async () => {
  const result = await explainWhatIf({
    message: 'why did we drop?',
    messages: [{ role: 'user', content: 'Where do we rank in Harris County?' }, { role: 'user', content: 'why did we drop?' }],
  }, { chat: null, lookupsReady: () => true, runStage2: async () => { throw new Error('Python should not run') } })
  assert.equal(result, null)
})
