'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { understandQuestion } = require('../services/questionIntent')
const { answerFromStage2 } = require('../services/stage2Chat')

const scope = {
  payors: ['Devoted Health, Inc.'],
  payorsCrossPlanTypes: [{ payor: 'Devoted Health, Inc.', planType: 'HMO' }],
  planType: 'HMO',
}

test('the model chooses a removal and does not invent a county', async () => {
  const understood = await understandQuestion({
    ...scope,
    message: 'What if Baylor Scott & White terminates with Devoted?',
  }, {
    chat: async () => JSON.stringify({
      action: 'remove',
      payor: 'Devoted Health, Inc.',
      planType: 'HMO',
      healthSystem: 'Baylor Scott & White',
      county: 'Harris',
    }),
  })
  assert.equal(understood.action, 'remove')
  assert.equal(understood.scenario.healthSystem, 'Baylor Scott & White')
  assert.equal(understood.scenario.healthSystemIncrease, false)
  assert.equal(understood.scenario.county, '')
  assert.equal(understood.scenario.payor, 'Devoted Health, Inc.')
})

test('the model chooses a rank read for every county', async () => {
  const understood = await understandQuestion({
    ...scope,
    message: 'Where do we rank?',
  }, {
    chat: async () => JSON.stringify({ action: 'get_rank', county: '' }),
  })
  assert.equal(understood.action, 'get_rank')
  assert.equal(understood.scenario.county, '')
  assert.equal(understood.scenario.payor, 'Devoted Health, Inc.')
  assert.equal(understood.scenario.plantype, 'HMO')
  assert.equal(understood.scenario.healthSystem, '')
})

test('a missing model still routes a termination and a rank question', async () => {
  const removed = await understandQuestion({
    ...scope,
    message: 'What happens to our rank in Houston County if Baylor Scott & White Health terminates its contract with Devoted?',
  }, { chat: async () => { throw new Error('offline') } })
  assert.equal(removed.action, 'remove')
  assert.equal(removed.scenario.healthSystemIncrease, false)
  assert.equal(removed.scenario.county, 'Houston')

  const rank = await understandQuestion({
    ...scope,
    message: 'Where do we rank?',
  }, { chat: null })
  assert.equal(rank.action, 'get_rank')
  assert.equal(rank.scenario.county, '')
})

test('a rank read calls Python and an addition does not', async () => {
  const calls = []
  const runStage2 = async (scenario) => {
    calls.push(scenario)
    return { ok: true, rankColumn: 'rank_payor_plantype', rows: [{ county: 'Harris', rank: 2, rankBefore: 2 }, { county: 'Houston', rank: 4, rankBefore: 4 }] }
  }
  const rank = await answerFromStage2({ ...scope, message: 'Where do we rank?' }, {
    chat: async () => JSON.stringify({ action: 'get_rank' }),
    lookupsReady: () => true,
    runStage2,
  })
  assert.equal(rank.kind, 'rank')
  assert.equal(calls[0].healthSystem, '')
  assert.match(rank.answer, /Harris/)
  assert.match(rank.answer, /Houston/)
  assert.equal(rank.suggestions, undefined)

  const added = await answerFromStage2({ ...scope, message: 'Add Baylor Scott & White' }, {
    chat: async () => JSON.stringify({ action: 'add', healthSystem: 'Baylor Scott & White' }),
    lookupsReady: () => true,
    runStage2,
  })
  assert.equal(added.answer, undefined)
  assert.equal(added.change.action, 'add')
  assert.equal(added.change.name, 'Baylor Scott & White')
  assert.equal(calls.length, 1)
})

test('a removal calls Python with the increase flag false', async () => {
  let seen
  const result = await answerFromStage2({
    ...scope,
    message: 'Remove Baylor Scott & White',
  }, {
    chat: async () => JSON.stringify({ action: 'remove', healthSystem: 'Baylor Scott & White' }),
    lookupsReady: () => true,
    runStage2: async (scenario) => {
      seen = scenario
      return { ok: true, rows: [{ county: 'Harris', rank: 3, rankBefore: 2 }] }
    },
  })
  assert.equal(seen.healthSystemIncrease, false)
  assert.equal(result.kind, 'prediction')
  assert.match(result.answer, /Removing Baylor Scott & White/)
})

test('how close stays on the roster model', async () => {
  const result = await answerFromStage2({ ...scope, message: 'How close are we to rank 2?' }, {
    chat: async () => JSON.stringify({ action: 'sensitivity' }),
    lookupsReady: () => true,
    runStage2: async () => { throw new Error('Python should not run') },
  })
  assert.equal(result, null)
})
