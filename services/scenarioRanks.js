'use strict'

/**
 * Latest rankings for one scored what-if: HCA Healthcare removed from UnitedHealth Group, Inc.
 * Source: data/scenario_hca_united.csv, collapsed from the ranked scenario workbook.
 * Rank before comes from the published rankings in data/rankings.csv.
 */

const fs = require('node:fs')
const path = require('node:path')
const { loadRankData, parseRankings } = require('./rankingsStore')
const { finders } = require('./stage2Params')

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

function beforeRank(row) {
  const found = publishedTable().find((item) =>
    sameCounty(item.county, row.county) && item.payor === row.payor && item.planType === row.planType)
  return found?.publishedRank ?? null
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
  PAYOR,
  HEALTH_SYSTEM,
  SCORED_COUNTY,
}
