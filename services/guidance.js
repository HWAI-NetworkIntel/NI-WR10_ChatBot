'use strict'

/**
 * Guardrails and "where to go next" guidance.
 *
 * - Write requests and attempts to override the assistant's rules get one focused reply:
 *   what the assistant does, questions it can answer, and dashboards with more detail.
 * - Answers that could not be completed carry the same dashboard links.
 *
 * Dashboard URLs come from .env (NPI_SEARCH_URL, PNC_DASHBOARD_URL). A link without a URL
 * is still returned so the user at least learns which dashboard to open.
 */

const { refusesWrite } = require('./rankService')

const INJECTION = /\b(ignore|disregard|forget|bypass|override)\b.{0,30}\b(rules?|instructions?|guardrails?|restrictions?|prompt|polic(?:y|ies))\b|\b(system prompt|developer mode|jailbreak|pretend (?:you are|to be)|act as (?:an? )?(?:admin|dba|developer))\b/i
const WRITE = /\b(update|delete|insert|modify|edit|alter|truncate|drop|overwrite|change|write to)\b.{0,40}\b(tables?|records?|rows?|database|db|columns?|schema|network data)\b|\b(delete\s+from|insert\s+into|drop\s+table|alter\s+table|truncate\s+table|update\s+\w+\s+set)\b/i

const TABLE_EDIT = /\b(add|remove|drop|hide|include|show)\b(?:\s+\S+){0,6}\s+columns?\b/i

const SCOPE ='I answer read-only questions about Texas Medicare Advantage provider networks: payor rankings by county, provider and hospital counts, specialties, and what-if network changes.'

const EXAMPLES = [
  'Where do we rank in Harris County?',
  'How many cardiologists does Humana have in Dallas County?',
  'Show our rank in every county as a table',
  'What if we remove Baylor Scott & White?',
]

function dashboardLinks() {
  return [
    {
      label: 'NPI Search dashboard',
      url: String(process.env.NPI_SEARCH_URL || '').trim(),
      description: 'Look up a provider by NPI, name, specialty, or location.',
    },
    {
      label: 'PNC dashboard',
      url: String(process.env.PNC_DASHBOARD_URL || '').trim(),
      description: 'Compare provider network composition across payors.',
    },
  ]
}

/** 'injection', 'write', or '' when the question is fine. */
function guardrailReason(text) {
  const value = String(text || '')
  if (INJECTION.test(value)) return 'injection'
  // "drop the rank column" edits the answer table, not the database.
  if (TABLE_EDIT.test(value) && !/\b(database|db|schema|sql)\b/i.test(value)) return ''
  if (WRITE.test(value) || refusesWrite(value)) return 'write'
  return ''
}

/** The reply for a blocked question. `answer`, `message`, and `content` all carry the text for every endpoint. */
function guardrailReply(reason) {
  const lead = reason === 'injection'
    ? "I can't set aside how I work."
    : "I can't change network data. This assistant is read-only."
  const answer = `${lead} ${SCOPE} Try one of the questions below, or open a dashboard for provider-level detail.`
  return {
    kind: 'refused',
    reason,
    answer,
    message: answer,
    content: answer,
    suggestions: EXAMPLES,
    suggestionField: 'question',
    links: dashboardLinks(),
  }
}

const GUIDED_KINDS = new Set(['cannot_answer', 'error', 'needs_data'])

/** Add dashboard links to answers that could not be completed. */
function withGuidance(result) {
  if (!result || typeof result !== 'object' || !GUIDED_KINDS.has(result.kind) || result.links) return result
  return { ...result, links: dashboardLinks() }
}

module.exports = { guardrailReason, guardrailReply, withGuidance, dashboardLinks, EXAMPLES }
