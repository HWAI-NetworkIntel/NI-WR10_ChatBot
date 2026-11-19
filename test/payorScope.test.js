'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { payorScopeIssue, resolveAskScope } = require('../services/askService')

const tables = ['NetworkProviderMapping', 'ProviderLocation', 'County', 'ParentOrganization', 'GeographyPlanFilters', 'PlanType']
const input = {
  payors: ['Humana Inc.'],
  payorsCrossPlanTypes: [
    { payor: 'Humana Inc.', planType: 'HMO' },
    { payor: 'Humana Inc.', planType: 'PPO' },
  ],
}

test('a LIKE filter for the name the user said counts as the legal payor name', () => {
  const sql = `
    SELECT COUNT(DISTINCT pl.NPI) AS Providers
    FROM NetworkProviderMapping npm
    JOIN ProviderLocation pl ON pl.ProviderLocationId = npm.ProviderLocationId
    JOIN County c ON c.FIPS = pl.FIPS
    JOIN ParentOrganization po ON po.ParentOrganizationId = npm.ParentOrganizationId
    JOIN GeographyPlanFilters gpf ON gpf.ParentOrganizationId = po.ParentOrganizationId
    JOIN PlanType pt ON pt.PlanTypeId = gpf.PlanTypeId
    WHERE c.StateCode = 'TX' AND c.CountyName LIKE 'Dallas%'
      AND po.ParentOrganizationName LIKE '%humana%'
      AND (pt.PlanType = 'HMO' OR pt.PlanType = 'PPO')`
  assert.equal(payorScopeIssue(sql, tables, input), '')
})

test('a question that does not name a payor asks instead of using the payload payor', () => {
  const known = { payors: ['CVS Health Corporation', 'Humana Inc.'], planTypes: ['HMO', 'PPO'] }
  const asked = resolveAskScope({
    question: 'for what all county its available',
    payors: ['CVS Health Corporation'],
    payorsCrossPlanTypes: [{ payor: 'CVS Health Corporation', planType: 'HMO' }],
    context: { county: 'what all', state: 'TX' },
  }, known)
  assert.equal(asked.clarify.suggestionField, 'payor')
  assert.deepEqual(asked.clarify.suggestions, known.payors)
  assert.match(asked.clarify.answer, /Which payor/)

  const named = resolveAskScope({
    question: 'How many providers does Humana have?',
    payors: ['CVS Health Corporation'],
    payorsCrossPlanTypes: [{ payor: 'CVS Health Corporation', planType: 'HMO' }],
  }, known)
  assert.deepEqual(named.input.payors, ['Humana Inc.'])

  const chosen = resolveAskScope({
    question: 'for what all county its available',
    payors: ['Humana Inc.'],
    payorsCrossPlanTypes: [{ payor: 'Humana Inc.', planType: 'HMO' }],
    payorConfirmed: true,
    context: { county: 'what all', state: 'TX' },
  }, known)
  assert.deepEqual(chosen.input.payors, ['Humana Inc.'])
  assert.equal(chosen.input.context.county, undefined)
  assert.equal(chosen.input.context.state, 'TX')
})

test('a query with no payor filter is still rejected', () => {
  const sql = `
    SELECT 1
    FROM ParentOrganization po
    JOIN GeographyPlanFilters gpf ON gpf.ParentOrganizationId = po.ParentOrganizationId
    JOIN PlanType pt ON pt.PlanTypeId = gpf.PlanTypeId`
  assert.match(payorScopeIssue(sql, ['ParentOrganization', 'GeographyPlanFilters', 'PlanType'], input), /Humana Inc\./)
})
