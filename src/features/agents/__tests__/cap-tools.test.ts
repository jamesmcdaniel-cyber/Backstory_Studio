import { test } from 'node:test'
import assert from 'node:assert/strict'
import { capDiscoveredTools, type DiscoveredTool } from '../execute-agent'

const client = { executeTool: async () => ({}) }
function tool(name: string, isWrite: boolean): DiscoveredTool {
  return {
    name,
    description: name,
    inputSchema: { type: 'object', properties: {} },
    binding: { provider: isWrite ? 'nango:slack' : 'read', serverUrl: 'x', toolName: name, client },
    isWrite,
  }
}

test('write tools are never crowded out by many read tools (reserved budget)', () => {
  // 70 read tools (over the 64 cap) + 3 write tools loaded "last".
  const reads = Array.from({ length: 70 }, (_, i) => tool(`read_${i}`, false))
  const writes = [tool('nango_slack', true), tool('nango_gmail', true), tool('slack_post', true)]
  const { tools, bindings } = capDiscoveredTools([...reads, ...writes], 'org1')

  assert.equal(tools.length, 64) // capped
  for (const w of writes) {
    assert.ok(bindings.has(w.name), `write tool ${w.name} must survive the cap`)
  }
})

test('dedupes by name (first wins) and respects the total cap', () => {
  const list = [tool('a', false), tool('a', false), tool('b', true)]
  const { tools } = capDiscoveredTools(list, 'org1')
  assert.deepEqual(tools.map((t) => t.name).sort(), ['a', 'b'])
})

test('under the cap, everything is kept', () => {
  const list = [tool('r1', false), tool('w1', true), tool('r2', false)]
  const { tools } = capDiscoveredTools(list, 'org1')
  assert.equal(tools.length, 3)
})
