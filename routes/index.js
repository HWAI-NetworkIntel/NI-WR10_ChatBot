const express = require('express')
const { config } = require('../config/config')
const { answerRank, looksLikeRankQuestion, rankOptions, refusesWrite } = require('../services/rankService')

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
  if (!getSchemaContext()) return res.status(503).json({ error: 'Schema is not loaded' })
  try {
    return res.json(await answerQuestion(parsed.data))
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
    const result = await answerRank({ ...body, message, earlier })
    const status = result.status || 200
    const { status: _status, ...payload } = result
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
  const rankThread = looksLikeRankQuestion(userText) || (texts.some((text) => looksLikeRankQuestion(text)) && continuesRank(userText))
  if (rankThread && !/\bjson\b/i.test(parsed.data.system || '')) {
    try {
      const result = await answerRank({ ...req.body, message: userText, earlier })
      const status = result.status || 200
      const { status: _status, ...body } = result
      return res.status(status).json({ content: body.answer, ...body })
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
