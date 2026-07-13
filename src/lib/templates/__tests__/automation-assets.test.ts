import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  AUTOMATION_ASSET_CONTRACT_MARKER,
  enhanceAutomationInstructions,
} from '../automation-assets'

test('enhanceAutomationInstructions adds the implementation package after domain instructions', () => {
  const enhanced = enhanceAutomationInstructions('Gather account data and rank risks.')
  assert.ok(enhanced.startsWith('Gather account data and rank risks.'))
  assert.ok(enhanced.includes(AUTOMATION_ASSET_CONTRACT_MARKER))
  assert.ok(enhanced.includes('Canonical workflow JSON'))
  assert.ok(enhanced.includes('n8n, Make, Zapier, Workato, and Microsoft Power Automate'))
  assert.ok(enhanced.includes('responsive, accessible, and presentation-ready'))
  assert.ok(enhanced.includes('idempotency'))
})

test('enhanceAutomationInstructions is idempotent', () => {
  const once = enhanceAutomationInstructions('Do the work.')
  assert.equal(enhanceAutomationInstructions(once), once)
  assert.equal(once.split(AUTOMATION_ASSET_CONTRACT_MARKER).length - 1, 1)
})
