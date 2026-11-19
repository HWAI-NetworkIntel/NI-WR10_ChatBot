'use strict'

/**
 * Scripted conversations for the three judging criteria:
 *   01 value beyond existing capabilities  -> insight-first answers, opportunity finder, next steps
 *   02 ambiguous prompts                    -> typos, aliases, ambiguous payors, stated assumptions, vague words
 *   03 conversational context               -> state, "the third one", corrections, follow-ups, reset
 *
 * The model is switched off so every turn runs on the wording rules and the result is the same on every run.
 */

const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')

const llm = require('../services/llm')
const { findCounty, canonicalCounty } = require('../services/countyResolve')
const { checkNamedPayor } = require('../services/payorResolve')
const { readState, nextState, isReset, sinceReset, resolveOrdinal, applyCorrection, isFollowUp } = require('../services/conversationState')
const { planFromRules, cleanHistory } = require('../services/conversationPlanner')
const { buildRankTable } = require('../services/rankTable')
const { findOpportunities } = require('../services/rankImprove')
const { nextSteps } = require('../services/nextSteps')

const HUMANA = { payors: ['Humana Inc.'], payorsCrossPlanTypes: [{ payor: 'Humana Inc.', planType: 'HMO' }, { payor: 'Humana Inc.', planType: 'PPO' }] }

const realChat = llm.chat
before(() => {
  llm.chat = async () => {
    throw new Error('model offline in tests')
  }
})
after(() => {
  llm.chat = realChat
})

/* ---------- 02 · ambiguous prompts ---------- */

test('counties: spelling mistakes, abbreviations, and city names', () => {
  const cases = {
    'where do we rank in hariss county': 'Harris',
    'show rank in ft bend': 'Fort Bend',
    'how are we doing in San Antonio': 'Bexar',
    'fort worth': 'Tarrant',
    'and for Tarant?': 'Tarrant',
    'what about Nueses county': 'Nueces',
    'where do we stand in houston': 'Houston',
  }
  for (const [text, county] of Object.entries(cases)) assert.equal(findCounty(text), county, text)
  assert.equal(canonicalCounty('bexer'), 'Bexar')
})

test('counties: ordinary words after "in" and "for" are not mistaken for a county', () => {
  for (const word of ['market', 'every', 'total', 'general', 'detail', 'tabular', 'quality', 'texas', 'network', 'order', 'summary']) {
    assert.equal(findCounty(`show our rank in ${word}`), '', word)
    assert.equal(findCounty(`show our rank for ${word}`), '', word)
  }
})

test('a name that fits several payors asks which one, instead of saying it was not found', () => {
  const result = checkNamedPayor('where does the hospital district rank in harris county')
  assert.equal(result.reply.kind, 'clarify')
  assert.match(result.reply.answer, /matches more than one payor/)
  assert.deepEqual([...result.ambiguous].sort(), ['Bexar County Hospital District', 'El Paso County Hospital District', 'Harris County Hospital District'])
  assert.deepEqual([...result.reply.suggestions].sort(), [...result.ambiguous].sort())
})

test('an unknown payor still gets county options, and the county is found despite a typo', () => {
  const result = checkNamedPayor('where does MJHS rank in hariss county')
  assert.match(result.reply.answer, /couldn't find a payor called "MJHS".*ranked in Harris County/)
})

test('vague wording becomes a concrete table: "bottom" sorts worst first, no number means 5', () => {
  const plan = planFromRules('show our worst ranked counties')
  assert.equal(plan.route, 'table')
  assert.deepEqual(plan.table.sort, [{ field: 'rank', dir: 'desc' }])
  assert.equal(plan.table.limit, 5)
  const top = planFromRules('top 3 payors ranked in hariss county')
  assert.equal(top.table.limit, 3)
  assert.deepEqual(top.table.filters.county, ['Harris'])
})

test('answers say what they assumed when the question left something out', () => {
  const table = buildRankTable({ scope: 'dashboard' }, HUMANA)
  assert.match(table.answer, /Assumed: your dashboard payor \(Humana Inc\.\) · dashboard plan types \(HMO, PPO\) · every Texas county · latest published rankings/)
  const narrowed = buildRankTable({ scope: 'all', filters: { county: ['Harris'], planType: ['HMO'] } }, HUMANA)
  assert.doesNotMatch(narrowed.answer, /every Texas county|HMO and PPO/)
})

/* ---------- 01 · value beyond existing capabilities ---------- */

test('a one-county table leads with who leads and where we sit', () => {
  const table = buildRankTable({ scope: 'all', filters: { county: ['hariss'] } }, HUMANA)
  assert.match(table.answer, /^.+ leads Harris County\. Humana Inc\. \((HMO|PPO)\) is rank \d+ of \d+\.\n/)
  // Plain text: the chat UI does not render markdown emphasis.
  assert.doesNotMatch(table.answer, /\*\*|_Assumed/)
})

test('the opportunity finder names the best county to move up in and the lever to pull', () => {
  const result = findOpportunities({}, { payorsCrossPlanTypes: [{ payor: 'Humana Inc.', planType: 'HMO' }] })
  assert.equal(result.subtype, 'opportunity')
  assert.match(result.answer, /^Best chance to move up: .+ County\. Humana Inc\. \(HMO\) is rank \d+ of \d+, just behind .+\. Biggest lever: .+\.\n/)
  assert.doesNotMatch(result.answer, /\*\*/)
  assert.deepEqual(result.tables[0].columns, ['County', 'Rank', 'Next network ahead', 'Biggest lever'])
  assert.equal(result.tables[0].rows.length, 5)
  // Actionable counties first: the headline never says there is nothing to improve.
  assert.doesNotMatch(result.answer.split('\n')[0], /Not on improvable measures/)
  // Scores order the list but are not shown.
  assert.doesNotMatch(result.answer + JSON.stringify(result.tables), /network score|points/i)
})

test('opportunity wording routes to the finder without the model', () => {
  for (const question of ['where are we closest to moving up a rank?', 'what are our quick wins', 'where should we focus first', 'biggest opportunities for us']) {
    assert.equal(planFromRules(question)?.route, 'opportunity', question)
  }
})

test('answers carry follow-up questions; clarify and refused replies do not', () => {
  assert.deepEqual(nextSteps('table', { kind: 'data' }, { county: 'Harris' }), [
    'How do we improve our rank in Harris County?',
    'Show all payors ranked in Harris County',
    'Where are we closest to moving up a rank?',
  ])
  assert.deepEqual(nextSteps('opportunity', { kind: 'improvement', closest: ['Galveston', 'Jefferson'] }, {}).slice(0, 2), [
    'What should we improve in Galveston County?',
    'What should we improve in Jefferson County?',
  ])
  assert.deepEqual(nextSteps('rank', { kind: 'clarify' }, {}), [])
  assert.deepEqual(nextSteps('rank', { kind: 'refused' }, {}), [])
})

/* ---------- 03 · conversational context ---------- */

test('state records the table shown, so "the third one" points at a row', () => {
  const table = buildRankTable({ scope: 'all', filters: { county: ['Harris'] } }, HUMANA)
  const state = nextState({}, { plan: { route: 'table', standalone: 'Show all payors in Harris County', table: table.spec }, result: table })
  assert.equal(state.county, 'Harris')
  assert.equal(state.listField, 'payor')
  assert.ok(state.list.length >= 3)
  const pointed = resolveOrdinal('tell me more about the third one', state)
  assert.equal(pointed.item, state.list[2])
  assert.equal(pointed.question, `tell me more about ${state.list[2]}`)
  assert.equal(resolveOrdinal('tell me more about the last one', state).item, state.list.at(-1))
  assert.equal(resolveOrdinal('the third county', state), null, 'a county ordinal does not point into a payor list')
})

test('state from the client is cleaned: wrong types and unknown fields are dropped', () => {
  const state = readState({ payor: 42, county: ['x'], list: ['a', 7, '', 'b'], listField: 'sql', extra: 'drop me' })
  assert.deepEqual(state, { payor: '42', county: 'x', planType: '', route: '', standalone: '', list: ['a', '7', 'b'], listField: '' })
})

test('corrections swap one value in the last question', () => {
  const state = readState({ standalone: 'Where does Aetna rank in Harris County?', payor: 'CVS Health Corporation', county: 'Harris', planType: 'HMO' })
  const payor = applyCorrection('No, I meant UHC', state)
  assert.equal(payor.patch.payor, 'UnitedHealth Group, Inc.')
  assert.equal(payor.question, 'Where does UnitedHealth Group, Inc. rank in Harris County?')
  const county = applyCorrection('actually Dallas', state)
  assert.equal(county.question, 'Where does Aetna rank in Dallas County?')
  const plan = applyCorrection('make it PPO', state)
  assert.equal(plan.patch.planType, 'PPO')
  // "Harris" alone is the county, not Harris County Hospital District.
  assert.deepEqual(applyCorrection('I meant Harris', { ...state, county: 'Dallas', standalone: 'Where does Aetna rank in Dallas County?' }).patch, { county: 'Harris' })
  // A full new question is not a correction.
  assert.equal(applyCorrection('actually, where do we rank in Dallas county and why are we behind?', state), null)
  assert.equal(applyCorrection('No, I meant UHC', readState({})), null, 'nothing to correct without an earlier question')
})

test('short follow-ups rerun the last question with one detail changed, even without the model', () => {
  const state = readState({ route: 'table', standalone: 'Show all payors ranked in Harris County', county: 'Harris' })
  assert.ok(isFollowUp('and for Dallas?'))
  assert.ok(!isFollowUp('where do we rank in Dallas county?'))
  const plan = planFromRules('and for Dallas?', state)
  assert.equal(plan.route, 'table')
  assert.deepEqual(plan.table.filters.county, ['Dallas'])
  assert.equal(plan.table.scope, 'all', 'keeps "all payors" from the earlier question')
  const improve = planFromRules('what about PPO', readState({ route: 'improve', standalone: 'How do we improve our rank in Harris County?', county: 'Harris' }))
  assert.equal(improve.route, 'improve')
  assert.equal(improve.improve.county, 'Harris')
  assert.equal(improve.improve.planType, 'PPO')
})

test('"there" refers to the county in the conversation state', () => {
  const plan = planFromRules('how do we improve our rank there', readState({ county: 'Bexar' }))
  assert.equal(plan.route, 'improve')
  assert.equal(plan.improve.county, 'Bexar')
})

test('reset clears the conversation: earlier turns are dropped from the history', () => {
  assert.ok(isReset('start over'))
  assert.ok(isReset('New question.'))
  assert.ok(!isReset('start over in Dallas county with a new table'))
  const history = [
    { role: 'user', content: 'Where does Aetna rank in Harris County?' },
    { role: 'assistant', content: 'Rank 2 of 19.' },
    { role: 'user', content: 'start over' },
    { role: 'assistant', content: 'Starting fresh.' },
    { role: 'user', content: 'where do we rank?' },
  ]
  assert.deepEqual(sinceReset(history).map((turn) => turn.content), ['Starting fresh.', 'where do we rank?'])
  assert.equal(cleanHistory(history).length, 2)
})

/* ---------- a full conversation through the /rank route ---------- */

test('a multi-turn conversation through /rank keeps the thread', async () => {
  const app = require('../app')
  const server = app.listen(0)
  const port = server.address().port
  let state = {}
  const say = async (message) => {
    const response = await fetch(`http://localhost:${port}/rank`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...HUMANA, message, state }),
    })
    const reply = await response.json()
    if (reply.state) state = reply.state
    return reply
  }
  try {
    // 02: a typo in the county; 01: insight first, then follow-up questions.
    const first = await say('Show all payors ranked in hariss county')
    assert.match(first.answer, /^.+ leads Harris County\./)
    assert.equal(state.county, 'Harris')
    assert.equal(first.suggestionField, 'question')
    assert.ok(first.suggestions.includes('How do we improve our rank in Harris County?'))

    // 03: "there" is Harris.
    const second = await say('how do we improve our rank there')
    assert.equal(second.kind, 'clarify', 'Humana has HMO and PPO on the dashboard, so it asks which')
    assert.deepEqual([...second.suggestions].sort(), ['HMO', 'PPO'])

    // 03: a correction keeps the question and changes one value.
    const third = await say('make it PPO')
    assert.equal(third.kind, 'improvement')
    assert.match(third.answer, /^Switched to PPO\.\n/)
    assert.match(third.answer, /Humana Inc\. \(PPO\) is rank \d+ of \d+ in Harris County/)
    assert.equal(state.planType, 'PPO')

    const fourth = await say('No, I meant Dallas')
    assert.match(fourth.answer, /^Switched to Dallas County\.\n/)
    assert.match(fourth.answer, /in Dallas County/)
    assert.equal(state.county, 'Dallas')

    // 01: something a dashboard cannot answer.
    const fifth = await say('where are we closest to moving up?')
    assert.equal(fifth.subtype, 'opportunity')

    // 03: reset.
    const reset = await say('start over')
    assert.equal(reset.kind, 'reset')
    assert.equal(reset.resetHistory, true)
    assert.deepEqual(state, readState({}))

    // 02: an ambiguous payor asks which one.
    const ambiguous = await say('where does the hospital district rank?')
    assert.equal(ambiguous.kind, 'clarify')
    assert.match(ambiguous.answer, /matches more than one payor/)

    // Write requests are still refused, and the state survives the refusal.
    state = { county: 'Harris' }
    const refused = await say('delete the rankings table')
    assert.equal(refused.kind, 'refused')
    assert.equal(refused.state.county, 'Harris')
  } finally {
    server.close()
  }
})

test('a client that sends no state still keeps the thread: "how can i improve" after a Humana question', async () => {
  // The UI in the screenshot: several dashboard payors, only `messages`, no `state`, and a typo.
  const app = require('../app')
  const server = app.listen(0)
  const port = server.address().port
  const body = {
    payors: ['Humana Inc.', 'Centene Corporation'],
    payorsCrossPlanTypes: [{ payor: 'Humana Inc.', planType: 'HMO' }, { payor: 'Centene Corporation', planType: 'HMO' }],
    messages: [
      { role: 'user', content: 'Where does Humana rank in Dallas County?' },
      { role: 'assistant', content: 'Humana Inc. HMO is rank 8 of 16 in Dallas County.' },
      { role: 'user', content: 'how can i improve the rankigs' },
    ],
  }
  try {
    for (const [path, extra] of [['/rank', {}], ['/llm/chat', { system: '' }]]) {
      const response = await fetch(`http://localhost:${port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, ...extra }) })
      const reply = await response.json()
      assert.equal(reply.kind, 'improvement', path)
      assert.match(reply.answer, /Humana Inc\. \(HMO\) is rank \d+ of \d+ in Dallas County/, path)
      assert.match(reply.answer, /Dallas County, from earlier in the conversation/, path)
      assert.ok(reply.tables.length >= 1, path)
    }
  } finally {
    server.close()
  }
})

test('the selected payor is never listed in its own competitor set', async () => {
  const { answerRank } = require('../services/rankService')
  const result = await answerRank({
    message: 'where do we rank in Dallas county?',
    payors: ['Centene Corporation'],
    payorsCrossPlanTypes: [{ payor: 'Centene Corporation', planType: 'HMO' }],
  })
  assert.equal(result.kind, 'baseline')
  assert.match(result.answer, /^Centene Corporation HMO is rank \d+ of \d+ in Dallas County/)
  const competitors = result.answer.match(/The competitor set is (.+?)\. \S+ .* is the next better/)?.[1] || ''
  assert.ok(competitors.length > 0, result.answer)
  assert.doesNotMatch(competitors, /Centene/)
})
