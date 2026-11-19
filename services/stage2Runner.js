const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { toArgv } = require('./stage2Params')

const SCRIPT = path.join(__dirname, '..', 'algo', 'Stage2_dynamic.py')
const TIMEOUT_MS = 180000

function lookupsReady() {
  const dir = process.env.NI_LOOKUP_DIR
  if (!dir) return false
  return fs.existsSync(path.join(dir, 'base_ranked.csv')) && fs.existsSync(path.join(dir, 'base_final.csv'))
}

function lastJson(text) {
  const lines = String(text || '').split(/\r?\n/).map((line) => line.trim()).filter((line) => line.startsWith('{'))
  if (!lines.length) return null
  return JSON.parse(lines[lines.length - 1])
}

function pythonCommand() {
  const command = process.env.STAGE2_PYTHON || 'py'
  return command.toLowerCase() === 'py' ? { command, prefix: ['-3'] } : { command, prefix: [] }
}

// One run reloads every lookup file (about 20 s), so successful results are kept until the lookups change.
const CACHE_LIMIT = 50
const cache = new Map()

function lookupStamp() {
  try {
    return String(fs.statSync(path.join(process.env.NI_LOOKUP_DIR || '', 'base_ranked.csv')).mtimeMs)
  } catch {
    return ''
  }
}

/** Run Stage2_dynamic.py and resolve the JSON object it prints. Same scenario and lookups: cached result. */
async function runStage2(scenario) {
  const argv = toArgv(scenario)
  const key = `${lookupStamp()}|${JSON.stringify(argv)}`
  if (cache.has(key)) return cache.get(key)
  const result = await spawnStage2(argv)
  if (result?.ok) {
    if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value)
    cache.set(key, result)
  }
  return result
}

function spawnStage2(argv) {
  const { command, prefix } = pythonCommand()
  const args = [...prefix, SCRIPT, ...argv]
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, env: process.env })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('The rank script timed out.'))
    }, TIMEOUT_MS)
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', () => {
      clearTimeout(timer)
      try {
        const payload = lastJson(stdout)
        if (!payload) {
          const detail = stderr.trim().slice(0, 300)
          reject(new Error(detail || 'The rank script did not return a rank.'))
          return
        }
        resolve(payload)
      } catch (err) {
        reject(err)
      }
    })
  })
}

function formatStage2Answer(scenario, result) {
  const moves = []
  if (scenario.healthSystem) moves.push(`${scenario.healthSystemIncrease ? 'Adding' : 'Removing'} ${scenario.healthSystem}`)
  if (scenario.physicianGroup) moves.push(`${scenario.physicianGroupIncrease ? 'Adding' : 'Removing'} ${scenario.physicianGroup}`)
  const scope = [scenario.payor, scenario.plantype, scenario.planId].filter(Boolean).join(' ')
  const lead = moves.length ? `${moves.join(' and ')} for ${scope}.` : `Current rank for ${scope}.`
  const rows = Array.isArray(result.rows) ? result.rows : []
  if (!rows.length) return `${lead} The script returned no rank rows.`
  const place = scenario.county ? rows.filter((row) => String(row.county || '').toLowerCase() === scenario.county.toLowerCase()) : rows
  const shown = place.length ? place : rows
  if (!moves.length && shown.length === 1) {
    return `${lead} ${shown[0].county} County is rank ${shown[0].rank}.`
  }
  if (shown.length === 1) {
    const row = shown[0]
    const before = row.rankBefore == null ? '' : ` It was rank ${row.rankBefore}.`
    return `${lead} The new rank in ${row.county} County is ${row.rank}.${before}`
  }
  if (!moves.length) {
    const table = ['| County | Rank |', '| --- | --- |']
    for (const row of shown) table.push(`| ${row.county} | ${row.rank ?? ''} |`)
    return `${lead} This covers ${shown.length} Texas counties.\n\n${table.join('\n')}`
  }
  const table = ['| County | Rank before | New rank |', '| --- | --- | --- |']
  for (const row of shown) table.push(`| ${row.county} | ${row.rankBefore ?? ''} | ${row.rank ?? ''} |`)
  return `${lead}\n\n${table.join('\n')}`
}

module.exports = { lookupsReady, runStage2, formatStage2Answer }
