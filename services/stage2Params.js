/**
 * Arguments for algo/Stage2_dynamic.py.
 * Scope is a payor, a plan id, or a payor and plan type. A plan type alone is rejected.
 * A health system and a physician group can both be set, or either one.
 * An increase flag is true when that entity is added and false when it is removed.
 */

const PLAN_TYPES = ['HMO-POS', 'Local PPO', 'Regional PPO', 'HMO', 'PPO']

function blank(value) {
  return String(value ?? '').trim()
}

function flag(value) {
  if (value == null || String(value).trim() === '') return null
  const text = String(value).trim().toLowerCase()
  if (['true', '1', 'yes', 'add', 'increase'].includes(text)) return true
  if (['false', '0', 'no', 'remove', 'drop', 'terminate'].includes(text)) return false
  return undefined
}

function canonicalPlanType(value) {
  const text = blank(value)
  if (!text) return ''
  const found = PLAN_TYPES.find((type) => type.toLowerCase() === text.toLowerCase())
  return found || text
}

function scenarioFromBody(body) {
  const src = body && typeof body === 'object' ? body : {}
  const healthSystem = blank(src.healthSystem ?? src.health_system)
  const physicianGroup = blank(src.physicianGroup ?? src['physician group'] ?? src.physician_group)
  return {
    payor: blank(src.payor),
    plantype: canonicalPlanType(src.plantype ?? src.planType ?? src.plan_type),
    planId: blank(src.planId ?? src.plan_id ?? src.planID),
    healthSystem,
    physicianGroup,
    healthSystemIncrease: healthSystem ? flag(src.healthSystemIncrease ?? src.health_system_increase) : null,
    physicianGroupIncrease: physicianGroup
      ? flag(src.physicianGroupIncrease ?? src.physicainGroupIncrease ?? src.physician_group_increase)
      : null,
    county: blank(src.county).replace(/\s+county$/i, ''),
  }
}

function scopeIssue(scenario) {
  const { payor, plantype, planId } = scenario
  if (plantype && !payor) {
    return 'A plan type cannot be passed on its own. Pass a payor, a plan id, or a payor and plan type.'
  }
  if (!payor && !planId) {
    return 'Pass a payor, a plan id, or a payor and plan type.'
  }
  return ''
}

function changeIssue(scenario) {
  if (scenario.healthSystem && scenario.healthSystemIncrease == null) {
    return 'Say whether the health system is added or removed.'
  }
  if (scenario.physicianGroup && scenario.physicianGroupIncrease == null) {
    return 'Say whether the physician group is added or removed.'
  }
  if (scenario.healthSystemIncrease === undefined || scenario.physicianGroupIncrease === undefined) {
    return 'Use true when a health system or physician group is added, and false when it is removed.'
  }
  return ''
}

function scenarioIssue(scenario) {
  return scopeIssue(scenario) || changeIssue(scenario)
}

/** Positional arguments: payor, plantype, planId, healthSystem, physician group, then the two increase flags, then county. */
function toArgv(scenario) {
  return [
    scenario.payor || '',
    scenario.plantype || '',
    scenario.planId || '',
    scenario.healthSystem || '',
    scenario.physicianGroup || '',
    scenario.healthSystem ? String(scenario.healthSystemIncrease === true) : '',
    scenario.physicianGroup ? String(scenario.physicianGroupIncrease === true) : '',
    scenario.county || '',
  ]
}

function findPlanType(text) {
  for (const type of PLAN_TYPES) {
    const pattern = type.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    if (new RegExp(`\\b${pattern}\\b`, 'i').test(text)) return type
  }
  return ''
}

function findPlanId(text) {
  const match = text.match(/\b(H\d{4}(?:[_-]\d+){1,2})\b/i)
  return match ? match[1].replace(/-/g, '_') : ''
}

function findCounty(text) {
  const match = text.match(/\b(?:in|for|within)\s+([A-Za-z][A-Za-z .'-]*?)\s+county\b/i)
  return match ? match[1].trim() : ''
}

function findPayor(text, payors) {
  const list = (Array.isArray(payors) ? payors : []).map((payor) => String(payor).trim()).filter(Boolean)
  const mentioned = list.filter((payor) => {
    const name = payor.toLowerCase()
    if (text.toLowerCase().includes(name)) return true
    const head = name.split(/\s+/)[0]
    return head.length > 3 && new RegExp(`\\b${head}\\b`, 'i').test(text)
  })
  if (mentioned.length > 1) return { ambiguous: mentioned }
  if (mentioned.length === 1) return mentioned[0]
  const withName = text.match(/\bwith\s+([A-Za-z][A-Za-z0-9&.' -]{1,80}?)(?=\s*[?.!]|$)/i)
  if (withName) return withName[1].trim()
  if (list.length === 1 && /\b(we|our)\b/i.test(text)) return list[0]
  return ''
}

function cleanName(phrase) {
  return String(phrase || '')
    .replace(/\b(health systems?|hospital systems?|physician groups?|medical groups?)\b/gi, ' ')
    .replace(/\s+(?:its|their)\s+contract\b.*$/i, '')
    .replace(/[?.!,]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function kindOf(phrase) {
  if (/\bphysician group\b|\bmedical group\b/i.test(phrase)) return 'physicianGroup'
  if (/\bgroup\b/i.test(phrase) && !/\bhealth\b/i.test(phrase)) return 'physicianGroup'
  return 'healthSystem'
}

function flagNear(text, name, fallback) {
  const at = text.toLowerCase().indexOf(String(name || '').toLowerCase())
  const window = at >= 0 ? text.slice(Math.max(0, at - 48), at + name.length + 48) : text
  if (/\b(add(?:ing|ed)?|include|included|bring in)\b/i.test(window)) return true
  if (/\b(terminat\w*|drop(?:ping|ped)?|remov\w*|los(?:e|ing)|exit)\b/i.test(window)) return false
  return fallback
}

function namedEntity(text, pattern) {
  const match = pattern.exec(text)
  if (!match) return null
  const raw = match[1].trim()
  const name = cleanName(raw)
  if (!name) return null
  return { kind: kindOf(match[0]), name }
}

function usableName(name) {
  if (!name || name.length < 3) return false
  if (/^(these|those|the|some|small groups?|groups?)$/i.test(name)) return false
  if (/^(one|two|three|four|five|\d+)\b/i.test(name)) return false
  return true
}

function rememberEntity(found, entity) {
  if (!entity || !usableName(entity.name)) return
  if (found.some((item) => item.kind === entity.kind)) return
  found.push(entity)
}

function entitiesFromPrompt(text) {
  const found = []
  rememberEntity(found, namedEntity(text, /\bhealth system\s+([^,?.]+?)(?=\s+(?:and|that|which|is|gets|from)\b|[?.!,]|$)/i))
  rememberEntity(found, namedEntity(text, /\b(?:physician|medical)\s+group\s+([^,?.]+?)(?=\s+(?:and|that|which|is|gets|from)\b|[?.!,]|$)/i))
  if (found.length) return found

  const subject = text.match(/\b(?:if|what if|when)\s+(.+?)\s+(?:terminates|terminated|terminate|drops|dropped|leaves|exits)\b/i)
  if (subject) {
    const name = cleanName(subject[1])
    if (usableName(name) && !/^(we|our|our network)$/i.test(name)) found.push({ kind: kindOf(subject[1]), name })
  }
  const dropped = text.match(/\b(?:drop(?:ping)?|remov(?:e|ing)|terminat(?:e|ing))\s+(?:the\s+)?(.+?)(?=\s+(?:in|from|for)\b|[?.!,]|$)/i)
  if (dropped) {
    const name = cleanName(dropped[1])
    if (usableName(name) && !found.some((item) => item.name.toLowerCase() === name.toLowerCase())) {
      found.push({ kind: kindOf(dropped[0]), name })
    }
  }
  const add = text.match(/\b(?:add(?:ing)?|include|including|bring in)\s+(?:the\s+)?(.+?)(?=\s+(?:in|for|to|into)\b|[?.!,]|$)/i)
  if (add) {
    const name = cleanName(add[1])
    if (usableName(name) && !found.some((item) => item.name.toLowerCase() === name.toLowerCase())) {
      found.push({ kind: kindOf(add[0]), name })
    }
  }
  return found
}

/**
 * Pull a Stage2 scenario out of a chat message.
 * relevant is false when the message is not an add or a removal of a system or group.
 */
function scenarioFromPrompt(text, context = {}) {
  const message = String(text || '').trim()
  const entities = entitiesFromPrompt(message)
  const asksChange = /\b(terminat\w*|drop(?:ping|ped)?|remov\w*|add(?:ing|ed)?|include|los(?:e|ing))\b/i.test(message)
  if (!entities.length || !asksChange) return { relevant: false }

  const payorFound = findPayor(message, context.payors)
  if (payorFound && typeof payorFound === 'object' && payorFound.ambiguous) {
    return { relevant: true, clarify: `Which payor? Choose one of ${payorFound.ambiguous.join(', ')}.` }
  }
  const scenario = {
    payor: typeof payorFound === 'string' ? payorFound : '',
    plantype: findPlanType(message),
    planId: findPlanId(message),
    healthSystem: '',
    physicianGroup: '',
    healthSystemIncrease: null,
    physicianGroupIncrease: null,
    county: findCounty(message) || blank(context.county).replace(/\s+county$/i, ''),
  }
  const sentenceFlag = flagNear(message, '', null)
  for (const entity of entities) {
    const increase = flagNear(message, entity.name, sentenceFlag)
    if (entity.kind === 'physicianGroup') {
      scenario.physicianGroup = entity.name
      scenario.physicianGroupIncrease = increase
    } else {
      scenario.healthSystem = entity.name
      scenario.healthSystemIncrease = increase
    }
  }
  const issue = scenarioIssue(scenario)
  if (issue) return { relevant: true, clarify: issue, scenario }
  return { relevant: true, scenario }
}

module.exports = {
  scenarioFromBody,
  scenarioFromPrompt,
  scenarioIssue,
  toArgv,
  finders: { findPayor, findPlanType, findPlanId, findCounty },
}
