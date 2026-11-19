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

/**
 * What vague words mean in this assistant. The planner reads these so "the bad payors" or "how are we
 * doing on quality" become a concrete table or measure instead of a guess, and the answer says what it assumed.
 */
const VAGUE_TERMS = [
  'Vague words, and what they mean here:',
  '- "best", "strongest", "leading", "top", "winning": rank 1 is best, so sort rank ascending.',
  '- "worst", "weakest", "bad", "bottom", "losing", "lagging": sort rank descending.',
  '- "top" or "bottom" with no number: 5 rows.',
  '- "better than" / "ahead of": a lower rank number. "behind" / "below": a higher rank number.',
  `- "quality": the quality measures (${TERMS.pcpQuality}, ${TERMS.physicianGroupQuality}, ${TERMS.hospitalQuality}).`,
  `- "size", "breadth", "coverage": provider counts (${TERMS.pcpBreadth}, ${TERMS.physicianGroupBreadth}).`,
  '- "recently", "latest", "current", "now", "this year": the latest published rankings. Only one as-of year is loaded.',
  '- "doing", "performing", "standing" with no measure: the published rank.',
  '- "here", "there", "that county": the county from the conversation state.',
]

module.exports = { TERMS, GLOSSARY, VAGUE_TERMS }
