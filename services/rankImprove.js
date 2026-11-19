'use strict'

/**
 * "How do we improve our rank?" — compare a payor's network against the payors ranked around it.
 *
 * Source: data/network_ratings.csv (built by scripts/import_ranked_dashboard.js from the
 * provider dashboard extract). One row per county × plan type × payor, taken from the same
 * plan the published rank uses.
 *
 * How the network score is built (algo/Stage2_dynamic.py):
 *   provider counts + share of providers rated High on quality (and PU), blended 70/30 with
 *   the Modified HWAI rating, then scaled 15–85 within each county.
 * So counts, quality-rated providers, and the HWAI rating move the rank. Cost and utilization
 * "High" counts are shown for context only; they are not in the score formula.
 *
 * Every number in the reply comes from the CSV. Nothing is estimated.
 */

const fs = require('node:fs')
const path = require('node:path')
const { parseCsv } = require('./rankingsStore')
const { TERMS } = require('./terminology')

const METRICS = [
  { column: 'pcp_npi_count_without_low_exclude_hosp', label: TERMS.pcpBreadth, drives: true },
  { column: 'spe_npi_count_without_low_exclude_hosp', label: TERMS.physicianGroupBreadth, drives: true },
  { column: 'other_npi_count_without_low_exclude_hosp', label: TERMS.otherBreadth, drives: false },
  { column: 'PCP_Quality Score rating', scoreColumn: 'PCP_Quality Score %', label: TERMS.pcpQuality, drives: true },
  { column: 'Spe_Quality Score rating', scoreColumn: 'Spe_Quality Score %', label: TERMS.physicianGroupQuality, drives: true },
  { column: 'Hosp_Quality Score rating', scoreColumn: 'Hosp_Quality Score %', label: TERMS.hospitalQuality, drives: true },
  { column: 'Modified Hwai Rating', label: TERMS.starRating, drives: true },
  { column: 'PCP_Cost Score rating', label: 'PCPs rated High on cost', drives: false },
  { column: 'PCP_FFS Utilization Score category', label: 'PCPs rated High on FFS utilization', drives: false },
  { column: 'PCP_MA Utilization Score category', label: 'PCPs rated High on MA utilization', drives: false },
  { column: 'Spe_Cost Score rating', label: 'Physician groups rated High on cost', drives: false },
  { column: 'Spe_FFS Utilization Score category', label: 'Physician groups rated High on FFS utilization', drives: false },
  { column: 'Spe_MA Utilization Score category', label: 'Physician groups rated High on MA utilization', drives: false },
  { column: 'Hosp_Cost Score rating', label: 'Health systems rated High on cost', drives: false },
  { column: 'Hosp_FFS Utilization Score category', label: 'Health systems rated High on FFS utilization', drives: false },
  { column: 'Hosp_MA Utilization Score category', label: 'Health systems rated High on MA utilization', drives: false },
]

const METHOD = [
  "Ranks are county-wide: every payor × plan type network in the county (HMO and PPO) is ranked in one list, weighted by enrollment across the payor's plans.",
  "Provider counts and ratings come from the payor's largest plan in the county (highest July 2026 enrollment).",
  'Rated-High counts are the number of distinct providers in the network rated High on that measure.',
  'Only measures that drive the rank are listed: PCPs, physician groups, quality scores, and the star rating (Modified HWAI rating, out of 5).',
  'A quality score is the share of providers in the network rated High on quality. The rank uses this share, so quality rows are compared on it; the count rated High is shown beside it.',
  'Competitor networks are held as published. Closing a gap does not guarantee a rank change, because the rank is relative within the county.',
]

const REFERENCES = [{ table: 'data/network_ratings.csv', description: 'Provider counts and rated-High counts by county, plan type, and payor' }]

function numberOrNull(value) {
  if (value == null || String(value).trim() === '') return null
  const parsed = Number(String(value).replace(/,/g, ''))
  return Number.isFinite(parsed) ? parsed : null
}

function round(value) {
  return value == null ? null : Math.round(value * 100) / 100
}

function compact(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '')
}

function payorStem(name) {
  let key = compact(name)
  let previous = ''
  while (key && key !== previous) {
    previous = key
    key = key.replace(/(incorporated|corporation|healthcare|company|group|health|corp|inc|llc|co)$/, '')
  }
  return key.length >= 4 ? key : compact(name)
}

function samePayor(wanted, actual) {
  const a = compact(wanted)
  const b = compact(actual)
  if (!a || !b) return false
  if (a === b || b.includes(a) || a.includes(b)) return true
  const stem = payorStem(wanted)
  return Boolean(stem) && b.includes(stem)
}

function canonicalPlanType(value) {
  const key = compact(value)
  if (!key) return ''
  if (key.startsWith('hmo')) return 'HMO'
  if (key.endsWith('ppo')) return 'PPO'
  return String(value).trim()
}

let cached = null
function loadRatings(file = path.join(__dirname, '..', 'data', 'network_ratings.csv')) {
  if (cached && cached.file === file) return cached.rows
  if (!fs.existsSync(file)) return []
  const [header, ...body] = parseCsv(fs.readFileSync(file, 'utf8'))
  const at = Object.fromEntries(header.map((name, index) => [name, index]))
  const rows = body.map((cells) => ({
    county: cells[at.county],
    fips: cells[at.fips],
    payor: cells[at.payor],
    planType: canonicalPlanType(cells[at.planType]),
    network: cells[at.network],
    networkScore: numberOrNull(cells[at.rankScore] ?? cells[at.networkScore]),
    rank: numberOrNull(cells[at.rank]),
    metrics: Object.fromEntries(METRICS.flatMap((metric) => [metric.column, metric.scoreColumn].filter(Boolean))
      .map((column) => [column, numberOrNull(cells[at[column]])])),
  })).filter((row) => row.county && row.payor && row.rank != null)
  cached = { file, rows }
  return rows
}

function label(row) {
  return `${row.payor} (${row.planType})`
}

function unique(values) {
  return [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b))
}

/** Score-driving metrics where the competitor is ahead, largest relative gap first. */
function drivingGaps(focal, other) {
  return METRICS.filter((metric) => metric.drives)
    .map((metric) => {
      // Quality is judged on the score (% rated High) when both sides have it, else on the count.
      const column = metric.scoreColumn && focal.metrics[metric.scoreColumn] != null && other.metrics[metric.scoreColumn] != null
        ? metric.scoreColumn
        : metric.column
      const mine = focal.metrics[column]
      const theirs = other.metrics[column]
      if (mine == null || theirs == null || theirs <= mine) return null
      return {
        metric,
        byScore: column === metric.scoreColumn,
        mine,
        theirs,
        mineCount: focal.metrics[metric.column],
        theirsCount: other.metrics[metric.column],
        gap: theirs - mine,
        relative: (theirs - mine) / Math.max(Math.abs(theirs), 1),
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.relative - a.relative)
}

/** Payor and plan type from the question, else the dashboard; ask when it is still ambiguous. */
function resolveFocal(request, context, rows) {
  const pairs = Array.isArray(context?.payorsCrossPlanTypes) ? context.payorsCrossPlanTypes : []
  let payor = String(request.payor || '').trim()
  if (payor) {
    const known = rows.find((row) => samePayor(payor, row.payor))
    if (!known) return { clarify: { answer: `${payor} has no published rankings. Choose a ranked payor.`, suggestions: unique(rows.map((row) => row.payor)).slice(0, 40), field: 'payor' } }
    payor = known.payor
  } else {
    const dashboard = unique(pairs.map((pair) => pair.payor))
    if (dashboard.length !== 1) {
      return { clarify: { answer: 'Which payor should I compare against its competitors?', suggestions: dashboard.length ? dashboard : unique(rows.map((row) => row.payor)).slice(0, 40), field: 'payor' } }
    }
    payor = rows.find((row) => samePayor(dashboard[0], row.payor))?.payor || dashboard[0]
  }
  let planType = canonicalPlanType(request.planType)
  if (!planType) {
    const fromDashboard = unique(pairs.filter((pair) => samePayor(pair.payor, payor)).map((pair) => canonicalPlanType(pair.planType)))
    const fromData = unique(rows.filter((row) => samePayor(payor, row.payor)).map((row) => row.planType))
    const choices = fromDashboard.length ? fromDashboard : fromData
    if (choices.length !== 1) return { clarify: { answer: `Which plan type should I use for ${payor}?`, suggestions: choices.length ? choices : fromData, field: 'planType' } }
    planType = choices[0]
  }
  return { payor, planType }
}

function countyComparison(rows, focal, request) {
  const county = rows[0].county
  const ranked = [...rows].sort((a, b) => a.rank - b.rank || a.payor.localeCompare(b.payor))
  const payorsRanked = ranked.length
  let compare = []
  const named = String(request.comparePayor || '').trim()
  if (named) {
    const match = ranked.find((row) => samePayor(named, row.payor) && row.planType === focal.planType && row !== focal)
      || ranked.find((row) => samePayor(named, row.payor) && row !== focal)
    if (match) compare = [match]
  }
  if (!compare.length) {
    // Competitors only: the payor's own network in the other plan type is not a rival.
    const rivals = ranked.filter((row) => !samePayor(focal.payor, row.payor))
    const ahead = rivals.filter((row) => row.rank < focal.rank)
    const nextBetter = ahead.at(-1)
    const leader = rivals[0]
    if (nextBetter) compare = nextBetter === leader ? [leader] : [nextBetter, leader]
    else compare = rivals.slice(0, 1) // we lead: compare with the closest challenger
  }
  if (!compare.length) {
    return { answer: `${label(focal)} is the only ranked network in ${county} County, so there is no one to compare against.` }
  }
  const closest = compare[0]
  const leader = compare[1]
  const lines = [`${label(focal)} is rank ${focal.rank} of ${payorsRanked} in ${county} County.`]
  const tables = []
  if (focal.rank < closest.rank) {
    const gaps = drivingGaps(focal, closest)
    if (gaps.length) tables.push(gapTable(`To keep the lead over ${label(closest)} (rank ${closest.rank}), close the areas where it is ahead`, focal, closest, gaps))
    else lines.push(`It is ahead of ${label(closest)} (rank ${closest.rank}) on every improvable measure.`)
    return { answer: lines.join('\n'), tables }
  }
  const gaps = drivingGaps(focal, closest)
  if (gaps.length) tables.push(gapTable(`What can be improved to pass ${label(closest)} (rank ${closest.rank})`, focal, closest, gaps))
  else lines.push(`${label(closest)} (rank ${closest.rank}) is not ahead on PCPs, physician groups, quality scores, or the star rating. The difference comes from measures outside this comparison.`)
  if (leader) {
    const toLeader = drivingGaps(focal, leader).slice(0, 4)
    if (toLeader.length) tables.push(gapTable(`To reach the leader, ${label(leader)} (rank ${leader.rank})`, focal, leader, toLeader))
  }
  return { answer: lines.join('\n'), tables }
}

function formatNumber(value) {
  return Number.isInteger(value) ? value.toLocaleString('en-US') : String(round(value))
}

const HWAI = 'Modified Hwai Rating'

/** 3.45 -> "★★★½☆ 3.45": nearest half star out of 5, with the exact rating. */
function starRating(value) {
  if (value == null) return ''
  const halves = Math.round(Math.min(Math.max(value, 0), 5) * 2)
  const full = Math.floor(halves / 2)
  const half = halves % 2
  return `${'★'.repeat(full)}${half ? '½' : ''}${'☆'.repeat(5 - full - half)} ${round(value)}`
}

function displayValue(metric, value) {
  return metric.column === HWAI ? starRating(value) : formatNumber(value)
}

/** "63.6% (7 rated High)" for quality rows judged on the score. */
function qualityValue(score, count) {
  const share = `${(Math.round(score * 10) / 10).toFixed(1)}%`
  return count == null ? share : `${share} (${formatNumber(count)} rated High)`
}

function cellValue(item, side) {
  if (item.byScore) return qualityValue(item[side], item[`${side}Count`])
  return displayValue(item.metric, item[side])
}

function neededText(item) {
  if (item.metric.column === HWAI) return `raise by ${round(item.gap)} stars`
  if (item.byScore) return `raise by ${(Math.round(item.gap * 10) / 10).toFixed(1)} pts`
  return `add ${formatNumber(Math.ceil(item.gap))}`
}

/** One table per comparison: our value and the competitor's value side by side. */
function gapTable(title, focal, other, gaps) {
  return {
    title,
    columns: ['Measure', label(focal), label(other), 'Needed'],
    rows: gaps.map((item) => [item.metric.label, cellValue(item, 'mine'), cellValue(item, 'theirs'), neededText(item)]),
  }
}

function statewideSummary(rows, payor, planType) {
  const mine = rows.filter((row) => samePayor(payor, row.payor) && row.planType === planType)
  if (!mine.length) return null
  const byCounty = new Map()
  for (const row of rows) {
    if (!byCounty.has(row.county)) byCounty.set(row.county, [])
    byCounty.get(row.county).push(row)
  }
  const gapCounts = new Map()
  const lines = []
  let leads = 0
  for (const focal of mine) {
    const peers = byCounty.get(focal.county) || []
    const payorsRanked = peers.length
    const nextBetter = peers.filter((row) => row.rank < focal.rank && !samePayor(payor, row.payor)).sort((a, b) => b.rank - a.rank)[0]
    if (!nextBetter) {
      leads += 1
      continue
    }
    const gaps = drivingGaps(focal, nextBetter)
    for (const item of gaps.slice(0, 3)) gapCounts.set(item.metric.label, (gapCounts.get(item.metric.label) || 0) + 1)
    lines.push({
      county: focal.county,
      rank: focal.rank,
      payorsRanked,
      nextBetter: label(nextBetter),
      scoreGap: round((nextBetter.networkScore ?? 0) - (focal.networkScore ?? 0)),
    })
  }
  // Smallest gap to the next network first; the gap itself is not shown.
  lines.sort((a, b) => a.scoreGap - b.scoreGap || a.county.localeCompare(b.county))
  const common = [...gapCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4)
  const parts = [`${payor} (${planType}) is ranked in ${mine.length} Texas counties and is rank 1 in ${leads}.`]
  if (common.length) {
    parts.push(`\nWhat to improve most often to pass the next network:\n${common.map(([name, count]) => `• ${name} (behind in ${count} ${count === 1 ? 'county' : 'counties'})`).join('\n')}`)
  }
  if (lines.length) {
    parts.push(`\nCounties closest to moving up:\n${lines.slice(0, 5).map((line) => `• ${line.county}: rank ${line.rank} of ${line.payorsRanked}, next is ${line.nextBetter}`).join('\n')}`)
  }
  parts.push('\nName a county to see exactly what to improve there.')
  return { answer: parts.join('\n') }
}

/**
 * request: { county?, payor?, planType?, comparePayor? } from the planner.
 * context: the request body (payors, payorsCrossPlanTypes) for "we" / "our".
 */
function improveRank(request = {}, context = {}, deps = {}) {
  const rows = (deps.loadRatings || loadRatings)()
  if (!rows.length) {
    return { kind: 'needs_data', answer: 'Network ratings are not loaded. Run scripts/import_ranked_dashboard.js with the provider dashboard extract to create data/network_ratings.csv.' }
  }
  const focalChoice = resolveFocal(request, context, rows)
  if (focalChoice.clarify) {
    return { kind: 'clarify', answer: focalChoice.clarify.answer, suggestions: focalChoice.clarify.suggestions, suggestionField: focalChoice.clarify.field }
  }
  const { payor, planType } = focalChoice
  const countyName = String(request.county || '').replace(/\s+county$/i, '').replace(/,?\s*(texas|tx)$/i, '').trim()
  const base = { focal: { payor, planType }, assumptions: METHOD, references: REFERENCES, sql: '' }
  if (!countyName) {
    const summary = statewideSummary(rows, payor, planType)
    if (!summary) return { kind: 'needs_data', answer: `${payor} has no published ${planType} rankings in Texas.`, ...base }
    return { kind: 'improvement', ...base, ...summary }
  }
  // Ranks are county-wide: every payor × plan type entry competes in one list (Stage2_dynamic RANK_SCOPE).
  const countyRows = rows.filter((row) => compact(row.county) === compact(countyName))
  if (!countyRows.length) {
    return { kind: 'clarify', answer: `No rankings are published for ${countyName} County. Name another Texas county.`, ...base }
  }
  const focal = countyRows.find((row) => samePayor(payor, row.payor) && row.planType === planType)
  if (!focal) {
    return {
      kind: 'clarify',
      answer: `${payor} has no ${planType} ranking in ${countyRows[0].county} County. Choose a payor ranked there.`,
      suggestions: unique(countyRows.filter((row) => row.planType === planType).map((row) => row.payor)),
      suggestionField: 'payor',
      ...base,
    }
  }
  const comparison = countyComparison(countyRows, focal, request)
  return {
    kind: 'improvement',
    ...base,
    geography: { county: focal.county, state: 'TX' },
    ...comparison,
  }
}

module.exports = { improveRank, loadRatings, METRICS }
