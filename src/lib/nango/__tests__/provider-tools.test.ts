import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { DeliveryConnection, NangoProxyArgs } from '../delivery'
import { NANGO_PROVIDER_TOOLS, PROVIDER_CONFIG_KEYS, toolsForProvider } from '../provider-tools'

const conn: DeliveryConnection = { connectionId: 'c1', providerConfigKey: 'github', scope: 'user' }

/** Capture the proxy request an adapter emits (no network). */
function spyProxy() {
  const calls: NangoProxyArgs[] = []
  const proxy = async (args: NangoProxyArgs) => {
    calls.push(args)
    return { data: { ok: true } }
  }
  return { proxy, calls }
}

const run = (name: string, args: Record<string, unknown>) => {
  const spec = NANGO_PROVIDER_TOOLS.find((t) => t.name === name)
  assert.ok(spec, `spec ${name} exists`)
  const { proxy, calls } = spyProxy()
  return spec!.run(conn, args, proxy).then(() => calls[0])
}

test('every provider tool has a config-key mapping and a well-formed schema', () => {
  for (const tool of NANGO_PROVIDER_TOOLS) {
    assert.ok(PROVIDER_CONFIG_KEYS[tool.provider]?.length, `${tool.provider} has config keys`)
    assert.equal(typeof tool.isWrite, 'boolean')
    assert.ok(tool.name.startsWith(`${tool.provider}_`), `${tool.name} is provider-namespaced`)
    assert.equal((tool.inputSchema as { type?: string }).type, 'object')
  }
})

test('github: read tools are not writes; create/comment are writes', () => {
  assert.equal(NANGO_PROVIDER_TOOLS.find((t) => t.name === 'github_list_repositories')!.isWrite, false)
  assert.equal(NANGO_PROVIDER_TOOLS.find((t) => t.name === 'github_list_pull_requests')!.isWrite, false)
  assert.equal(NANGO_PROVIDER_TOOLS.find((t) => t.name === 'github_create_issue')!.isWrite, true)
  assert.equal(NANGO_PROVIDER_TOOLS.find((t) => t.name === 'github_comment')!.isWrite, true)
})

test('github_list_repositories → GET /user/repos, or /users/{owner}/repos with owner', async () => {
  const mine = await run('github_list_repositories', {})
  assert.equal(mine.method, 'GET')
  assert.equal(mine.endpoint, '/user/repos')
  assert.equal(mine.connectionId, 'c1')
  assert.equal((mine.params as { per_page: number }).per_page, 30)

  const org = await run('github_list_repositories', { owner: 'acme', per_page: 5 })
  assert.equal(org.endpoint, '/users/acme/repos')
  assert.equal((org.params as { per_page: number }).per_page, 5)
})

test('github_list_pull_requests → GET /repos/{o}/{r}/pulls with state', async () => {
  const c = await run('github_list_pull_requests', { owner: 'acme', repo: 'app', state: 'closed' })
  assert.equal(c.method, 'GET')
  assert.equal(c.endpoint, '/repos/acme/app/pulls')
  assert.equal((c.params as { state: string }).state, 'closed')
})

test('github_create_issue → POST /repos/{o}/{r}/issues with title+body', async () => {
  const c = await run('github_create_issue', { owner: 'acme', repo: 'app', title: 'Bug', body: 'Steps' })
  assert.equal(c.method, 'POST')
  assert.equal(c.endpoint, '/repos/acme/app/issues')
  assert.deepEqual(c.data, { title: 'Bug', body: 'Steps' })
  // body omitted when absent
  const noBody = await run('github_create_issue', { owner: 'acme', repo: 'app', title: 'T' })
  assert.deepEqual(noBody.data, { title: 'T' })
})

test('github_comment → POST issue comments endpoint', async () => {
  const c = await run('github_comment', { owner: 'acme', repo: 'app', issue_number: 42, body: 'thanks' })
  assert.equal(c.endpoint, '/repos/acme/app/issues/42/comments')
  assert.deepEqual(c.data, { body: 'thanks' })
})

test('linear_list_issues → POST /graphql with a query variable', async () => {
  const c = await run('linear_list_issues', { query: 'login bug', first: 10 })
  assert.equal(c.method, 'POST')
  assert.equal(c.endpoint, '/graphql')
  const data = c.data as { query: string; variables: { first: number; filter?: unknown } }
  assert.ok(data.query.includes('issues('))
  assert.equal(data.variables.first, 10)
  assert.ok(data.variables.filter, 'a text query becomes a filter')
  // no query → no filter
  const all = await run('linear_list_issues', {})
  assert.equal((all.data as { variables: { filter?: unknown } }).variables.filter, undefined)
})

test('linear_create_issue → issueCreate mutation with team+title, optional fields omitted', async () => {
  const c = await run('linear_create_issue', { teamId: 'T1', title: 'New' })
  const data = c.data as { query: string; variables: { input: Record<string, unknown> } }
  assert.ok(data.query.includes('issueCreate'))
  assert.deepEqual(data.variables.input, { teamId: 'T1', title: 'New' })
  const full = await run('linear_create_issue', { teamId: 'T1', title: 'N', description: 'D', assigneeId: 'U9' })
  assert.deepEqual((full.data as { variables: { input: Record<string, unknown> } }).variables.input, {
    teamId: 'T1', title: 'N', description: 'D', assigneeId: 'U9',
  })
})

test('linear_update_issue → issueUpdate mutation with only the changed fields', async () => {
  const c = await run('linear_update_issue', { id: 'I1', stateId: 'S2' })
  const data = c.data as { query: string; variables: { id: string; input: Record<string, unknown> } }
  assert.ok(data.query.includes('issueUpdate'))
  assert.equal(data.variables.id, 'I1')
  assert.deepEqual(data.variables.input, { stateId: 'S2' })
})

test('toolsForProvider groups by provider', () => {
  assert.equal(toolsForProvider('github').length, 4)
  assert.equal(toolsForProvider('linear').length, 3)
  assert.equal(toolsForProvider('nonexistent').length, 0)
})
