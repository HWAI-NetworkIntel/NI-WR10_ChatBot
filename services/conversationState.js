'use strict'

/**
 * What the conversation is about, carried between turns as a small structured object.
 *
 * Chat history alone loses context: the planner sees only the last few turns, each clipped, so a
 * long rank table falls out and "tell me about the third one" has nothing to point at. Every answer
 * now returns `state`; the client sends it back on the next request.
 *
 *   state = { payor, county, planType, route, standalone, list, listField }
 *     list       the names in the last table shown, in order ("the third one" = list[2])
 *     listField  'payor' or 'county': what the list holds
 *
 * This module also handles the turns that only make sense against that state:
 *   reset       "start over", "new question"            -> clear everything
 *   correction  "no, I meant UHC", "actually PPO"       -> the last question again, with one value swapped
 *   ordinal     "the third one", "the last county"      -> the name from the last table
 */

const { findCounty, canonicalCounty } = require('./countyResolve')
const { payorCandidates, namedPayorPhrase, defaultKnownPayors } = require('./payorResolve')

const MAX_LIST = 25
const MAX_TEXT = 500

function text(value, max = 200) {
  return String(value ?? '').trim().slice(0, max)
}

/** The state a client sent back, keeping only known fields of the right type. Never trusted further than that. */
function readState(raw) {
  const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const list = Array.isArray(value.list) ? value.list.map((item) => text(item)).filter(Boolean).slice(0, MAX_LIST) : []
  return {
    payor: text(value.payor),
    county: text(value.county),
    planType: text(value.planType, 25),
    route: text(value.route, 20),
    standalone: text(value.standalone, MAX_TEXT),
    list,
    listField: ['payor', 'county'].includes(value.listField) ? value.listField : '',
  }
}

const RESET = /^\s*(?:please\s+)?(?:start\s+(?:over|again|fresh)|reset(?:\s+(?:the\s+)?(?:chat|conversation|context))?|new\s+(?:question|topic|conversation|chat)|clear\s+(?:the\s+)?(?:chat|conversation|context|history)|forget\s+(?:that|everything|all\s+that|the\s+(?:earlier|previous)\s+(?:conversation|questions?)))\s*[.!]*\s*$/i

function isReset(message) {
  return RESET.test(String(message || ''))
}

/** Turns after the user's most recent reset. Earlier turns no longer apply. */
function sinceReset(messages) {
  const list = Array.isArray(messages) ? messages : []
  let start = 0
  list.forEach((turn, at) => {
    if (turn?.role === 'user' && isReset(turn.content)) start = at + 1
  })
  return list.slice(start)
}

function resetReply(suggestions = []) {
  const answer = 'Starting fresh. I have cleared the earlier conversation. What would you like to know?'
  return { kind: 'reset', answer, message: answer, content: answer, suggestions, suggestionField: 'question', resetHistory: true, state: readState({}) }
}

/* ---------- "the third one" ---------- */

const ORDINALS = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10, '1st': 1, '2nd': 2, '3rd': 3, '4th': 4, '5th': 5, '6th': 6, '7th': 7, '8th': 8, '9th': 9, '10th': 10 }
const ORDINAL = /\b(?:the\s+)?(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|1st|2nd|3rd|[4-9]th|10th|last)\s+(one|payor|payer|county|row|network|entry|item)\b/i

/** "tell me more about the third one" -> "tell me more about Humana Inc.", using the last table shown. */
function resolveOrdinal(message, state) {
  const value = String(message || '')
  const match = value.match(ORDINAL)
  if (!match || !state?.list?.length) return null
  const noun = match[2].toLowerCase()
  const wants = /^(payor|payer|network)$/.test(noun) ? 'payor' : noun === 'county' ? 'county' : ''
  if (wants && state.listField && wants !== state.listField) return null
  const position = match[1].toLowerCase() === 'last' ? state.list.length : ORDINALS[match[1].toLowerCase()]
  const item = state.list[position - 1]
  if (!item) return null
  const replacement = state.listField === 'county' ? `${item} County` : item
  return { question: value.replace(match[0], replacement), item, field: state.listField || 'payor' }
}

/* ---------- "no, I meant UHC" ---------- */

const CORRECTION = /^\s*(?:(?:no|nope|sorry|oops|wait|hmm)\b[\s,.!-]*)?(?:i\s+meant|i\s+mean|i\s+said|meant|actually|rather|make\s+(?:it|that)|change\s+(?:it\s+|that\s+)?to|switch\s+to|use)\s+(?:the\s+)?(.+?)\s*[.!?]*\s*$/i
const NOT_X_BUT_Y = /^\s*(?:no[\s,.!-]*)?not\s+[^,]+?,\s*(?:but\s+)?(?:the\s+)?(.+?)\s*[.!?]*\s*$/i

function escape(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function replaceWord(source, oldValue, newValue) {
  if (!oldValue) return ''
  const re = new RegExp(`\\b${escape(oldValue)}\\b`, 'i')
  return re.test(source) ? source.replace(re, newValue) : ''
}

/**
 * A correction of the last question: { question, patch, note } or null when the message is not one.
 * Only short corrections that name a payor, county, or plan type count, so "actually, where do we rank
 * in Dallas?" stays an ordinary question.
 */
function applyCorrection(message, state, deps = {}) {
  if (!state?.standalone) return null
  const value = String(message || '')
  const match = value.match(CORRECTION) || value.match(NOT_X_BUT_Y)
  if (!match) return null
  const phrase = match[1].replace(/\s+(?:not|instead\s+of|rather\s+than)\s+.*$/i, '').replace(/\s+instead$/i, '').trim()
  if (!phrase || phrase.split(/\s+/).length > 6) return null
  const previous = state.standalone
  const plan = phrase.match(/^(hmo(?:-pos)?|(?:local\s+|regional\s+)?ppo)(?:\s+plans?)?$/i)
  if (plan) {
    const planType = /hmo/i.test(plan[1]) ? 'HMO' : 'PPO'
    const question = replaceWord(previous, state.planType, planType) || previous.replace(/\b(HMO(?:-POS)?|PPO)\b/i, planType)
    return {
      question: question !== previous ? question : `${previous} (${planType} plans)`,
      patch: { planType },
      note: `Switched to ${planType}.`,
    }
  }
  const counties = deps.counties
  const toCounty = (county) => {
    const question = replaceWord(previous, state.county, county) || `${previous.replace(/\s*[?.!]\s*$/, '')} in ${county} County`
    return { question, patch: { county }, note: `Switched to ${county} County.` }
  }
  // An exact county name first ("Harris" is the county, not Harris County Hospital District),
  // then payors, then counties with a spelling mistake ("Humana" must not become a county).
  const exactCounty = canonicalCounty(phrase, counties, { maxTypos: 0 })
  if (exactCounty) return toCounty(exactCounty)
  const payors = (deps.knownPayors || defaultKnownPayors)()
  const found = payorCandidates(phrase, payors)
  if (found.length === 1) {
    const payor = found[0]
    const oldPhrase = namedPayorPhrase(previous)
    const question = replaceWord(previous, oldPhrase, payor)
      || replaceWord(previous, state.payor, payor)
      || `${previous.replace(/\s*[?.!]\s*$/, '')} for ${payor}`
    return { question, patch: { payor }, note: `Switched to ${payor}.` }
  }
  const county = /\bcounty\b/i.test(phrase) ? canonicalCounty(phrase, counties) : canonicalCounty(phrase, counties, { maxTypos: 1 })
  if (county) return toCounty(county)
  return null
}

/* ---------- short follow-ups for the rule-based planner ---------- */

const FOLLOW_UP = /^\s*(?:and|also|now|only|just|same\s+for|what\s+about|how\s+about|and\s+what\s+about|then|ok(?:ay)?\s+(?:and|now))\b/i

/** "and for Dallas?", "what about PPO", "only Harris": a turn that changes one detail of the last question. */
function isFollowUp(message) {
  const value = String(message || '').trim()
  if (!value) return false
  if (FOLLOW_UP.test(value)) return true
  return value.split(/\s+/).length <= 3 && !/\b(rank|ranking|score|improve|table|list|show|how|why|what|where|who)\b/i.test(value)
}

/* ---------- the state after an answer ---------- */

function single(list) {
  return Array.isArray(list) && list.length === 1 ? text(list[0]) : ''
}

/** The names in the table just shown, in order, so a later turn can say "the third one". */
function listFrom(result) {
  const tables = [
    { columns: result?.columns, rows: result?.rows },
    ...(Array.isArray(result?.tables) ? result.tables : []),
  ].filter((table) => Array.isArray(table.columns) && Array.isArray(table.rows) && table.rows.length)
  for (const table of tables) {
    for (const [field, header] of [['payor', /^payor$/i], ['county', /^county$/i]]) {
      const at = table.columns.findIndex((column) => header.test(String(column)))
      if (at < 0) continue
      const names = [...new Set(table.rows.map((row) => text(Array.isArray(row) ? row[at] : '')).filter(Boolean))]
      if (names.length > 1) return { list: names.slice(0, MAX_LIST), listField: field }
    }
  }
  return null
}

/**
 * The state after this turn. Values the answer settled win; a question that widened to every county clears
 * the county; anything the turn did not touch carries over.
 */
function nextState(previous, { plan, body, result, question } = {}) {
  const prior = readState(previous)
  if (!result || ['refused', 'reset'].includes(result.kind)) return prior
  const spec = plan?.table || result?.spec || null
  const improve = plan?.improve || plan?.opportunity || null
  const payor = text(result?.focal?.payor)
    || single(spec?.filters?.payor)
    || text(improve?.payor)
    || single(body?.payors)
    || prior.payor
  let county = text(result?.geography?.county) || single(spec?.filters?.county)
  if (!county && improve) county = text(improve.county)
  if (!county && spec && !spec.filters?.county?.length) county = ''
  else if (!county && !improve) county = findCounty(plan?.standalone || question || '') || prior.county
  const planType = text(result?.focal?.planType) || single(spec?.filters?.planType) || text(improve?.planType) || prior.planType
  const listed = listFrom(result)
  return readState({
    payor,
    county,
    planType,
    route: plan?.route || prior.route || 'rank',
    standalone: plan?.standalone || question || prior.standalone,
    list: listed ? listed.list : prior.list,
    listField: listed ? listed.listField : prior.listField,
  })
}

/**
 * State rebuilt from earlier user turns, for clients that do not send `state` back.
 * Newest turn first: the last payor and county the user named. A payor that is not ranked is skipped.
 */
function stateFromHistory(messages) {
  const { checkNamedPayor } = require('./payorResolve')
  const turns = sinceReset(Array.isArray(messages) ? messages : [])
    .filter((turn) => turn?.role === 'user')
    .map((turn) => String(turn.content || ''))
    .reverse()
  let payor = ''
  let county = ''
  for (const turnText of turns) {
    if (!payor) payor = checkNamedPayor(turnText)?.payor || ''
    if (!county) county = findCounty(turnText)
    if (payor && county) break
  }
  return readState({ payor, county, standalone: turns[0] || '' })
}

/** True when the state holds anything worth sending to the planner. */
function hasState(state) {
  const value = readState(state)
  return Boolean(value.payor || value.county || value.planType || value.standalone || value.list.length)
}

module.exports = {
  stateFromHistory,
  hasState,
  readState,
  nextState,
  isReset,
  sinceReset,
  resetReply,
  resolveOrdinal,
  applyCorrection,
  isFollowUp,
  listFrom,
}
