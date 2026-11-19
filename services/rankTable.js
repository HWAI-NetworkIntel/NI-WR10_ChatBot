'use strict'

/**
 * Build a table of any shape from the published rankings (data/rankings.csv).
 * The planner LLM only chooses the shape (columns, filters, pivot, sort, limit).
 * Every value in the table comes from the CSV, never from the model.
 */

const path = require('node:path')
const { loadRankData } = require('./rankingsStore')

const MAX_ROWS = 500
const MAX_PIVOT_COLUMNS = 40
const MARKDOWN_ROWS = 100

function round(value) {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : value
}

/** Columns the table can show. Labels are what the user sees. */
const FIELDS = {
  county: { label: 'County', get: (row) => row.county },
  fips: { label: 'FIPS', get: (row) => row.fips },
  payor: { label: 'Payor', get: (row) => row.payor },
  planType: { label: 'Plan type', get: (row) => row.planType },
  network: { label: 'Network', get: (row) => row.network },
  metric: { label: 'Metric', get: (row) => row.metric },
  value: { label: 'Network score', get: (row) => round(row.value) },
  rank: { label: 'Rank', get: (row) => row.rank },
  payorsRanked: { label: 'Ranked networks', get: (row) => row.payorsRanked },
  asOf: { label: 'As of', get: (row) => row.asOf },
}

const NUMERIC = new Set(['value', 'rank', 'payorsRanked'])
const DEFAULT_COLUMNS = ['county', 'payor', 'planType', 'rank', 'payorsRanked', 'value']
const PIVOT_VALUES = ['rank', 'value', 'payorsRanked', 'network']

const ALIASES = {
  county: 'county', countyname: 'county', geography: 'county',
  fips: 'fips', countyfips: 'fips',
  payor: 'payor', payer: 'payor', parentorganization: 'payor', carrier: 'payor',
  plantype: 'planType', plan: 'planType', product: 'planType',
  network: 'network', networkname: 'network',
  metric: 'metric',
  value: 'value', score: 'value', networkscore: 'value',
  rank: 'rank', ranking: 'rank', position: 'rank',
  payorsranked: 'payorsRanked', payersranked: 'payorsRanked', competitors: 'payorsRanked', outof: 'payorsRanked', totalpayors: 'payorsRanked',
  asof: 'asOf', date: 'asOf', year: 'asOf',
}

function fieldName(value) {
  const key = String(value ?? '').toLowerCase().replace(/[^a-z]+/g, '')
  return ALIASES[key] || ''
}

function textList(value) {
  const list = Array.isArray(value) ? value : (value == null || value === '' ? [] : [value])
  return [...new Set(list.map((item) => String(item ?? '').trim()).filter(Boolean))].slice(0, 300)
}

function numberOrNull(value) {
  if (value == null || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

/** Keep only what the engine understands. Anything unknown is dropped, never trusted. */
function normalizeTableSpec(raw) {
  const spec = raw && typeof raw === 'object' ? raw : {}
  const columns = [...new Set((Array.isArray(spec.columns) ? spec.columns : []).map(fieldName).filter(Boolean))]
  const filters = spec.filters && typeof spec.filters === 'object' ? spec.filters : {}
  const pivotRaw = spec.pivot && typeof spec.pivot === 'object' ? spec.pivot : null
  let pivot = null
  if (pivotRaw) {
    const rows = fieldName(pivotRaw.rows)
    const across = fieldName(pivotRaw.columns)
    const value = fieldName(pivotRaw.value) || 'rank'
    if (rows && across && rows !== across && PIVOT_VALUES.includes(value)) pivot = { rows, columns: across, value }
  }
  const sort = (Array.isArray(spec.sort) ? spec.sort : [])
    .map((item) => ({ field: fieldName(item?.field), dir: String(item?.dir || '').toLowerCase() === 'desc' ? 'desc' : 'asc' }))
    .filter((item) => item.field)
  const limit = numberOrNull(spec.limit)
  return {
    columns: columns.length ? columns : [...DEFAULT_COLUMNS],
    filters: {
      county: textList(filters.county).map((name) => name.replace(/\s+county$/i, '').replace(/,?\s*(texas|tx)$/i, '').trim()),
      // "Molina Healthcare, Inc. × HMO" -> "Molina Healthcare, Inc."
      payor: textList(filters.payor).map((name) => name.split(/\s+[×x]\s+/)[0].trim()).filter(Boolean),
      planType: textList(filters.planType || filters.plantype),
      rankMax: numberOrNull(filters.rankMax),
      rankMin: numberOrNull(filters.rankMin),
    },
    scope: String(spec.scope || '').toLowerCase() === 'all' ? 'all' : 'dashboard',
    pivot,
    sort,
    limit: limit && limit > 0 ? Math.min(Math.floor(limit), MAX_ROWS) : null,
  }
}

function compact(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '')
}

/** "Humana" matches "Humana Inc."; "UnitedHealthcare" matches "UnitedHealth Group, Inc.". */
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

function samePlanType(wanted, actual) {
  const a = compact(wanted)
  const b = compact(actual)
  if (!a || !b) return false
  if (a === b) return true
  // Rankings carry HMO and PPO. HMO-POS counts as HMO, Local / Regional PPO count as PPO.
  if (b === 'hmo') return a.startsWith('hmo')
  if (b === 'ppo') return a.endsWith('ppo')
  return false
}

function sameCounty(wanted, actual) {
  return compact(wanted) === compact(actual)
}

/** Add rank (published, or computed from the score) and how many payors share that county and plan type. */
function enrich(rankings) {
  const groups = new Map()
  for (const row of rankings) {
    // Published ranks are county-wide: HMO and PPO networks compete in one list (Stage2_dynamic RANK_SCOPE).
    const key = `${compact(row.county)}|${compact(row.metric)}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(row)
  }
  const out = []
  for (const rows of groups.values()) {
    for (const row of rows) {
      const computed = 1 + rows.filter((other) => other.value > row.value).length
      out.push({ ...row, rank: row.publishedRank ?? computed, payorsRanked: rows.length })
    }
  }
  return out
}

function compare(a, b) {
  if (a == null && b == null) return 0
  if (a == null) return 1
  if (b == null) return -1
  if (typeof a === 'number' && typeof b === 'number') return a - b
  return String(a).localeCompare(String(b), undefined, { numeric: true })
}

function sortBy(list, sort, read) {
  return [...list].sort((left, right) => {
    for (const { field, dir } of sort) {
      const diff = compare(read(left, field), read(right, field))
      if (diff) return dir === 'desc' ? -diff : diff
    }
    return 0
  })
}

function scopeRows(rows, spec, context) {
  const pairs = Array.isArray(context?.payorsCrossPlanTypes) ? context.payorsCrossPlanTypes : []
  const { county, payor, planType, rankMax, rankMin } = spec.filters
  return rows.filter((row) => {
    if (county.length && !county.some((name) => sameCounty(name, row.county))) return false
    if (payor.length && !payor.some((name) => samePayor(name, row.payor))) return false
    if (planType.length && !planType.some((name) => samePlanType(name, row.planType))) return false
    if (rankMax != null && !(row.rank <= rankMax)) return false
    if (rankMin != null && !(row.rank >= rankMin)) return false
    // "Our" rankings: the dashboard payor × plan type pairs, unless the user named payors or plan types.
    if (spec.scope === 'dashboard' && pairs.length && !payor.length) {
      const ok = pairs.some((pair) => samePayor(pair.payor, row.payor) && (planType.length || samePlanType(pair.planType, row.planType)))
      if (!ok) return false
    }
    return true
  })
}

function flatTable(rows, spec) {
  const sort = spec.sort.length ? spec.sort : [
    { field: 'county', dir: 'asc' },
    { field: 'planType', dir: 'asc' },
    { field: 'rank', dir: 'asc' },
  ]
  const sorted = sortBy(rows, sort, (row, field) => FIELDS[field].get(row))
  const limit = spec.limit || MAX_ROWS
  return {
    columns: spec.columns.map((field) => FIELDS[field].label),
    rows: sorted.slice(0, limit).map((row) => spec.columns.map((field) => FIELDS[field].get(row) ?? null)),
    rowLimitHit: sorted.length > limit,
    total: sorted.length,
    notes: [],
  }
}

/** One field down the side, one across the top, a value in each cell. */
function pivotTable(rows, spec) {
  const { rows: down, columns: across, value } = spec.pivot
  const identity = ['county', 'payor', 'planType'].filter((field) => field !== down && field !== across)
  const extra = identity.filter((field) => new Set(rows.map((row) => FIELDS[field].get(row))).size > 1)
  const headerOf = (row) => {
    const base = String(FIELDS[across].get(row) ?? '')
    return extra.length ? `${base} (${extra.map((field) => FIELDS[field].get(row)).join(', ')})` : base
  }
  const counts = new Map()
  for (const row of rows) counts.set(headerOf(row), (counts.get(headerOf(row)) || 0) + 1)
  let headers = [...counts.keys()]
  const notes = []
  if (headers.length > MAX_PIVOT_COLUMNS) {
    headers = headers.sort((a, b) => counts.get(b) - counts.get(a)).slice(0, MAX_PIVOT_COLUMNS)
    notes.push(`Only the ${MAX_PIVOT_COLUMNS} most common ${FIELDS[across].label.toLowerCase()} columns are shown.`)
  }
  headers.sort((a, b) => compare(a, b))
  const keep = new Set(headers)
  const byRow = new Map()
  for (const row of rows) {
    const header = headerOf(row)
    if (!keep.has(header)) continue
    const key = FIELDS[down].get(row)
    if (!byRow.has(key)) byRow.set(key, new Map())
    const cells = byRow.get(key)
    const cell = FIELDS[value].get(row)
    const current = cells.get(header)
    // Two rows in one cell only happens for duplicate CSV rows: keep the better rank / higher score.
    if (current == null || (value === 'rank' ? cell < current : cell > current)) cells.set(header, cell)
  }
  const sortDir = spec.sort.find((item) => item.field === down)?.dir || 'asc'
  const keys = [...byRow.keys()].sort((a, b) => (sortDir === 'desc' ? -compare(a, b) : compare(a, b)))
  const limit = spec.limit || MAX_ROWS
  notes.push(`Cells show ${FIELDS[value].label.toLowerCase()}. A blank cell means no published ranking.`)
  return {
    columns: [FIELDS[down].label, ...headers],
    rows: keys.slice(0, limit).map((key) => [key, ...headers.map((header) => byRow.get(key).get(header) ?? null)]),
    rowLimitHit: keys.length > limit,
    total: keys.length,
    notes,
  }
}

function describeScope(spec, context) {
  const parts = []
  const { county, payor, planType, rankMax, rankMin } = spec.filters
  if (payor.length) parts.push(payor.join(', '))
  else if (spec.scope === 'dashboard' && context?.payorsCrossPlanTypes?.length) {
    const pairs = context.payorsCrossPlanTypes
    parts.push(pairs.length <= 3
      ? pairs.map((pair) => `${pair.payor} (${pair.planType})`).join(', ')
      : `${pairs.length} dashboard payor × plan type pairs`)
  } else parts.push('all payors')
  if (planType.length) parts.push(planType.join('/'))
  parts.push(county.length ? `${county.join(', ')} County` : 'every Texas county')
  if (rankMax != null) parts.push(`rank ${rankMax} or better`)
  if (rankMin != null) parts.push(`rank ${rankMin} or worse`)
  return parts.join(', ')
}

function cellText(value) {
  return value == null ? '' : String(value).replace(/\|/g, '\\|').replace(/\n/g, ' ')
}

function markdownTable(columns, rows, max = MARKDOWN_ROWS) {
  const lines = [`| ${columns.map(cellText).join(' | ')} |`, `| ${columns.map(() => '---').join(' | ')} |`]
  for (const row of rows.slice(0, max)) lines.push(`| ${row.map(cellText).join(' | ')} |`)
  if (rows.length > max) lines.push(`\n_Showing ${max} of ${rows.length} rows._`)
  return lines.join('\n')
}

function defaultData() {
  return loadRankData(path.join(__dirname, '..', 'data'))
}

/**
 * Returns the same shape as a text-to-SQL "data" answer so the UI can render it the same way.
 * `markdown` is the table as text for chat endpoints that only render `answer`.
 */
function buildRankTable(rawSpec, context = {}, deps = {}) {
  const spec = normalizeTableSpec(rawSpec)
  const data = (deps.loadData || defaultData)()
  const references = [{ table: 'data/rankings.csv', description: 'Published payor × plan type rankings by Texas county' }]
  if (!data.rankings.length) {
    return { kind: 'needs_data', answer: 'Rankings are not loaded. Add data/rankings.csv.', columns: [], rows: [], references }
  }
  const enriched = enrich(data.rankings)
  const matched = scopeRows(enriched, spec, context)
  const scope = describeScope(spec, context)
  const metrics = [...new Set(matched.map((row) => row.metric))]
  const asOf = [...new Set(matched.map((row) => row.asOf).filter(Boolean))]
  if (!matched.length) {
    const planTypes = [...new Set(enriched.map((row) => row.planType))].sort().join(', ')
    return {
      kind: 'data',
      answer: `No published rankings matched ${scope}. Rankings are loaded for plan types ${planTypes}.`,
      explanation: `Looked up published rankings for ${scope}.`,
      assumptions: [],
      columns: [],
      rows: [],
      rowLimitHit: false,
      sql: '',
      references,
      spec,
    }
  }
  const table = spec.pivot ? pivotTable(matched, spec) : flatTable(matched, spec)
  const assumptions = [
    `Source: published rankings${metrics.length ? ` (${metrics.join(', ')})` : ''}${asOf.length ? `, as of ${asOf.join(', ')}` : ''}.`,
    'Rank 1 is the strongest network in the county. HMO and PPO networks are ranked together in one list.',
    ...table.notes,
  ]
  if (spec.scope === 'dashboard' && !spec.filters.payor.length) assumptions.push('Limited to the dashboard payors. Ask for "all payors" to include competitors.')
  const shown = table.rows.length
  const answer = `Published rankings for ${scope}: ${shown} row${shown === 1 ? '' : 's'}${table.rowLimitHit ? ` (cut off at ${shown} of ${table.total})` : ''}.`
  return {
    kind: 'data',
    answer,
    markdown: markdownTable(table.columns, table.rows),
    explanation: `Built from the published Texas rankings for ${scope}.`,
    assumptions,
    columns: table.columns,
    rows: table.rows,
    rowLimitHit: table.rowLimitHit,
    sql: '',
    references,
    spec,
  }
}

module.exports = {
  FIELDS,
  DEFAULT_COLUMNS,
  normalizeTableSpec,
  buildRankTable,
  markdownTable,
}
