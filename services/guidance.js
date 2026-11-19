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

// Abuse and insults. Kept to clear cases so network questions are never caught.
const ABUSE = /\b(f+u+c+k+\w*|fck\w*|f\*+k\w*|motherf\w+|shit\w*|bullshit|bitch\w*|bastard\w*|asshole\w*|dickhead|cunt\w*|wtf|stfu|piss off|screw you|shut up|go to hell|you suck|useless (?:bot|tool|assistant)|stupid (?:bot|tool|assistant)|idiot\w*|moron\w*|dumbass)\b/i

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
  if (ABUSE.test(value)) return 'abuse'
  if (INJECTION.test(value)) return 'injection'
  // "drop the rank column" edits the answer table, not the database.
  if (TABLE_EDIT.test(value) && !/\b(database|db|schema|sql)\b/i.test(value)) return ''
  if (WRITE.test(value) || refusesWrite(value)) return 'write'
  return ''
}

/** The reply for a blocked question. `answer`, `message`, and `content` all carry the text for every endpoint. */
function guardrailReply(reason) {
  const lead = {
    abuse: "Let's keep it professional.",
    injection: "I can't set aside how I work.",
  }[reason] || "I can't change network data. This assistant is read-only."
  const close = reason === 'abuse'
    ? 'Try one of the questions below, or open the PNC dashboard for provider-level detail.'
    : 'Try one of the questions below, or open a dashboard for provider-level detail.'
  const answer = `${lead} ${SCOPE} ${close}`
  return {
    kind: 'refused',
    reason,
    answer,
    message: answer,
    content: answer,
    suggestions: EXAMPLES,
    suggestionField: 'question',
    links: pncFirstLinks(),
  }
}

const GUIDED_KINDS = new Set(['cannot_answer', 'error', 'needs_data'])

const OUT_OF_SCOPE = 'That detail is outside what this assistant can answer. It covers network rankings, provider counts by county, and what to improve to raise your rank. For provider and hospital level detail, open the PNC dashboard.'

/** Dashboards for detail the assistant does not hold, PNC first. */
function pncFirstLinks() {
  const links = dashboardLinks()
  return [...links.filter((link) => /^PNC/.test(link.label)), ...links.filter((link) => !/^PNC/.test(link.label))]
}

/** A data question with no rows, or one the SQL step could not answer: a general reply, not "no matching data". */
function isOutOfScope(result) {
  if (result.kind === 'cannot_answer') return true
  return result.kind === 'data' && Array.isArray(result.rows) && result.rows.length === 0 && !result.tables?.length
}

/** Add dashboard links to answers that could not be completed. */
function withGuidance(result) {
  if (!result || typeof result !== 'object') return result
  if (isOutOfScope(result)) {
    // Query details are dropped too: there is nothing useful to show in the notes.
    return { kind: 'out_of_scope', answer: OUT_OF_SCOPE, message: OUT_OF_SCOPE, content: OUT_OF_SCOPE, links: pncFirstLinks() }
  }
  if (!GUIDED_KINDS.has(result.kind) || result.links) return result
  return { ...result, links: dashboardLinks() }
}

module.exports = { guardrailReason, guardrailReply, withGuidance, dashboardLinks, EXAMPLES, OUT_OF_SCOPE }
