const express = require('express')
const { config } = require('../config/config')
const { answerRank, looksLikeRankQuestion, rankOptions, refusesWrite } = require('../services/rankService')
const { answerFromStage2 } = require('../services/stage2Chat')
const { planQuestion, historyFromBody } = require('../services/conversationPlanner')
const { buildRankTable } = require('../services/rankTable')

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
  if (refusesWrite(parsed.data.question)) {
    return res.json({ kind: 'refused', message: "I can't change the network tables. Ask a read-only question." })
  }
  try {
    const { history = [], ...input } = parsed.data
    const plan = await safePlan({ ...input, history })
    if (plan && refusesWrite(plan.standalone)) {
      return res.json({ kind: 'refused', message: "I can't change the network tables. Ask a read-only question." })
    }
    if (plan?.route === 'table') {
      const { markdown: _markdown, ...table } = buildRankTable(plan.table, input)
      return res.json({ ...table, standalone: plan.standalone })
    }
    if (plan?.route === 'rank') {
      const earlier = userTexts(history).join('\n')
      const { status, payload } = await rankThread({ ...req.body, history: undefined }, plan.standalone, earlier)
      return res.status(status).json({ ...payload, standalone: plan.standalone })
    }
    if (!getSchemaContext()) return res.status(503).json({ error: 'Schema is not loaded' })
    const question = (plan?.standalone || input.question).slice(0, 500)
    const result = await answerQuestion({ ...input, question })
    return res.json(plan ? { ...result, standalone: question } : result)
  } catch (err) {
    console.error(JSON.stringify({ event: 'ask', name: err instanceof Error ? err.name : 'Error' }))
    return res.status(500).json({ kind: 'error', message: ASK_ERROR_MESSAGE })
  }
})

function userTexts(messages) {
  return (messages || []).filter((message) => message.role === 'user').map((message) => message.content)
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
    const body = req.body ?? {}
    const texts = userTexts(body.messages)
    const message = String(body.message || body.question || texts.at(-1) || '').trim()
    const earlier = body.earlier || texts.slice(0, -1).join('\n')
    const plan = await safePlan({ ...body, question: message, history: historyFromBody(body) })
    if (plan?.route === 'table') return res.json({ ...chatTable(buildRankTable(plan.table, body)), standalone: plan.standalone })
    const { status, payload } = await rankThread(body, message, earlier)
    return res.status(status).json(payload)
  } catch (err) {
    console.error(JSON.stringify({ event: 'rank', name: err instanceof Error ? err.name : 'Error' }))
    return res.status(500).json({ kind: 'error', answer: "I couldn't evaluate that rank change." })
  }
})

router.post('/llm/chat', async (req, res) => {
  if (!chatRequestSchema || !chat) return res.status(503).json({ error: 'LLM request failed' })
  const parsed = chatRequestSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: formatChatIssues(parsed.error) })
  const texts = userTexts(parsed.data.messages)
  const userText = texts.at(-1) || ''
  const earlier = texts.slice(0, -1).join('\n')
  if (refusesWrite(userText) || refusesWrite(parsed.data.system)) {
    return res.json({ content: "I can't change the network tables. Ask a read-only rank question.", kind: 'refused' })
  }
  // A caller asking for JSON controls its own format, so it skips the planner and rank routing.
  const callerFormat = /\bjson\b/i.test(parsed.data.system || '')
  const plan = callerFormat ? null : await safePlan({ ...req.body, question: userText, history: historyFromBody(parsed.data) })
  if (plan?.route === 'table') {
    const table = chatTable(buildRankTable(plan.table, req.body))
    return res.json({ content: table.answer, ...table, standalone: plan.standalone })
  }
  const rankLike = plan?.route === 'rank'
    || looksLikeRankQuestion(userText)
    || (texts.some((text) => looksLikeRankQuestion(text)) && continuesRank(userText))
  if (rankLike && !callerFormat) {
    try {
      const { status, payload } = await rankThread(req.body, userText, earlier)
      return res.status(status).json({ content: payload.answer, ...payload })
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
