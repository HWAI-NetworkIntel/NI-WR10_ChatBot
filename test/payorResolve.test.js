'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { checkNamedPayor, checkPayorPhrase, namedPayorPhrase, scopeToPayor } = require('../services/payorResolve')

test('an unknown payor gets options ranked in that county, not a guess', () => {
  const result = checkNamedPayor('where does MJHS rank in Houston county?')
  assert.equal(result.unknown, 'MJHS')
  assert.equal(result.reply.kind, 'clarify')
  assert.equal(result.reply.suggestionField, 'payor')
  assert.match(result.reply.answer, /couldn't find a payor called "MJHS".*ranked in Houston County, or type the payor name/)
  // Houston County payors, best rank first.
  assert.deepEqual(result.reply.suggestions, ['CVS Health Corporation', 'UnitedHealth Group, Inc.', 'Health Care Service Corporation', 'Molina Healthcare, Inc.', 'Humana Inc.'])
})

test('names, abbreviations, and spelling mistakes resolve to the ranked payor', () => {
  const cases = {
    'where does Humana rank in Dallas county': 'Humana Inc.',
    'where does UHC rank in Houston county?': 'UnitedHealth Group, Inc.',
    'how does BCBS rank in Harris county': 'Health Care Service Corporation',
    'what is the aetna ranking': 'CVS Health Corporation',
    'what is cenetne ranking': 'Centene Corporation',
    'where does molina hmo rank': 'Molina Healthcare, Inc.',
  }
  for (const [question, payor] of Object.entries(cases)) assert.equal(checkNamedPayor(question)?.payor, payor, question)
})

test('other wordings of an unknown payor are caught too', () => {
  for (const question of ['what is the ranking for MJHS in dallas county', 'MJHS ranking in dallas county', 'show MJHS rank in dallas', 'how is MJHS doing in dallas county']) {
    assert.equal(checkNamedPayor(question)?.unknown, 'MJHS', question)
  }
  assert.match(checkNamedPayor('what is the ranking for MJHS in dallas county').reply.answer, /ranked in Dallas County/)
})

test('a payor in the provider data without a ranking says so', () => {
  const result = checkNamedPayor('where does verda rank')
  assert.equal(result.reply.kind, 'clarify')
  assert.match(result.reply.answer, /^Verda Healthcare, Inc\. is in the provider data but has no published network ranking/)
})

test('the planner\'s reading of the payor is checked the same way', () => {
  assert.equal(checkPayorPhrase('MJHS', 'what about MJHS in dallas county').reply.kind, 'clarify')
  assert.equal(checkPayorPhrase('UHC', 'and UHC?').payor, 'UnitedHealth Group, Inc.')
  assert.equal(checkPayorPhrase('', 'anything'), null)
})

test('questions about our own rank name no payor', () => {
  for (const question of ['where do we rank in Houston county?', 'what is our ranking', 'how is the network ranked', 'what is the Dallas county ranking', 'Show our rank in every county as a table', 'how can i improve the ranking', 'top 5 ranking in dallas county', 'current ranking', 'what are the latest rankings if we remove HCA healthcare', 'what are the new rankings']) {
    assert.equal(checkNamedPayor(question), null, question)
    assert.equal(namedPayorPhrase(question, new Set(['dallas'])), '', question)
  }
})

test('a named payor replaces a remembered payor in the request scope', () => {
  const body = { payors: ['Health Care Service Corporation'], payorsCrossPlanTypes: [{ payor: 'Health Care Service Corporation', planType: 'HMO' }] }
  const scoped = scopeToPayor(body, 'UnitedHealth Group, Inc.')
  assert.deepEqual(scoped.payors, ['UnitedHealth Group, Inc.'])
  assert.deepEqual(scoped.payorsCrossPlanTypes, [{ payor: 'UnitedHealth Group, Inc.', planType: 'HMO' }])
})

test('the /rank route asks about MJHS instead of answering for the remembered payor', async () => {
  const app = require('../app')
  const server = app.listen(0)
  try {
    const port = server.address().port
    const body = {
      message: 'where does MJHS rank in Houston county?',
      payors: ['Health Care Service Corporation'],
      payorsCrossPlanTypes: [{ payor: 'Health Care Service Corporation', planType: 'HMO' }],
    }
    const response = await fetch(`http://localhost:${port}/rank`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const reply = await response.json()
    assert.equal(reply.kind, 'clarify')
    assert.doesNotMatch(reply.answer, /Health Care Service Corporation HMO is rank/)
    // After the user picks a payor from the options, the pick is answered.
    const picked = await fetch(`http://localhost:${port}/rank`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, payors: ['Molina Healthcare, Inc.'], payorsCrossPlanTypes: [{ payor: 'Molina Healthcare, Inc.', planType: 'HMO' }], payorConfirmed: true }) })
    assert.notEqual((await picked.json()).kind, 'clarify')
  } finally {
    server.close()
  }
})
