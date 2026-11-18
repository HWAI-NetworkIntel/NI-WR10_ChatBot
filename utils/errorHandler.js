const { AppError } = require('./AppError')

function errorHandler(err, _req, res, next) {
  if (res.headersSent) return next(err)
  const knownBodyError = err?.type === 'entity.parse.failed' || err?.type === 'entity.too.large'
  const statusCode = err instanceof AppError ? err.statusCode : err?.type === 'entity.parse.failed' ? 400 : err?.type === 'entity.too.large' ? 413 : 500
  const code = err instanceof AppError ? err.code : err?.type === 'entity.parse.failed' ? 'INVALID_JSON' : err?.type === 'entity.too.large' ? 'PAYLOAD_TOO_LARGE' : 'INTERNAL_SERVER_ERROR'
  const message = err instanceof AppError
    ? err.message
    : err?.type === 'entity.parse.failed'
      ? 'Request body must contain valid JSON.'
      : err?.type === 'entity.too.large'
        ? 'Request body is too large.'
        : 'An unexpected error occurred.'
  if (!knownBodyError && statusCode >= 500) console.error(JSON.stringify({ event: 'request_error', code, name: err?.name || 'Error' }))
  return res.status(statusCode).json({ error: { code, message } })
}

module.exports = { errorHandler }
