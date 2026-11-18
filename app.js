/** HTTP application for live NI database questions. */
const cors = require('cors')
const express = require('express')
const rateLimit = require('express-rate-limit')
const helmet = require('helmet')
const { config } = require('./config/config')
const routes = require('./routes')

const app = express()

app.use(helmet())
app.use(cors({
  origin(origin, callback) {
    if (!origin || origin === config.ALLOWED_ORIGIN) return callback(null, true)
    return callback(null, false)
  },
}))
app.use((req, res, next) => {
  const started = Date.now()
  const path = req.originalUrl.split('?')[0] ?? req.path
  res.on('finish', () => console.log(JSON.stringify({ method: req.method, path, status: res.statusCode, ms: Date.now() - started })))
  next()
})
app.use(express.json({ limit: '100kb' }))
app.use(['/ask', '/llm'], rateLimit({
  windowMs: 60_000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests' },
}))
app.use(routes)
app.use((err, _req, res, next) => {
  if (res.headersSent) return next(err)
  const status = typeof err === 'object' && err !== null && 'status' in err && typeof err.status === 'number' ? err.status : 500
  const code = status >= 400 && status < 600 ? status : 500
  const error = code === 413 ? 'Payload too large' : code === 500 ? 'Internal error' : 'Bad request'
  return res.status(code).json({ error })
})

module.exports = app
