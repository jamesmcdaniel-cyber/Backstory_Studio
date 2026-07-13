# AI Steps Suite — First-Class AI Operations in Flows (WS14)

**Date:** 2026-07-13
**Status:** Approved (design confirmed by James; part 1 of the green-lit Gumloop full-parity roadmap: AI steps → subflows → knowledge/quick-wins → files)

## Problem

Gumloop ships ~15 purpose-built AI nodes (Ask AI, Extract Data, Categorizer, Summarizer, Scorer…). Our only AI leaf is "Run an agent", which requires a pre-built roster agent — there is no way to drop a one-off "ask AI about this" or "extract these fields from that text" step into a flow.

## Design

### Step model — one `ai` node, five ops (the `data`/`dataOp` house pattern)

```
{ type: 'ai', data: {
    aiOp: 'ask' | 'extract' | 'categorize' | 'summarize' | 'score',
    input: string,                    // templated content to operate on (chip editor)
    instructions?: string,            // ask: the prompt (required-in-practice); others: optional guidance
    model?: 'fast' | 'smart',         // tier → DEFAULT_SUMMARY_MODEL / DEFAULT_AGENT_MODEL; default 'fast'
    outputFields?: OutputField[],     // extract ONLY: the fields to pull (≥1 named required)
    categories?: string[],            // categorize ONLY: the label set (≥2 required)
    scoreMin?: number, scoreMax?: number, // score ONLY: defaults 1 / 10
    label?, note?,
    onError?: 'stop' | 'continue' | 'route',
    retries?, timeoutMs?,             // same reliability envelope as agent/tool/http
} }
```

### Outputs (downstream token contract)

- `ask`, `summarize` → text (string output).
- `extract` → object shaped by `outputFields` → `{{step.x.output.<field>}}`.
- `categorize` → `{ category: string }` (always one of `categories`).
- `score` → `{ score: number, reason: string }` (score within [min,max]).

### Execution

- Interpreter: `RunActionFn`'s `kind` union gains `'ai'`; the `ai` node case resolves templates (input, instructions, categories are static), then calls the adapter through the SAME per-step retry/timeout policy wrapper tool/http use. Structured-parse failure surfaces as a step failure (so `onError: 'route'` catches it).
- Adapter (execute-flow): builds an op-specific prompt (pure builders in a new `src/lib/flows/ai-prompts.ts`), calls `createModelRunner(tierModel)` single-turn (no tools), and for extract/categorize/score appends `structuredResponseInstruction(...)` + parses with `parseStructuredAgentOutput(...)` (the agent step's proven machinery — categorize/score reuse it with synthetic OutputField lists). Category replies are validated against the declared set (fail with a clear error when the model returns an unknown label). Score is clamped/validated numeric.
- Persistence: a FlowRunStep like tool/http steps (no AgentExecution row — this is not an agent run).
- Billing rides the platform Anthropic key exactly like agents/copilot.

### Validation

- `extract` with zero named `outputFields` → error `"{label} needs at least one field to extract."`
- `categorize` with fewer than 2 non-blank categories → error `"{label} needs at least two categories."`
- `score` with `scoreMin >= scoreMax` → error.
- Blank `input` → warning (`"{label} has no input — it will run on empty text."`).

### Builder UX + copilot (full new-node ripple)

- Picker: the AI group becomes six leaves — Ask AI, Extract data, Categorize, Summarize, Score (seeding `aiOp` + sensible default data), plus the existing "Run an agent".
- Editors (card AND drawer): input (TokenTextEditor), instructions textarea, model tier select; op-specific: outputFields editor (reuse the agent step's), categories chip/list editor, score min/max numbers. onError select present (advanced params parity).
- Canvas: titles 'Ask AI' / 'Extract data' / 'Categorize' / 'Summarize' / 'Score'; subtitle = first line of instructions or input.
- DataTree: extract exposes its outputFields as typed children; categorize/score expose `category` / `score`,`reason`.
- Copilot: STEP_TYPES += 'ai'; grounding documents the op shapes + when to prefer an `ai` step over an agent step; OPS_CONTRACT add-op list += 'ai'.
- Humanized labels everywhere; NO raw enum strings user-visible.

### Testing

Pure interpreter tests with an injected fake `runAction` (ai kind): each op's output contract; structured-failure + onError route/continue; retry/timeout policy applies. Prompt-builder unit tests (exact instruction text, category enum injection, score bounds). Validation tests. Component tests for both editors (op switch, categories add/remove, extract fields). Copilot ops test accepts `{"op":"add","type":"ai"}`.

## Non-goals (YAGNI)

Image/video/audio ops, per-step API keys or non-Anthropic providers, "define AI function" (subflows cover it next), AI-filter/list-sorter (the filter/data steps + an ask step cover them), streaming partial output to the canvas.
