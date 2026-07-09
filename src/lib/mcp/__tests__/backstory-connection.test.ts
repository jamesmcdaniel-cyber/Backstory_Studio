import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  evaluateBackstoryReady,
  backstoryGateEnabled,
  backstoryServerUrl,
  readyCacheFresh,
  BACKSTORY_MCP_DEFAULT_URL,
} from '../backstory-connection'

test('evaluateBackstoryReady requires an active row with authcode tokens', () => {
  assert.equal(evaluateBackstoryReady(null), false)
  assert.equal(evaluateBackstoryReady({ isActive: false, authConfig: { flow: 'authcode', accessToken: 'enc' } }), false)
  assert.equal(evaluateBackstoryReady({ isActive: true, authConfig: {} }), false)
  assert.equal(evaluateBackstoryReady({ isActive: true, authConfig: { flow: 'authcode' } }), false)
  assert.equal(evaluateBackstoryReady({ isActive: true, authConfig: { flow: 'authcode', accessToken: 'enc' } }), true)
  assert.equal(evaluateBackstoryReady({ isActive: true, authConfig: 'not-an-object' }), false)
})

test('backstoryGateEnabled follows BACKSTORY_MCP_GATE with production default', () => {
  const prior = { gate: process.env.BACKSTORY_MCP_GATE, env: process.env.NODE_ENV }
  try {
    process.env.BACKSTORY_MCP_GATE = 'on'
    assert.equal(backstoryGateEnabled(), true)
    process.env.BACKSTORY_MCP_GATE = 'off'
    assert.equal(backstoryGateEnabled(), false)
    delete process.env.BACKSTORY_MCP_GATE
    assert.equal(backstoryGateEnabled(), process.env.NODE_ENV === 'production')
  } finally {
    if (prior.gate === undefined) delete process.env.BACKSTORY_MCP_GATE
    else process.env.BACKSTORY_MCP_GATE = prior.gate
  }
})

test('backstoryServerUrl defaults and honors the env override', () => {
  const prior = process.env.BACKSTORY_MCP_URL
  try {
    delete process.env.BACKSTORY_MCP_URL
    assert.equal(backstoryServerUrl(), BACKSTORY_MCP_DEFAULT_URL)
    process.env.BACKSTORY_MCP_URL = 'https://custom.example.com/mcp'
    assert.equal(backstoryServerUrl(), 'https://custom.example.com/mcp')
  } finally {
    if (prior === undefined) delete process.env.BACKSTORY_MCP_URL
    else process.env.BACKSTORY_MCP_URL = prior
  }
})

test('readyCacheFresh is a 60s TTL', () => {
  const now = 1_000_000
  assert.equal(readyCacheFresh(now - 59_000, now), true)
  assert.equal(readyCacheFresh(now - 61_000, now), false)
})

test('sameServerUrl ignores trailing slashes and case', async () => {
  const { sameServerUrl } = await import('../backstory-connection')
  assert.equal(sameServerUrl('https://mcp.backstory.ai/mcp/', 'https://MCP.backstory.ai/mcp'), true)
  assert.equal(sameServerUrl('https://mcp.backstory.ai/mcp', 'https://other.example.com/mcp'), false)
  assert.equal(sameServerUrl('', ''), false)
})

test('evaluateExistingBackstoryConnection accepts active matching rows regardless of auth type', async () => {
  const { evaluateExistingBackstoryConnection, BACKSTORY_MCP_DEFAULT_URL } = await import('../backstory-connection')
  assert.equal(evaluateExistingBackstoryConnection({ isActive: true, serverUrl: BACKSTORY_MCP_DEFAULT_URL, authType: 'oauth2' }, BACKSTORY_MCP_DEFAULT_URL), true)
  assert.equal(evaluateExistingBackstoryConnection({ isActive: true, serverUrl: `${BACKSTORY_MCP_DEFAULT_URL}/`, authType: 'api_key' }, BACKSTORY_MCP_DEFAULT_URL), true)
  assert.equal(evaluateExistingBackstoryConnection({ isActive: false, serverUrl: BACKSTORY_MCP_DEFAULT_URL, authType: 'oauth2' }, BACKSTORY_MCP_DEFAULT_URL), false)
  assert.equal(evaluateExistingBackstoryConnection({ isActive: true, serverUrl: 'https://other.example.com', authType: 'oauth2' }, BACKSTORY_MCP_DEFAULT_URL), false)
  assert.equal(evaluateExistingBackstoryConnection(null, BACKSTORY_MCP_DEFAULT_URL), false)
})
