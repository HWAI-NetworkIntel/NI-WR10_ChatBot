'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { scenarioFromBody, scenarioFromPrompt, scenarioIssue, toArgv } = require('../services/stage2Params')

test('accepts a payor with both a removal and an addition', () => {
  const scenario = scenarioFromBody({
    payor: 'humana',
    plantype: 'hmo',
    planId: 'H123_56_9',
    healthSystem: 'baloyor',
    'physician group': 'qwerty',
    healthSystemIncrease: 'true',
    physicainGroupIncrease: 'false',
  })
  assert.equal(scenarioIssue(scenario), '')
  assert.deepEqual(toArgv(scenario), ['humana', 'HMO', 'H123_56_9', 'baloyor', 'qwerty', 'true', 'false', ''])
})

test('rejects a plan type that is not paired with a payor', () => {
  const onlyType = scenarioFromBody({ plantype: 'HMO', healthSystem: 'Baylor', healthSystemIncrease: false })
  assert.match(scenarioIssue(onlyType), /plan type cannot be passed on its own/)
  const planId = scenarioFromBody({ planId: 'H1234_001', healthSystem: 'Baylor', healthSystemIncrease: 'false' })
  assert.equal(scenarioIssue(planId), '')
  const payor = scenarioFromBody({ payor: 'Humana', healthSystem: 'Baylor', healthSystemIncrease: false })
  assert.equal(scenarioIssue(payor), '')
})

test('reads a termination from the question and keeps the payor', () => {
  const parsed = scenarioFromPrompt(
    'What happens to our rank in Houston County, TX if Baylor Scott & White Health terminates its contract with Humana?',
    { payors: ['Humana Inc.', 'UnitedHealth Group'] },
  )
  assert.equal(parsed.relevant, true)
  assert.equal(parsed.clarify, undefined)
  assert.equal(parsed.scenario.payor, 'Humana Inc.')
  assert.equal(parsed.scenario.plantype, '')
  assert.equal(parsed.scenario.planId, '')
  assert.equal(parsed.scenario.healthSystem, 'Baylor Scott & White Health')
  assert.equal(parsed.scenario.healthSystemIncrease, false)
  assert.equal(parsed.scenario.physicianGroup, '')
  assert.equal(parsed.scenario.county, 'Houston')
})

test('asks for a payor when only a plan type is named', () => {
  const parsed = scenarioFromPrompt('What if we drop Baylor from HMO?')
  assert.equal(parsed.relevant, true)
  assert.match(parsed.clarify, /plan type cannot be passed on its own/)
})

test('leaves an ordinary rank question on the existing rank path', () => {
  const parsed = scenarioFromPrompt('Where do we rank in Houston County today?', { payors: ['Humana'] })
  assert.equal(parsed.relevant, false)
})
