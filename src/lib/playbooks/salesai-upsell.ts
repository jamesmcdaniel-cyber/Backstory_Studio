import type { FlowGraph } from '@/lib/flows/graph'

/**
 * The SalesAI Upsell Engine playbook (from the BRD): a deterministic Flow that
 * pulls in-segment accounts from Backstory Sales AI (+ Snowflake usage), fans
 * out a readiness scorer per account, then composes and posts the top-20 brief
 * to Slack. One-click provisioned: agents are created (idempotently) and the
 * flow graph is wired to their ids.
 */

export const PLAYBOOK_FLOW_NAME = 'SalesAI Upsell Engine'

export const PLAYBOOK_AGENTS = {
  puller: {
    title: 'Upsell Candidate Puller',
    description: 'Lists in-segment accounts for the SalesAI upsell motion as strict JSON.',
    integrations: ['Backstory MCP', 'strata:snowflake'],
    instructions: [
      'You list candidate accounts for a SalesAI upsell motion. The input names the target segment; when empty, default to accounts that own Data Foundation + EDB but NOT SalesAI (the low-hanging fruit). "ClosePlan-only" means customers whose only product is ClosePlan (e.g. Seismic, CRWD, ZS, PANW).',
      'Use the Backstory Sales AI tools to pull the account list for the segment. If Snowflake is available through your tools, enrich with product-usage/feature-adoption signals to pre-filter obviously inactive accounts.',
      'OUTPUT CONTRACT: respond with ONLY a JSON array of account-name strings — no prose, no markdown fence, max 25 entries, most promising first. Example: ["Seismic","Zscaler","CrowdStrike"]. If you cannot retrieve any accounts, return [] and nothing else.',
    ].join('\n'),
  },
  scorer: {
    title: 'Upsell Account Scorer',
    description: 'Scores one account for SalesAI adoption readiness as strict JSON.',
    integrations: ['Backstory MCP', 'strata:snowflake'],
    instructions: [
      'You score ONE account (given as input) for SalesAI adoption readiness.',
      'Assess from Backstory Sales AI (and Snowflake usage data when available): data quality/maturity, feature adoption baseline, engagement velocity, ARR health, competitive/churn risk signals, and named decision-makers.',
      'OUTPUT CONTRACT: respond with ONLY a JSON object — no prose, no markdown fence — shaped exactly: {"account": string, "score": number (0-100), "subscores": {"dataQuality": number, "featureAdoption": number, "engagement": number, "arrHealth": number}, "risks": string[], "decisionMakers": string[], "useCase": string, "nextAction": string}. Never fabricate: when a dimension is unknowable from your tools, score it conservatively and add a risk note like "no usage data available".',
    ].join('\n'),
  },
  composer: {
    title: 'Upsell Brief Composer',
    description: 'Ranks scorecards, composes the top-20 motion brief, and posts it to Slack.',
    integrations: ['Slack', 'strata:slack'],
    instructions: [
      'You receive a JSON array of account scorecards (fields: account, score, subscores, risks, decisionMakers, useCase, nextAction). Rank by score and take the top 20.',
      'Compose a skimmable Markdown brief: lead with the headline numbers (accounts scored, average score, #ready-now), then a ranked table (account, score, top risk, decision-maker, next action), then a 4-week deployment roadmap for the top 3 accounts, then honest data-gap notes.',
      'Post the brief to Slack using your Slack tools — default to the channel named in the brief request or #sales-ai-upsell; if posting fails, still return the full brief as your final answer.',
      'State counts precisely ("top 20 of 23 scored"). Never invent scores — use only what the scorecards contain.',
    ].join('\n'),
  },
} as const

/** Wire the playbook flow graph to the provisioned agent ids. */
export function buildUpsellGraph(agentIds: { puller: string; scorer: string; composer: string }): FlowGraph {
  return {
    nodes: [
      { id: 'trigger', type: 'trigger', data: { trigger: { type: 'manual', input: 'Data Foundation + EDB only' } } },
      {
        id: 'pull',
        type: 'agent',
        data: {
          agentId: agentIds.puller,
          label: 'Pull in-segment accounts',
          input: 'Segment: {{trigger.input}}',
          retries: 1,
        },
      },
      {
        id: 'score_each',
        type: 'loop',
        data: { label: 'Score each account', over: '{{step.pull.output}}', concurrency: 5, body: ['score'] },
      },
      {
        id: 'score',
        type: 'agent',
        data: {
          agentId: agentIds.scorer,
          label: 'Readiness score',
          input: '{{item}}',
          onError: 'continue',
          outputFields: [
            { name: 'account', type: 'string' },
            { name: 'score', type: 'number' },
            { name: 'risks', type: 'array' },
            { name: 'decisionMakers', type: 'array' },
            { name: 'nextAction', type: 'string' },
          ],
        },
      },
      {
        id: 'brief',
        type: 'agent',
        data: {
          agentId: agentIds.composer,
          label: 'Compose + post Slack brief',
          input: 'Scorecards: {{step.score_each.output}}',
          retries: 1,
        },
      },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'pull' },
      { id: 'e1', source: 'pull', target: 'score_each' },
      { id: 'e2', source: 'score_each', target: 'brief' },
    ],
  }
}
