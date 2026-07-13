import '@/test-support/jsdom-env'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { render, cleanup, fireEvent } from '@testing-library/react'
import { StepCard } from '../step-card'
import type { FlowNode } from '@/lib/flows/graph'

function triggerNode(): FlowNode {
  return {
    id: 'trigger',
    type: 'trigger',
    data: {
      trigger: {
        type: 'manual',
        inputFields: [{ name: 'account', type: 'string' }],
      },
    },
  } as never
}

test('typing a default value for a trigger input field updates the node', () => {
  let latest: FlowNode | null = null
  const node = triggerNode()
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
    } as never)
  )
  const input = getByLabelText('Default value') as HTMLInputElement
  fireEvent.change(input, { target: { value: 'acme-corp' } })
  assert.ok(latest)
  const fields = (latest as unknown as { data: { trigger: { inputFields: { name: string; default?: string }[] } } }).data.trigger.inputFields
  assert.equal(fields[0].default, 'acme-corp')
  cleanup()
})

test('clearing a trigger input field default stores undefined, not an empty string', () => {
  let latest: FlowNode | null = null
  const node = triggerNode()
  ;(node.data as { trigger: { inputFields: { name: string; default?: string }[] } }).trigger.inputFields[0].default = 'acme-corp'
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
    } as never)
  )
  const input = getByLabelText('Default value') as HTMLInputElement
  assert.equal(input.value, 'acme-corp')
  fireEvent.change(input, { target: { value: '' } })
  assert.ok(latest)
  const fields = (latest as unknown as { data: { trigger: { inputFields: { name: string; default?: string }[] } } }).data.trigger.inputFields
  assert.equal(fields[0].default, undefined)
  cleanup()
})
