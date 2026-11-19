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
