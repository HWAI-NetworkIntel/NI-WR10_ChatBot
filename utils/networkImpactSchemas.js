const { z } = require('zod')

const predictionRequestSchema = z.record(z.string(), z.unknown())

module.exports = { predictionRequestSchema }
