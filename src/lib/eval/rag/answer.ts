/**
 * Grounded answer generation for the eval. A single structured call over the
 * retrieved context, instructed to answer ONLY from context and to refuse with
 * a fixed sentinel when the context lacks the answer. This is the proxy the
 * eval grades — it measures whether grounding-style prompting + a relevance
 * floor reduce fabrication, establishing the value BEFORE Task 6 bakes the
 * grounding line into the real run prompt.
 */
import { generateStructured } from '@/lib/llm/model-runner'

export const REFUSAL_SENTINEL = "I don't have enough information to answer that."

export const EVAL_GROUNDING_INSTRUCTION =
  'Answer using ONLY the provided context. Ground every factual claim in that context. ' +
  `If the context does not contain the answer, reply exactly: "${REFUSAL_SENTINEL}" — do not guess or fabricate.`

const ANSWER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: { answer: { type: 'string', description: 'The grounded answer, or the exact refusal sentinel.' } },
  required: ['answer'],
} as const

export async function generateGroundedAnswer(
  query: string,
  context: string,
  deps: { generate?: typeof generateStructured } = {},
): Promise<string> {
  const generate = deps.generate ?? generateStructured
  const raw = await generate({
    schemaName: 'rag_eval_answer',
    schema: ANSWER_SCHEMA as unknown as Record<string, unknown>,
    maxTokens: 512,
    system: EVAL_GROUNDING_INSTRUCTION,
    user: `CONTEXT:\n${context || '(no relevant context was retrieved)'}\n\nQUESTION: ${query}`,
  })
  const parsed = JSON.parse(raw) as { answer?: string }
  return typeof parsed.answer === 'string' ? parsed.answer : ''
}

/** True when the answer is a refusal ("...don't/do not have enough information..."). */
export function isRefusal(answer: string): boolean {
  return /do(?:es)?\s*n(?:o|')t\s+have\s+enough\s+information/i.test(answer)
}
