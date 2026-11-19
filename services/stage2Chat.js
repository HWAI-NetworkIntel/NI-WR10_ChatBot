const { understandQuestion } = require('./questionIntent')
const { answerHcaRemoval, explainRankMove, latestRankingsAnswer, liveRemoval } = require('./scenarioRanks')
const { defaultKnownPayors, resolvePayorPhrase } = require('./payorResolve')
const { findCounty } = require('./countyResolve')
const { scenarioIssue } = require('./stage2Params')
const { formatStage2Answer, lookupsReady, runStage2 } = require('./stage2Runner')

/**
 * The model classifies the question, then:
 * a current rank or a payor comparison is read from the Python script,
 * removing HCA Healthcare for UnitedHealthcare is answered from the scored scenario file,
 * any other removal is recomputed by that script,
 * an addition or a "how close" question stays on the roster rank model.
 * Returns null, or { change } / { message }, when the roster model should answer.
 */
async function answerFromStage2(input, deps = {}) {
  const message = String(input?.message || input?.question || '').trim()
  if (!message) return null
  const understood = await (deps.understandQuestion || understandQuestion)(input, deps)
  const ready = (deps.lookupsReady || lookupsReady)()
  const run = deps.runStage2 || runStage2

  // A removal is recomputed live. The scored HCA file is only a fallback when the lookups are missing.
  const removal = ready ? liveRemoval(message, understood, input) : null
  if (removal) {
    try {
      const result = await run(removal)
      if (!result.ok) return { kind: 'error', answer: result.error || "I couldn't recompute that rank.", scenario: removal }
      return latestRankingsAnswer(removal, result)
    } catch (err) {
      return { kind: 'error', answer: err instanceof Error ? err.message : "I couldn't recompute that rank.", scenario: removal }
    }
  }
  if (!ready) {
    const published = answerHcaRemoval(message, understood?.scenario, input)
    if (published) return published
  }
  if (!understood || understood.action === 'other' || understood.action === 'sensitivity') return null

  if (understood.action === 'add') return namedChange('add', understood)
  if (understood.action === 'compare_ranks' && !understood.comparePayor) return null

  if (understood.action === 'remove' && !understood.scenario.healthSystem && !understood.scenario.physicianGroup) {
    return null
  }

  // Current ranks and payor comparisons are read from the local published data (rankings / network ratings),
  // never from the rank script. The script only recomputes removals.
  if (!ready || understood.action !== 'remove') {
    if (understood.action === 'remove') return namedChange('remove', understood)
    if (understood.action === 'compare_ranks' && understood.comparePayor) {
      return { message: `How do we rank against ${understood.comparePayor}?` }
    }
    return null
  }

  if (understood.clarify) return { kind: 'clarify', answer: understood.clarify, scenario: understood.scenario }
  const issue = scenarioIssue(understood.action === 'remove' ? understood.scenario : { ...understood.scenario, healthSystem: '', physicianGroup: '', healthSystemIncrease: null, physicianGroupIncrease: null })
  if (issue) return { kind: 'clarify', answer: issue, scenario: understood.scenario }

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

const WHY = /\b(why|how come|what caused|cause[sd]?|reason|explain)\b/i
const MOVED = /\b(drop\w*|fall\w*|fell|declin\w*|lower\w*|down|worse\w*|slip\w*|lost|los(?:e|ing)|chang\w*|mov\w*|rise|rose|risen|improv\w*|went|go(?:es)?|jump\w*|climb\w*)\b/i
const REMOVAL_HINT = /\b(remov\w*|drop\w*|terminat\w*|without|losing|lose|exit\w*|leav\w*)\b/i

/** "Why did United's ranking drop?" is about a rank move, not about improving the published rank. */
function asksWhyRankMoved(message) {
  return WHY.test(message) && MOVED.test(message)
}

/** Earlier user turns, newest first, from whichever history field the endpoint received. */
function earlierQuestions(input, message) {
  const turns = []
  for (const field of ['messages', 'history']) {
    if (!Array.isArray(input?.[field])) continue
    for (const turn of input[field]) if (turn?.role === 'user') turns.push(String(turn.content || ''))
  }
  if (!turns.length && input?.earlier) turns.push(...String(input.earlier).split('\n'))
  const list = turns.map((text) => text.trim()).filter(Boolean)
  if (list.at(-1) === message) list.pop()
  return list.reverse()
}

function payorNamedIn(message) {
  const known = defaultKnownPayors()
  const lower = String(message || '').toLowerCase()
  const full = known.filter((name) => lower.includes(name.toLowerCase().replace(/[,.]?\s*(inc|llc|corporation)\.?$/i, '')))
  if (full.length) return full.sort((a, b) => b.length - a.length)[0]
  // "Harris County" is a place, not the payor Harris County Hospital District.
  const text = String(message || '')
    .replace(/['’]s\b/g, '')
    .replace(/\b(?:[A-Za-z]+\s+){0,2}[A-Za-z]+\s+county\b/gi, ' ')
  const words = text.split(/[^\w&.-]+/).filter((word) => word.length >= 3 && !/^(why|what|how|did|does|the|and|texas|hmo|ppo|rank\w*)$/i.test(word))
  for (let size = Math.min(3, words.length); size >= 1; size -= 1) {
    for (let at = 0; at + size <= words.length; at += 1) {
      const found = resolvePayorPhrase(words.slice(at, at + size).join(' '), known)
      if (found) return found
    }
  }
  return ''
}

/**
 * "Why did United's ranking drop in Brazoria?" right after a removal what-if: rerun that same what-if
 * (cached) and explain the move. Null when the question is not a why-follow-up or no earlier removal exists.
 */
async function explainWhatIf(input, deps = {}) {
  const message = String(input?.message || input?.question || '').trim()
  if (!asksWhyRankMoved(message)) return null
  if (!(deps.lookupsReady || lookupsReady)()) return null
  const understand = deps.understandQuestion || understandQuestion
  let removal = null
  for (const earlier of earlierQuestions(input, message).slice(0, 6)) {
    if (!REMOVAL_HINT.test(earlier) && !/\bhca\b/i.test(earlier)) continue
    const understood = await understand({ ...input, message: earlier, question: earlier }, deps)
    removal = liveRemoval(earlier, understood, input)
    if (removal) break
  }
  if (!removal) return null
  const run = deps.runStage2 || runStage2
  try {
    const result = await run(removal)
    if (!result.ok) return { kind: 'error', answer: result.error || "I couldn't recompute that rank.", scenario: removal }
    return explainRankMove(removal, result, {
      payor: payorNamedIn(message) || removal.payor,
      county: findCounty(message) || '',
    })
  } catch (err) {
    return { kind: 'error', answer: err instanceof Error ? err.message : "I couldn't recompute that rank.", scenario: removal }
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

module.exports = { answerFromStage2, explainWhatIf, asksWhyRankMoved }
