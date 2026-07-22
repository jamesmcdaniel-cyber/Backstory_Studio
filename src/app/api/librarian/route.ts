import Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { DEFAULT_SUMMARY_MODEL } from '@/lib/llm/model-runner'
import { qwenClient, qwenModel } from '@/lib/llm/qwen'
import { withAuthenticatedApi } from '@/lib/server/api-handler'
import { agentVisibilityScope, executionVisibilityScope } from '@/lib/server/visibility'
import { assertAiCallAllowed } from '@/lib/usage/ai-guard'
import { recordTokenUsage } from '@/lib/usage/budget'

// The Librarian: a holistic workspace assistant. It answers general questions
// about Backstory AND surfaces the user's own library — templates, flows,
// agents, and recent runs — as clickable results grounded in what it found.

export type LibrarianResult = {
  type: 'agent' | 'flow' | 'template' | 'run'
  id: string
  title: string
  subtitle: string
  href: string
}

const SYSTEM_PROMPT = `You are the Librarian, a concise assistant inside Backstory Studio — a platform where sales teams build AI agents and automated flows over their connected tools (Slack, Gmail, Salesforce, Jira, Granola, and a Backstory MCP for account/deal data).

Answer the user's question directly and briefly (2–5 sentences, no preamble). When the provided library items are relevant, refer to them by name and tell the user what to do next (open a flow, use a template, review a run). If nothing in the library fits, give practical general guidance and point them to the right area (Agents, Flows, Integrations). Never invent items that aren't listed.`

/** Meaningful search terms from the question (drop short/stop words). */
function terms(question: string): string[] {
  const stop = new Set(['the', 'and', 'for', 'with', 'how', 'can', 'what', 'you', 'are', 'this', 'that', 'from', 'about', 'into', 'does', 'should', 'could', 'would', 'when', 'where', 'which', 'your', 'our', 'get'])
  return Array.from(new Set(
    question.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !stop.has(w)),
  )).slice(0, 6)
}

function orContains(words: string[], fields: string[]) {
  const clauses: Record<string, unknown>[] = []
  for (const w of words) for (const f of fields) clauses.push({ [f]: { contains: w, mode: 'insensitive' } })
  return clauses
}

export const POST = withAuthenticatedApi(async (request, auth) => {
  const { question } = z.object({ question: z.string().min(1).max(2000) }).parse(await request.json())
  await assertAiCallAllowed({ organizationId: auth.organizationId, rateKey: `librarian:${auth.dbUser.id}`, limit: 30 })

  const words = terms(question)
  const org = auth.organizationId
  const uid = auth.dbUser.id
  // With no usable search terms, surface the most recent library items instead
  // of matching on nothing.
  const hasWords = words.length > 0

  const [agents, flows, templates, runs] = await Promise.all([
    prisma.agentTask.findMany({
      where: { organizationId: org, ...agentVisibilityScope(uid), ...(hasWords ? { OR: orContains(words, ['description', 'objective']) } : {}) },
      orderBy: { updatedAt: 'desc' },
      take: 4,
      select: { id: true, description: true, folder: true, metadata: true },
    }),
    prisma.flow.findMany({
      where: { organizationId: org, ...(hasWords ? { OR: orContains(words, ['name', 'description']) } : {}) },
      orderBy: { updatedAt: 'desc' },
      take: 4,
      select: { id: true, name: true, description: true, status: true },
    }),
    prisma.agentTemplate.findMany({
      where: { organizationId: org, isActive: true, ...(hasWords ? { OR: orContains(words, ['name', 'description']) } : {}) },
      orderBy: { updatedAt: 'desc' },
      take: 4,
      select: { id: true, name: true, description: true },
    }),
    prisma.agentExecution.findMany({
      where: { organizationId: org, ...executionVisibilityScope(uid), ...(hasWords ? { OR: [...orContains(words, ['agentType']), { agentTask: { is: { OR: orContains(words, ['description', 'objective']) } } }] } : {}) },
      orderBy: { startedAt: 'desc' },
      take: 4,
      select: { id: true, agentType: true, status: true, startedAt: true, metadata: true },
    }),
  ])

  const titleOf = (metadata: unknown, fallback: string) => {
    const m = (metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {}) as Record<string, unknown>
    return (typeof m.title === 'string' && m.title.trim()) || fallback
  }

  const results: LibrarianResult[] = [
    ...flows.map((f): LibrarianResult => ({ type: 'flow', id: f.id, title: f.name || 'Untitled flow', subtitle: `Flow · ${f.status.toLowerCase()}`, href: `/flows/${f.id}` })),
    ...agents.map((a): LibrarianResult => ({ type: 'agent', id: a.id, title: titleOf(a.metadata, a.description.split('\n')[0] || 'Untitled agent'), subtitle: a.folder ? `Agent · ${a.folder}` : 'Agent', href: `/agents?agent=${a.id}` })),
    ...templates.map((t): LibrarianResult => ({ type: 'template', id: t.id, title: t.name, subtitle: 'Template', href: `/templates/${t.id}` })),
    ...runs.map((r): LibrarianResult => ({ type: 'run', id: r.id, title: titleOf(r.metadata, r.agentType), subtitle: `Run · ${r.status.toLowerCase()}`, href: `/agents?run=${r.id}` })),
  ]

  // Ground the answer on what we actually found (names + types only).
  const grounding = results.length
    ? `Library items found for this question:\n${results.map((r) => `- [${r.type}] ${r.title} — ${r.subtitle}`).join('\n')}`
    : 'No matching library items were found.'
  const prompt = `${grounding}\n\nUser question: ${question}`

  const useClaude = Boolean(process.env.ANTHROPIC_API_KEY)
  const client = useClaude ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : qwenClient()
  const model = useClaude
    ? (DEFAULT_SUMMARY_MODEL.startsWith('claude') ? DEFAULT_SUMMARY_MODEL : 'claude-haiku-4-5')
    : qwenModel(DEFAULT_SUMMARY_MODEL.startsWith('claude') ? 'qwen-3.7' : DEFAULT_SUMMARY_MODEL)

  const response = await client.messages.create({
    model,
    max_tokens: 700,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: prompt }],
  })
  void recordTokenUsage(org, (response.usage?.input_tokens ?? 0) + (response.usage?.output_tokens ?? 0)).catch(() => undefined)

  const answer = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim()

  return { success: true, answer: answer || 'I couldn’t generate an answer just now — try rephrasing.', results }
})
