/** Express application for network impact prediction. */
const cors = require('cors')
const express = require('express')
const rateLimit = require('express-rate-limit')
const helmet = require('helmet')
const { config } = require('./config/config')
const routes = require('./routes')
const { predict } = require('./controllers/networkImpactController')
const { AppError } = require('./utils/AppError')
const { errorHandler } = require('./utils/errorHandler')

const app = express()

app.use(helmet())
app.use(cors({
  origin(origin, callback) {
    if (!origin || origin === config.ALLOWED_ORIGIN) return callback(null, true)
    return callback(null, false)
  },
}))
app.use(express.json({ limit: '100kb' }))
app.use('/api', rateLimit({
  windowMs: 60_000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => res.status(429).json({
    error: { code: 'RATE_LIMITED', message: 'Too many requests. Please try again later.' },
  }),
}))
app.post('/api/network-impact/predict', predict)
app.use(routes)
app.use((_req, _res, next) => next(new AppError(404, 'NOT_FOUND', 'Route not found.')))
app.use(errorHandler)

module.exports = app
