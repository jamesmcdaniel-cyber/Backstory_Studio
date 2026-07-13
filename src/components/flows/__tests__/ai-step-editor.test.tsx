import '@/test-support/jsdom-env'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { render, cleanup, fireEvent } from '@testing-library/react'
import { StepCard } from '../step-card'
import type { FlowNode } from '@/lib/flows/graph'

function aiNode(data: Record<string, unknown>): FlowNode {
  return { id: 'a1', type: 'ai', data: { aiOp: 'ask', ...data } } as never
}

function renderCard(node: FlowNode, onChange: (updated: FlowNode) => void) {
  return render(
    React.createElement(StepCard, {
      node,
      title: 'Ask AI',
      selected: true,
      agents: [],
      toolCatalog: [],
      onChange,
    } as never)
  )
}

test('the operation select shows humanized labels and switching writes aiOp', () => {
  let latest: FlowNode | null = null
  const { getByDisplayValue, queryByText } = renderCard(aiNode({}), (updated) => {
    latest = updated
  })
  const select = getByDisplayValue('Ask AI') as HTMLSelectElement
  assert.equal(queryByText('ask'), null, 'raw enum value never rendered')
  fireEvent.change(select, { target: { value: 'categorize' } })
  assert.ok(latest)
  assert.equal((latest as unknown as { data: { aiOp: string } }).data.aiOp, 'categorize')
  cleanup()
})

test('categorize op edits its category rows', () => {
  let latest: FlowNode | null = null
  const { getByLabelText } = renderCard(aiNode({ aiOp: 'categorize', categories: ['Urgent', ''] }), (updated) => {
    latest = updated
  })
  fireEvent.change(getByLabelText('Category 2') as HTMLInputElement, { target: { value: 'Routine' } })
  assert.ok(latest)
  assert.deepEqual((latest as unknown as { data: { categories: string[] } }).data.categories, ['Urgent', 'Routine'])
  cleanup()
})

test('extract op renders its field rows and writes outputFields', () => {
  let latest: FlowNode | null = null
  const { getByLabelText } = renderCard(aiNode({ aiOp: 'extract', outputFields: [{ name: '', type: 'string' }] }), (updated) => {
    latest = updated
  })
  fireEvent.change(getByLabelText('Extract field 1 name') as HTMLInputElement, { target: { value: 'amount' } })
  assert.ok(latest)
  const fields = (latest as unknown as { data: { outputFields: { name: string }[] } }).data.outputFields
  assert.equal(fields[0].name, 'amount')
  cleanup()
})

test('score op writes numeric bounds', () => {
  let latest: FlowNode | null = null
  const { getByLabelText } = renderCard(aiNode({ aiOp: 'score', scoreMin: 1, scoreMax: 10 }), (updated) => {
    latest = updated
  })
  fireEvent.change(getByLabelText('Highest score') as HTMLInputElement, { target: { value: '5' } })
  assert.ok(latest)
  assert.equal((latest as unknown as { data: { scoreMax: number } }).data.scoreMax, 5)
  cleanup()
})
