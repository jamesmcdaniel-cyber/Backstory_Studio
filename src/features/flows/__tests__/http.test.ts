import { test } from 'node:test'
import assert from 'node:assert/strict'
import { prepareHttpRequest, responseOutput } from '../http'

test('prepareHttpRequest appends query params and sends JSON bodies', () => {
  const request = prepareHttpRequest({
    method: 'POST',
    url: 'https://api.example.com/accounts',
    query: { tag: ['a', 'b'], active: true },
    headers: { authorization: 'Bearer token' },
    body: { account: 'Acme' },
    bodyMode: 'json',
  })
  assert.equal(request.url, 'https://api.example.com/accounts?tag=a&tag=b&active=true')
  assert.equal(request.init.method, 'POST')
  assert.deepEqual(request.init.headers, { authorization: 'Bearer token', 'content-type': 'application/json' })
  assert.equal(request.init.body, '{"account":"Acme"}')
})

test('prepareHttpRequest omits body for GET and supports text body mode', () => {
  const get = prepareHttpRequest({ method: 'GET', url: 'https://api.example.com/search', body: '{"ignored":true}', bodyMode: 'json' })
  assert.equal(get.init.body, undefined)

  const post = prepareHttpRequest({ method: 'POST', url: 'https://api.example.com/hook', body: 'hello', bodyMode: 'text' })
  assert.equal(post.init.body, 'hello')
  assert.deepEqual(post.init.headers, {})
})

test('prepareHttpRequest validates object-shaped headers and query params', () => {
  assert.throws(() => prepareHttpRequest({ url: 'https://api.example.com', headers: '[]' }), /Headers/)
  assert.throws(() => prepareHttpRequest({ url: 'https://api.example.com', query: '"bad"' }), /Query/)
})

test('prepareHttpRequest preserves existing query params and clamps request options', () => {
  const request = prepareHttpRequest({
    method: 'PATCH',
    url: 'https://api.example.com/search?existing=1',
    query: '{"tag":["a","b"],"active":true}',
    headers: '{"x-count": 5}',
    timeoutMs: 999999,
    failOnHttpError: false,
    responseType: 'text',
    body: '{"ok":true}',
  })
  assert.equal(request.url, 'https://api.example.com/search?existing=1&tag=a&tag=b&active=true')
  assert.deepEqual(request.init.headers, { 'x-count': '5', 'content-type': 'application/json' })
  assert.equal(request.timeoutMs, 120000)
  assert.equal(request.failOnHttpError, false)
  assert.equal(request.responseType, 'text')
})

test('prepareHttpRequest rejects invalid JSON bodies when JSON mode is explicit', () => {
  assert.throws(
    () => prepareHttpRequest({ method: 'POST', url: 'https://api.example.com', bodyMode: 'json', body: '{broken' }),
    /not valid JSON/,
  )
})

test('responseOutput auto-parses JSON responses and keeps raw body text', async () => {
  const response = new Response('{"ok":true}', {
    status: 201,
    statusText: 'Created',
    headers: { 'content-type': 'application/json' },
  })
  const output = await responseOutput(response, 'auto')
  assert.equal(output.ok, true)
  assert.equal(output.status, 201)
  assert.deepEqual(output.body, { ok: true })
  assert.equal(output.bodyText, '{"ok":true}')
})

test('responseOutput can force text or JSON parsing', async () => {
  const text = await responseOutput(new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } }), 'text')
  assert.equal(text.body, '{"ok":true}')
  await assert.rejects(() => responseOutput(new Response('not-json'), 'json'), /not valid JSON/)
})
