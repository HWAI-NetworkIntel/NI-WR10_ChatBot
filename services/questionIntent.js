/**
 * The model reads the question and chooses the process:
 * get_rank and compare_ranks go to the Python rank script,
 * remove goes to that script as a drop,
 * add and sensitivity stay on the roster rank model.
 * A missing model or a bad reply falls back to the same choice from the wording.
 */

const { looksLikeRankQuestion } = require('./rankService')
const { finders, scenarioFromBody, scenarioFromPrompt } = require('./stage2Params')

const INTENT_SYSTEM = [
  'You classify one Texas Medicare Advantage network question.',
  'Reply with one JSON object and no other text.',
  'Fields: action, payor, planType, planId, healthSystem, physicianGroup, county, comparePayor.',
  'action is one of get_rank, compare_ranks, remove, add, sensitivity, other.',
  'get_rank: the current rank, or where a payor ranks.',
  'compare_ranks: compare payors or networks, who is ahead, rank against, best and worst.',
  'remove: drop, terminate, or remove a health system or physician group.',
  'add: add or include a health system or physician group, or the smallest set of additions.',
  'sensitivity: how close to a rank, or how much reach is needed to reach a rank.',
  'other: provider counts, specialties, a bare yes, or anything that is not a rank or a network change.',
  'county is the county name only when the user named one. Otherwise county is "". A missing county means every Texas county. Never ask the user to pick a county.',
  'payor and comparePayor are "" when the user did not name them. "we" and "our" refer to dashboardPayors.',
  'planType is HMO, PPO, HMO-POS, Local PPO, Regional PPO, or "".',
].join('\n')

function blank(value) {
  return String(value ?? '').trim()
}

function normalizeAction(value) {
  const text = blank(value).toLowerCase().replace(/[\s-]+/g, '_')
  if (['get_rank', 'rank', 'baseline', 'current', 'current_rank'].includes(text)) return 'get_rank'
  if (['compare_ranks', 'compare', 'comparison', 'against'].includes(text)) return 'compare_ranks'
  if (['remove', 'removal', 'terminate', 'drop'].includes(text)) return 'remove'
  if (['add', 'addition', 'include', 'prescribe'].includes(text)) return 'add'
  if (['sensitivity', 'close', 'how_close'].includes(text)) return 'sensitivity'
  if (text === 'other' || text === 'ask') return 'other'
  return ''
}

function parseIntent(text) {
  const raw = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  const value = JSON.parse(raw)
  const action = normalizeAction(value.action || value.intent)
  if (!action) return null
  return {
    action,
    payor: blank(value.payor),
    plantype: blank(value.planType || value.plantype),
    planId: blank(value.planId || value.plan_id),
    healthSystem: blank(value.healthSystem || value.health_system),
    physicianGroup: blank(value.physicianGroup || value.physician_group || value['physician group']),
    county: blank(value.county).replace(/\s+county$/i, ''),
    comparePayor: blank(value.comparePayor || value.compareWith || value.compare_payor),
  }
}

function mentioned(text, value) {
  const token = blank(value).toLowerCase().replace(/\s+county$/i, '')
  if (token.length < 3) return false
  return String(text || '').toLowerCase().includes(token)
}

function listedPayors(input) {
  const direct = Array.isArray(input?.payors) ? input.payors : []
  const pairs = Array.isArray(input?.payorsCrossPlanTypes) ? input.payorsCrossPlanTypes.map((pair) => pair.payor) : []
  return [...new Set([...direct, ...pairs].map((payor) => blank(payor)).filter(Boolean))]
}

function matchListed(name, list) {
  const key = blank(name).toLowerCase()
  if (!key) return ''
  return list.find((payor) => payor.toLowerCase() === key)
    || list.find((payor) => payor.toLowerCase().includes(key) || key.includes(payor.toLowerCase()))
    || ''
}

function resolvePayor(name, list, message) {
  const listed = matchListed(name, list)
  if (listed && (mentioned(message, name) || list.length === 1)) return listed
  if (mentioned(message, name)) return blank(name)
  if (list.length === 1) return list[0]
  return ''
}

function resolvePlanType(name, input, payor, message) {
  const pairs = Array.isArray(input?.payorsCrossPlanTypes) ? input.payorsCrossPlanTypes : []
  const types = [...new Set(pairs
    .filter((pair) => !payor || String(pair.payor).toLowerCase() === payor.toLowerCase())
    .map((pair) => blank(pair.planType))
    .filter(Boolean))]
  const named = blank(name)
  if (named && mentioned(message, named)) {
    return types.find((type) => type.toLowerCase() === named.toLowerCase()) || named
  }
  if (blank(input?.planType)) return blank(input.planType)
  if (types.length === 1) return types[0]
  return ''
}

function emptyIntent(action) {
  return {
    action,
    payor: '',
    plantype: '',
    planId: '',
    healthSystem: '',
    physicianGroup: '',
    county: '',
    comparePayor: '',
  }
}

function intentFromRules(message, input) {
  const text = String(message || '').trim()
  const parsed = scenarioFromPrompt(text, { payors: listedPayors(input) })
  if (parsed.relevant && parsed.scenario) {
    const adding = parsed.scenario.healthSystemIncrease === true || parsed.scenario.physicianGroupIncrease === true
    const removing = parsed.scenario.healthSystemIncrease === false || parsed.scenario.physicianGroupIncrease === false
    return {
      action: removing && !adding ? 'remove' : 'add',
      ...parsed.scenario,
      comparePayor: '',
      clarify: parsed.clarify || '',
    }
  }
  if (/\bhow close\b|\bsensitivity\b|\bhow much .{0,40}reach\b/i.test(text)) return { ...emptyIntent('sensitivity') }
  if (/\b(compar(?:e|ing|ison)|against|best network|best and worst)\b/i.test(text)) {
    const payor = finders.findPayor(text, listedPayors(input))
    return { ...emptyIntent('compare_ranks'), payor: typeof payor === 'string' ? payor : '', plantype: finders.findPlanType(text), county: finders.findCounty(text) }
  }
  if (/\b(smallest set of adds|which additions|additions get us)\b/i.test(text)) return { ...emptyIntent('add'), plantype: finders.findPlanType(text), county: finders.findCounty(text) }
  if (looksLikeRankQuestion(text)) {
    const payor = finders.findPayor(text, listedPayors(input))
    return {
      ...emptyIntent('get_rank'),
      payor: typeof payor === 'string' ? payor : '',
      plantype: finders.findPlanType(text),
      planId: finders.findPlanId(text),
      county: finders.findCounty(text),
    }
  }
  return emptyIntent('other')
}

function groundIntent(intent, message, input) {
  const payors = listedPayors(input)
  const payor = resolvePayor(intent.payor, payors, message)
  const plantype = resolvePlanType(intent.plantype, input, payor, message)
  const requestedCounty = blank(input?.county || input?.geography?.county || input?.context?.county).replace(/\s+county$/i, '')
  const county = mentioned(message, intent.county) ? blank(intent.county).replace(/\s+county$/i, '') : requestedCounty
  const healthSystem = mentioned(message, intent.healthSystem) ? intent.healthSystem : ''
  const physicianGroup = mentioned(message, intent.physicianGroup) ? intent.physicianGroup : ''
  const comparePayor = resolvePayor(intent.comparePayor, payors, message)
  let healthSystemIncrease = null
  let physicianGroupIncrease = null
  if (intent.action === 'remove') {
    if (healthSystem) healthSystemIncrease = false
    if (physicianGroup) physicianGroupIncrease = false
  }
  if (intent.action === 'add') {
    if (healthSystem) healthSystemIncrease = true
    if (physicianGroup) physicianGroupIncrease = true
  }
  const scenario = scenarioFromBody({
    payor,
    plantype,
    planId: intent.planId,
    healthSystem,
    physicianGroup,
    healthSystemIncrease,
    physicianGroupIncrease,
    county,
  })
  return {
    action: intent.action,
    scenario,
    comparePayor: comparePayor && comparePayor.toLowerCase() !== scenario.payor.toLowerCase() ? comparePayor : '',
    clarify: intent.clarify || '',
  }
}

function leavesTheModel(message) {
  const text = String(message || '').trim()
  if (/^(yes|yep|yeah|confirm|go ahead|use that|that one)\b/i.test(text)) return true
  if (!looksLikeRankQuestion(text) && /^(?:in\s+)?[a-z][a-z .'-]{1,40}(?:\s+county)?$/i.test(text)) return true
  return false
}

async function defaultChat(request) {
  const { chat } = require('./llm')
  return chat(request)
}

async function understandQuestion(input, deps = {}) {
  const message = String(input?.message || input?.question || '').trim()
  if (!message || leavesTheModel(message)) return groundIntent(emptyIntent('other'), message, input)
  if (deps.chat !== null) {
    const chat = deps.chat || defaultChat
    try {
      const raw = await chat({
        system: INTENT_SYSTEM,
        messages: [{
          role: 'user',
          content: JSON.stringify({
            question: message,
            earlier: String(input?.earlier || ''),
            dashboardPayors: listedPayors(input),
            dashboardPlanType: blank(input?.planType),
          }),
        }],
        json: true,
      })
      const parsed = parseIntent(raw)
      if (parsed) return groundIntent(parsed, message, input)
    } catch {
      // The wording rules below keep the same routing when the model is unavailable.
    }
  }
  return groundIntent(intentFromRules(message, input), message, input)
}

module.exports = {
  understandQuestion,
  intentFromRules,
  parseIntent,
  groundIntent,
}
