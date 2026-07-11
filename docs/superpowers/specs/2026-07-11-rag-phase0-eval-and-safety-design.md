# RAG/Agent-Response Phase 0 — Eval Backbone + Two Safety Fixes (Design)

**Status:** Design (2026-07-11)
**Phase:** 0 of the RAG/agent-response enhancement roadmap (Phase 1 retrieval quality, Phase 2 grounding, Phase 3 runtime, + cross-cutting isolation follow to come — each its own spec).

## Goal

Before optimizing retrieval or grounding, build the measurement that makes those changes provable, and fix the two live correctness bugs the current-state audit found: a per-rep privacy leak and a hallucination amplifier.

## Why Phase 0 first

The audit found **no quality eval for retrieval or grounding** (the eval harness explicitly excludes RAG, has 2 toy fixtures, and skips its judge without a key). Every retrieval/grounding change is therefore unmeasurable today — the "ship unverified" trap. It also found two bugs cheap enough to fix now: (1) agent-memory graph nodes are hardcoded `visibility: 'shared'`, leaking a private agent's learned facts across reps; (2) no relevance floor on any retrieval path, paired with a system-prompt line forbidding the model from saying it lacks info — a direct hallucination driver.

## Non-goals (deferred to later phases)

Re-ranking, hybrid dense+sparse, structure-aware chunking, re-embed-NULL-rows job, cross-source fusion (Phase 1). Chunk-level citations surfaced to users, a full faithfulness-verification pass in production (Phase 2). Output schema, parallelized retrieval/tool-discovery, streaming, transcript efficiency (Phase 3). pgvector per-rep isolation, `deleteByOwner` wiring, book-via-rep-token seam (isolation track). This phase only builds the eval and fixes the two bugs.

---

## Deliverable 1 — RAG + grounding eval harness

**Shape:** a benchmark, run on-demand (`npm run eval:rag`), NOT a per-commit CI gate — measuring *real* retrieval quality needs real Voyage embeddings, so it's gated on `VOYAGE_API_KEY` + a model key like the existing live-eval half. It emits a scorecard we track over time and use to tune Phase 0's relevance floor and Phase 1's retrieval work.

**Location:** `src/lib/eval/rag/` (new), invoked by a `package.json` script `eval:rag`.

### Corpus + golden set — synthetic, generated once, committed

1. **Seed corpus** (`src/lib/eval/rag/corpus/`): a small, committed set of Sales-AI-flavored source documents (pricing, playbooks, account notes, product FAQs — ~8-12 short docs) as plain text/markdown files. Committed, deterministic.
2. **Synthetic Q/A generation** (`src/lib/eval/rag/generate.ts`, a ONE-TIME build step run by a human with a model key): for each source doc, an LLM generates N grounded question/answer pairs, each tagged with the source doc id(s) it's answerable from and a reference answer. Output written to `src/lib/eval/rag/golden.json` and **committed** — so the eval itself is reproducible and needs no generation at run time (only embedding + judging need keys). A few adversarial "unanswerable" queries (answer NOT in the corpus) are included so we can measure the grounding-refusal fix (Deliverable 3): the correct behavior is retrieve-nothing-above-floor + "I don't know", not a fabricated answer.
3. **Regeneration** is manual and rare (`npm run eval:rag:generate`); the committed `golden.json` is the source of truth for scoring.

### Metrics

Run over a throwaway pgvector test DB seeded from the corpus (chunked + embedded via the real `ingest`/`embeddings` path), querying the **real** `retrieveKnowledge` (and, where a graph store is configured, `retrieveContext`):

- **Retrieval (deterministic given embeddings):** `recall@k` (did the gold chunk/doc for a query appear in top-k) and `MRR` (mean reciprocal rank of the first gold hit). Reported per-k (k=3,5,10) so Phase 1 re-ranking has a baseline.
- **Grounding (LLM-judge, needs a model key):** reusing `generateStructured`, a judge scores each generated answer for **faithfulness** (are its claims supported by the retrieved context) and **answer-relevance** (does it address the query). For the unanswerable queries, a **refusal** check (did the system decline rather than fabricate).
- Output: a `RagScorecard` printed + written to `src/lib/eval/rag/scorecard.latest.json` (git-ignored) — recall@k, MRR, mean faithfulness, mean answer-relevance, refusal rate.

### What it does NOT do

No hallucination *production* guard (that's Phase 2); this is a measurement harness. It does not block CI. It reuses existing `ingest`/`embeddings`/`retrieveKnowledge` — it must not fork retrieval logic (measuring the real thing is the whole point).

---

## Deliverable 2 — Fix the memory-node privacy leak

**Bug:** `indexAgentMemory` (`src/lib/rag/indexer.ts:~316`) hardcodes `visibility: 'shared'`, and `saveAgentMemory` (`src/lib/memory/agent-memory.ts:~35-133`) never passes `ownerUserId` — so a private agent's learned facts/user-answers/suggestions surface to other reps via org-wide graph search, contradicting the `run` node type which already inherits the agent's owner/visibility.

**Fix (graph-node-only, no schema change):**
- `saveAgentMemory` gains `ownerUserId` + `visibility` params, sourced from the owning agent (`AgentTask.userId`, `AgentTask.visibility`), threaded from its callers (the resume/ask-user save path and the reflection/suggestion save path in `execute-agent.ts` — the agent row is already in scope there).
- `indexAgentMemory` sets the insight node's `ownerUserId`/`visibility` from those params instead of hardcoding `shared`, mirroring the `run` node exactly (`ownerUserId: agent.userId ?? null, visibility: agent.visibility === 'private' ? 'private' : 'shared'`).
- Postgres `AgentMemory` needs no owner/visibility column — its isolation already rides on `agentId` + `agentVisibilityScope` at the API layer; only the graph node was leaking.

**Test:** extend `store-contract.test.ts` (or a focused test) asserting a private agent's memory insight node is invisible to a different viewer via `search`/`expand`, and visible to its owner; plus a unit test that `saveAgentMemory` threads a private agent's owner/visibility into the indexer call.

---

## Deliverable 3 — Fix the hallucination amplifier

Three coordinated changes:

1. **Relevance floor on retrieval injection.** Add an optional `minScore` cutoff to `retrieveKnowledge`, `retrieveAgentMemory`, and `retrieveContext` (score = `1 - cosine_distance`), so results below the floor are dropped and, when nothing clears it, nothing is injected. The floor VALUE is chosen empirically from Deliverable 1's recall@k / faithfulness curves (build the eval first, then set the threshold where faithfulness rises without tanking recall) — not guessed. Default applied at the `execute-agent.ts` injection sites; the raw retrievers keep returning scores so the eval can sweep thresholds.

2. **Grounding/refusal instruction in the RUN system prompt.** Add to `src/features/agents/system-prompt.ts` a line mirroring the chat route's existing one: *"Ground factual claims in the provided context and this run's tool results. If the context and tools don't contain the answer, say so plainly — don't guess or fabricate."*

3. **Soften the anti-hedging line.** Reword the existing `system-prompt.ts` line "Never claim you lack access to information that is present in your context…" so it distinguishes **present** (use it, don't wrongly hedge) from **absent** (say so): e.g. *"When the information IS present in your context or reachable via your tools, use it — don't wrongly claim you can't access it. When it is genuinely absent, say so rather than inventing it."* This stops the two instructions from fighting.

**Test:** a `system-prompt.test.ts` assertion that the grounding instruction is present and the softened anti-hedging wording is present; a unit test that the injection sites drop below-floor results (the eval measures the end-to-end faithfulness lift).

---

## Sequencing within Phase 0

Build order matters: **eval harness first** (Deliverable 1) → run it to establish the baseline and pick the relevance-floor value → apply Deliverable 3 (floor + prompt) and re-run the eval to show the faithfulness lift → Deliverable 2 (memory-node fix) is independent and can land any time. The two fixes are proven by: the memory-node fix by the isolation test; the hallucination fix by a measured faithfulness/refusal improvement on the eval scorecard (before/after).

## Testing summary

- Deliverable 1: the harness runs on-demand (keys required); a small structural unit test (no keys) verifies the scorecard shape + that `golden.json` parses and the metric functions (recall@k, MRR) compute correctly on synthetic fixtures.
- Deliverable 2: graph-store isolation test (private memory node hidden from non-owner) + saveAgentMemory owner-threading unit test.
- Deliverable 3: system-prompt assertions + injection-floor unit test; end-to-end faithfulness lift shown via the eval scorecard.

## Constraints

- Code style: single quotes, no semicolons, 2-space indent.
- No raw `{{token}}` in user-facing UI (not relevant here).
- No Prisma schema migration in Phase 0 (the memory-node fix is graph-only; the eval uses a throwaway DB).
- Reuse existing retrieval/ingest/embeddings code — the eval must measure the real path, and the relevance floor must live at the injection boundary, not a forked retriever.
