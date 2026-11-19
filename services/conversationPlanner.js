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

const ROUTES = ['table', 'rank', 'sql', 'chat']
const MAX_TURNS = 8
const MAX_TURN_CHARS = 1500

const PLANNER_SYSTEM = [
  'You are the first step of a Texas Medicare Advantage provider-network assistant.',
  'Read the conversation and the latest question, work out what the user wants, and reply with one JSON object only.',
  '',
  'Fields:',
  '- standalone: the latest question rewritten so it makes sense with no conversation. Resolve "it", "that", "same", "those", "these counties", "add a column", "also show" from earlier turns. Do not add facts the user did not give.',
  '- route: one of table, rank, sql, chat.',
  '  table: show, list, or tabulate published payor rankings or network scores across several rows: rank lists, top N, ranks for every county, a table of ranks, ranks across counties or payors, or changing the columns of an earlier rank table. No hypothetical change.',
  '  rank: one current rank ("where do we rank in Harris County"), how we rank against one named payor, a what-if change (add, remove, drop, terminate a health system or physician group), or how close we are to a rank.',
  '  sql: anything else answered from network data: provider or hospital counts, specialties, enrollment, plans, bids, languages, distances. Also use sql when a rank table needs a column that is not in FIELDS (for example enrollment or provider counts).',
  '  chat: definitions, greetings, or how the tool works.',
  '- table: an object only when route is table, otherwise null:',
  '  { "columns": [...], "filters": { "county": [], "payor": [], "planType": [], "rankMax": null, "rankMin": null },',
  '    "scope": "dashboard" | "all", "pivot": null | { "rows": field, "columns": field, "value": field },',
  '    "sort": [ { "field": field, "dir": "asc" | "desc" } ], "limit": number | null }',
  '  columns: ordered fields from FIELDS. Include every column the user asked for. When the user changes an earlier table, keep its columns and add or remove only what they asked.',
  '  scope: "dashboard" for our own payors (dashboardPayors, "we", "us", "our", "my") and "all" when the user wants every payor or competitors.',
  '  filters.payor and filters.planType hold only payors or plan types the user named. Leave them empty for "we" / "our": scope "dashboard" already applies dashboardPayors.',
  '  pivot: use when the user wants one field across the top, for example counties down the side, payors across, rank in each cell.',
  '  filters.county empty means every Texas county. rankMax 3 means rank 3 or better.',
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
    source: 'model',
  }
}

const WHAT_IF = /\b(add|adding|remove|removing|drop|dropping|terminat\w*|if we|what if|how close|how much)\b/i
const TABLE_WORDS = /\b(table|list|all|every|each|counties|across|by county|per county|top\s+\d+)\b/i
const RANK_WORDS = /\brank(?:s|ed|ing|ings)?\b|\bnetwork scores?\b/i

/** Used only when the model is unavailable. Returns null to keep the endpoint's existing behaviour. */
function planFromRules(question) {
  const text = String(question || '')
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
