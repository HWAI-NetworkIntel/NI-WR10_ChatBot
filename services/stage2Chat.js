const { understandQuestion } = require('./questionIntent')
const { scenarioIssue } = require('./stage2Params')
const { formatStage2Answer, lookupsReady, runStage2 } = require('./stage2Runner')

/**
 * The model classifies the question, then:
 * a current rank or a payor comparison is read from the Python script,
 * a removal is recomputed by that script,
 * an addition or a "how close" question stays on the roster rank model.
 * Returns null, or { change } / { message }, when the roster model should answer.
 */
async function answerFromStage2(input, deps = {}) {
  const message = String(input?.message || input?.question || '').trim()
  if (!message) return null
  const understood = await (deps.understandQuestion || understandQuestion)(input, deps)
  if (!understood || understood.action === 'other' || understood.action === 'sensitivity') return null

  if (understood.action === 'add') return namedChange('add', understood)
  if (understood.action === 'compare_ranks' && !understood.comparePayor) return null

  if (understood.action === 'remove' && !understood.scenario.healthSystem && !understood.scenario.physicianGroup) {
    return null
  }

  const ready = (deps.lookupsReady || lookupsReady)()
  if (!ready) {
    if (understood.action === 'remove') return namedChange('remove', understood)
    if (understood.action === 'compare_ranks' && understood.comparePayor) {
      return { message: `How do we rank against ${understood.comparePayor}?` }
    }
    return null
  }

  if (understood.clarify) return { kind: 'clarify', answer: understood.clarify, scenario: understood.scenario }
  const issue = scenarioIssue(understood.action === 'remove' ? understood.scenario : { ...understood.scenario, healthSystem: '', physicianGroup: '', healthSystemIncrease: null, physicianGroupIncrease: null })
  if (issue) return { kind: 'clarify', answer: issue, scenario: understood.scenario }

  const run = deps.runStage2 || runStage2
  try {
    if (understood.action === 'compare_ranks' && understood.comparePayor) {
      const left = await run(readScenario(understood.scenario))
      const right = await run(readScenario({ ...understood.scenario, payor: understood.comparePayor }))
      if (!left.ok) return { kind: 'error', answer: left.error || "I couldn't read that rank.", scenario: understood.scenario }
      if (!right.ok) return { kind: 'error', answer: right.error || "I couldn't read that rank.", scenario: understood.scenario }
      return {
        kind: 'comparison',
        answer: `${formatStage2Answer(readScenario(understood.scenario), left)} ${formatStage2Answer(readScenario({ ...understood.scenario, payor: understood.comparePayor }), right)}`,
        scenario: understood.scenario,
        rows: [...(left.rows || []), ...(right.rows || [])],
      }
    }
    const scenario = understood.action === 'remove' ? understood.scenario : readScenario(understood.scenario)
    const result = await run(scenario)
    if (!result.ok) return { kind: 'error', answer: result.error || "I couldn't recompute that rank.", scenario }
    return {
      kind: understood.action === 'remove' ? 'prediction' : 'rank',
      answer: formatStage2Answer(scenario, result),
      scenario: result.scenario || scenario,
      rankColumn: result.rankColumn,
      rows: result.rows,
    }
  } catch (err) {
    return { kind: 'error', answer: err instanceof Error ? err.message : "I couldn't recompute that rank." }
  }
}

function readScenario(scenario) {
  return { ...scenario, healthSystem: '', physicianGroup: '', healthSystemIncrease: null, physicianGroupIncrease: null }
}

function namedChange(action, understood) {
  const name = understood.scenario.healthSystem || understood.scenario.physicianGroup
  if (!name) return null
  return { change: { action, name } }
}

module.exports = { answerFromStage2 }
