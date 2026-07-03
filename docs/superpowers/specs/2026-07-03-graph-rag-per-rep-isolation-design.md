# Graph-RAG per-rep data isolation

**Date:** 2026-07-03
**Status:** Approved (design)

## Problem

Graph-RAG nodes are scoped by `organizationId` only. On a multi-rep org, rep A's
agent can surface correlated context (accounts, opportunities, signals, prior
runs) drawn from rep B's book, because vector `search` / graph `expand` filter by
org alone. For a delivery surface where every rep "has Sales AI," that's a
privacy/correctness gap, not just cosmetics.

The People.ai org **service key returns the whole org book** by design; the only
reliable per-rep signal is a rep's **own** People.ai token, which naturally
returns just their book.

## Posture (chosen)

**Owner-tagged, private-by-default.** Graph nodes carry an owner + visibility.
Data indexed via a rep's own token is private to them; service-key/webhook data
stays org-shared. Rep-private book scoping switches on automatically as reps
connect their own People.ai — no owner-name matching. Backward compatible:
existing backfilled nodes read as shared.

## Design

### Node model (`store.ts`)
Add to `GraphNode` and `PendingNode`:
- `ownerUserId?: string | null` — null = no individual owner
- `visibility?: 'shared' | 'private'` — default `'shared'`

**Visibility contract** — a node is visible to viewer `V` iff
`organizationId == O AND (visibility != 'private' OR ownerUserId == V)`.
Equivalently, hidden iff `visibility == 'private' && ownerUserId != V`. This
mirrors the existing Prisma `agentVisibilityScope` / `executionVisibilityScope`
semantics so RAG isolation matches row-level isolation.

### Store interface
- `search(org, viewerUserId, vec, k)` and `expand(org, viewerUserId, ids, hops)`
  (`viewerUserId: string | null`; null sees only shared nodes).
- `MemoryGraphStore`: filter in JS via a shared `visibleTo` predicate.
- `Neo4jGraphStore`: persist `ownerUserId`/`visibility`; over-fetch the vector
  index then filter with `coalesce(node.visibility,'shared')` so legacy nodes
  read as shared; add the same predicate to the expansion `MATCH`. No migration.

### Ownership at index time
| Source | ownerUserId | visibility |
|---|---|---|
| Book via service key / webhook signals | `null` | `shared` |
| Book via a rep's own People.ai token | that rep | `private` (seam, not tonight) |
| Agents | `AgentTask.userId` | `AgentTask.visibility` |
| Runs | agent's `userId` | agent's `visibility` |

### Retrieval call sites (already know the user)
- `execute-agent.ts` → viewer = execution `userId`
- `assistant-context.ts` / chat route → viewer = authenticated current user
- `retrieve.ts` gains `viewerUserId` on `RetrieveOptions`, passes to store.

### Out of scope tonight
- Re-backfilling the book per user-token (labeled seam).
- Owner-email attribution of service-key/webhook data (the rejected "full
  attribution" option).

## Testing
- Memory store visibility matrix: private hidden from non-owner, visible to
  owner; shared visible to all; `null` viewer sees only shared — for both
  `search` and `expand`.
- Update existing `store-contract` / `retrieve` / `indexer` tests for the new
  signatures.
