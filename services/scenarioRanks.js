'use strict'

/**
 * Latest rankings after a health system or physician group is removed from a payor's networks.
 * Live: algo/Stage2_dynamic.py recomputes the ranks (liveRemoval + latestRankingsAnswer).
 * Fallback when the rank lookups are not available: HCA Healthcare removed from UnitedHealth Group, Inc.
 * is read from data/scenario_hca_united.csv.
 * Rank before is always the current rank from data/network_ratings.csv.
 */

const fs = require('node:fs')
const path = require('node:path')
const { loadRankData, parseRankings } = require('./rankingsStore')
const { finders } = require('./stage2Params')
const { loadRatings } = require('./rankImprove')
const { TERMS } = require('./terminology')

const SCENARIO_FILE = path.join(__dirname, '..', 'data', 'scenario_hca_united.csv')
const DATA_DIR = path.join(__dirname, '..', 'data')
const PAYOR = 'UnitedHealth Group, Inc.'
const HEALTH_SYSTEM = 'HCA Healthcare'
const SCORED_COUNTY = 'Harris'

let scenarioRows = null
let baselineRows = null

function compact(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '')
}

function isHca(name) {
  const key = compact(name)
  return key === 'hca' || key === 'hcahealthcare' || key === 'hcahealth' || key === 'hospitalcorporationofamerica'
}

function isUnited(name) {
  const key = compact(name)
  if (!key) return false
  if (key === 'uhc') return true
  return key.includes('unitedhealth')
}

function messageNamesUnited(message) {
  return /\bunited\s*health|\bunitedhealthcare\b|\buhc\b/i.test(message)
}

function sameCounty(left, right) {
  return compact(left) === compact(right)
}

function samePlan(wanted, actual) {
  const left = compact(wanted)
  const right = compact(actual)
  if (!left || !right) return false
  if (left === right) return true
  if (right === 'hmo') return left.startsWith('hmo')
  if (right === 'ppo') return left.endsWith('ppo')
  return false
}

function roundScore(value) {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : null
}

function scenarioTable() {
  if (scenarioRows) return scenarioRows
  if (!fs.existsSync(SCENARIO_FILE)) {
    scenarioRows = []
    return scenarioRows
  }
  scenarioRows = parseRankings(fs.readFileSync(SCENARIO_FILE, 'utf8'))
  return scenarioRows
}

function publishedTable() {
  if (!baselineRows) baselineRows = loadRankData(DATA_DIR).rankings
  return baselineRows
}

function unitedPayor(scenario, message, input) {
  if (messageNamesUnited(message)) return PAYOR
  if (isUnited(scenario?.payor)) return PAYOR
  if (scenario?.payor) return ''
  const listed = Array.isArray(input?.payors) ? input.payors.map((payor) => String(payor)) : []
  if (listed.length === 1 && isUnited(listed[0])) return PAYOR
  return ''
}

function messageRemovesHca(text) {
  return /\b(remov\w*|drop(?:ping|ped)?|terminat\w*|without|losing|lose|exit)\b[\s\S]{0,48}\bhca\b/i.test(text)
    || /\bhca\b[\s\S]{0,60}\b(terminat\w*|drops?|dropped|leaves|exits|remov\w*)\b/i.test(text)
}

/** True when the question is the scored HCA removal for UnitedHealthcare. */
function asksHcaRemoval(message, scenario) {
  if (scenario?.physicianGroup) return false
  if (scenario?.healthSystem && !isHca(scenario.healthSystem)) return false
  const text = String(message || '')
  if (/\bhow many\b|\bcount of\b|\blist of\b/i.test(text) && !/\brank/i.test(text)) return false
  const named = isHca(scenario?.healthSystem) || /\bhca\b/i.test(text)
  if (!named) return false
  if (messageRemovesHca(text)) return true
  return scenario?.healthSystemIncrease === false && isHca(scenario?.healthSystem)
}

/** Current rank: the rank in data/network_ratings.csv (the published dashboard rank). */
function beforeRank(row) {
  const found = loadRatings().find((item) =>
    sameCounty(item.county, row.county) && item.payor === row.payor && samePlan(row.planType, item.planType))
  return found?.rank ?? null
}

function movement(row) {
  const label = `${row.payor} ${row.planType}`
  if (row.rankBefore == null) return `${label} is rank ${row.rank}.`
  if (row.rankBefore === row.rank) return `${label} stays at rank ${row.rank}.`
  return `${label} moves from rank ${row.rankBefore} to rank ${row.rank}.`
}

function cell(value) {
  return value == null ? '' : String(value).replace(/\|/g, '\\|')
}

function namedCounty(message) {
  const found = String(message || '').match(/\b((?:[A-Za-z]+\s+){0,2}[A-Za-z]+)\s+county\b/i)
  if (!found) return ''
  const stop = new Set(['in', 'for', 'within', 'of', 'the', 'and', 'our', 'to', 'a'])
  const words = found[1].split(/\s+/)
  const lastStop = words.reduce((at, word, index) => (stop.has(word.toLowerCase()) ? index : at), -1)
  return (lastStop >= 0 ? words.slice(lastStop + 1) : words).join(' ')
}

function countyInFile(name) {
  if (!name) return ''
  const found = scenarioTable().find((row) => sameCounty(row.county, name))
  return found ? found.county : ''
}

/** Prefer the county written before the word "county", then a county the intent already resolved. */
function countyName(message, scenario) {
  return countyInFile(namedCounty(message)) || countyInFile(scenario?.county) || SCORED_COUNTY
}

function filledScenario(scenario, county) {
  return {
    payor: PAYOR,
    plantype: scenario?.plantype || '',
    planId: scenario?.planId || '',
    healthSystem: HEALTH_SYSTEM,
    physicianGroup: '',
    healthSystemIncrease: false,
    physicianGroupIncrease: null,
    county,
  }
}

function rankedRows(scenario, county) {
  const planType = scenario?.plantype || ''
  return scenarioTable()
    .filter((row) => sameCounty(row.county, county) && (!planType || samePlan(planType, row.planType)))
    .map((row) => ({
      state: row.state || 'TX',
      county: row.county,
      payor: row.payor,
      planType: row.planType,
      network: row.network,
      value: roundScore(row.value),
      rank: row.publishedRank,
      rankBefore: beforeRank(row),
    }))
    .filter((row) => row.rank != null)
    .sort((a, b) => a.rank - b.rank || a.planType.localeCompare(b.planType) || a.payor.localeCompare(b.payor))
}

/**
 * Chat answer for "what if HCA Healthcare is removed / terminated" for UnitedHealthcare.
 * Returns null when the question is a different change, so the live rank path can answer it.
 */
function answerHcaRemoval(message, scenario, input) {
  if (!asksHcaRemoval(message, scenario)) return null
  if (!unitedPayor(scenario, message, input)) return null
  if (!scenarioTable().length) return null

  const county = countyName(message, scenario)
  // A dashboard plan type is not a request to hide the other plan type. Filter only when the question names one.
  const asked = { ...scenario, plantype: finders.findPlanType(message) }
  const rows = rankedRows(asked, county)
  const scope = filledScenario(asked, county)
  if (!rows.length) {
    return {
      kind: 'needs_data',
      answer: `The latest rankings after removing ${HEALTH_SYSTEM} have no ${scope.plantype ? `${scope.plantype} ` : ''}rows for ${county} County.`,
      scenario: scope,
    }
  }

  const united = rows.filter((row) => row.payor === PAYOR)
  const askedCounty = Boolean(namedCounty(message) || String(scenario?.county || '').trim())
  const lead = askedCounty
    ? `Removing ${HEALTH_SYSTEM} for ${PAYOR}. Latest rankings in ${county} County after that termination.`
    : `Removing ${HEALTH_SYSTEM} for ${PAYOR} in ${county} County. These are the latest rankings after that termination.`
  const moves = united.map(movement).join(' ')
  // Ranks only: the network score orders the table but is not shown to users.
  const table = [
    '| Payor | Plan type | Rank before | New rank |',
    '| --- | --- | --- | --- |',
    ...rows.map((row) => `| ${[row.payor, row.planType, row.rankBefore ?? '', row.rank].map(cell).join(' | ')} |`),
  ]
  const countyNote = askedCounty && !sameCounty(county, SCORED_COUNTY)
    ? `\n\nThe network change was scored for ${SCORED_COUNTY} County. This table is the latest ranking for ${county} County after that change.`
    : ''
  return {
    kind: 'prediction',
    answer: `${lead}${moves ? ` ${moves}` : ''}${countyNote}\n\n${table.join('\n')}\n\nSource: latest rankings after ${HEALTH_SYSTEM} is removed from ${PAYOR}.`,
    scenario: scope,
    rankColumn: 'rank_payor_plantype',
    // The UI can render `rows` as a table, so the score is left out here too.
    rows: rows.map(({ value: _score, ...row }) => row),
  }
}

function publishedCounty(name) {
  const text = String(name || '').trim().replace(/\s+county$/i, '')
  if (!text) return ''
  const found = publishedTable().find((row) => sameCounty(row.county, text))
  return found ? found.county : ''
}

function planTypeIn(message) {
  const named = finders.findPlanType(message)
  if (!named) return ''
  return /ppo/i.test(named) ? 'PPO' : 'HMO'
}

/**
 * The removal to recompute with the rank script, or null when the question is not a removal.
 * "Remove HCA" with no payor named uses UnitedHealthcare when the question or dashboard names it.
 * A dashboard plan type is not a request to hide the other plan type: only a plan type in the question scopes the drop.
 */
function liveRemoval(message, understood, input) {
  const scenario = understood?.scenario || {}
  const hca = asksHcaRemoval(message, scenario)
  if (!hca && understood?.action !== 'remove') return null
  const healthSystem = hca ? HEALTH_SYSTEM : String(scenario.healthSystem || '').trim()
  const physicianGroup = hca ? '' : String(scenario.physicianGroup || '').trim()
  if (!healthSystem && !physicianGroup) return null
  const payor = (hca && unitedPayor(scenario, message, input)) || String(scenario.payor || '').trim()
  const planId = String(scenario.planId || '').trim()
  if (!payor && !planId) return null
  return {
    payor,
    plantype: payor ? planTypeIn(message) : '',
    planId,
    healthSystem,
    physicianGroup,
    healthSystemIncrease: healthSystem ? false : null,
    physicianGroupIncrease: physicianGroup ? false : null,
    county: publishedCounty(namedCounty(message)) || publishedCounty(scenario.county),
  }
}

function biggestMove(rows, payor) {
  const byCounty = new Map()
  for (const row of rows) {
    if (row.payor !== payor || row.rankBefore == null) continue
    const move = Math.abs(row.rank - row.rankBefore)
    byCounty.set(row.county, Math.max(byCounty.get(row.county) || 0, move))
  }
  let best = ''
  let size = -1
  for (const [county, move] of byCounty) {
    if (move > size) {
      best = county
      size = move
    }
  }
  return best
}

function listCounties(names) {
  if (names.length < 2) return names.join('')
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

/** Chat answer from a live rank script run: the latest county rankings after the removal. */
function latestRankingsAnswer(scenario, result) {
  const removed = [scenario.healthSystem, scenario.physicianGroup].filter(Boolean).join(' and ')
  const scope = [scenario.payor || scenario.planId, scenario.plantype].filter(Boolean).join(' ')
  const affected = Array.isArray(result.affectedCounties) ? result.affectedCounties : []
  // New rank: the rank script. Rank before: the current rank in network_ratings.csv, as everywhere else in the chat.
  const all = (Array.isArray(result.countyRanks) ? result.countyRanks : []).map((row) => {
    const modelBefore = row.rankBefore == null ? null : Number(row.rankBefore)
    return {
      state: 'TX',
      county: row.county,
      payor: row.payor,
      planType: row.planType,
      rankBefore: beforeRank(row) ?? modelBefore,
      rank: Number(row.rank),
    }
  })
  const county = scenario.county || biggestMove(all, scenario.payor) || affected[0] || ''
  const filled = { ...scenario, county }

  if (!county) {
    return {
      kind: 'prediction',
      answer: `Removing ${removed} from ${scope} does not change any ranking. ${removed} is not in those networks in the ranked counties.`,
      scenario: filled,
      rankColumn: 'rank_payor_plantype',
      rows: [],
    }
  }

  const rows = all
    .filter((row) => sameCounty(row.county, county))
    .filter((row) => !scenario.plantype || row.planType === scenario.plantype)
    .sort((a, b) => a.rank - b.rank || a.planType.localeCompare(b.planType) || a.payor.localeCompare(b.payor))
  const changed = affected.some((name) => sameCounty(name, county))
  const lead = changed
    ? `Removing ${removed} from ${scope}${scope.endsWith('.') ? '' : '.'} Latest rankings in ${county} County after that change.`
    : `Removing ${removed} from ${scope} does not move any rank in ${county} County.`
  const moves = rows.filter((row) => row.payor === scenario.payor).map(movement).join(' ')
  const others = affected.filter((name) => !sameCounty(name, county))
  const otherNote = others.length
    ? `\n\nRankings also change in ${listCounties(others)} ${others.length === 1 ? 'County' : 'counties'}. Name a county to see its rankings.`
    : ''
  const table = rows.length
    ? `\n\n${[
      '| Payor | Plan type | Rank before | New rank |',
      '| --- | --- | --- | --- |',
      ...rows.map((row) => `| ${[row.payor, row.planType, row.rankBefore ?? '', row.rank].map(cell).join(' | ')} |`),
    ].join('\n')}`
    : ''
  return {
    kind: 'prediction',
    answer: `${lead}${changed && moves ? ` ${moves}` : ''}${table}${otherNote}\n\nSource: recomputed by the rank model from the current network data.`,
    scenario: filled,
    rankColumn: 'rank_payor_plantype',
    rows,
    affectedCounties: affected,
  }
}

// Measures from the rank script's countyMeasures, in the order and names users see.
const EXPLAIN_MEASURES = [
  { key: 'highQualityHospitals', label: TERMS.hospitalQuality, kind: 'count' },
  { key: 'hospitalQualityPct', label: 'Hospital quality score', kind: 'pct' },
  { key: 'hospitals', label: 'Hospitals in network', kind: 'count' },
  { key: 'pcps', label: TERMS.pcpBreadth, kind: 'count' },
  { key: 'specialists', label: TERMS.physicianGroupBreadth, kind: 'count' },
  { key: 'pcpQualityPct', label: TERMS.pcpQuality, kind: 'pct' },
  { key: 'specialistQualityPct', label: TERMS.physicianGroupQuality, kind: 'pct' },
  { key: 'starRating', label: TERMS.starRating, kind: 'stars' },
]

function measureText(measure, value) {
  if (value == null || !Number.isFinite(value)) return ''
  if (measure.kind === 'pct') return `${value.toFixed(1)}%`
  if (measure.kind === 'stars') return value.toFixed(2)
  return Number.isInteger(Math.round(value * 10) / 10) ? String(Math.round(value)) : value.toFixed(1)
}

function measureChanged(measure, before, after) {
  if (!Number.isFinite(before) || !Number.isFinite(after)) return false
  return Math.abs(after - before) >= (measure.kind === 'pct' ? 0.05 : 0.05)
}

function rankWords(row) {
  if (row.rankBefore == null) return `is rank ${row.rank}`
  if (row.rankBefore === row.rank) return `stays at rank ${row.rank}`
  return `${row.rank > row.rankBefore ? 'falls' : 'rises'} from rank ${row.rankBefore} to rank ${row.rank}`
}

/**
 * "Why did United's rank drop in Brazoria?" after a removal what-if: the rank move from that same run,
 * the measures that changed in the payor's network, and the payors that moved ahead of it.
 */
function explainRankMove(scenario, result, { payor, county } = {}) {
  const removed = [scenario.healthSystem, scenario.physicianGroup].filter(Boolean).join(' and ')
  const latest = latestRankingsAnswer({ ...scenario, county: county || scenario.county }, result)
  const place = latest.scenario.county
  const who = payor || scenario.payor
  const what = `In the what-if where ${removed} is removed from ${scenario.payor || scenario.planId}`
  if (!place) return { ...latest, answer: `${what}, no ranking changes. ${removed} is not in those networks in the ranked counties.` }

  const mine = latest.rows.filter((row) => row.payor === who)
  if (!mine.length) {
    return { ...latest, answer: `${what}, ${who} has no ranked network in ${place} County.` }
  }
  const moves = mine.map((row) => `${row.planType} ${rankWords(row)}`).join(', and ')
  const lead = `${what}, ${who} ${moves} in ${place} County.`

  if (who !== scenario.payor) {
    const theirs = latest.rows.filter((row) => row.payor === scenario.payor).map((row) => `${row.planType} ${rankWords(row)}`).join(', and ')
    return {
      ...latest,
      kind: 'prediction',
      answer: `${lead} ${who}'s own network does not change in this what-if. Its rank moves only because ${scenario.payor} ${theirs || 'changes rank'} after losing ${removed}.`,
    }
  }

  const measures = (Array.isArray(result.countyMeasures) ? result.countyMeasures : [])
    .filter((row) => sameCounty(row.county, place) && row.payor === who)
    .filter((row) => !scenario.plantype || row.planType === scenario.plantype)
  const tables = measures.map((row) => {
    const changed = EXPLAIN_MEASURES.filter((measure) => measureChanged(measure, row.before?.[measure.key], row.after?.[measure.key]))
    return {
      title: `What changed in ${who} (${row.planType}) in ${place} County`,
      columns: ['Measure', `Before removing ${removed}`, 'After', 'Change'],
      rows: changed.map((measure) => {
        const before = row.before[measure.key]
        const after = row.after[measure.key]
        const diff = after - before
        const sign = diff > 0 ? '+' : '−'
        const delta = measure.kind === 'pct' ? `${sign}${Math.abs(diff).toFixed(1)} pts` : `${sign}${measureText(measure, Math.abs(diff))}`
        return [measure.label, measureText(measure, before), measureText(measure, after), delta]
      }),
    }
  }).filter((table) => table.rows.length)

  const myRanks = new Map(mine.map((row) => [row.planType, row]))
  const passed = latest.rows.filter((row) => row.payor !== who && row.rankBefore != null && [...myRanks.values()].some((me) =>
    me.rankBefore != null && row.rankBefore > me.rankBefore && row.rank < me.rank))
  const passedText = passed.length
    ? ` ${passed.map((row) => `${row.payor} (${row.planType})`).join(', ')} moved ahead of it.`
    : ''
  const why = tables.length
    ? ` Removing ${removed} changes these measures in its ${place} County network, which lowers its standing against the other networks.`
    : ` Its own measures in ${place} County barely change, so the move comes from how the other networks now compare.`
  const unchanged = tables.length ? ' Measures not listed are unchanged.' : ''
  return {
    kind: 'prediction',
    answer: `${lead}${why}${passedText}${unchanged}`,
    scenario: latest.scenario,
    rankColumn: latest.rankColumn,
    tables,
    affectedCounties: latest.affectedCounties,
  }
}

/** Same rows for the predict API. Null when this scenario file does not apply. */
function scenarioResult(scenario) {
  if (!scenario || scenario.physicianGroup || scenario.healthSystemIncrease !== false) return null
  if (!isHca(scenario.healthSystem) || !isUnited(scenario.payor)) return null
  if (!scenarioTable().length) return null
  const county = String(scenario?.county || '').trim() || SCORED_COUNTY
  const rows = rankedRows(scenario, county)
  return {
    ok: true,
    rankColumn: 'rank_payor_plantype',
    scenario: filledScenario(scenario, county),
    rows,
  }
}

module.exports = {
  answerHcaRemoval,
  scenarioResult,
  liveRemoval,
  latestRankingsAnswer,
  explainRankMove,
  PAYOR,
  HEALTH_SYSTEM,
  SCORED_COUNTY,
}
