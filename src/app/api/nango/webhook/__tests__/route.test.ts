import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'
import { POST } from '../route'

const post = (body: string) =>
  POST(new NextRequest('https://app.test/api/nango/webhook', { method: 'POST', body }))

test('nango webhook acks (200) without acting when NANGO_SECRET_KEY is unset', async () => {
  const prev = process.env.NANGO_SECRET_KEY
  delete process.env.NANGO_SECRET_KEY
  try {
    const res = await post(JSON.stringify({ type: 'auth', connectionId: 'c1' }))
    assert.equal(res.status, 200)
    const data = await res.json()
    assert.equal(data.ok, true)
    assert.equal(data.skipped, 'nango-unconfigured')
  } finally {
    if (prev === undefined) delete process.env.NANGO_SECRET_KEY
    else process.env.NANGO_SECRET_KEY = prev
  }
})

test('nango webhook rejects an unverified request (401) when configured', async () => {
  const prev = process.env.NANGO_SECRET_KEY
  process.env.NANGO_SECRET_KEY = 'test-secret-key'
  try {
    // No valid X-Nango-Signature header → verifyIncomingWebhookRequest fails.
    const res = await post(JSON.stringify({ type: 'auth', connectionId: 'c1' }))
    assert.equal(res.status, 401)
    const data = await res.json()
    assert.equal(data.ok, false)
  } finally {
    if (prev === undefined) delete process.env.NANGO_SECRET_KEY
    else process.env.NANGO_SECRET_KEY = prev
  }
})
