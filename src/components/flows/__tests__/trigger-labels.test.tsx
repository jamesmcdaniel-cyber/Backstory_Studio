import '@/test-support/jsdom-env'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { render, cleanup } from '@testing-library/react'
import { FlowCanvas } from '../flow-canvas'
import type { FlowGraph } from '@/lib/flows/graph'

test('a webhook trigger card reads "When an HTTP request is received", not "Webhook trigger"', () => {
  const graph: FlowGraph = { nodes: [{ id: 'trigger', type: 'trigger', data: { trigger: { type: 'webhook' } } }], edges: [] } as never
  const { container } = render(React.createElement(FlowCanvas, {
    graph, agentName: () => '', agents: [], toolCatalog: [],
    statusByNode: {}, selectedId: null,
    onSelect: () => {}, onChangeNode: () => {}, onInsertAfter: () => {}, onAppendBranch: () => {}, onBackgroundClick: () => {},
  } as never))
  assert.ok((container.textContent || '').includes('When an HTTP request is received'))
  assert.ok(!(container.textContent || '').includes('Webhook trigger'))
  cleanup()
})
