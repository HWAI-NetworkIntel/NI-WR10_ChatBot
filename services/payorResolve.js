'use strict'

/**
 * Check the payor a question names before anything answers it.
 *
 *   "where does MJHS rank in Houston county?"  -> MJHS is not a ranked payor: ask, with options.
 *   "where does UHC rank in Houston county?"   -> UnitedHealth Group, Inc., even if the chat
 *                                                 remembered a different payor.
 *   "where do we rank?"                        -> no named payor: the dashboard payor applies.
 *
 * Without this, a remembered payor answered questions about a different payor.
 */

const path = require('node:path')
const fs = require('node:fs')
const { loadRankData, parseCsv } = require('./rankingsStore')
const { typoDistance } = require('../utils/text')
const { findCounty } = require('./countyResolve')

/** Common names and abbreviations for ranked parent organizations. */
const ALIASES = {
  uhc: 'UnitedHealth Group, Inc.',
  united: 'UnitedHealth Group, Inc.',
  unitedhealthcare: 'UnitedHealth Group, Inc.',
  aarp: 'UnitedHealth Group, Inc.',
  bcbs: 'Health Care Service Corporation',
  bcbstx: 'Health Care Service Corporation',
  bluecross: 'Health Care Service Corporation',
  bluecrossblueshield: 'Health Care Service Corporation',
  hcsc: 'Health Care Service Corporation',
  aetna: 'CVS Health Corporation',
  cvs: 'CVS Health Corporation',
  wellcare: 'Centene Corporation',
  anthem: 'Elevance Health, Inc.',
  wellpoint: 'Elevance Health, Inc.',
  amerigroup: 'Elevance Health, Inc.',
  bsw: 'Baylor Scott & White Health',
  baylor: 'Baylor Scott & White Health',
  baylorscottwhite: 'Baylor Scott & White Health',
  memorialhermann: 'Memorial Hermann Health System',
  christus: 'CHRISTUS Health',
  devoted: 'Devoted Health, Inc.',
  clover: 'Clover Health Holdings, Inc.',
  scan: 'SCAN Group',
  alignment: 'Alignment Healthcare USA, LLC',
}

/** Words that mean "our payor" or are not a payor at all. */
const NOT_A_PAYOR = new Set(['we', 'our', 'us', 'my', 'i', 'it', 'they', 'their', 'them', 'you', 'your', 'this', 'that',
  'the', 'a', 'network', 'networks', 'payor', 'payer', 'payors', 'payers', 'plan', 'plans', 'company', 'overall', 'current',
  'best', 'worst', 'top', 'hmo', 'ppo', 'county', 'texas', 'tx', 'rank', 'ranking', 'rankings', 'position', 'here', 'there',
  'latest', 'new', 'updated', 'final', 'published', 'expected', 'projected', 'predicted', 'future', 'old', 'previous', 'baseline', 'scenario'])

const PATTERNS = [
  /\bwhere (?:does|do|is|are|did) (.+?) (?:rank|ranked|stand|land|place)\b/i,
  /\bhow (?:does|do|is|are) (.+?) (?:rank|ranked|ranking|stand|doing)\b/i,
  /\bwhat(?:'s| is| are| was) (?:the )?(.+?)(?:'s|s')? (?:current )?(?:rank|ranking|rankings|position|standing)\b/i,
  /\b(?:rank|ranking|rankings|position|standing) (?:of|for) (.+?)(?= in\b| across\b| statewide\b|[?.!,]|$)/i,
  // "MJHS ranking in dallas county", "show MJHS rank": at the start, at most 3 words.
  /^(?:(?:show|give|get|tell)\s+(?:me\s+)?)?([a-z][\w&.'-]*(?:\s+[a-z][\w&.'-]*){0,2})\s+(?:rank|ranking|rankings|position)\b/i,
]

/** Ordinary words: a phrase containing any of these is part of a sentence, not a payor name. */
const SENTENCE_WORDS = new Set(['how', 'can', 'could', 'should', 'would', 'what', 'which', 'who', 'why', 'when', 'where', 'is', 'are',
  'do', 'does', 'did', 'improve', 'increase', 'raise', 'make', 'get', 'show', 'give', 'tell', 'me', 'please', 'and', 'or', 'in', 'of',
  'for', 'to', 'with', 'all', 'every', 'each', 'both', 'next', 'new', 'same', 'that', 'those', 'these', 'plan', 'type', 'types'])

function compact(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '')
}

function stem(name) {
  let key = compact(name)
  let previous = ''
  while (key && key !== previous) {
    previous = key
    key = key.replace(/(incorporated|corporation|healthcare|company|holdings?|group|health|corp|inc|llc|co)$/, '')
  }
  return key.length >= 4 ? key : ''
}

/** The payor phrase in "where does X rank", or '' when the question names none. */
function namedPayorPhrase(message, counties = new Set()) {
  const text = String(message || '').trim()
  for (const pattern of PATTERNS) {
    const match = text.match(pattern)
    if (!match) continue
    const phrase = match[1]
      .replace(/^(?:the|a)\s+/i, '')
      .replace(/(?:'s|s')$/i, '')
      .replace(/\s+(?:hmo|ppo|network|networks|plans?)$/i, '')
      .trim()
    const words = phrase.toLowerCase().split(/\s+/).filter(Boolean)
    if (!words.length || words.length > 6) continue
    // Numbers ("top 5") and filler words are never a payor name; ordinary sentence words mean we matched too much.
    const bare = (word) => word.replace(/[^a-z]/g, '')
    if (words.every((word) => !bare(word) || NOT_A_PAYOR.has(bare(word)))) continue
    if (words.some((word) => SENTENCE_WORDS.has(bare(word)))) continue
    if (words.some((word) => ['we', 'our', 'us', 'my'].includes(word))) continue
    if (counties.has(compact(phrase.replace(/\s+county$/i, '')))) continue
    return phrase
  }
  return ''
}

/**
 * Every payor a phrase could mean. One entry is a match; several mean the user must choose
 * ("hospital district" fits three county hospital districts); none means the name is unknown.
 */
function payorCandidates(phrase, payors) {
  const key = compact(phrase)
  if (!key) return []
  const alias = ALIASES[key]
  if (alias && payors.includes(alias)) return [alias]
  const whole = payors.filter((payor) => compact(payor) === key)
  if (whole.length) return whole
  const partial = payors.filter((payor) => {
    const full = compact(payor)
    const short = stem(payor)
    return (full.includes(key) && key.length >= 4) || (short && (key.includes(short) || (short.includes(key) && key.length >= 4)))
  })
  if (partial.length) return partial
  // Spelling mistakes: payors within 1 edit (2 for long names) of their stem or first word; the closest win.
  const scored = payors.map((payor) => {
    const targets = [stem(payor), compact(String(payor).split(/[s,]+/)[0])].filter((value) => value.length >= 5)
    const distances = targets.map((target) => typoDistance(key, target)).filter((d, i) => d <= (targets[i].length >= 9 ? 2 : 1))
    return { payor, distance: distances.length ? Math.min(...distances) : Infinity }
  }).filter((item) => Number.isFinite(item.distance))
  if (!scored.length) return []
  const best = Math.min(...scored.map((item) => item.distance))
  return scored.filter((item) => item.distance === best).map((item) => item.payor)
}

/** The ranked payor a phrase means, or '' when nothing fits or several payors fit. */
function resolvePayorPhrase(phrase, payors) {
  const found = payorCandidates(phrase, payors)
  return found.length === 1 ? found[0] : ''
}

let cached = null
function defaultRankings() {
  if (!cached) cached = loadRankData(path.join(__dirname, '..', 'data')).rankings
  return cached
}

function countyIn(message, rankings) {
  return findCounty(message, [...new Set(rankings.map((row) => row.county))])
}

/** Payors ranked in the county, best rank first; statewide, the most widely ranked first. */
function payorOptions(rankings, county) {
  if (county) {
    const rows = rankings.filter((row) => row.county === county).sort((a, b) => (a.publishedRank ?? 99) - (b.publishedRank ?? 99))
    return [...new Set(rows.map((row) => row.payor))]
  }
  const counts = new Map()
  for (const row of rankings) counts.set(row.payor, (counts.get(row.payor) || 0) + 1)
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([payor]) => payor).slice(0, 12)
}

let cachedPayors = null
/** Every parent organization in the provider extract (data/payors.csv), ranked or not. */
function defaultKnownPayors() {
  if (cachedPayors) return cachedPayors
  const file = path.join(__dirname, '..', 'data', 'payors.csv')
  cachedPayors = fs.existsSync(file)
    ? parseCsv(fs.readFileSync(file, 'utf8')).slice(1).map((cells) => String(cells[0] || '').trim()).filter(Boolean)
    : []
  return cachedPayors
}

/**
 * Check a payor phrase from the question ("MJHS", "UHC", "cenetne", "verda").
 * { payor } for a ranked payor; { unknown, reply } for a name that is not ranked; null for no phrase.
 */
function checkPayorPhrase(phrase, message, deps = {}) {
  const value = String(phrase || '').trim()
  if (!value) return null
  const rankings = (deps.rankings || defaultRankings)()
  if (!rankings.length) return null
  const ranked = [...new Set(rankings.map((row) => row.payor))]
  const known = [...new Set([...ranked, ...(deps.knownPayors || defaultKnownPayors)()])]
  const candidates = payorCandidates(value, known)
  const payor = candidates.length === 1 ? candidates[0] : ''
  if (payor && ranked.includes(payor)) return { payor }
  const county = countyIn(message, rankings)
  const where = county ? ` ranked in ${county} County` : ''
  // Several ranked payors fit the name: list them instead of saying none was found.
  const rankedCandidates = candidates.filter((name) => ranked.includes(name))
  if (rankedCandidates.length > 1) {
    const answer = `"${value}" matches more than one payor: ${rankedCandidates.join('; ')}. Which one did you mean?`
    return {
      unknown: value,
      ambiguous: rankedCandidates,
      reply: { kind: 'clarify', answer, message: answer, content: answer, suggestions: rankedCandidates, suggestionField: 'payor' },
    }
  }
  const answer = payor
    ? `${payor} is in the provider data but has no published network ranking in Texas. Choose a payor${where}, or type the payor name.`
    : `I couldn't find a payor called "${value}" in the Texas rankings. Choose a payor${where}, or type the payor name.`
  return {
    unknown: value,
    reply: { kind: 'clarify', answer, message: answer, content: answer, suggestions: payorOptions(rankings, county), suggestionField: 'payor' },
  }
}

/**
 * The payor the question's wording names, checked. null when the wording names none
 * (then the planner's reading is checked, and otherwise the dashboard payor applies).
 */
function checkNamedPayor(message, deps = {}) {
  const rankings = (deps.rankings || defaultRankings)()
  if (!rankings.length) return null
  const counties = new Set(rankings.map((row) => compact(row.county)))
  return checkPayorPhrase(namedPayorPhrase(message, counties), message, deps)
}

/** The request body scoped to the named payor, keeping plan types it is ranked for. */
function scopeToPayor(body, payor, deps = {}) {
  const rankings = (deps.rankings || defaultRankings)()
  const ranked = [...new Set(rankings.filter((row) => row.payor === payor).map((row) => row.planType))]
  const asked = [...new Set((body?.payorsCrossPlanTypes || []).map((pair) => String(pair.planType || '').toUpperCase()))]
  const keep = ranked.filter((type) => asked.some((value) => value.startsWith(type.toUpperCase()) || value.endsWith(type.toUpperCase())))
  const types = keep.length ? keep : ranked
  return { ...body, payors: [payor], payorsCrossPlanTypes: types.map((planType) => ({ payor, planType })) }
}

/** When a request arrives with no payor at all: ask, with options, instead of showing a validation error. */
function askForPayor(message, deps = {}) {
  const rankings = (deps.rankings || defaultRankings)()
  const county = countyIn(message, rankings)
  const answer = `Which payor should I use${county ? ` for ${county} County` : ''}? Choose one below, or type the payor name.`
  return { kind: 'clarify', answer, message: answer, content: answer, suggestions: payorOptions(rankings, county), suggestionField: 'payor' }
}

module.exports = { checkNamedPayor, checkPayorPhrase, scopeToPayor, namedPayorPhrase, resolvePayorPhrase, payorCandidates, askForPayor, countyIn, defaultKnownPayors, ALIASES }
