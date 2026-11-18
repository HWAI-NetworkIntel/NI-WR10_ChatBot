const express = require('express')
const { config } = require('../config/config')
const { getPool } = require('../dataaccess/db')
const { ASK_ERROR_MESSAGE, answerQuestion, askRequestSchema, formatAskIssues } = require('../services/askService')
const { chat, chatRequestSchema, formatChatIssues, forwardChatStream, LlmHttpError } = require('../services/llm')
const { databaseConfig, getSchemaContext, schemaPanel } = require('../services/schemaService')

const router = express.Router()
const NO_DOCUMENTED_TABLES = 'the login cannot see any documented table'

router.get('/health', async (_req, res) => {
  const body = { status: 'error', database: config.DB_DATABASE, dbOk: false, tableCount: 0 }
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
  const ctx = getSchemaContext()
  if (!ctx) return res.status(503).json({ error: 'Schema is not loaded' })
  return res.json(ctx.drift)
})

router.get('/schema', (_req, res) => {
  const ctx = getSchemaContext()
  if (!ctx) return res.status(503).json({ error: 'Schema is not loaded' })
  return res.json(schemaPanel(ctx))
})

router.post('/ask', async (req, res) => {
  const parsed = askRequestSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: formatAskIssues(parsed.error) })
  if (!getSchemaContext()) return res.status(503).json({ error: 'Schema is not loaded' })
  try {
    return res.json(await answerQuestion(parsed.data))
  } catch (err) {
    console.error(JSON.stringify({ event: 'ask', name: err instanceof Error ? err.name : 'Error' }))
    return res.status(500).json({ kind: 'error', message: ASK_ERROR_MESSAGE })
  }
})

router.post('/llm/chat', async (req, res) => {
  const parsed = chatRequestSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: formatChatIssues(parsed.error) })
  try {
    if (parsed.data.stream) {
      await forwardChatStream(parsed.data, res)
      return
    }
    const content = await chat(parsed.data)
    return res.json({ content })
  } catch (err) {
    if (res.headersSent) return
    if (err instanceof LlmHttpError) return res.status(err.status).json({ error: err.message })
    const aborted = typeof err === 'object' && err !== null && 'name' in err && err.name === 'AbortError'
    return res.status(aborted ? 504 : 502).json({ error: aborted ? 'LLM request timed out' : 'LLM request failed' })
  }
})

module.exports = router
