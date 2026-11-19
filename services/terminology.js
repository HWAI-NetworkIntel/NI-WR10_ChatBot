'use strict'

/**
 * The names users see for network measures. Every answer path uses these:
 * the improvement engine (rankImprove.js) as row labels, and the LLM prompts
 * (prompts.js) as a glossary so SQL answers and chat use the same words.
 * Change a name here and it changes everywhere.
 */
const TERMS = {
  pcpBreadth: 'Network breadth (PCPs)',
  physicianGroupBreadth: 'Physician groups in network',
  otherBreadth: 'Other providers in network',
  pcpQuality: 'PCP quality score',
  physicianGroupQuality: 'Physician group quality score',
  hospitalQuality: 'High quality Hospitals',
  starRating: 'Star rating',
}

/** Glossary lines for LLM prompts. */
const GLOSSARY = [
  'Use these names for network measures, exactly as written:',
  `- The number of PCPs in a network: "${TERMS.pcpBreadth}".`,
  `- The number of specialists in a network: "${TERMS.physicianGroupBreadth}".`,
  `- The share of PCPs rated High on quality: "${TERMS.pcpQuality}".`,
  `- The share of specialists rated High on quality: "${TERMS.physicianGroupQuality}".`,
  `- Hospitals rated High on quality: "${TERMS.hospitalQuality}".`,
  `- The Modified HWAI rating (out of 5): "${TERMS.starRating}".`,
]

module.exports = { TERMS, GLOSSARY }
