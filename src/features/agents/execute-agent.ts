import type { Job } from 'bullmq'
import { prisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { KlavisClient } from '@/lib/mcp/klavis-client'
import { BackstoryMcpClient, backstoryMcpConfigured } from '@/lib/mcp/backstory-mcp'
import { McpClient, mcpConfigFromConnection } from '@/lib/mcp/mcp-client'
import { ensureFreshConnectionToken, persistRefreshedAuthcodeTokens } from '@/lib/mcp/connection-token'
import { GranolaToolClient, granolaConfigured, granolaTools } from '@/lib/integrations/granola'
import { SlackToolClient, slackConfigured, slackTools } from '@/lib/integrations/slack'
import { EmailToolClient, emailConfigured, emailTools } from '@/lib/integrations/email'
import { notify } from '@/lib/notifications/service'
import { checkMonthlyTokenBudget } from '@/lib/usage/budget'
import { buildAgentSystemPrompt } from './system-prompt'
import {
  createModelRunner,
  generateHeadline,
  DEFAULT_AGENT_MODEL,
  type ToolDefinition,
  type ToolResult,
} from '@/lib/llm/model-runner'

export type AgentExecutionJob = {
  executionId?: string
  agentId: string
  organizationId: string
  userId: string
  input?: string
  resume?: boolean
  reply?: string
}

// Minimal interface that both KlavisClient and BackstoryMcpClient satisfy,
// so ToolBinding.client can hold either without casting.
interface McpToolClient {
  executeTool(serverUrl: string, name: string, args: Record<string, unknown>): Promise<any>
}

type ToolBinding = {
  provider: string
  serverUrl: string
  toolName: string
  client: McpToolClient
}

type PendingQuestion = {
  toolCallId: string
  question: string
  stepId: string | null
  collectedResults: ToolResult[]
}

const ASK_USER_TOOL: ToolDefinition = {
  name: 'ask_user',
  description:
    'Pause the run and ask the user one question. Call this only when you are blocked on a decision, missing information, or approval that only the user can provide. The run resumes when they reply.',
  inputSchema: {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'The question to show the user.' },
    },
    required: ['question'],
  },
}

function jsonValue(value: unknown) {
  return JSON.parse(JSON.stringify(value ?? null))
}

function toolName(provider: string, name: string) {
  return `${provider}_${name}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64)
}

function metadataOf(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, any>) : {}
}

async function loadTools(organizationId: string, providers: string[]) {
  const tools: ToolDefinition[] = []
  const bindings = new Map<string, ToolBinding>()

  // ---- Klavis-managed MCP servers ----------------------------------------
  const hasBackstoryProvider = providers.some((p) => /backstory/i.test(p))
  // Non-Backstory providers that Klavis handles
  const klavisProviders = providers.filter((p) => !/backstory/i.test(p))

  if (process.env.KLAVIS_API_KEY && klavisProviders.length > 0) {
    const client = new KlavisClient({ apiKey: process.env.KLAVIS_API_KEY, platformName: 'backstory' })
    const agents = await prisma.mCPAgent.findMany({
      where: {
        organizationId,
        isActive: true,
        agentType: { in: klavisProviders.map((provider) => provider.toUpperCase()) },
      },
    })

    for (const agent of agents) {
      const provider = String(agent.agentType).toLowerCase()
      // C2 — a failing tool-discovery for one provider must not abort the run.
      // Degrade gracefully: log + skip this provider, keep whatever else loaded.
      try {
        const available = await client.getServerTools(agent.mcpServerUrl)
        if (available.length > 20) {
          apiLogger.warn('loadTools: per-provider tool cap reached; some tools not exposed to the agent', {
            provider, organizationId, discovered: available.length, cap: 20, dropped: available.length - 20,
          })
        }
        for (const tool of available.slice(0, 20)) {
          const name = toolName(provider, tool.name)
          if (bindings.has(name)) continue
          bindings.set(name, { provider, serverUrl: agent.mcpServerUrl, toolName: tool.name, client })
          tools.push({
            name,
            description: tool.description || `${tool.name} via ${provider}`,
            inputSchema: tool.inputSchema || { type: 'object', properties: {} },
          })
        }
      } catch (error) {
        apiLogger.warn('loadTools: Klavis tool discovery failed, skipping provider', {
          provider,
          organizationId,
          error: error instanceof Error ? error.message : String(error),
        })
        continue
      }
    }
  }

  // ---- Backstory MCP (OAuth 2.0 client-credentials or static bearer) ------
  if (hasBackstoryProvider && backstoryMcpConfigured()) {
    // C2 — isolate Backstory discovery so its failure degrades to fewer tools
    // instead of aborting the run.
    try {
      const backstoryUrl = process.env.BACKSTORY_MCP_URL!
      const backstoryClient = new BackstoryMcpClient()
      const available = await backstoryClient.getServerTools(backstoryUrl)
      for (const tool of available.slice(0, 20)) {
        const name = toolName('backstory', tool.name)
        if (bindings.has(name)) continue
        bindings.set(name, { provider: 'backstory', serverUrl: backstoryUrl, toolName: tool.name, client: backstoryClient })
        tools.push({
          name,
          description: tool.description || `${tool.name} via backstory`,
          inputSchema: tool.inputSchema || { type: 'object', properties: {} },
        })
      }
    } catch (error) {
      apiLogger.warn('loadTools: Backstory MCP tool discovery failed, skipping provider', {
        provider: 'backstory',
        organizationId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  // ---- Per-org MCP connections (all active connections, any authType) ------
  // These are available to every agent in the org regardless of the providers
  // list; a failing/unreachable server must NOT abort the run or block others.
  const connections = await prisma.mcpConnection.findMany({
    where: { organizationId, isActive: true },
  })

  for (let conn of connections) {
    // Slug used as the provider prefix (e.g. "my salesforce" → "my_salesforce")
    const slug = conn.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')
    try {
      conn = await ensureFreshConnectionToken(conn)
      const config = mcpConfigFromConnection(conn)
      // For authcode connections, let a mid-run token refresh persist the
      // rotated tokens back to this row so the next run reuses them.
      if (config.flow === 'authcode') {
        const connectionId = conn.id
        const baseAuthConfig = conn.authConfig as Record<string, unknown>
        const fallbackRefresh = config.refreshToken ?? ''
        config.persistTokens = async (tokens) => {
          await persistRefreshedAuthcodeTokens(connectionId, baseAuthConfig, tokens, fallbackRefresh)
        }
      }
      const client = new McpClient(config)
      const available = await client.getServerTools(conn.serverUrl)
      for (const tool of available.slice(0, 20)) {
        // Stop if we've hit the overall 64-tool cap
        if (tools.length >= 64) break
        const name = toolName(slug, tool.name)
        if (bindings.has(name)) continue
        bindings.set(name, {
          provider: slug,
          serverUrl: conn.serverUrl,
          toolName: tool.name,
          client,
        })
        tools.push({
          name,
          description: tool.description || `${tool.name} via ${conn.name}`,
          inputSchema: tool.inputSchema || { type: 'object', properties: {} },
        })
      }
    } catch (error) {
      apiLogger.warn('loadTools: org MCP connection tool discovery failed, skipping', {
        connectionId: conn.id,
        connectionName: conn.name,
        serverUrl: conn.serverUrl,
        organizationId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  // ---- Granola REST API (built-in; no Klavis / MCP server required) --------
  // Gate: GRANOLA_API_KEY must be set AND the agent's providers list must
  // include an entry matching /granola/i. A failure here must not abort the
  // run or prevent other tools from loading.
  const hasGranolaProvider = providers.some((p) => /granola/i.test(p))
  if (granolaConfigured() && hasGranolaProvider) {
    try {
      const client = new GranolaToolClient()
      const serverUrl = 'https://public-api.granola.ai/v1'
      for (const def of granolaTools()) {
        if (tools.length >= 64) break
        const name = toolName('granola', def.name)
        if (bindings.has(name)) continue
        bindings.set(name, { provider: 'granola', serverUrl, toolName: def.name, client })
        tools.push({ name, description: def.description, inputSchema: def.inputSchema })
      }
    } catch (error) {
      apiLogger.warn('loadTools: Granola tool setup failed, skipping provider', {
        provider: 'granola',
        organizationId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  // ---- Slack REST API (built-in; delivery integration) --------------------
  // Gate: SLACK_BOT_TOKEN must be set AND the agent's providers list must
  // include an entry matching /slack/i. A failure here must not abort the
  // run or prevent other tools from loading.
  const hasSlackProvider = providers.some((p) => /slack/i.test(p))
  if (slackConfigured() && hasSlackProvider) {
    try {
      const client = new SlackToolClient()
      const serverUrl = 'https://slack.com/api'
      for (const def of slackTools()) {
        if (tools.length >= 64) break
        const name = toolName('slack', def.name)
        if (bindings.has(name)) continue
        bindings.set(name, { provider: 'slack', serverUrl, toolName: def.name, client })
        tools.push({ name, description: def.description, inputSchema: def.inputSchema })
      }
    } catch (error) {
      apiLogger.warn('loadTools: Slack tool setup failed, skipping provider', {
        provider: 'slack',
        organizationId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  // ---- Email via Resend REST API (built-in; delivery integration) ----------
  // Gate: RESEND_API_KEY must be set AND the agent's providers list must
  // include an entry matching /email/i. A failure here must not abort the
  // run or prevent other tools from loading.
  const hasEmailProvider = providers.some((p) => /email/i.test(p))
  if (emailConfigured() && hasEmailProvider) {
    try {
      const client = new EmailToolClient()
      const serverUrl = 'https://api.resend.com'
      for (const def of emailTools()) {
        if (tools.length >= 64) break
        const name = toolName('email', def.name)
        if (bindings.has(name)) continue
        bindings.set(name, { provider: 'email', serverUrl, toolName: def.name, client })
        tools.push({ name, description: def.description, inputSchema: def.inputSchema })
      }
    } catch (error) {
      apiLogger.warn('loadTools: Email tool setup failed, skipping provider', {
        provider: 'email',
        organizationId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  if (tools.length > 64) {
    apiLogger.warn('loadTools: global tool cap reached; some discovered tools are not available to the agent', {
      organizationId, discovered: tools.length, cap: 64, dropped: tools.length - 64,
    })
  }
  return { tools: tools.slice(0, 64), bindings }
}

async function recordEvent(executionId: string, stepId: string | null, kind: string, payload?: unknown) {
  await prisma.workflowEvent.create({
    data: { executionId, stepId, kind, payload: jsonValue(payload) },
  })
}

export async function runAgentExecution(data: AgentExecutionJob) {
  const { agentId, organizationId, userId } = data
  const agent = await prisma.agentTask.findFirst({
    where: { id: agentId, organizationId, status: 'ACTIVE' },
  })
  if (!agent) throw new Error('Agent not found or inactive')

  const agentMetadata = metadataOf(agent.metadata)
  const model = agentMetadata.model || DEFAULT_AGENT_MODEL
  const runner = createModelRunner(model)

  const queuedExecution = data.executionId
    ? await prisma.agentExecution.findFirst({
        where: {
          id: data.executionId,
          agentTaskId: agentId,
          organizationId,
        },
      })
    : null
  if (data.executionId && !queuedExecution) throw new Error('Queued execution does not match this tenant and agent')

  const resuming = Boolean(data.resume)
  if (resuming && !queuedExecution) throw new Error('Resume requested without an execution')

  // Idempotency guard: a fresh run may only start from a `pending` row. If a
  // duplicate delivery or (despite maxStalledCount:0) a re-queue hands us an
  // execution that already started, finished, or failed, do not replay it —
  // that would re-fire every side effect from the top.
  if (queuedExecution && !resuming && queuedExecution.status !== 'pending') {
    return { status: queuedExecution.status, skipped: true as const }
  }

  let transcript: unknown[]
  let pendingResults: ToolResult[] | null = null

  if (resuming && queuedExecution) {
    const executionMetadata = metadataOf(queuedExecution.metadata)
    const pending = executionMetadata.pendingQuestion as PendingQuestion | undefined
    if (queuedExecution.status !== 'waiting_for_input' || !pending || !Array.isArray(queuedExecution.transcript)) {
      throw new Error('Execution is not waiting for input')
    }
    transcript = queuedExecution.transcript as unknown[]
    const reply = data.reply?.trim() || 'The user did not provide an answer. Use your best judgment.'
    pendingResults = [
      ...(pending.collectedResults || []),
      { toolCallId: pending.toolCallId, content: reply },
    ]
    if (pending.stepId) {
      await prisma.workflowStep.update({
        where: { id: pending.stepId },
        data: { status: 'succeeded', output: jsonValue({ answer: reply }), completedAt: new Date() },
      })
    }
    await recordEvent(queuedExecution.id, pending.stepId || null, 'user.replied', { answer: reply })
  } else {
    transcript = runner.start(data.input || agent.objective)
  }

  const execution = queuedExecution
    ? await prisma.agentExecution.update({
        where: { id: queuedExecution.id },
        data: {
          status: 'running',
          model: runner.model,
          ...(resuming
            ? { metadata: jsonValue({ ...metadataOf(queuedExecution.metadata), pendingQuestion: null }) }
            : { startedAt: new Date() }),
        },
      })
    : await prisma.agentExecution.create({
        data: {
          agentType: agent.agentType,
          agentTaskId: agent.id,
          status: 'running',
          model: runner.model,
          input: { prompt: data.input || agent.objective },
          trigger: { type: 'schedule' },
          metadata: { title: agentMetadata.title || agent.description },
          userId,
          organizationId,
        },
      })

  if (!resuming) {
    await prisma.executionMessage.create({
      data: { executionId: execution.id, role: 'user', content: data.input || agent.objective },
    })
  }

  const executionMetadata = metadataOf(execution.metadata)
  const segmentStart = Date.now()
  const usage = { inputTokens: 0, outputTokens: 0 }

  try {
    // Enforce the workspace's monthly token ceiling before doing any model work.
    const budget = await checkMonthlyTokenBudget(organizationId)
    if (budget.over) {
      throw new Error(
        `Monthly token budget reached for this workspace (${budget.used.toLocaleString()}/${budget.limit.toLocaleString()} tokens). Raise AGENT_MONTHLY_TOKEN_LIMIT or wait for the next cycle.`,
      )
    }

    const providers = Array.isArray(agentMetadata.integrations) ? agentMetadata.integrations.map(String) : []
    const skillIds = Array.isArray(agentMetadata.skills) ? agentMetadata.skills.map(String) : []
    const { tools, bindings } = await loadTools(organizationId, providers)
    const system = buildAgentSystemPrompt(agent.objective, skillIds)

    if (pendingResults) runner.appendToolResults(transcript, pendingResults)

    const maxTurns = Number(agentMetadata.maxTurns) || Number(process.env.AGENT_MAX_TURNS) || 16
    let finalText = ''

    for (let turn = 0; turn < maxTurns; turn += 1) {
      const turnResult = await runner.next(transcript, system, [...tools, ASK_USER_TOOL])
      usage.inputTokens += turnResult.usage.inputTokens
      usage.outputTokens += turnResult.usage.outputTokens

      if (!turnResult.toolCalls.length) {
        finalText = turnResult.text || 'Agent completed without a text response.'
        break
      }

      const results: ToolResult[] = []
      let pendingAsk: { toolCallId: string; question: string } | null = null

      for (const call of turnResult.toolCalls) {
        if (call.name === ASK_USER_TOOL.name) {
          if (pendingAsk) {
            results.push({
              toolCallId: call.id,
              content: JSON.stringify({ error: 'Ask one question at a time. Fold this into your pending question.' }),
              isError: true,
            })
            continue
          }
          pendingAsk = {
            toolCallId: call.id,
            question: String(call.input.question || 'The agent needs your input to continue.'),
          }
          continue
        }

        const binding = bindings.get(call.name)
        const step = await prisma.workflowStep.create({
          data: {
            executionId: execution.id,
            node: binding ? `${binding.provider}.${binding.toolName}` : call.name,
            status: 'running',
            input: jsonValue(call.input),
            startedAt: new Date(),
          },
        })
        await recordEvent(execution.id, step.id, 'tool.started', { name: step.node, args: call.input })

        try {
          if (!binding) throw new Error(`Tool binding not found: ${call.name}`)
          const result = await binding.client.executeTool(binding.serverUrl, binding.toolName, call.input)
          await prisma.workflowStep.update({
            where: { id: step.id },
            data: { status: 'succeeded', output: jsonValue(result), completedAt: new Date() },
          })
          await recordEvent(execution.id, step.id, 'tool.completed', { name: step.node })
          results.push({ toolCallId: call.id, content: JSON.stringify(result) })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          await prisma.workflowStep.update({
            where: { id: step.id },
            data: { status: 'failed', error: jsonValue({ message }), completedAt: new Date() },
          })
          await recordEvent(execution.id, step.id, 'tool.failed', { name: step.node, error: message })
          results.push({ toolCallId: call.id, content: JSON.stringify({ error: message }), isError: true })
        }
      }

      if (pendingAsk) {
        const step = await prisma.workflowStep.create({
          data: {
            executionId: execution.id,
            node: 'ask_user',
            status: 'waiting',
            input: jsonValue({ question: pendingAsk.question }),
            startedAt: new Date(),
          },
        })
        await recordEvent(execution.id, step.id, 'agent.question', { question: pendingAsk.question })
        await prisma.executionMessage.create({
          data: { executionId: execution.id, role: 'agent', content: pendingAsk.question },
        })
        await prisma.agentExecution.update({
          where: { id: execution.id },
          data: {
            status: 'waiting_for_input',
            transcript: jsonValue(transcript),
            inputTokens: { increment: usage.inputTokens },
            outputTokens: { increment: usage.outputTokens },
            executionTime: { increment: Date.now() - segmentStart },
            metadata: jsonValue({
              ...executionMetadata,
              pendingQuestion: {
                toolCallId: pendingAsk.toolCallId,
                question: pendingAsk.question,
                stepId: step.id,
                collectedResults: results,
              } satisfies PendingQuestion,
            }),
          },
        })
        await notify({
          organizationId,
          userId,
          type: 'agent.needs_input',
          level: 'action',
          title: `${agentMetadata.title || agent.description} needs your input`,
          body: pendingAsk.question,
          agentTaskId: agent.id,
          executionId: execution.id,
        })
        return { status: 'waiting_for_input', question: pendingAsk.question }
      }

      runner.appendToolResults(transcript, results)
    }

    const summary = finalText || 'Agent reached the maximum number of tool-call turns.'
    const output = { summary }
    const headline = await generateHeadline(summary)

    await prisma.executionMessage.create({
      data: { executionId: execution.id, role: 'agent', content: summary },
    })
    await prisma.$transaction([
      prisma.agentExecution.update({
        where: { id: execution.id },
        data: {
          status: 'completed',
          output,
          transcript: jsonValue(transcript),
          inputTokens: { increment: usage.inputTokens },
          outputTokens: { increment: usage.outputTokens },
          executionTime: { increment: Date.now() - segmentStart },
          completedAt: new Date(),
          metadata: jsonValue({ ...executionMetadata, pendingQuestion: null, ...(headline ? { headline } : {}) }),
        },
      }),
      prisma.agentTask.update({
        where: { id: agent.id },
        data: {
          lastExecutedAt: new Date(),
          executionCount: { increment: 1 },
          lastResult: output,
        },
      }),
    ])
    await notify({
      organizationId,
      userId,
      type: 'agent.completed',
      level: 'success',
      title: `${agentMetadata.title || agent.description} completed`,
      body: headline || summary,
      agentTaskId: agent.id,
      executionId: execution.id,
    })
    return output
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await prisma.agentExecution.update({
      where: { id: execution.id },
      data: {
        status: 'failed',
        // M5 — cap persisted error strings so they can't bloat the row.
        error: message.slice(0, 300),
        transcript: jsonValue(transcript),
        inputTokens: { increment: usage.inputTokens },
        outputTokens: { increment: usage.outputTokens },
        executionTime: { increment: Date.now() - segmentStart },
        completedAt: new Date(),
      },
    })
    await notify({
      organizationId,
      userId,
      type: 'agent.error',
      level: 'error',
      title: `${agentMetadata.title || agent.description} hit an error`,
      body: message,
      agentTaskId: agent.id,
      executionId: execution.id,
    })
    throw error
  }
}

export async function executeAgentJob(job: Job<AgentExecutionJob>) {
  return runAgentExecution(job.data)
}
