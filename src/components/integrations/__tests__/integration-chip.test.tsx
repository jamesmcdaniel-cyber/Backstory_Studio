import { test } from 'node:test'
import assert from 'node:assert/strict'
import { integrationLabel } from '../integration-chip'

test('integrationLabel strips internal plane prefixes and title-cases bare slugs', () => {
  // Plane prefixes that leak into stored connector keys are removed.
  assert.equal(integrationLabel('nango:snowflake'), 'Snowflake')
  assert.equal(integrationLabel('nango:salesforce'), 'Salesforce')
  assert.equal(integrationLabel('native:slack'), 'Slack')
  assert.equal(integrationLabel('people_ai:backstory'), 'Backstory')
  // Hyphen/underscore slugs become spaced Title Case.
  assert.equal(integrationLabel('nango:google-mail'), 'Google Mail')
  // Branded / multi-word display names pass through untouched.
  assert.equal(integrationLabel('Backstory MCP'), 'Backstory MCP')
  assert.equal(integrationLabel('HTTP API'), 'HTTP API')
  assert.equal(integrationLabel('Email'), 'Email')
})
