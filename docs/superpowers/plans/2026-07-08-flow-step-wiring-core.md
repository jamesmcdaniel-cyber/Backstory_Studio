# Flow Step Wiring Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Workstream 1 of the flow-parity spec (`docs/superpowers/specs/2026-07-08-flow-parity-design.md`): required trigger inputs, structured agent responses that feed downstream tokens, human-assistance toggle, MS-style Advanced-parameters sections, and inline token pickers on the canvas step cards.

**Architecture:** All runtime behavior lands in the pure interpreter (`src/features/flows/interpret.ts`) and small pure lib modules so it is unit-testable with `node:test`. UI changes extend the existing inline `StepCard` bodies and the `StepDrawer`, sharing one `AdvancedParamsSection` component and one advanced-params manifest so field definitions live in one place.

**Tech Stack:** Next.js 15 App Router, React 18, TypeScript, zod, Tailwind, lucide-react, `node:test` via `tsx --test`.

## Global Constraints

- Code style: single quotes, **no semicolons**, 2-space indent — match surrounding files exactly.
- Tests: `node:test` + `node:assert/strict`, files in `__tests__/*.test.ts` (plain `.ts` only — there is no React component test infra; components are verified by `npm run typecheck` + `npm run lint`).
- Run tests with `npm test` (runs every `src/**/__tests__/*.test.ts`). Single file: `npx tsx --test src/lib/flows/__tests__/graph.test.ts`.
- Local env has no Supabase vars: never run `npm run dev` / `npm run build` to verify. Verification is `npm run typecheck && npm run lint && npm test`.
- Do not rename or break existing exports (`OutputField`, `ToolCatalog`, `StepStatus`, mutation helpers) — other files import them.
- Existing token paths are `{{trigger.input.<field>}}` and `{{step.<nodeId>.output.<field>}}` — keep them; do not invent new token shapes.
- Commit after every task with the message given in that task.

---

### Task 1: Schema — required trigger inputs + agent response fields

**Files:**
- Modify: `src/lib/flows/graph.ts`
- Modify: `src/lib/flows/trigger.ts`
- Test: `src/lib/flows/__tests__/graph.test.ts`, `src/lib/flows/__tests__/trigger.test.ts`

**Interfaces:**
- Produces: `triggerInputFieldSchema` (zod), `type TriggerInputField = OutputField & { required?: boolean }`, agent node data gains `responseFormat?: 'text' | 'structured'` and `humanAssistance?: boolean`, and `triggerInputFieldsFromTrigger(trigger: unknown): TriggerInputField[]` in `trigger.ts`. Later tasks (3, 4, 6, 7) rely on these exact names.

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/flows/__tests__/graph.test.ts`:

```ts
test('triggerInputFieldSchema accepts a required flag', () => {
  const parsed = triggerInputFieldSchema.parse({ name: 'account', type: 'string', required: true })
  assert.equal(parsed.required, true)
  assert.equal(triggerInputFieldSchema.parse({ name: 'note', type: 'string' }).required, undefined)
})

test('agent nodes accept responseFormat and humanAssistance', () => {
  const graph = flowGraphSchema.parse({
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      {
        id: 'n1',
        type: 'agent',
        data: {
          agentId: 'a1',
          responseFormat: 'structured',
          humanAssistance: false,
          outputFields: [{ name: 'score', type: 'number' }],
        },
      },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 'n1' }],
  })
  const agent = graph.nodes[1]
  assert.equal(agent.type, 'agent')
  if (agent.type === 'agent') {
    assert.equal(agent.data.responseFormat, 'structured')
    assert.equal(agent.data.humanAssistance, false)
  }
})
```

Update the import at the top of that file to include the new schema:

```ts
import { flowGraphSchema, emptyGraph, triggerInputFieldSchema } from '../graph'
```

Append to `src/lib/flows/__tests__/trigger.test.ts`:

```ts
test('triggerInputFieldsFromTrigger normalizes fields and required flags', () => {
  const fields = triggerInputFieldsFromTrigger({
    type: 'manual',
    inputFields: [
      { name: 'account', type: 'string', description: 'Customer', required: true },
      { name: 'count', type: 'number' },
      { name: 'weird', type: 'nope' },
      'not-a-record',
    ],
  })
  assert.deepEqual(fields, [
    { name: 'account', type: 'string', description: 'Customer', required: true },
    { name: 'count', type: 'number', description: undefined, required: false },
    { name: 'weird', type: 'any', description: undefined, required: false },
  ])
  assert.deepEqual(triggerInputFieldsFromTrigger(undefined), [])
  assert.deepEqual(triggerInputFieldsFromTrigger({ type: 'manual' }), [])
})
```

Update that file's import line to include the new function (it currently imports from `../trigger`).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsx --test src/lib/flows/__tests__/graph.test.ts src/lib/flows/__tests__/trigger.test.ts`
Expected: FAIL — `triggerInputFieldSchema` and `triggerInputFieldsFromTrigger` are not exported.

- [ ] **Step 3: Implement the schema changes**

In `src/lib/flows/graph.ts`, directly below the `outputFieldSchema` / `OutputField` lines (line 11-12), add:

```ts
/** A trigger input field: an OutputField plus whether the run must supply it. */
export const triggerInputFieldSchema = outputFieldSchema.extend({ required: z.boolean().optional() })
export type TriggerInputField = z.infer<typeof triggerInputFieldSchema>
```

In the same file, inside `agentNode`'s `data` object (after `outputFields`, line 34), add:

```ts
    // Agent response contract: 'structured' appends a JSON instruction built
    // from outputFields and fails the step when the reply can't be parsed.
    responseFormat: z.enum(['text', 'structured']).optional(),
    // MS-parity "request human assistance when unsure": when false, a step
    // that pauses to ask a human fails instead of waiting.
    humanAssistance: z.boolean().optional(),
```

In `src/lib/flows/trigger.ts`, update the import and add the normalizer at the bottom:

```ts
import { FIELD_TYPES, type FlowGraph, type TriggerInputField } from '@/lib/flows/graph'
```

```ts
/** Normalize the trigger's declared input fields from untrusted JSON. */
export function triggerInputFieldsFromTrigger(trigger: unknown): TriggerInputField[] {
  if (!isRecord(trigger) || !Array.isArray(trigger.inputFields)) return []
  return trigger.inputFields.filter(isRecord).map((field) => ({
    name: typeof field.name === 'string' ? field.name : '',
    type: (FIELD_TYPES as readonly string[]).includes(String(field.type)) ? (field.type as TriggerInputField['type']) : 'any',
    description: typeof field.description === 'string' ? field.description : undefined,
    required: field.required === true,
  }))
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx --test src/lib/flows/__tests__/graph.test.ts src/lib/flows/__tests__/trigger.test.ts`
Expected: PASS

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck && npm run lint`
Expected: clean.

```bash
git add src/lib/flows/graph.ts src/lib/flows/trigger.ts src/lib/flows/__tests__/graph.test.ts src/lib/flows/__tests__/trigger.test.ts
git commit -m "feat(flows): add required trigger input fields and agent response schema"
```

---

### Task 2: Structured agent response helpers

**Files:**
- Create: `src/features/flows/agent-response.ts`
- Test: `src/features/flows/__tests__/agent-response.test.ts`

**Interfaces:**
- Consumes: `OutputField` from `@/lib/flows/graph`.
- Produces: `structuredResponseInstruction(fields: OutputField[]): string` and `parseStructuredAgentOutput(output: unknown, fields: OutputField[]): { output?: Record<string, unknown>; error?: string }`. Task 3 imports both.

- [ ] **Step 1: Write the failing tests**

Create `src/features/flows/__tests__/agent-response.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { structuredResponseInstruction, parseStructuredAgentOutput } from '../agent-response'

const FIELDS = [
  { name: 'score', type: 'number' as const, description: 'Fit score 0-100' },
  { name: 'summary', type: 'string' as const },
]

test('structuredResponseInstruction lists every property with its type', () => {
  const instruction = structuredResponseInstruction(FIELDS)
  assert.match(instruction, /JSON object/)
  assert.match(instruction, /"score" \(number\): Fit score 0-100/)
  assert.match(instruction, /"summary" \(string\)/)
})

test('parseStructuredAgentOutput accepts a clean JSON reply', () => {
  const result = parseStructuredAgentOutput('{"score": 88, "summary": "Great fit"}', FIELDS)
  assert.equal(result.error, undefined)
  assert.deepEqual(result.output, { score: 88, summary: 'Great fit' })
})

test('parseStructuredAgentOutput tolerates code fences and surrounding prose', () => {
  const fenced = 'Here you go:\n```json\n{"score": 12, "summary": "Weak"}\n```\nLet me know!'
  assert.deepEqual(parseStructuredAgentOutput(fenced, FIELDS).output, { score: 12, summary: 'Weak' })
})

test('parseStructuredAgentOutput accepts an already-structured object', () => {
  assert.deepEqual(parseStructuredAgentOutput({ score: 1, summary: 'x' }, FIELDS).output, { score: 1, summary: 'x' })
})

test('parseStructuredAgentOutput reports missing properties', () => {
  const result = parseStructuredAgentOutput('{"score": 5}', FIELDS)
  assert.match(result.error ?? '', /summary/)
  assert.equal(result.output, undefined)
})

test('parseStructuredAgentOutput fails on non-JSON replies', () => {
  const result = parseStructuredAgentOutput('I could not decide.', FIELDS)
  assert.match(result.error ?? '', /JSON/)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsx --test src/features/flows/__tests__/agent-response.test.ts`
Expected: FAIL — module `../agent-response` not found.

- [ ] **Step 3: Implement the module**

Create `src/features/flows/agent-response.ts`:

```ts
import type { OutputField } from '@/lib/flows/graph'

/**
 * Instruction appended to an agent step's input when the step declares a
 * structured response. Kept prompt-only: the agent runtime has no schema
 * channel, so the contract is enforced by parseStructuredAgentOutput below.
 */
export function structuredResponseInstruction(fields: OutputField[]): string {
  const lines = fields
    .filter((field) => field.name.trim())
    .map((field) => `- "${field.name.trim()}" (${field.type}${field.description ? `): ${field.description}` : ')'}`)
  return [
    'Respond ONLY with a single JSON object (no prose, no code fences) containing exactly these properties:',
    ...lines,
  ].join('\n')
}

/** Pull a JSON object out of an agent reply that may include fences or prose. */
function extractJsonObject(raw: string): Record<string, unknown> | undefined {
  const trimmed = raw.trim()
  const candidates = [trimmed]
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) candidates.push(fence[1].trim())
  const braces = trimmed.match(/\{[\s\S]*\}/)
  if (braces) candidates.push(braces[0])
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
    } catch {
      /* try the next candidate */
    }
  }
  return undefined
}

/**
 * Validate a structured agent reply against the step's declared output fields.
 * Returns the parsed object, or an actionable error for the run panel.
 */
export function parseStructuredAgentOutput(
  output: unknown,
  fields: OutputField[],
): { output?: Record<string, unknown>; error?: string } {
  const record =
    typeof output === 'string'
      ? extractJsonObject(output)
      : output && typeof output === 'object' && !Array.isArray(output)
        ? (output as Record<string, unknown>)
        : undefined
  if (!record) {
    return { error: 'The agent did not return the JSON object this step requires. Adjust the agent instructions or switch the response format to Text only.' }
  }
  const missing = fields.map((field) => field.name.trim()).filter((name) => name && record[name] === undefined)
  if (missing.length) {
    return { error: `The agent response is missing required propert${missing.length === 1 ? 'y' : 'ies'}: ${missing.join(', ')}.` }
  }
  return { output: record }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx --test src/features/flows/__tests__/agent-response.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/features/flows/agent-response.ts src/features/flows/__tests__/agent-response.test.ts
git commit -m "feat(flows): add structured agent response instruction + parser"
```

---

### Task 3: Interpreter — structured responses and human-assistance enforcement

**Files:**
- Modify: `src/features/flows/interpret.ts` (the `node.type === 'agent'` branch, lines 237-253)
- Test: `src/features/flows/__tests__/interpret.test.ts`

**Interfaces:**
- Consumes: `structuredResponseInstruction`, `parseStructuredAgentOutput` from Task 2; agent node data `responseFormat` / `humanAssistance` from Task 1.
- Produces: runtime behavior only — agent steps with `responseFormat: 'structured'` expose a parsed object as `step.<id>.output` (so `{{step.<id>.output.<field>}}` tokens resolve), and `humanAssistance: false` converts a waiting pause into a step failure.

- [ ] **Step 1: Write the failing tests**

Append to `src/features/flows/__tests__/interpret.test.ts` (match the file's existing helper style — it builds small graphs and fake `runAgent` functions; reuse its existing graph-builder helpers if present, otherwise use this standalone form):

```ts
test('structured agent steps append the JSON instruction and expose parsed fields', async () => {
  const graph = {
    nodes: [
      { id: 'trigger', type: 'trigger' as const, data: {} },
      {
        id: 'n1',
        type: 'agent' as const,
        data: {
          agentId: 'a1',
          input: 'Score this account',
          responseFormat: 'structured' as const,
          outputFields: [{ name: 'score', type: 'number' as const }],
        },
      },
      { id: 'n2', type: 'transform' as const, data: { fields: [{ name: 'finalScore', value: '{{step.n1.output.score}}' }] } },
    ],
    edges: [
      { id: 'e1', source: 'trigger', target: 'n1' },
      { id: 'e2', source: 'n1', target: 'n2' },
    ],
  }
  let sentInput = ''
  const result = await interpretFlow(graph, 'acme', {
    runAgent: async (node) => {
      sentInput = node.input
      return { output: '{"score": 91}' }
    },
  })
  assert.equal(result.status, 'succeeded')
  assert.match(sentInput, /JSON object/)
  assert.match(sentInput, /"score"/)
  assert.deepEqual(result.output, { finalScore: 91 })
})

test('structured agent steps fail when the reply is not the required JSON', async () => {
  const graph = {
    nodes: [
      { id: 'trigger', type: 'trigger' as const, data: {} },
      {
        id: 'n1',
        type: 'agent' as const,
        data: { agentId: 'a1', responseFormat: 'structured' as const, outputFields: [{ name: 'score', type: 'number' as const }] },
      },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 'n1' }],
  }
  const result = await interpretFlow(graph, '', { runAgent: async () => ({ output: 'no json here' }) })
  assert.equal(result.status, 'failed')
  const step = result.steps.find((s) => s.nodeId === 'n1')
  assert.equal(step?.status, 'failed')
  assert.match(step?.error ?? '', /JSON/)
})

test('humanAssistance=false turns a waiting agent into a failed step', async () => {
  const graph = {
    nodes: [
      { id: 'trigger', type: 'trigger' as const, data: {} },
      { id: 'n1', type: 'agent' as const, data: { agentId: 'a1', humanAssistance: false } },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 'n1' }],
  }
  const result = await interpretFlow(graph, '', {
    runAgent: async () => ({ waiting: { status: 'waiting_user', question: 'Which region?' } }),
  })
  assert.equal(result.status, 'failed')
  assert.equal(result.steps.find((s) => s.nodeId === 'n1')?.status, 'failed')
})

test('humanAssistance defaults to allowing the pause', async () => {
  const graph = {
    nodes: [
      { id: 'trigger', type: 'trigger' as const, data: {} },
      { id: 'n1', type: 'agent' as const, data: { agentId: 'a1' } },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 'n1' }],
  }
  const result = await interpretFlow(graph, '', {
    runAgent: async () => ({ waiting: { status: 'waiting_user', question: 'Which region?' } }),
  })
  assert.equal(result.status, 'waiting')
  assert.equal(result.waiting?.nodeId, 'n1')
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsx --test src/features/flows/__tests__/interpret.test.ts`
Expected: the four new tests FAIL (structured output not parsed → `finalScore` resolves to the raw string; waiting not converted to failure). Existing tests still pass.

- [ ] **Step 3: Implement the interpreter changes**

In `src/features/flows/interpret.ts`, add the import at the top:

```ts
import { structuredResponseInstruction, parseStructuredAgentOutput } from './agent-response'
```

Replace the `if (node.type === 'agent') { ... }` block (lines 237-253) with:

```ts
    if (node.type === 'agent') {
      const outputFields = node.data.outputFields ?? []
      const structured = node.data.responseFormat === 'structured' && outputFields.some((field) => field.name.trim())
      let resolved = resolveTemplate(node.data.input ?? '{{trigger.input}}', ctx)
      if (structured) resolved = `${resolved}\n\n${structuredResponseInstruction(outputFields)}`
      const res = await runAgentWithReliability(node, resolved)
      if (res.waiting) {
        if (node.data.humanAssistance === false) {
          const error = 'The agent asked for help, but human assistance is turned off for this step.'
          emit({ nodeId: node.id, status: 'failed', error })
          if ((node.data.onError ?? 'stop') === 'continue') return { kind: 'ok', output: undefined }
          return { kind: 'fail', error }
        }
        emit({ nodeId: node.id, status: 'waiting' })
        return { kind: 'pause', nodeId: node.id, question: res.waiting.question }
      }
      if (res.error) {
        emit({ nodeId: node.id, status: 'failed', error: res.error })
        if ((node.data.onError ?? 'stop') === 'continue') return { kind: 'ok', output: undefined }
        return { kind: 'fail', error: res.error }
      }
      let output = asStructured(res.output)
      if (structured) {
        const parsed = parseStructuredAgentOutput(res.output, outputFields)
        if (parsed.error) {
          emit({ nodeId: node.id, status: 'failed', error: parsed.error })
          if ((node.data.onError ?? 'stop') === 'continue') return { kind: 'ok', output: undefined }
          return { kind: 'fail', error: parsed.error }
        }
        output = parsed.output
      }
      ctx.step[node.id] = { output }
      emit({ nodeId: node.id, status: 'succeeded', output })
      return { kind: 'ok', output }
    }
```

- [ ] **Step 4: Run the full flow test suites**

Run: `npx tsx --test src/features/flows/__tests__/interpret.test.ts && npm test`
Expected: PASS — new tests green, no regressions.

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck && npm run lint`

```bash
git add src/features/flows/interpret.ts src/features/flows/__tests__/interpret.test.ts
git commit -m "feat(flows): enforce structured agent responses and human-assistance toggle in interpreter"
```

---

### Task 4: Required trigger-input validation at run time

**Files:**
- Create: `src/lib/flows/input-validation.ts`
- Modify: `src/features/flows/execute-flow.ts`
- Test: `src/lib/flows/__tests__/input-validation.test.ts`

**Interfaces:**
- Consumes: `TriggerInputField` (Task 1), `triggerInputFieldsFromTrigger` + `triggerFromGraph` from `@/lib/flows/trigger`.
- Produces: `missingRequiredInputFields(fields: TriggerInputField[], input: unknown): string[]`. `runFlowExecution` throws `ApiError(…, 400, 'FLOW_INPUT_ERROR')` when required fields are absent — both manual execute and webhook trigger routes call it, so both are covered with one change. Task 6 reuses the same function client-side.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/flows/__tests__/input-validation.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { missingRequiredInputFields } from '../input-validation'

const FIELDS = [
  { name: 'account', type: 'string' as const, required: true },
  { name: 'priority', type: 'string' as const, required: false },
  { name: 'count', type: 'number' as const, required: true },
]

test('returns empty when nothing is required', () => {
  assert.deepEqual(missingRequiredInputFields([{ name: 'a', type: 'string' as const }], undefined), [])
})

test('reports required fields missing from the payload', () => {
  assert.deepEqual(missingRequiredInputFields(FIELDS, { priority: 'high' }), ['account', 'count'])
})

test('accepts a payload that supplies every required field', () => {
  assert.deepEqual(missingRequiredInputFields(FIELDS, { account: 'Acme', count: 3 }), [])
})

test('treats empty strings and null as missing', () => {
  assert.deepEqual(missingRequiredInputFields(FIELDS, { account: '  ', count: null }), ['account', 'count'])
})

test('false and 0 count as supplied', () => {
  const fields = [{ name: 'flag', type: 'boolean' as const, required: true }, { name: 'n', type: 'number' as const, required: true }]
  assert.deepEqual(missingRequiredInputFields(fields, { flag: false, n: 0 }), [])
})

test('a non-object input misses every required field', () => {
  assert.deepEqual(missingRequiredInputFields(FIELDS, 'just text'), ['account', 'count'])
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsx --test src/lib/flows/__tests__/input-validation.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the module**

Create `src/lib/flows/input-validation.ts`:

```ts
import type { TriggerInputField } from '@/lib/flows/graph'

/**
 * Names of required trigger input fields the run payload does not supply.
 * Empty strings and null are treated as missing; false and 0 are values.
 */
export function missingRequiredInputFields(fields: TriggerInputField[], input: unknown): string[] {
  const required = fields.filter((field) => field.required && field.name.trim())
  if (!required.length) return []
  const record =
    input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : undefined
  return required
    .map((field) => field.name.trim())
    .filter((name) => {
      const value = record?.[name]
      return value === undefined || value === null || (typeof value === 'string' && !value.trim())
    })
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx --test src/lib/flows/__tests__/input-validation.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Wire into runFlowExecution**

In `src/features/flows/execute-flow.ts`:

Add imports:

```ts
import { triggerFromGraph, triggerInputFieldsFromTrigger } from '@/lib/flows/trigger'
import { missingRequiredInputFields } from '@/lib/flows/input-validation'
```

Move the `resuming` declaration up: it currently reads `const resuming = Boolean(job.flowRunId && job.reply !== undefined)` on line 71 — move that line to directly after `const input = job.input ?? ''` (line 51). Then, directly after the existing validation block (`if (!validation.ok) { throw ... }`, line 69), insert:

```ts
  // Required trigger inputs (declared on the trigger node) must be present.
  // Skipped when resuming: the original input was validated on the first run.
  if (!resuming) {
    const inputFields = triggerInputFieldsFromTrigger(triggerFromGraph(graph, flow.trigger))
    const missing = missingRequiredInputFields(inputFields, input)
    if (missing.length) {
      throw new ApiError(
        `Missing required input field${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}`,
        400,
        'FLOW_INPUT_ERROR',
      )
    }
  }
```

(Do not add a second `resuming` declaration where the old line was — delete the original.)

- [ ] **Step 6: Run everything**

Run: `npm test && npm run typecheck && npm run lint`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add src/lib/flows/input-validation.ts src/lib/flows/__tests__/input-validation.test.ts src/features/flows/execute-flow.ts
git commit -m "feat(flows): validate required trigger inputs before every run"
```

---

### Task 5: Advanced-parameters manifest + shared section component

**Files:**
- Create: `src/lib/flows/advanced-params.ts`
- Create: `src/components/flows/advanced-params.tsx`
- Modify: `src/components/flows/step-card.tsx` (append section to Agent/Tool/Http/Loop bodies)
- Modify: `src/components/flows/step-drawer.tsx` (replace ad-hoc onError/retries/timeout/bodyMode/responseType/failOnHttpError blocks for agent/tool/http with the shared component)
- Test: `src/lib/flows/__tests__/advanced-params.test.ts`

**Interfaces:**
- Consumes: `FlowNode` from graph.
- Produces: `advancedParamKeys(type: FlowNode['type']): AdvancedParamKey[]`, `advancedParamsSetCount(node: FlowNode): number` (lib) and `<AdvancedParamsSection node onChange defaultOpen? />` (component, `onChange: (node: FlowNode) => void`). Tasks 7-8 leave these untouched but the StepCard bodies they modify will already contain the section.

- [ ] **Step 1: Write the failing manifest tests**

Create `src/lib/flows/__tests__/advanced-params.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { advancedParamKeys, advancedParamsSetCount } from '../advanced-params'
import type { FlowNode } from '../graph'

test('each node type declares its advanced keys', () => {
  assert.deepEqual(advancedParamKeys('agent'), ['onError', 'retries', 'timeoutMs'])
  assert.deepEqual(advancedParamKeys('tool'), ['onError', 'retries', 'timeoutMs'])
  assert.deepEqual(advancedParamKeys('http'), ['bodyMode', 'responseType', 'failOnHttpError', 'onError', 'retries', 'timeoutMs'])
  assert.deepEqual(advancedParamKeys('loop'), ['concurrency'])
  assert.deepEqual(advancedParamKeys('trigger'), [])
})

test('advancedParamsSetCount counts only explicitly-set params', () => {
  const bare: FlowNode = { id: 'n1', type: 'http', data: { method: 'POST', url: 'https://x.test' } }
  assert.equal(advancedParamsSetCount(bare), 0)
  const tuned: FlowNode = {
    id: 'n2',
    type: 'http',
    data: { method: 'GET', url: 'https://x.test', retries: 2, failOnHttpError: false },
  }
  assert.equal(advancedParamsSetCount(tuned), 2)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsx --test src/lib/flows/__tests__/advanced-params.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the manifest**

Create `src/lib/flows/advanced-params.ts`:

```ts
import type { FlowNode } from '@/lib/flows/graph'

/**
 * The single source of truth for which optional "advanced" parameters each
 * node type supports. Powers the MS-style "Advanced parameters — Showing N of
 * M" section on step cards and in the settings drawer.
 */
export type AdvancedParamKey =
  | 'onError'
  | 'retries'
  | 'timeoutMs'
  | 'bodyMode'
  | 'responseType'
  | 'failOnHttpError'
  | 'concurrency'

const BY_TYPE: Partial<Record<FlowNode['type'], AdvancedParamKey[]>> = {
  agent: ['onError', 'retries', 'timeoutMs'],
  tool: ['onError', 'retries', 'timeoutMs'],
  http: ['bodyMode', 'responseType', 'failOnHttpError', 'onError', 'retries', 'timeoutMs'],
  loop: ['concurrency'],
}

export function advancedParamKeys(type: FlowNode['type']): AdvancedParamKey[] {
  return BY_TYPE[type] ?? []
}

/** How many of the node's advanced params are explicitly set. */
export function advancedParamsSetCount(node: FlowNode): number {
  const data = node.data as Record<string, unknown>
  return advancedParamKeys(node.type).filter((key) => data[key] !== undefined).length
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx --test src/lib/flows/__tests__/advanced-params.test.ts`
Expected: PASS

- [ ] **Step 5: Implement the shared section component**

Create `src/components/flows/advanced-params.tsx`:

```tsx
'use client'

import { useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { FlowNode } from '@/lib/flows/graph'
import { advancedParamKeys, advancedParamsSetCount, type AdvancedParamKey } from '@/lib/flows/advanced-params'
import { AGENT_RUN_MAX_DURATION_SECONDS } from '@/lib/agents/timeouts'

const controlClass =
  'h-9 w-full rounded-md border border-slate-300 bg-white px-2.5 text-sm text-slate-950 outline-none transition-colors hover:border-slate-400 focus:border-blue-500 focus:ring-2 focus:ring-blue-100'
const labelClass = 'text-[11px] font-semibold uppercase tracking-wide text-slate-500'

/**
 * MS-parity "Advanced parameters" section: collapsed summary ("Showing N of
 * M"), Show all / Clear all, and the per-key controls declared by the
 * advanced-params manifest. Shared by the step card and the settings drawer.
 */
export function AdvancedParamsSection({
  node,
  onChange,
  defaultOpen = false,
}: {
  node: FlowNode
  onChange: (node: FlowNode) => void
  defaultOpen?: boolean
}) {
  const keys = advancedParamKeys(node.type)
  const [open, setOpen] = useState(defaultOpen)
  if (!keys.length) return null

  const data = node.data as Record<string, unknown>
  const setCount = advancedParamsSetCount(node)
  const patch = (values: Record<string, unknown>) => onChange({ ...node, data: { ...node.data, ...values } } as FlowNode)
  const clearAll = () => patch(Object.fromEntries(keys.map((key) => [key, undefined])))
  const maxTimeoutSeconds = node.type === 'agent' ? AGENT_RUN_MAX_DURATION_SECONDS : 120

  const control = (key: AdvancedParamKey) => {
    if (key === 'onError') {
      return (
        <select
          className={controlClass}
          value={(data.onError as string | undefined) ?? 'stop'}
          onChange={(event) => patch({ onError: event.target.value })}
        >
          <option value="stop">Stop flow on error</option>
          <option value="continue">Continue on error</option>
        </select>
      )
    }
    if (key === 'retries') {
      return (
        <input
          type="number"
          min={0}
          max={5}
          className={controlClass}
          value={(data.retries as number | undefined) ?? 0}
          onChange={(event) => patch({ retries: Math.max(0, Math.min(5, Number(event.target.value) || 0)) })}
        />
      )
    }
    if (key === 'timeoutMs') {
      const timeoutMs = data.timeoutMs as number | undefined
      return (
        <input
          type="number"
          min={1}
          max={maxTimeoutSeconds}
          className={controlClass}
          placeholder="No timeout"
          value={timeoutMs ? Math.round(timeoutMs / 1000) : ''}
          onChange={(event) => {
            const secs = Number(event.target.value)
            patch({ timeoutMs: secs > 0 ? Math.max(1, Math.min(maxTimeoutSeconds, secs)) * 1000 : undefined })
          }}
        />
      )
    }
    if (key === 'bodyMode') {
      return (
        <select className={controlClass} value={(data.bodyMode as string | undefined) ?? 'json'} onChange={(event) => patch({ bodyMode: event.target.value })}>
          <option value="json">JSON body</option>
          <option value="text">Text body</option>
          <option value="none">No body</option>
        </select>
      )
    }
    if (key === 'responseType') {
      return (
        <select className={controlClass} value={(data.responseType as string | undefined) ?? 'auto'} onChange={(event) => patch({ responseType: event.target.value })}>
          <option value="auto">Parse response automatically</option>
          <option value="json">Parse response as JSON</option>
          <option value="text">Parse response as text</option>
        </select>
      )
    }
    if (key === 'failOnHttpError') {
      return (
        <select
          className={controlClass}
          value={data.failOnHttpError === false ? 'false' : 'true'}
          onChange={(event) => patch({ failOnHttpError: event.target.value !== 'false' })}
        >
          <option value="true">Fail on 4xx/5xx</option>
          <option value="false">Return the response</option>
        </select>
      )
    }
    // concurrency
    return (
      <input
        type="number"
        min={1}
        max={20}
        className={controlClass}
        value={(data.concurrency as number | undefined) ?? 3}
        onChange={(event) => patch({ concurrency: Math.max(1, Math.min(20, Number(event.target.value) || 1)) })}
      />
    )
  }

  const LABELS: Record<AdvancedParamKey, string> = {
    onError: 'On error',
    retries: 'Retries',
    timeoutMs: 'Timeout (seconds)',
    bodyMode: 'Body type',
    responseType: 'Parse response as',
    failOnHttpError: 'HTTP errors',
    concurrency: 'At a time',
  }

  return (
    <div className="border-t border-slate-200 pt-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-semibold text-slate-900">Advanced parameters</p>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setOpen((value) => !value)}
            className="flex items-center gap-1.5 rounded-md border border-slate-300 px-2.5 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
          >
            {open ? 'Hide all' : `Showing ${setCount} of ${keys.length} — Show all`}
            <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-180')} />
          </button>
          <button
            type="button"
            onClick={clearAll}
            disabled={setCount === 0}
            className="rounded-md px-2 py-1.5 text-xs font-semibold text-slate-500 hover:text-slate-900 disabled:pointer-events-none disabled:opacity-40"
          >
            Clear all
          </button>
        </div>
      </div>
      {open && (
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {keys.map((key) => (
            <div key={key} className="grid gap-1.5">
              <label className={labelClass}>{LABELS[key]}</label>
              {control(key)}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 6: Use it in StepCard**

In `src/components/flows/step-card.tsx`:

Add import:

```ts
import { AdvancedParamsSection } from './advanced-params'
```

Append `<AdvancedParamsSection node={node} onChange={update} />` as the last child of the returned wrapper `div` in `AgentBody`, `HttpBody`, `ToolBody`, and `LoopBody` (each already receives `update`). Example for `HttpBody` — its return becomes:

```tsx
  return (
    <div className="space-y-4">
      {/* ...existing URI/Method/Headers/Queries/Body fields unchanged... */}
      <AdvancedParamsSection node={node} onChange={update} />
    </div>
  )
```

- [ ] **Step 7: Use it in StepDrawer**

In `src/components/flows/step-drawer.tsx`:

Add import:

```ts
import { AdvancedParamsSection } from '@/components/flows/advanced-params'
```

- In the `node.type === 'agent'` block: delete the `On error`/`Retries` two-column grid and the `Timeout (seconds, optional)` block (lines 422-460) and put `<AdvancedParamsSection node={node} onChange={onChange} defaultOpen />` in their place (before `OutputFieldsEditor`).
- In the `node.type === 'tool'` block: delete its `On error`/`Retries` grid and `Timeout` block (lines 619-657) and add `<AdvancedParamsSection node={node} onChange={onChange} defaultOpen />` in their place.
- In the `node.type === 'http'` block: delete the `Body type`/`Parse response as` grid (lines 718-743), the `Fail on HTTP error`/`Timeout` grid (lines 759-786), and the `On error`/`Retries` grid (lines 787-810). Add `<AdvancedParamsSection node={node} onChange={onChange} defaultOpen />` after the Body textarea's `DataTree`. The Body textarea's `disabled={(node.data.bodyMode ?? 'json') === 'none'}` logic stays as-is.

- [ ] **Step 8: Verify**

Run: `npm run typecheck && npm run lint && npm test`
Expected: clean; no unused-variable lint errors from the deleted drawer blocks (remove now-unused imports if eslint flags them).

- [ ] **Step 9: Commit**

```bash
git add src/lib/flows/advanced-params.ts src/lib/flows/__tests__/advanced-params.test.ts src/components/flows/advanced-params.tsx src/components/flows/step-card.tsx src/components/flows/step-drawer.tsx
git commit -m "feat(flows): shared MS-style advanced parameters section for cards and drawer"
```

---

### Task 6: Required-input UI — trigger toggle, test panel markers, run pre-check

**Files:**
- Modify: `src/components/flows/step-card.tsx` (TriggerBody: required toggle; reuse shared normalizer)
- Modify: `src/components/flows/step-drawer.tsx` (InputFieldsEditor: required checkbox)
- Modify: `src/components/flows/test-input-panel.tsx` (required markers)
- Modify: `src/app/flows/[id]/page.tsx` (use shared normalizer; block Run when required fields are empty)

**Interfaces:**
- Consumes: `TriggerInputField`, `triggerInputFieldsFromTrigger` (Task 1), `missingRequiredInputFields` (Task 4).
- Produces: `TestInputPanel` prop type widens from `OutputField[]` to `TriggerInputField[]` (backward compatible — `required` is optional).

- [ ] **Step 1: StepCard trigger required toggle**

In `src/components/flows/step-card.tsx`:

Update imports:

```ts
import { CONDITION_OPS, type ConditionClause, type ConditionOp, type FlowNode, type OutputField, type TriggerInputField } from '@/lib/flows/graph'
import { triggerInputFieldsFromTrigger } from '@/lib/flows/trigger'
```

Change `TriggerData` (line 35) to:

```ts
type TriggerData = { type?: 'manual' | 'schedule' | 'webhook' | 'signal'; inputFields?: TriggerInputField[]; input?: string }
```

Delete the local `triggerFields()` helper (lines 108-118) and replace its usages with the shared normalizer — in `TriggerBody`:

```ts
  const fields = triggerInputFieldsFromTrigger(trigger)
```

Update `updateField`'s patch type to `Partial<TriggerInputField>`, and in the field row grid change the template to add a Required cell — replace the row's `sm:grid-cols-[42px_minmax(120px,0.7fr)_minmax(180px,1fr)_36px]` with `sm:grid-cols-[42px_minmax(120px,0.7fr)_minmax(150px,1fr)_auto_36px]` and insert this element between the description input and the remove button:

```tsx
                <label className="flex items-center gap-1.5 text-xs font-medium text-slate-600" title="The run must supply this value">
                  <input
                    type="checkbox"
                    checked={field.required === true}
                    onChange={(event) => updateField(fieldIndex, { required: event.target.checked || undefined })}
                    className="h-4 w-4 rounded border-slate-300 text-blue-600"
                  />
                  Required
                </label>
```

- [ ] **Step 2: Drawer InputFieldsEditor required checkbox**

In `src/components/flows/step-drawer.tsx`:

- Change `TriggerData.inputFields` (line 42) to `TriggerInputField[]` and import the type: add `type TriggerInputField` to the graph import on line 7.
- Change `InputFieldsEditor`'s props to `{ fields: TriggerInputField[]; onChange: (fields: TriggerInputField[]) => void }`.
- Inside its per-field card, after the description input, add:

```tsx
            <label className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
              <input
                type="checkbox"
                checked={field.required === true}
                onChange={(e) => onChange(fields.map((f, j) => (j === i ? { ...f, required: e.target.checked || undefined } : f)))}
                className="h-3.5 w-3.5 rounded border-border"
              />
              Required — the run must supply this value
            </label>
```

- [ ] **Step 3: TestInputPanel required markers**

In `src/components/flows/test-input-panel.tsx`:

- Change the import to `import type { TriggerInputField } from '@/lib/flows/graph'` and the `fields` prop type to `TriggerInputField[]` (both in `TestInputPanel` and `inputForField`'s `field` param can stay `OutputField`-shaped; simplest is to change both to `TriggerInputField`).
- In the field label, after the type badge, add:

```tsx
                  {field.required && <span className="text-red-500" title="Required">*</span>}
```

- [ ] **Step 4: Builder page — shared normalizer + run pre-check**

In `src/app/flows/[id]/page.tsx`:

- Add imports:

```ts
import { triggerInputFieldsFromTrigger } from '@/lib/flows/trigger'
import { missingRequiredInputFields } from '@/lib/flows/input-validation'
```

- Replace the local `triggerInputFields()` helper (lines 91-100) with:

```ts
function triggerInputFields(graph: FlowGraph) {
  const triggerNode = graph.nodes.find((node): node is Extract<FlowNode, { type: 'trigger' }> => node.type === 'trigger')
  return triggerInputFieldsFromTrigger(triggerNode?.data.trigger)
}
```

(The `isRecord` helper stays — other code uses it.)

- In the `run` callback, after the validation check and before `setRunning(true)`, add:

```ts
    const missing = missingRequiredInputFields(inputFields, parseFlowInput(testInput))
    if (missing.length) {
      toast.error(`Fill the required input field${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}`)
      setShowTestInput(true)
      setMode('build')
      return
    }
```

and add `inputFields` to the `run` callback's dependency array.

- [ ] **Step 5: Verify and commit**

Run: `npm run typecheck && npm run lint && npm test`
Expected: clean.

```bash
git add src/components/flows/step-card.tsx src/components/flows/step-drawer.tsx src/components/flows/test-input-panel.tsx 'src/app/flows/[id]/page.tsx'
git commit -m "feat(flows): required trigger inputs — toggle, test-panel markers, run pre-check"
```

---

### Task 7: Run-an-agent parity UI

**Files:**
- Modify: `src/components/flows/step-card.tsx` (AgentBody: refresh + New agent, human-assistance toggle, response format + structured fields editor)
- Modify: `src/components/flows/step-drawer.tsx` (agent section: same controls above OutputFieldsEditor)
- Modify: `src/components/flows/flow-canvas.tsx` (thread `onRefreshAgents`)
- Modify: `src/app/flows/[id]/page.tsx` (refreshAgents callback)

**Interfaces:**
- Consumes: agent node data `responseFormat` / `humanAssistance` (Task 1), `FIELD_TYPES` from graph.
- Produces: `StepCard` gains optional prop `onRefreshAgents?: () => void`; `FlowCanvas` gains the same prop and passes it through. Agents are created on `/dashboard` — the "New agent" link opens it in a new tab.

- [ ] **Step 1: StepCard AgentBody parity controls**

In `src/components/flows/step-card.tsx`:

- Add `RefreshCw` and `ExternalLink` to the lucide import, and `FIELD_TYPES` to the graph import.
- Add `onRefreshAgents?: () => void` to `StepCard`'s props and thread it into `renderNodeBody` and `AgentBody`.
- Replace `AgentBody` with:

```tsx
function AgentBody({
  node,
  agents,
  update,
  onRefreshAgents,
}: {
  node: Extract<FlowNode, { type: 'agent' }>
  agents: Agent[]
  update: (node: FlowNode) => void
  onRefreshAgents?: () => void
}) {
  const isDefaultInput = defaultAgentInput(node.data.input)
  const responseFormat = node.data.responseFormat ?? 'text'
  const outputFields = node.data.outputFields ?? []
  const setOutputFields = (fields: OutputField[]) =>
    update({ ...node, data: { ...node.data, outputFields: fields.length ? fields : undefined } })
  return (
    <div className="space-y-4">
      <div className="grid gap-2">
        <label className={labelClass}>Agent <span className="text-red-500">*</span></label>
        <div className="flex items-center gap-2">
          <select
            value={node.data.agentId}
            onChange={(event) => update({ ...node, data: { ...node.data, agentId: event.target.value } })}
            className={cn(controlClass, 'min-w-0 flex-1')}
          >
            <option value="">Choose an agent</option>
            {agents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.title}
              </option>
            ))}
          </select>
          {onRefreshAgents && (
            <button
              type="button"
              onClick={onRefreshAgents}
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-slate-300 text-slate-500 hover:bg-slate-100 hover:text-slate-900"
              aria-label="Refresh agent list"
              title="Refresh agent list"
            >
              <RefreshCw className="h-4 w-4" />
            </button>
          )}
          <a
            href="/dashboard"
            target="_blank"
            rel="noreferrer"
            className="flex h-10 shrink-0 items-center gap-1.5 rounded-md border border-slate-300 px-3 text-sm font-semibold text-slate-700 hover:bg-slate-50"
            title="Create a new agent on the dashboard"
          >
            <Plus className="h-4 w-4" /> New
          </a>
        </div>
      </div>
      <div className="grid gap-2">
        <label className={labelClass}>Message to agent</label>
        <textarea
          value={isDefaultInput ? '' : node.data.input ?? ''}
          onChange={(event) => update({ ...node, data: { ...node.data, input: event.target.value } })}
          className={textareaClass}
          placeholder={isDefaultInput ? 'Uses the trigger input by default. Add instructions here if needed.' : 'Tell the agent what to do at this step.'}
        />
      </div>
      <div className="flex items-start justify-between gap-3 rounded-lg bg-slate-50 p-3">
        <div>
          <p className="text-sm font-semibold text-slate-900">Request human assistance when unsure</p>
          <p className="mt-0.5 text-xs text-slate-500">When the agent isn&apos;t sure how to proceed, the flow pauses and asks for input.</p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={node.data.humanAssistance !== false}
          onClick={() => update({ ...node, data: { ...node.data, humanAssistance: node.data.humanAssistance === false ? undefined : false } })}
          className={cn(
            'relative mt-0.5 h-6 w-11 shrink-0 rounded-full transition-colors',
            node.data.humanAssistance !== false ? 'bg-blue-600' : 'bg-slate-300',
          )}
        >
          <span
            className={cn(
              'absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all',
              node.data.humanAssistance !== false ? 'left-[22px]' : 'left-0.5',
            )}
          />
        </button>
      </div>
      <div className="grid gap-2">
        <div className="flex items-center justify-between">
          <label className={labelClass}>Agent response</label>
          <select
            value={responseFormat}
            onChange={(event) =>
              update({ ...node, data: { ...node.data, responseFormat: event.target.value === 'structured' ? 'structured' : undefined } })
            }
            className="h-8 rounded-md border border-slate-300 bg-white px-2 text-xs font-semibold text-slate-700 outline-none"
          >
            <option value="text">Text only</option>
            <option value="structured">Structured</option>
          </select>
        </div>
        <p className="text-xs text-slate-500">
          {responseFormat === 'structured'
            ? 'The agent must reply with JSON matching these properties; each becomes data for later steps.'
            : 'The agent replies with plain text. Switch to Structured to map fields into later steps.'}
        </p>
        {responseFormat === 'structured' && (
          <div className="space-y-2">
            {outputFields.map((field, index) => (
              <div key={index} className="grid gap-2 sm:grid-cols-[1fr_120px_36px]">
                <input
                  value={field.name}
                  onChange={(event) => setOutputFields(outputFields.map((entry, j) => (j === index ? { ...entry, name: event.target.value } : entry)))}
                  className={controlClass}
                  placeholder="propertyName"
                />
                <select
                  value={field.type}
                  onChange={(event) => setOutputFields(outputFields.map((entry, j) => (j === index ? { ...entry, type: event.target.value as OutputField['type'] } : entry)))}
                  className={controlClass}
                >
                  {FIELD_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {type}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => setOutputFields(outputFields.filter((_, j) => j !== index))}
                  className="flex h-10 w-10 items-center justify-center rounded-md text-slate-400 hover:bg-red-50 hover:text-red-600"
                  aria-label="Remove property"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            ))}
            <button
              type="button"
              onClick={() => setOutputFields([...outputFields, { name: '', type: 'string' }])}
              className="text-sm font-semibold text-blue-700 hover:text-blue-900"
            >
              Add property
            </button>
          </div>
        )}
      </div>
      <AdvancedParamsSection node={node} onChange={update} />
    </div>
  )
}
```

(Note: `AdvancedParamsSection` was already appended in Task 5 — this replacement keeps it. `ExternalLink` ends up unused if you follow this snippet; only import icons you use.)

- Update the `renderNodeBody` switch's agent case to pass the prop: `return <AgentBody node={node} agents={agents} update={update} onRefreshAgents={onRefreshAgents} />` and add `onRefreshAgents` to `renderNodeBody`'s params and to the call site inside `StepCard`.

- [ ] **Step 2: Drawer agent section parity**

In `src/components/flows/step-drawer.tsx`, inside the `node.type === 'agent'` block, directly before `<OutputFieldsEditor …/>`, add:

```tsx
            <div>
              <label className={labelClass}>Human assistance</label>
              <select
                className={fieldClass}
                value={node.data.humanAssistance === false ? 'off' : 'on'}
                onChange={(e) => onChange({ ...node, data: { ...node.data, humanAssistance: e.target.value === 'off' ? false : undefined } })}
              >
                <option value="on">Pause and ask when unsure</option>
                <option value="off">Never ask — fail instead</option>
              </select>
            </div>
            <div>
              <label className={labelClass}>Agent response</label>
              <select
                className={fieldClass}
                value={node.data.responseFormat ?? 'text'}
                onChange={(e) => onChange({ ...node, data: { ...node.data, responseFormat: e.target.value === 'structured' ? 'structured' : undefined } })}
              >
                <option value="text">Text only</option>
                <option value="structured">Structured (JSON matching output fields)</option>
              </select>
              {node.data.responseFormat === 'structured' && !(node.data.outputFields ?? []).some((f) => f.name.trim()) && (
                <p className="mt-1.5 text-xs text-amber-600">Add at least one output field below to define the JSON shape.</p>
              )}
            </div>
```

- [ ] **Step 3: Thread onRefreshAgents through FlowCanvas and the page**

In `src/components/flows/flow-canvas.tsx`:
- Add `onRefreshAgents?: () => void` to `FlowCanvas`'s props.
- In the `card(...)` helper, pass `onRefreshAgents={onRefreshAgents}` to `StepCard`.

In `src/app/flows/[id]/page.tsx`:
- Add the callback near the other callbacks:

```ts
  const refreshAgents = useCallback(async () => {
    const data = await fetch('/api/agents', { cache: 'no-store' }).then((r) => r.json()).catch(() => null)
    if (data?.success) setAgents(data.agents.map((a: Agent) => ({ id: a.id, title: a.title })))
  }, [])
```

- Pass `onRefreshAgents={refreshAgents}` to `<FlowCanvas …/>`.

- [ ] **Step 4: Verify and commit**

Run: `npm run typecheck && npm run lint && npm test`
Expected: clean.

```bash
git add src/components/flows/step-card.tsx src/components/flows/step-drawer.tsx src/components/flows/flow-canvas.tsx 'src/app/flows/[id]/page.tsx'
git commit -m "feat(flows): run-an-agent parity — refresh/new agent, human assistance, structured response"
```

---

### Task 8: Inline token picker on the selected step card

**Files:**
- Create: `src/components/flows/insert-token.ts`
- Modify: `src/components/flows/step-card.tsx` (token targets + picker; required markers on primary fields)
- Modify: `src/components/flows/flow-canvas.tsx` (thread `dataFields` to the selected card)
- Modify: `src/app/flows/[id]/page.tsx` (pass `dataFields`)
- Modify: `src/components/flows/step-drawer.tsx` (reuse the shared caret helper — delete its local `insertToken` caret logic body in favor of the helper)

**Interfaces:**
- Consumes: `DataTree` component, `DataField` from `@/lib/flows/datatree`, `dataFields` computed in the builder page (already exists, keyed to the selected node).
- Produces: `insertAtCaret(current: string, token: string, el: HTMLInputElement | HTMLTextAreaElement | null): string` in `insert-token.ts`; `StepCard` prop `dataFields?: DataField[]`; `FlowCanvas` prop `dataFields?: DataField[]`.

- [ ] **Step 1: Create the shared caret helper**

Create `src/components/flows/insert-token.ts`:

```ts
/**
 * Insert `token` into `current` at the element's caret (replacing any
 * selection) and restore focus. Appends when no element/caret is available.
 */
export function insertAtCaret(
  current: string,
  token: string,
  el: HTMLInputElement | HTMLTextAreaElement | null,
): string {
  if (!el || typeof el.selectionStart !== 'number') return current ? `${current} ${token}` : token
  const start = el.selectionStart
  const end = el.selectionEnd ?? start
  const next = current.slice(0, start) + token + current.slice(end)
  const pos = start + token.length
  requestAnimationFrame(() => {
    try {
      el.focus()
      el.setSelectionRange(pos, pos)
    } catch {
      /* element unmounted */
    }
  })
  return next
}
```

- [ ] **Step 2: Reuse it in StepDrawer**

In `src/components/flows/step-drawer.tsx`, import it and replace the body of `insertToken` (lines 326-347) with:

```ts
  const insertToken = (token: string) => {
    const acc = activeAccessor()
    if (!acc) return
    acc.set(insertAtCaret(acc.get(), token, activeElRef.current))
  }
```

- [ ] **Step 3: StepCard token targets and picker**

In `src/components/flows/step-card.tsx`:

- Add imports:

```ts
import { useRef, useState, type KeyboardEvent } from 'react'
import { DataTree } from './data-tree'
import { insertAtCaret } from './insert-token'
import type { DataField } from '@/lib/flows/datatree'
```

- Add types near the top:

```ts
type TokenTarget = { el: HTMLInputElement | HTMLTextAreaElement; get: () => string; set: (value: string) => void }
export type RegisterTokenTarget = (
  get: () => string,
  set: (value: string) => void,
) => (event: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => void
```

- In `StepCard`, add props `dataFields?: DataField[]` and create the target ref + registrar:

```ts
  const tokenTargetRef = useRef<TokenTarget | null>(null)
  const registerTokenTarget: RegisterTokenTarget = (get, set) => (event) => {
    tokenTargetRef.current = { el: event.currentTarget, get, set }
  }
  const insertToken = (token: string) => {
    const target = tokenTargetRef.current
    if (!target) return
    target.set(insertAtCaret(target.get(), token, target.el))
  }
```

- Pass `registerTokenTarget` through `renderNodeBody` into the bodies, and attach `onFocus={registerTokenTarget(get, set)}` to these fields (each `get`/`set` pair mirrors the field's existing `value`/`onChange`):
  - `AgentBody`: message textarea — `registerTokenTarget(() => (isDefaultInput ? '' : node.data.input ?? ''), (v) => update({ ...node, data: { ...node.data, input: v } }))`
  - `HttpBody`: URI input and Body textarea (same pattern with `url` / `body`)
  - `InlineKeyValue`: each value input — `registerTokenTarget(() => rows[index]?.value ?? '', (v) => updateRow(index, { value: v }))` (thread `registerTokenTarget` in as a prop)
  - `ConditionBody`: left and right inputs
  - `TransformBody`: each value input
  - `LoopBody`: the custom-list input
  - `SwitchBody`: left and right inputs
- Below the body container (inside the same `stopEvent` div, after `renderNodeBody(...)`), render the picker only for the selected card:

```tsx
        {selected && dataFields && dataFields.length > 0 && (
          <div className="mt-4 border-t border-slate-200 pt-3">
            <DataTree
              fields={dataFields}
              onInsert={insertToken}
              title="Insert data from previous steps"
              emptyMessage="No earlier step data is available yet."
            />
          </div>
        )}
```

- Required markers on primary fields (MS parity): in `HttpBody` change the URI and Method labels to `URI <span className="text-red-500">*</span>` and `Method <span className="text-red-500">*</span>`; in `ToolBody` do the same for Connection and Action labels. (`AgentBody`'s Agent label got its marker in Task 7.)

- [ ] **Step 4: Thread dataFields through FlowCanvas and the page**

In `src/components/flows/flow-canvas.tsx`:
- Add `dataFields?: DataField[]` to props (`import type { DataField } from '@/lib/flows/datatree'`).
- In `card(...)`: `dataFields={selectedId === node.id ? dataFields : undefined}`.

In `src/app/flows/[id]/page.tsx`, pass `dataFields={dataFields}` to `<FlowCanvas …/>` (the memo already computes fields for the selected node; it returns `[]` for the trigger, so trigger cards show no picker).

- [ ] **Step 5: Verify and commit**

Run: `npm run typecheck && npm run lint && npm test`
Expected: clean.

```bash
git add src/components/flows/insert-token.ts src/components/flows/step-card.tsx src/components/flows/step-drawer.tsx src/components/flows/flow-canvas.tsx 'src/app/flows/[id]/page.tsx'
git commit -m "feat(flows): inline token picker and required markers on canvas step cards"
```

---

### Task 9: Final verification pass

**Files:** none new.

- [ ] **Step 1: Full suite**

Run: `npm run typecheck && npm run lint && npm test`
Expected: all clean/green.

- [ ] **Step 2: Manual smoke checklist (no local DB — UI-only checks via typecheck-backed reasoning or a Vercel preview)**

Confirm in code review terms:
- Trigger card: Add an input → chip types → row shows name/prompt/Required toggle.
- Agent card: agent select with refresh + New, assistance toggle, Agent response Text/Structured with property rows, Advanced parameters "Showing N of M".
- HTTP card: URI*/Method* markers, Advanced parameters includes bodyMode/responseType/failOnHttpError/onError/retries/timeout.
- Selected card shows "Insert data from previous steps"; clicking a field inserts `{{…}}` at the caret.
- Drawer: agent human-assistance + response format selects; advanced sections now come from the shared component.

- [ ] **Step 3: Commit any straggler fixes and stop**

This completes Workstream 1. Workstream 2 (picker/catalog UX) is planned separately.
