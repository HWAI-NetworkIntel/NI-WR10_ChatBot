'use strict'

/**
 * First step for every question: read the conversation, restate the latest question
 * so it stands alone, and choose how to answer it.
 *
 *   table -> rankTable.js builds a table of any shape from the published rankings
 *   rank  -> the existing rank pipeline (single rank, payor comparison, what-if, how close)
 *   sql   -> text-to-SQL over the network database
 *   chat  -> plain chat
 *
 * The model only plans. Numbers come from the rankings file or the database.
 * When the model is unavailable or replies badly, planFromRules keeps routing working.
 */

const { normalizeTableSpec } = require('./rankTable')

const ROUTES = ['table', 'improve', 'rank', 'sql', 'chat']
const MAX_TURNS = 8
const MAX_TURN_CHARS = 1500

const PLANNER_SYSTEM = [
  'You are the first step of a Texas Medicare Advantage provider-network assistant.',
  'Read the conversation and the latest question, work out what the user wants, and reply with one JSON object only.',
  '',
  'Fields:',
  '- standalone: the latest question rewritten so it makes sense with no conversation. Resolve "it", "that", "same", "those", "these counties", "add a column", "also show" from earlier turns. Do not add facts the user did not give.',
  '- route: one of table, improve, rank, sql, chat.',
  '  improve: how to improve, raise, or make our rank or network score better, why we rank below a payor, what we lack against competitors, or what to fix in our network. No named health system or group to add or remove.',
  '  table: show, list, or tabulate published payor rankings or network scores across several rows: rank lists, top N, ranks for every county, a table of ranks, ranks across counties or payors, or changing the columns of an earlier rank table. No hypothetical change.',
  '  rank: one current rank ("where do we rank in Harris County"), how we rank against one named payor, a what-if change (add, remove, drop, terminate a health system or physician group), or how close we are to a rank.',
  '  sql: anything else answered from network data: provider or hospital counts, specialties, enrollment, plans, bids, languages, distances. Also use sql when a rank table needs a column that is not in FIELDS (for example enrollment or provider counts).',
  '  chat: definitions, greetings, or how the tool works.',
  '- table: an object only when route is table, otherwise null:',
  '  { "columns": [...], "filters": { "county": [], "payor": [], "planType": [], "rankMax": null, "rankMin": null },',
  '    "scope": "dashboard" | "all", "pivot": null | { "rows": field, "columns": field, "value": field },',
  '    "sort": [ { "field": field, "dir": "asc" | "desc" } ], "limit": number | null }',
  '  columns: ordered fields from FIELDS. Include every column the user asked for, and no more than the question needs. Leave out metric and asOf unless the user asks for them. When the user changes an earlier table, keep its columns and add or remove only what they asked.',
  '  "in tabular format", "as a table", "tabulate", "make it a table" mean: show the data from the previous answer as a table. Keep the same county, payors, plan types and subject as that answer. Do not widen it to every payor or every county.',
  '  scope: "dashboard" for our own payors (dashboardPayors, "we", "us", "our", "my") and "all" when the user wants every payor or competitors.',
  '  filters.payor and filters.planType hold only payors or plan types the user named. Leave them empty for "we" / "our": scope "dashboard" already applies dashboardPayors.',
  '  pivot: use when the user wants one field across the top, for example counties down the side, payors across, rank in each cell.',
  '  filters.county empty means every Texas county. rankMax 3 means rank 3 or better.',
  '- improve: an object only when route is improve, otherwise null: { "county": "", "payor": "", "planType": "", "comparePayor": "" }.',
  '  county is "" for every county. payor and planType are "" for "we" / "our" (dashboardPayors apply). comparePayor is a payor the user wants to be compared against, else "".',
  'FIELDS: county, fips, payor, planType, network, metric, value (the network score), rank, payorsRanked (how many payors are ranked in that county and plan type), asOf.',
  'Never invent a county, payor, or plan type that the user or the conversation did not name.',
].join('\n')

function clip(text, max) {
  const value = String(text ?? '')
  return value.length > max ? `${value.slice(0, max)}…` : value
}

/** Last few turns, oldest first. Accepts [{role, content}] from any endpoint. */
function cleanHistory(history) {
  if (!Array.isArray(history)) return []
  return history
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
    source: 'model',
  }
}

function improveSpec(raw) {
  const value = raw && typeof raw === 'object' ? raw : {}
  const text = (field) => clip(String(value[field] ?? '').trim(), 200)
  return { county: text('county'), payor: text('payor'), planType: text('planType'), comparePayor: text('comparePayor') }
}

const IMPROVE = /\b(improve|better|boost|raise|increase|lift|climb|move up|strengthen)\b.{0,40}\b(rank(?:s|ing|ings)?|score|position|network)\b|\b(rank(?:s|ing|ings)?|score)\b.{0,30}\b(better|higher|up)\b|\bwhy\b.{0,40}\b(rank|behind|below|lower)\b|\bwhat (?:do|should) we (?:need|lack|fix|improve)\b/i

const WHAT_IF = /\b(add|adding|remove|removing|drop|dropping|terminat\w*|if we|what if|how close|how much)\b/i
const TABLE_WORDS = /\b(table|tabular|tabulate|list|all|every|each|counties|across|by county|per county|top\s+\d+)\b/i
const RANK_WORDS = /\brank(?:s|ed|ing|ings)?\b|\bnetwork scores?\b/i

/** Used only when the model is unavailable. Returns null to keep the endpoint's existing behaviour. */
function planFromRules(question) {
  const text = String(question || '')
  if (IMPROVE.test(text) && !/\b(add|adding|remove|removing|drop|dropping|terminat\w*|what if|if we)\b/i.test(text)) {
    const county = text.match(/\b(?:in|for)\s+([A-Z][a-zA-Z .'-]{1,30}?)\s+county\b/i)
    return { route: 'improve', standalone: text, improve: improveSpec({ county: county ? county[1] : '' }), table: null, source: 'rules' }
  }
  if (RANK_WORDS.test(text) && TABLE_WORDS.test(text) && !WHAT_IF.test(text)) {
    const scope = /\b(all|every)\s+(payors?|payers?|competitors?|plans?)\b|\bcompetitors?\b/i.test(text) ? 'all' : 'dashboard'
    return { route: 'table', standalone: text, table: normalizeTableSpec({ scope }), source: 'rules' }
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
  return planFromRules(question)
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
