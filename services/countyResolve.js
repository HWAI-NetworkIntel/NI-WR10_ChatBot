'use strict'

/**
 * Find the Texas county a user means, forgiving the way people actually type it:
 *
 *   "Harris County", "harris", "in Harris"          -> Harris
 *   "hariss county", "in Tarant"                     -> Harris, Tarrant   (spelling mistakes)
 *   "Ft Bend", "ft. bend county"                     -> Fort Bend         (abbreviations)
 *   "in San Antonio", "Fort Worth", "Corpus Christi" -> Bexar, Tarrant, Nueces (major cities)
 *
 * A city that is also a county name ("Houston", "Austin", "Dallas") stays that county.
 */

const path = require('node:path')
const { compact, typoDistance, typoAllowance } = require('../utils/text')

/** Major Texas cities whose county has a different name. */
const CITY_COUNTY = {
  sanantonio: 'Bexar',
  fortworth: 'Tarrant',
  arlington: 'Tarrant',
  corpuschristi: 'Nueces',
  plano: 'Collin',
  frisco: 'Collin',
  mckinney: 'Collin',
  irving: 'Dallas',
  garland: 'Dallas',
  mcallen: 'Hidalgo',
  edinburg: 'Hidalgo',
  brownsville: 'Cameron',
  laredo: 'Webb',
  killeen: 'Bell',
  waco: 'McLennan',
  amarillo: 'Potter',
  sugarland: 'Fort Bend',
  thewoodlands: 'Montgomery',
  conroe: 'Montgomery',
  roundrock: 'Williamson',
  georgetown: 'Williamson',
  pasadena: 'Harris',
  pearland: 'Brazoria',
  beaumont: 'Jefferson',
  odessa: 'Ector',
  midland: 'Midland',
  abilene: 'Taylor',
  tyler: 'Smith',
  longview: 'Gregg',
  sanmarcos: 'Hays',
  newbraunfels: 'Comal',
  collegestation: 'Brazos',
  bryan: 'Brazos',
  wichitafalls: 'Wichita',
}

/** Short forms people type: "Ft Bend" is Fort Bend. */
function expand(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/\bft\.?(?=\s)/g, 'fort')
    .replace(/\bmt\.?(?=\s)/g, 'mount')
    .replace(/\bst\.?(?=\s)/g, 'saint')
}

function clean(name) {
  return expand(name)
    .replace(/\bcounty\b/g, ' ')
    .replace(/,?\s*\b(texas|tx)\b/g, ' ')
    .replace(/[^a-z .'-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

let cachedCounties = null
function defaultCounties() {
  if (!cachedCounties) {
    const { loadRankData } = require('./rankingsStore')
    cachedCounties = [...new Set(loadRankData(path.join(__dirname, '..', 'data')).rankings.map((row) => row.county).filter(Boolean))]
  }
  return cachedCounties
}

function index(counties) {
  const byKey = new Map()
  for (const name of counties || []) {
    const key = compact(name)
    if (key && !byKey.has(key)) byKey.set(key, name)
  }
  return byKey
}

/**
 * The county a short name means, or '' when nothing fits.
 * options.maxTypos caps the typos allowed (0 = exact names and city aliases only), for loose text where a
 * looser match could misfire ("in market" must not become Parker).
 */
function canonicalCounty(name, counties = defaultCounties(), options = {}) {
  const key = compact(clean(name))
  if (!key) return ''
  const byKey = index(counties)
  if (byKey.has(key)) return byKey.get(key)
  const city = CITY_COUNTY[key]
  if (city && byKey.has(compact(city))) return byKey.get(compact(city))
  const allowance = Math.min(typoAllowance(key.length), options.maxTypos ?? Infinity)
  if (!allowance) return ''
  let best = []
  let bestDistance = Infinity
  for (const [countyKey, county] of byKey) {
    if (Math.abs(countyKey.length - key.length) > allowance) continue
    const distance = typoDistance(key, countyKey)
    if (distance > Math.min(allowance, typoAllowance(countyKey.length))) continue
    if (distance < bestDistance) {
      best = [county]
      bestDistance = distance
    } else if (distance === bestDistance) best.push(county)
  }
  return best.length === 1 ? best[0] : ''
}

/** Last 1–3 words of a phrase that name a county: "our rank in fort bend" -> Fort Bend. */
function trailingName(phrase, counties, options) {
  const words = clean(phrase).split(' ').filter(Boolean)
  for (let size = Math.min(3, words.length); size >= 1; size -= 1) {
    const found = canonicalCounty(words.slice(-size).join(' '), counties, options)
    if (found) return found
  }
  return ''
}

/** First 1–3 words of a phrase that name a county: "in san antonio for HMO" -> Bexar. */
function leadingName(phrase, counties, options) {
  const words = clean(phrase).split(' ').filter(Boolean)
  for (let size = Math.min(3, words.length); size >= 1; size -= 1) {
    const found = canonicalCounty(words.slice(0, size).join(' '), counties, options)
    if (found) return found
  }
  return ''
}

/**
 * The county a sentence names, or ''. The last county named wins ("not Dallas, Harris county").
 *   1. "<name> county"               typos allowed
 *   2. "in / for / near <name>"      one typo allowed on the name right after the preposition
 *   3. the whole message is a name   "harris", "ft bend", "san antonio"
 */
function findCounty(text, counties = defaultCounties()) {
  const value = expand(text)
  if (!value.trim()) return ''
  const hits = []
  for (const match of value.matchAll(/([a-z][a-z .'-]{0,40}?)\s+county\b(?!\s+(?:hospital|clinic|health|system|group|medical))/g)) {
    const found = trailingName(match[1], counties)
    if (found) hits.push({ at: match.index, county: found })
  }
  for (const match of value.matchAll(/\b(?:in|for|within|near|around|at)\s+([a-z][a-z .'-]{1,40})/g)) {
    const phrase = match[1].split(/\s+(?:county|and|or|for|with|vs|versus|compared|as|by|on|to|if|but)\b|[,?!;]/)[0]
    const found = leadingName(phrase, counties, { maxTypos: 1 })
    if (found) hits.push({ at: match.index, county: found })
  }
  if (!hits.length && clean(value).split(' ').length <= 3) {
    const whole = canonicalCounty(value.replace(/^(?:and|what about|how about|only|just|now)\s+/, ''), counties)
    if (whole) hits.push({ at: 0, county: whole })
  }
  if (!hits.length) return ''
  hits.sort((a, b) => a.at - b.at)
  return hits[hits.length - 1].county
}

module.exports = { canonicalCounty, findCounty, CITY_COUNTY }
