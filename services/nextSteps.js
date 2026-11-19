'use strict'

/**
 * Two or three follow-up questions after an answer, as clickable suggestions.
 * They point at what the assistant can do next with the same subject (why, how to improve, what if,
 * where else), so a user who only asked for a number sees the deeper answers that a dashboard cannot give.
 */

const SKIP = new Set(['clarify', 'refused', 'reset', 'error', 'needs_data', 'unavailable', 'out_of_scope', 'cannot_answer'])

/** Suggestions for this answer, or [] when it should carry none. */
function nextSteps(route, result, state = {}) {
  if (!result || SKIP.has(result.kind)) return []
  if (Array.isArray(result.suggestions) && result.suggestions.length) return []
  const county = String(state.county || '').trim()
  const closest = Array.isArray(result.closest) ? result.closest : []
  const moveUp = 'Where are we closest to moving up a rank?'
  let steps = []
  if (route === 'opportunity') {
    steps = [
      ...closest.slice(0, 2).map((name) => `What should we improve in ${name} County?`),
      'Show our rank in every county as a table',
    ]
  } else if (route === 'improve') {
    steps = county
      ? [`Show all payors ranked in ${county} County`, moveUp, 'Show our rank in every county as a table']
      : [...closest.slice(0, 1).map((name) => `How do we improve our rank in ${name} County?`), moveUp, 'Show our rank in every county as a table']
  } else if (route === 'table') {
    steps = county
      ? [`How do we improve our rank in ${county} County?`, `Show all payors ranked in ${county} County`, moveUp]
      : [moveUp, 'Show our top 5 counties by rank', 'How do we improve our rank in Harris County?']
  } else if (route === 'rank' || ['baseline', 'prediction'].includes(result.kind)) {
    steps = county
      ? [`Why are we behind the leader in ${county} County?`, `Show all payors ranked in ${county} County`, moveUp]
      : [moveUp, 'Show our rank in every county as a table']
  }
  return [...new Set(steps)].slice(0, 3)
}

module.exports = { nextSteps }
