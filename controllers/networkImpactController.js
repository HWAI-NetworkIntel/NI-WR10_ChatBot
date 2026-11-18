const { predictionRequestSchema } = require('../utils/networkImpactSchemas')
const { AppError } = require('../utils/AppError')
const networkImpactService = require('../services/networkImpactService')

function health(_req, res) {
  return res.status(200).json({ status: 'ok' })
}

async function predict(req, res, next) {
  const parsed = predictionRequestSchema.safeParse(req.body)
  if (!parsed.success) {
    const message = parsed.error.issues.map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`).join('; ')
    return next(new AppError(400, 'INVALID_REQUEST', message))
  }

  try {
    const result = await networkImpactService.predictNetworkImpact(parsed.data)
    return res.status(200).json(result)
  } catch (err) {
    return next(err)
  }
}

module.exports = { health, predict }
