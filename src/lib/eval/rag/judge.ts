/**
 * LLM-judge for grounding quality — faithfulness (are the answer's claims
 * supported by the retrieved context) and answer-relevance (does it address the
 * question). Reuses generateStructured (provider selection + fallback) and is
 * only called when a model key is configured.
 */
import { generateStructured } from '@/lib/llm/model-runner'

const GROUNDING_JUDGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    faithfulness: { type: 'number', description: '0 (claims unsupported/contradicted by context) to 1 (fully supported).' },
    answerRelevance: { type: 'number', description: '0 (ignores the question) to 1 (directly answers it).' },
    reasoning: { type: 'string', description: 'One sentence justifying the scores.' },
  },
  required: ['faithfulness', 'answerRelevance', 'reasoning'],
} as const

const clamp01 = (value: unknown): number => (typeof value === 'number' ? Math.max(0, Math.min(1, value)) : 0)

export async function judgeGrounding(
  query: string,
  answer: string,
  context: string,
  deps: { generate?: typeof generateStructured } = {},
): Promise<{ faithfulness: number; answerRelevance: number }> {
  const generate = deps.generate ?? generateStructured
  const raw = await generate({
    schemaName: 'rag_grounding_judgment',
    schema: GROUNDING_JUDGE_SCHEMA as unknown as Record<string, unknown>,
    maxTokens: 512,
    system:
      'You are a strict grader of retrieval-augmented answers. Given a question, the retrieved context, and the answer, score faithfulness (are the answer\'s claims supported by the context?) and answer-relevance (does it address the question?). Be rigorous: an answer that adds facts not in the context scores low on faithfulness even if plausible.',
    user: `QUESTION:\n${query}\n\nRETRIEVED CONTEXT:\n${context || '(none)'}\n\nANSWER:\n${answer}`,
  })
  const parsed = JSON.parse(raw) as { faithfulness?: unknown; answerRelevance?: unknown }
  return { faithfulness: clamp01(parsed.faithfulness), answerRelevance: clamp01(parsed.answerRelevance) }
}
