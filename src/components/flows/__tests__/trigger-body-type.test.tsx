/**
 * Coverage for the card's trigger body adopting the shared TriggerEditor (WS
 * task 3): the type picker and webhook panel now live in the expanded card,
 * and editing an input field no longer silently reverts trigger.type to
 * 'manual'.
 */
import '@/test-support/jsdom-env'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { render, cleanup, screen, fireEvent } from '@testing-library/react'
import { StepCard } from '../step-card'
import type { FlowNode } from '@/lib/flows/graph'

function webhookTriggerNode(): FlowNode {
  return {
    id: 'trigger',
    type: 'trigger',
    data: {
      trigger: {
        type: 'webhook',
        inputFields: [{ name: 'account', type: 'string' }],
      },
    },
  } as never
}

function manualTriggerNode(): FlowNode {
  return {
    id: 'trigger',
    type: 'trigger',
    data: { trigger: { type: 'manual' } },
  } as never
}

test('REGRESSION: editing an input field on a webhook trigger preserves type webhook', () => {
  let latest: FlowNode | null = null
  const node = webhookTriggerNode()
  const { getByLabelText } = render(
    React.createElement(StepCard, {
      node,
      title: 'Trigger',
      selected: true,
      agents: [],
      toolCatalog: [],
      onChange: (updated: FlowNode) => {
        latest = updated
      },
    } as never),
  )
  const input = getByLabelText('Input name') as HTMLInputElement
  fireEvent.change(input, { target: { value: 'accountName' } })
  assert.ok(latest)
  const trigger = (latest as unknown as { data: { trigger: { type?: string } } }).data.trigger
  assert.equal(trigger.type, 'webhook')
  cleanup()
})

test('card trigger editor offers the type picker and switching to webhook writes type webhook', () => {
  let latest: FlowNode | null = null
  const node = manualTriggerNode()
  const { getByLabelText } = render(
    React.createElement(StepCard, {
      node,
      title: 'Trigger',
      selected: true,
      agents: [],
      toolCatalog: [],
      onChange: (updated: FlowNode) => {
        latest = updated
      },
    } as never),
  )
  const select = getByLabelText(/trigger type/i) as HTMLSelectElement
  fireEvent.change(select, { target: { value: 'webhook' } })
  assert.ok(latest)
  const trigger = (latest as unknown as { data: { trigger: { type?: string } } }).data.trigger
  assert.equal(trigger.type, 'webhook')
  cleanup()
})

test('card webhook panel renders (URL block present) with stubbed fetch', async () => {
  const realFetch = globalThis.fetch
  const calls: string[] = []
  globalThis.fetch = (async (url: unknown) => {
    calls.push(String(url))
    return { ok: true, json: async () => ({ success: true, hasSecret: true, url: 'https://app.example/api/flows/f1/trigger' }) }
  }) as unknown as typeof fetch
  try {
    const node = webhookTriggerNode()
    render(
      React.createElement(StepCard, {
        node,
        title: 'Trigger',
        selected: true,
        agents: [],
        toolCatalog: [],
        flowId: 'f1',
        onChange: () => {},
      } as never),
    )
    await screen.findByText('https://app.example/api/flows/f1/trigger')
    assert.ok(screen.getByText('Webhook URL'))
    assert.ok(calls.some((u) => u.includes('/api/flows/f1/trigger-secret')))
  } finally {
    globalThis.fetch = realFetch
    cleanup()
  }
})
