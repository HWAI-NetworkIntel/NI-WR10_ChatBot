'use strict'

/**
 * First step for every question: read the conversation, restate the latest question
 * so it stands alone, and choose how to answer it.
 *
 *   table -> rankTable.js builds a table of any shape from the published rankings
 *   improve     -> rankImprove.js: what to improve to pass the networks ahead
 *   opportunity -> rankImprove.js: the counties where we are closest to moving up a rank
 *   rank  -> the existing rank pipeline (single rank, payor comparison, what-if, how close)
 *   sql   -> text-to-SQL over the network database
 *   chat  -> plain chat
 *
 * The model only plans. Numbers come from the rankings file or the database.
 * When the model is unavailable or replies badly, planFromRules keeps routing working.
 */

const { normalizeTableSpec } = require('./rankTable')
const { VAGUE_TERMS } = require('./terminology')
const { findCounty } = require('./countyResolve')
const { readState, sinceReset, isFollowUp, hasState } = require('./conversationState')

const ROUTES = ['table', 'improve', 'opportunity', 'rank', 'sql', 'chat']
const MAX_TURNS = 8
const MAX_TURN_CHARS = 1500

const PLANNER_SYSTEM = [
  'You are the first step of a Texas Medicare Advantage provider-network assistant.',
  'Read the conversation and the latest question, work out what the user wants, and reply with one JSON object only.',
  'state is what the conversation is about so far: payor, county, planType, the last route, the last standalone question, and list (the names in the last table shown, in order, of kind listField).',
  'Use state together with the conversation to resolve "it", "there", "that county", "same", "the third one" (list[2]), and short follow-ups like "and for Dallas?" or "what about PPO" (repeat the last standalone question with that one detail changed).',
  'When the latest question corrects an earlier one ("no, I meant UHC", "actually PPO"), repeat the earlier question with only that value replaced.',
  '',
  'Fields:',
  '- standalone: the latest question rewritten so it makes sense with no conversation. Resolve "it", "that", "same", "those", "these counties", "add a column", "also show" from earlier turns. Do not add facts the user did not give.',
  '- route: one of table, improve, rank, sql, chat.',
  '  improve: how to improve, raise, or make our rank or network score better, why we rank below a payor, what we lack against competitors, or what to fix in our network. No named health system or group to add or remove.',
  '  table: show, list, or tabulate published payor rankings or network scores across several rows: rank lists, top N, ranks for every county, a table of ranks, ranks across counties or payors, or changing the columns of an earlier rank table. No hypothetical change.',
  '  opportunity: where we are closest to moving up a rank, the easiest or quickest wins, the best opportunities, where to focus first, across counties. No single county named.',
  '  rank: one current rank ("where do we rank in Harris County"), how we rank against one named payor, a what-if change (add, remove, drop, terminate a health system or physician group), or how close we are to a rank.',
  '  sql: anything else answered from network data: provider or hospital counts, specialties, enrollment, plans, bids, languages, distances. Also use sql when a rank table needs a column that is not in FIELDS (for example enrollment or provider counts).',
  '  chat: definitions, greetings, or how the tool works.',
  '- table: an object only when route is table, otherwise null:',
  '  { "columns": [...], "filters": { "county": [], "payor": [], "planType": [], "rankMax": null, "rankMin": null },',
  '    "scope": "dashboard" | "all", "pivot": null | { "rows": field, "columns": field, "value": field },',
  '    "sort": [ { "field": field, "dir": "asc" | "desc" } ], "limit": number | null }',
  '  columns: ordered fields from FIELDS. Include every column the user asked for, and no more than the question needs. Leave out metric, asOf, and value (the network score) unless the user asks for them by name. Tables show ranks, not scores. When the user changes an earlier table, keep its columns and add or remove only what they asked.',
  '  "in tabular format", "as a table", "tabulate", "make it a table" mean: show the data from the previous answer as a table. Keep the same county, payors, plan types and subject as that answer. Do not widen it to every payor or every county.',
  '  scope: "dashboard" for our own payors (dashboardPayors, "we", "us", "our", "my") and "all" when the user wants every payor or competitors.',
  '  filters.payor and filters.planType hold only payors or plan types the user named. Leave them empty for "we" / "our": scope "dashboard" already applies dashboardPayors.',
  '  pivot: use when the user wants one field across the top, for example counties down the side, payors across, rank in each cell.',
  '  filters.county empty means every Texas county. rankMax 3 means rank 3 or better.',
  '- improve: an object only when route is improve, otherwise null: { "county": "", "payor": "", "planType": "", "comparePayor": "" }.',
  '  county is "" for every county. payor and planType are "" for "we" / "our" (dashboardPayors apply). comparePayor is a payor the user wants to be compared against, else "".',
  '- opportunity: an object only when route is opportunity, otherwise null: { "payor": "", "planType": "", "limit": null }. payor and planType are "" for "we" / "our".',
  'FIELDS: county, fips, payor, planType, network, metric, value (the network score), rank, payorsRanked (how many payors are ranked in that county and plan type), asOf.',
  '- payorMentioned: the payor or health plan company named in the LATEST question, copied exactly as the user typed it, even if misspelled or unknown (for example "MJHS", "UHC", "cenetne"). Use "" when the latest question names no payor, says "we", "our", or "us", or only names a health system or physician group being added or removed.',
  'Never invent a county, payor, or plan type that the user or the conversation did not name.',
  ...VAGUE_TERMS,
].join('\n')

function clip(text, max) {
  const value = String(text ?? '')
  return value.length > max ? `${value.slice(0, max)}…` : value
}

/** Last few turns, oldest first. Accepts [{role, content}] from any endpoint. */
function cleanHistory(history) {
  if (!Array.isArray(history)) return []
  return sinceReset(history)
    .filter((turn) => turn && (turn.role === 'user' || turn.role === 'assistant') && String(turn.content ?? '').trim())
    .slice(-MAX_TURNS)
    .map((turn) => ({ role: turn.role, content: clip(turn.content, MAX_TURN_CHARS) }))
}

function dashboardPairs(input) {
  const pairs = Array.isArray(input?.payorsCrossPlanTypes) ? input.payorsCrossPlanTypes : []
  return pairs.map((pair) => ({ payor: pair.payor, planType: pair.planType }))
}

function parsePlan(text, question) {
  const raw = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  const value = JSON.parse(raw)
  const route = String(value?.route || '').toLowerCase().trim()
  if (!ROUTES.includes(route)) return null
  const standalone = String(value.standalone || '').trim() || question
  return {
    route,
    standalone: clip(standalone, 500),
    table: route === 'table' ? normalizeTableSpec(value.table) : null,
    improve: route === 'improve' ? improveSpec(value.improve) : null,
    opportunity: route === 'opportunity' ? opportunitySpec(value.opportunity) : null,
    payorMentioned: clip(String(value.payorMentioned ?? '').trim(), 100),
    source: 'model',
  }
}

function opportunitySpec(raw) {
  const value = raw && typeof raw === 'object' ? raw : {}
  const limit = Number(value.limit)
  return {
    payor: clip(String(value.payor ?? '').trim(), 200),
    planType: clip(String(value.planType ?? '').trim(), 25),
    limit: Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), 20) : null,
  }
}

function improveSpec(raw) {
  const value = raw && typeof raw === 'object' ? raw : {}
  const text = (field) => clip(String(value[field] ?? '').trim(), 200)
  return { county: text('county'), payor: text('payor'), planType: text('planType'), comparePayor: text('comparePayor') }
}

const IMPROVE = /\b(improve|better|boost|raise|increase|lift|climb|move up|strengthen)\b.{0,40}\b(rank\w*|score|position|network)\b|\b(rank\w*|score)\b.{0,30}\b(better|higher|up)\b|\bwhy\b.{0,40}\b(rank|behind|below|lower)\b|\bwhat (?:do|should) we (?:need|lack|fix|improve)\b/i

const WHAT_IF = /\b(add|adding|remove|removing|drop|dropping|terminat\w*|if we|what if|how close|how much)\b/i
const TABLE_WORDS = /\b(table|tabular|tabulate|list|all|every|each|counties|across|by county|per county|top\s+\d+|bottom\s+\d+|best|worst|strongest|weakest)\b/i
const RANK_WORDS = /\brank\w*|\bnetwork scores?\b/i
const OPPORTUNITY = /\b(closest to (?:moving|ranking|climbing) up|closest to (?:the )?next rank|move up (?:most |the most )?easil\w*|easiest (?:wins?|places?|count(?:y|ies)|gains?)|quick(?:est)? wins?|low[- ]hanging|(?:biggest|best|top) opportunit\w*|where (?:should|can|could) we (?:focus|move up|gain|climb|improve (?:most|first))|where (?:are|is) we (?:closest|nearest))\b/i
const WIDE_SCOPE = /\b(all|every)\s+(payors?|payers?|competitors?|plans?|networks?)\b|\bcompetitors?\b/i
const HERE = /\b(there|here|that county|same county)\b/i

/** "HMO" or "PPO" when the wording names one ("HMO-POS" is HMO, "Local PPO" is PPO). */
function planTypeIn(text) {
  const match = String(text || '').match(/\b(HMO|PPO)\b/i)
  return match ? match[1].toUpperCase() : ''
}

/** "top 5", "bottom 3", "the worst", "best": rank order and row count. */
function vagueOrder(text) {
  const bottom = /\b(bottom|worst|weakest|lowest|lagging|bad)\b/i.test(text)
  const top = /\b(top|best|strongest|highest|leading)\b/i.test(text)
  if (!bottom && !top) return {}
  const count = text.match(/\b(?:top|bottom|best|worst)\s+(\d{1,3})\b/i)
  return { sort: [{ field: 'rank', dir: bottom ? 'desc' : 'asc' }], limit: count ? Number(count[1]) : 5 }
}

/** A table spec from the wording: scope, the county named (typos forgiven), and "top / bottom N". */
function tableFromWords(text, state) {
  const county = findCounty(text) || (state?.county && HERE.test(text) ? state.county : '')
  return normalizeTableSpec({
    scope: WIDE_SCOPE.test(text) ? 'all' : 'dashboard',
    filters: { county: county ? [county] : [] },
    ...vagueOrder(text),
  })
}

/**
 * Used only when the model is unavailable. Returns null to keep the endpoint's existing behaviour.
 * With state, a short follow-up ("and for Dallas?", "what about PPO") reruns the last table or improve
 * question with the new detail, so the conversation does not break when the model is down.
 */
function planFromRules(question, rawState) {
  const text = String(question || '')
  const state = readState(rawState)
  if (OPPORTUNITY.test(text)) {
    const count = text.match(/\b(?:top|best)\s+(\d{1,2})\b/i)
    return { route: 'opportunity', standalone: text, opportunity: { payor: '', planType: '', limit: count ? Number(count[1]) : null }, table: null, improve: null, source: 'rules' }
  }
  if (IMPROVE.test(text) && !/\b(add|adding|remove|removing|drop|dropping|terminat\w*|what if|if we)\b/i.test(text)) {
    const county = findCounty(text) || (HERE.test(text) ? state.county : '')
    return { route: 'improve', standalone: text, improve: improveSpec({ county, planType: planTypeIn(text) }), table: null, source: 'rules' }
  }
  if (RANK_WORDS.test(text) && TABLE_WORDS.test(text) && !WHAT_IF.test(text)) {
    return { route: 'table', standalone: text, table: tableFromWords(text, state), source: 'rules' }
  }
  if (state.standalone && isFollowUp(text) && ['table', 'improve'].includes(state.route)) {
    const county = findCounty(text)
    const planType = (text.match(/\b(HMO|PPO)\b/i) || [])[1]?.toUpperCase() || ''
    if (!county && !planType) return null
    const detail = [county && `${county} County`, planType].filter(Boolean).join(', ')
    const standalone = clip(`${state.standalone.replace(/\s*[?.!]\s*$/, '')} (${detail})`, 500)
    if (state.route === 'improve') {
      return { route: 'improve', standalone, improve: improveSpec({ county: county || state.county, planType: planType || state.planType }), table: null, source: 'rules' }
    }
    const spec = tableFromWords(state.standalone, state)
    if (county) spec.filters.county = [county]
    if (planType) spec.filters.planType = [planType]
    return { route: 'table', standalone, table: spec, source: 'rules' }
  }
  return null
}

async function defaultChat(request) {
  const { chat } = require('./llm')
  return chat(request)
}

/**
 * input: { question, history?: [{role, content}], payors?, payorsCrossPlanTypes?, planType? }
 * deps.chat: override the model (tests). deps.chat === null skips the model.
 */
async function planQuestion(input, deps = {}) {
  const question = String(input?.question || input?.message || '').trim()
  if (!question) return null
  if (deps.chat !== null) {
    try {
      const raw = await (deps.chat || defaultChat)({
        system: PLANNER_SYSTEM,
        messages: [{
          role: 'user',
          content: JSON.stringify({
            conversation: cleanHistory(input.history),
            // Only a state with content: an empty one would read as "no payor" and override the conversation.
            ...(hasState(input.state) ? { state: readState(input.state) } : {}),
            question,
            dashboardPayors: dashboardPairs(input),
          }),
        }],
        json: true,
      })
      const plan = parsePlan(raw, question)
      if (plan) return plan
    } catch {
      // Fall through to the wording rules.
    }
  }
  return planFromRules(question, input.state)
}

/** Conversation turns from a request body: an explicit history, or the messages before the last user turn. */
function historyFromBody(body) {
  if (Array.isArray(body?.history)) return cleanHistory(body.history)
  const messages = Array.isArray(body?.messages) ? body.messages : []
  let last = messages.length - 1
  while (last >= 0 && messages[last]?.role !== 'user') last -= 1
  return cleanHistory(last > 0 ? messages.slice(0, last) : [])
}

module.exports = {
  PLANNER_SYSTEM,
  planQuestion,
  planFromRules,
  parsePlan,
  cleanHistory,
  historyFromBody,
}
