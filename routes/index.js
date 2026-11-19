const express = require('express')
const { config } = require('../config/config')
const { answerRank, looksLikeRankQuestion, rankOptions, refusesWrite } = require('../services/rankService')
const { answerFromStage2, explainWhatIf } = require('../services/stage2Chat')
const { planQuestion, historyFromBody } = require('../services/conversationPlanner')
const { buildRankTable } = require('../services/rankTable')
const { improveRank, findOpportunities } = require('../services/rankImprove')
const { checkNamedPayor, checkPayorPhrase, scopeToPayor, askForPayor } = require('../services/payorResolve')
const { guardrailReason, guardrailReply, withGuidance, EXAMPLES } = require('../services/guidance')
const { readState, nextState, isReset, sinceReset, resetReply, resolveOrdinal, applyCorrection, stateFromHistory } = require('../services/conversationState')
const { nextSteps } = require('../services/nextSteps')

function loadOptional(name) {
  try {
    return require(name)
  } catch {
    return null
  }
}

const db = loadOptional('../dataaccess/db')
const ask = loadOptional('../services/askService')
const llm = loadOptional('../services/llm')
const prompts = loadOptional('../services/prompts')
const schema = loadOptional('../services/schemaService')
const ASK_ERROR_MESSAGE = ask?.ASK_ERROR_MESSAGE
const answerQuestion = ask?.answerQuestion
const askRequestSchema = ask?.askRequestSchema
const formatAskIssues = ask?.formatAskIssues
const chat = llm?.chat
const chatRequestSchema = llm?.chatRequestSchema
const formatChatIssues = llm?.formatChatIssues
const forwardChatStream = llm?.forwardChatStream
const LlmHttpError = llm?.LlmHttpError
const networkChatSystemPrompt = prompts?.networkChatSystemPrompt
const getPool = db?.getPool
const databaseConfig = schema?.databaseConfig
const getSchemaContext = schema?.getSchemaContext
const schemaPanel = schema?.schemaPanel

function continuesRank(text) {
  const value = String(text || '').trim()
  if (!value || value.length > 80) return false
  if (looksLikeRankQuestion(value)) return true
  return value.split(/\s+/).length <= 4
}
/** The planner never blocks an answer: on any failure the endpoint keeps its old routing. */
async function safePlan(input) {
  try {
    return await planQuestion(input)
  } catch {
    return null
  }
}

/** Chat endpoints render `answer` / `content` as markdown, so the table goes there too. */
function chatTable(table) {
  const { markdown, ...rest } = table
  return { ...rest, answer: markdown ? `${table.answer}\n\n${markdown}` : table.answer }
}

/** Routes the planner answers straight from the data files: rank tables, "how do we improve", and "where can we move up". */
function plannedAnswer(plan, context, prior) {
  if (plan?.route === 'table') return buildRankTable(plan.table, context)
  if (plan?.route === 'improve') return improveRank(withConversationCounty(withConversationPayor(plan.improve, context, prior), plan, prior), context)
  if (plan?.route === 'opportunity') return findOpportunities(withConversationPayor(plan.opportunity, context, prior), context)
  return null
}

/**
 * "How can I improve the rankings?" right after "Where does Humana rank?" means Humana. When the dashboard
 * does not settle one payor, the payor from the conversation is used instead of asking again.
 */
function withConversationPayor(spec, context, prior) {
  const request = { ...(spec || {}) }
  const dashboard = new Set([...(context?.payors || []), ...(context?.payorsCrossPlanTypes || []).map((pair) => pair.payor)])
  if (!request.payor && prior?.payor && dashboard.size !== 1) request.payor = prior.payor
  // The plan type the conversation settled on ("make it PPO") carries over too, instead of asking again.
  if (!request.planType && prior?.planType) request.planType = prior.planType
  return request
}

/**
 * "How can I improve?" right after a Dallas County question means Dallas County. A question that asks for
 * every county or statewide keeps its statewide answer. The answer's "Assumed" line says where the county came from.
 */
function withConversationCounty(request, plan, prior) {
  if (request.county || !prior?.county) return request
  if (/\b(every|all|each|statewide|state-wide|across|texas|counties)\b/i.test(plan?.standalone || '')) return request
  return { ...request, county: prior.county, countyFromConversation: true }
}

/** The client's state, or one rebuilt from earlier user turns when the client does not send it back. */
function priorState(body, messages) {
  if (body?.state && typeof body.state === 'object') return readState(body.state)
  const turns = Array.isArray(messages) ? messages : []
  // The latest user turn is the question being asked, not context.
  let last = turns.length - 1
  while (last >= 0 && turns[last]?.role !== 'user') last -= 1
  return stateFromHistory(last >= 0 ? turns.slice(0, last) : turns)
}

/**
 * Turns that only make sense against the conversation so far, handled before routing:
 *   "start over"            -> a reset reply (the caller returns it)
 *   "no, I meant UHC"       -> the last question with that value swapped, scoped to the new payor
 *   "the third one"         -> the name from the last table shown
 * Returns { reply } or { question, body, note }.
 */
function prepareTurn(message, body, prior) {
  if (isReset(message)) return { reply: resetReply(EXAMPLES) }
  let question = message
  let scoped = body
  let note = ''
  const fixed = applyCorrection(message, prior)
  if (fixed) {
    question = fixed.question
    note = fixed.note
    if (fixed.patch.payor) scoped = { ...scopeToPayor(scoped, fixed.patch.payor), payorConfirmed: true }
  }
  const pointed = resolveOrdinal(question, prior)
  if (pointed) {
    question = pointed.question
    if (pointed.field === 'payor') scoped = { ...scopeToPayor(scoped, pointed.item), payorConfirmed: true }
  }
  return { question: question.slice(0, 500), body: scoped, note }
}

/** "Switched to PPO." in front of the answer text, in every field an endpoint renders. */
function withNote(payload, note) {
  if (!note) return payload
  const out = { ...payload }
  for (const field of ['answer', 'content', 'message']) {
    if (typeof out[field] === 'string' && out[field]) out[field] = `${note}\n\n${out[field]}`
  }
  return out
}

/** Every answer carries the conversation state for the next turn and, where useful, follow-up questions. */
function finishTurn(payload, { plan, body, question, prior, note }) {
  const state = nextState(prior, { plan, body, result: payload, question })
  const steps = nextSteps(plan?.route || '', payload, state)
  const extra = steps.length ? { suggestions: steps, suggestionField: 'question' } : {}
  return withNote({ ...payload, ...extra, state }, note)
}

const WHAT_IF_CHANGE = /\b(add|adding|remove|removing|removed|drop|dropping|dropped|terminat\w*|exit|exits|leave|leaves|without|losing)\b/i

/**
 * The payor named in the question wins over a remembered or dashboard payor.
 * An unknown name ("MJHS") gets a clarify reply with payor options instead of a guess.
 * A payor the user just picked from those options (payorConfirmed) is taken as is.
 */
function payorCheck(message, body) {
  if (body?.payorConfirmed) return { body }
  // What-if changes ("if we remove HCA") are resolved by the scenario and rank pipeline, which reads the payor itself.
  if (WHAT_IF_CHANGE.test(message)) return { body }
  const named = checkNamedPayor(message)
  if (named?.reply) return { reply: named.reply }
  if (named?.payor && !(body?.payors || []).includes(named.payor)) return { body: scopeToPayor(body, named.payor) }
  return { body }
}

/**
 * Second check, for wording the patterns miss ("what about MJHS"): the payor the planner read
 * in the latest question. Skipped for what-if changes, where a name is the health system moved.
 */
function plannedPayorCheck(plan, message, body) {
  if (!plan?.payorMentioned || body?.payorConfirmed) return { body }
  if (WHAT_IF_CHANGE.test(message)) return { body }
  const named = checkPayorPhrase(plan.payorMentioned, message)
  if (named?.reply) return { reply: named.reply }
  if (named?.payor && !(body?.payors || []).includes(named.payor)) return { body: scopeToPayor(body, named.payor) }
  return { body }
}

/**
 * "Why did United's rank drop?" after a removal what-if: explained from that same what-if run,
 * before the planner can send it to the published-rank improvement answer. Null when it does not apply.
 */
async function whatIfFollowUp(body, question, turn, prior) {
  const explained = await explainWhatIf({ ...body, message: question, question })
  if (!explained) return null
  return finishTurn(withGuidance(explained), { plan: null, body, question, prior, note: turn.note })
}

/** Stage 2 (Python) first, then the roster rank model. */
async function rankThread(body, message, earlier) {
  const stage2 = await answerFromStage2({ ...body, message, earlier })
  if (stage2?.answer) return { status: stage2.kind === 'error' ? 422 : 200, payload: stage2 }
  const result = await answerRank({
    ...body,
    message: stage2?.message || message,
    earlier,
    ...(stage2?.change ? { change: stage2.change } : {}),
  })
  const { status, ...payload } = result
  // A request missing its payor scope is a question to ask, never a raw validation message.
  if (status === 400) return { status: 200, payload: askForPayor(message) }
  return { status: status || 200, payload }
}

const NO_DOCUMENTED_TABLES = 'the login cannot see any documented table'

const router = express.Router()

router.get('/health', async (_req, res) => {
  const body = { status: 'error', database: config.DB_DATABASE || '', dbOk: false, tableCount: 0 }
  if (!getPool || !databaseConfig || !getSchemaContext) return res.status(503).json(body)
  try {
    const pool = await getPool(databaseConfig())
    const result = await pool.request().query('SELECT COUNT(*) AS tableCount FROM INFORMATION_SCHEMA.TABLES')
    const tableCount = Number(result.recordset[0]?.tableCount)
    if (!Number.isFinite(tableCount)) return res.status(503).json(body)
    const allowed = getSchemaContext()?.allowedTables ?? []
    if (!allowed.length) return res.status(503).json({ ...body, tableCount, message: NO_DOCUMENTED_TABLES })
    return res.status(200).json({ status: 'ok', database: config.DB_DATABASE, dbOk: true, tableCount })
  } catch {
    return res.status(503).json(body)
  }
})

router.get('/schema/drift', (_req, res) => {
  if (!getSchemaContext) return res.status(503).json({ error: 'Schema is not loaded' })
  const ctx = getSchemaContext()
  if (!ctx) return res.status(503).json({ error: 'Schema is not loaded' })
  return res.json(ctx.drift)
})

router.get('/schema', (_req, res) => {
  if (!getSchemaContext || !schemaPanel) return res.status(503).json({ error: 'Schema is not loaded' })
  const ctx = getSchemaContext()
  if (!ctx) return res.status(503).json({ error: 'Schema is not loaded' })
  return res.json(schemaPanel(ctx))
})

router.post('/ask', async (req, res) => {
  if (!askRequestSchema || !answerQuestion) return res.status(503).json({ error: 'Schema is not loaded' })
  const parsed = askRequestSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: formatAskIssues(parsed.error) })
  const prior = priorState(req.body, [...(Array.isArray(req.body?.history) ? req.body.history : []), { role: 'user', content: parsed.data.question }])
  // Checked before anything else, so a blocked question never asks for a payor first.
  const blocked = guardrailReason(parsed.data.question)
  if (blocked) return res.json({ ...guardrailReply(blocked), state: prior })
  const turn = prepareTurn(parsed.data.question, parsed.data, prior)
  if (turn.reply) return res.json(turn.reply)
  try {
    const followUp = await whatIfFollowUp(turn.body, turn.question, turn, prior)
    if (followUp) return res.json(followUp)
  } catch (err) {
    console.error(JSON.stringify({ event: 'ask', name: err instanceof Error ? err.name : 'Error' }))
  }
  const checked = payorCheck(turn.question, turn.body)
  if (checked.reply) return res.json({ ...checked.reply, state: prior })
  try {
    const { history: rawHistory = [], ...rest } = checked.body
    const history = sinceReset(rawHistory)
    const firstInput = { ...rest, question: turn.question }
    const plan = await safePlan({ ...firstInput, history, state: prior })
    const blockedPlan = plan ? guardrailReason(plan.standalone) : ''
    if (blockedPlan) return res.json({ ...guardrailReply(blockedPlan), state: prior })
    const planned = plannedPayorCheck(plan, turn.question, firstInput)
    if (planned.reply) return res.json({ ...planned.reply, state: prior })
    const input = planned.body
    const finish = (payload) => finishTurn(payload, { plan, body: input, question: input.question, prior, note: turn.note })
    const direct = plannedAnswer(plan, input, prior)
    if (direct) {
      const { markdown: _markdown, ...payload } = direct
      return res.json(finish({ ...withGuidance(payload), standalone: plan.standalone }))
    }
    if (plan?.route === 'rank') {
      const earlier = userTexts(history).join('\n')
      // The restated question is only needed for follow-ups. A self-contained question is passed as typed,
      // so details the restatement adds (such as the dashboard plan type) do not narrow the answer.
      const asked = history.length ? plan.standalone : input.question
      const { status, payload } = await rankThread({ ...req.body, ...input, history: undefined }, asked, earlier)
      return res.status(status).json(finish({ ...payload, standalone: plan.standalone }))
    }
    if (!getSchemaContext()) return res.status(503).json({ error: 'Schema is not loaded' })
    const question = (plan?.standalone || input.question).slice(0, 500)
    const result = withGuidance(await answerQuestion({ ...input, question }))
    return res.json(finish(plan ? { ...result, standalone: question } : result))
  } catch (err) {
    console.error(JSON.stringify({ event: 'ask', name: err instanceof Error ? err.name : 'Error' }))
    return res.status(500).json(withGuidance({ kind: 'error', message: ASK_ERROR_MESSAGE }))
  }
})

function userTexts(messages) {
  return sinceReset(messages || []).filter((message) => message.role === 'user').map((message) => message.content)
}

router.get('/rank/options', (req, res) => {
  try {
    return res.json(rankOptions({
      q: req.query.q,
      county: req.query.county,
      planType: req.query.planType,
    }))
  } catch (err) {
    console.error(JSON.stringify({ event: 'rank_options', name: err instanceof Error ? err.name : 'Error' }))
    return res.status(500).json({ error: 'Rank options are unavailable' })
  }
})

router.post('/rank', async (req, res) => {
  try {
    const texts = userTexts(req.body?.messages)
    const message = String(req.body?.message || req.body?.question || texts.at(-1) || '').trim()
    const earlier = req.body?.earlier || texts.slice(0, -1).join('\n')
    const earlierTurns = Array.isArray(req.body?.messages) ? req.body.messages
      : String(earlier || '').split('\n').filter(Boolean).map((content) => ({ role: 'user', content }))
    const prior = priorState(req.body, Array.isArray(req.body?.messages) ? earlierTurns : [...earlierTurns, { role: 'user', content: message }])
    const blocked = guardrailReason(message)
    if (blocked) return res.json({ ...guardrailReply(blocked), state: prior })
    const turn = prepareTurn(message, req.body ?? {}, prior)
    if (turn.reply) return res.json(turn.reply)
    const asked = turn.question
    const followUp = await whatIfFollowUp(turn.body, asked, turn, prior)
    if (followUp) return res.json(followUp)
    const checked = payorCheck(asked, turn.body)
    if (checked.reply) return res.json({ ...checked.reply, state: prior })
    const plan = await safePlan({ ...checked.body, question: asked, history: historyFromBody(checked.body), state: prior })
    const planned = plannedPayorCheck(plan, asked, checked.body)
    if (planned.reply) return res.json({ ...planned.reply, state: prior })
    const body = planned.body
    const finish = (payload) => finishTurn(payload, { plan, body, question: asked, prior, note: turn.note })
    const direct = plannedAnswer(plan, body, prior)
    if (direct) return res.json(finish({ ...withGuidance(chatTable(direct)), standalone: plan.standalone }))
    const { status, payload } = await rankThread(body, asked, earlier)
    return res.status(status).json(finish(withGuidance(payload)))
  } catch (err) {
    console.error(JSON.stringify({ event: 'rank', name: err instanceof Error ? err.name : 'Error' }))
    return res.status(500).json(withGuidance({ kind: 'error', answer: "I couldn't evaluate that rank change." }))
  }
})

router.post('/llm/chat', async (req, res) => {
  if (!chatRequestSchema || !chat) return res.status(503).json({ error: 'LLM request failed' })
  const parsed = chatRequestSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: formatChatIssues(parsed.error) })
  const texts = userTexts(parsed.data.messages)
  const typed = texts.at(-1) || ''
  const earlier = texts.slice(0, -1).join('\n')
  const prior = priorState(req.body, parsed.data.messages)
  const blocked = guardrailReason(typed) || (refusesWrite(parsed.data.system) ? 'write' : '')
  if (blocked) return res.json({ ...guardrailReply(blocked), state: prior })
  // A caller asking for JSON controls its own format, so it skips the planner and rank routing.
  const callerFormat = /\bjson\b/i.test(parsed.data.system || '')
  const turn = callerFormat ? { question: typed, body: req.body, note: '' } : prepareTurn(typed, req.body, prior)
  if (turn.reply) return res.json(turn.reply)
  const userText = turn.question
  if (!callerFormat) {
    try {
      const followUp = await whatIfFollowUp(turn.body, userText, turn, prior)
      if (followUp) return res.json({ content: followUp.answer, ...followUp })
    } catch (err) {
      console.error(JSON.stringify({ event: 'rank', name: err instanceof Error ? err.name : 'Error' }))
    }
  }
  const checked = callerFormat ? { body: req.body } : payorCheck(userText, turn.body)
  if (checked.reply) return res.json({ ...checked.reply, state: prior })
  const plan = callerFormat ? null : await safePlan({ ...checked.body, question: userText, history: historyFromBody(parsed.data), state: prior })
  const planned = plannedPayorCheck(plan, userText, checked.body)
  if (planned.reply) return res.json({ ...planned.reply, state: prior })
  const scoped = planned.body
  const finish = (payload) => finishTurn(payload, { plan, body: scoped, question: userText, prior, note: turn.note })
  const direct = plannedAnswer(plan, scoped, prior)
  if (direct) {
    const payload = finish(withGuidance(chatTable(direct)))
    return res.json({ content: payload.answer, ...payload, standalone: plan.standalone })
  }
  const rankLike = plan?.route === 'rank'
    || looksLikeRankQuestion(userText)
    || (texts.some((text) => looksLikeRankQuestion(text)) && continuesRank(userText))
  if (rankLike && !callerFormat) {
    try {
      const { status, payload } = await rankThread(scoped, userText, earlier)
      const finished = finish(payload)
      return res.status(status).json({ content: finished.answer, ...finished })
    } catch (err) {
      console.error(JSON.stringify({ event: 'rank', name: err instanceof Error ? err.name : 'Error' }))
      return res.status(500).json({ error: "I couldn't evaluate that rank change." })
    }
  }
  const request = { ...parsed.data, system: networkChatSystemPrompt(parsed.data.system) }
  try {
    if (request.stream) {
      await forwardChatStream(request, res)
      return
    }
    const content = await chat(request)
    return res.json({ content })
  } catch (err) {
    if (res.headersSent) return
    if (err instanceof LlmHttpError) return res.status(err.status).json({ error: err.message })
    const aborted = typeof err === 'object' && err !== null && 'name' in err && err.name === 'AbortError'
    return res.status(aborted ? 504 : 502).json({ error: aborted ? 'LLM request timed out' : 'LLM request failed' })
  }
})

module.exports = router
