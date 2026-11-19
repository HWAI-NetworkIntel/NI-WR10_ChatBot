const { AppError } = require('../utils/AppError')
const { scenarioResult } = require('./scenarioRanks')
const { scenarioFromBody, scenarioIssue } = require('./stage2Params')
const { lookupsReady, runStage2 } = require('./stage2Runner')

async function predictNetworkImpact(input) {
  const scenario = scenarioFromBody(input)
  const issue = scenarioIssue(scenario)
  if (issue) throw new AppError(400, 'INVALID_SCOPE', issue)
  // The scored HCA file is only a fallback when the rank lookups are missing.
  if (!lookupsReady()) {
    const published = scenarioResult(scenario)
    if (published) return published
  }
  let result
  try {
    result = await runStage2(scenario)
  } catch (err) {
    throw new AppError(502, 'ALGORITHM_FAILED', err instanceof Error ? err.message : 'The rank script failed.')
  }
  if (!result?.ok && result?.missing) {
    throw new AppError(501, 'ALGORITHM_NOT_CONFIGURED', 'The rank lookup files are not available.')
  }
  if (!result?.ok) throw new AppError(422, 'SCENARIO_REJECTED', result?.error || 'The rank script rejected that scenario.')
  return result
}

module.exports = { predictNetworkImpact }
