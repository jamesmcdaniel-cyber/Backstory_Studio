/**
 * ONE-TIME synthetic golden-set generator. Run by a human with a model key:
 * `npm run eval:rag:generate`. For each corpus doc it asks the model for a few
 * grounded Q/A pairs; the result is written to golden.json and COMMITTED, so
 * the eval itself is reproducible and needs no generation at run time. The
 * committed bootstrap set (Task 2) is the source of truth until regenerated;
 * regeneration is rare and its output should be reviewed before committing.
 */
import { writeFileSync } from 'node:fs'
import { generateStructured } from '@/lib/llm/model-runner'
import { corpusDocIds, corpusDocText, GOLDEN_PATH, loadGolden } from './index'
import type { GoldenItem } from './types'

const QA_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    pairs: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: { type: 'string' },
          referenceAnswer: { type: 'string' },
        },
        required: ['query', 'referenceAnswer'],
      },
    },
  },
  required: ['pairs'],
} as const

const N_PER_DOC = 2

async function generate(): Promise<void> {
  const items: GoldenItem[] = []
  for (const docId of corpusDocIds()) {
    const text = corpusDocText(docId)
    const raw = await generateStructured({
      schemaName: 'rag_golden_qa',
      schema: QA_SCHEMA as unknown as Record<string, unknown>,
      maxTokens: 1024,
      system: `Generate exactly ${N_PER_DOC} question/answer pairs answerable STRICTLY from the document. Questions a salesperson would actually ask. Answers must be short and fully grounded in the document — invent nothing.`,
      user: `DOCUMENT (${docId}):\n${text}`,
    })
    const parsed = JSON.parse(raw) as { pairs?: Array<{ query: string; referenceAnswer: string }> }
    for (const [i, pair] of (parsed.pairs ?? []).entries()) {
      items.push({ id: `${docId}-${i}`, query: pair.query, referenceAnswer: pair.referenceAnswer, sourceDocIds: [docId], unanswerable: false })
    }
  }
  // Preserve the hand-authored adversarial unanswerable queries — regeneration
  // only refreshes the answerable pairs; the curated unanswerable queries are
  // carried over from the existing golden.json so the refusal metric survives a
  // regeneration instead of silently vanishing.
  const unanswerable = loadGolden().filter((item) => item.unanswerable)
  const merged = [...items, ...unanswerable]
  console.log(`Generated ${items.length} answerable pairs; carried over ${unanswerable.length} curated unanswerable queries. Review, then commit golden.json.`)
  writeFileSync(GOLDEN_PATH, JSON.stringify(merged, null, 2))
}

generate().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
