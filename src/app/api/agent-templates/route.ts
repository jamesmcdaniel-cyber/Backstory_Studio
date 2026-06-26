import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'

const templateSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(''),
  category: z.string().default('Custom'),
  instructions: z.string().min(1),
  integrations: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
  model: z.string().default('claude-opus-4-8'),
})

function serializeTemplate(template: any) {
  const config = template.configuration && typeof template.configuration === 'object' ? template.configuration as any : {}
  return {
    id: template.id,
    name: template.name,
    description: template.description || '',
    category: template.type,
    instructions: config.instructions || template.description || '',
    integrations: config.integrations || [],
    tags: config.tags || [],
    model: config.model || 'claude-opus-4-8',
    custom: true,
  }
}

const builtInTemplates = [
  {
    "id": "01-sales-digest",
    "name": "Sales Digest",
    "description": "Generates a personalized daily sales digest for each enrolled user.",
    "category": "Daily Intelligence",
    "instructions": "Generates a personalized daily sales digest for each enrolled user. At 6 AM on weekdays, the workflow retrieves the list of digest subscribers from the User Config Store, queries Backstory via MCP for each user's relevant account and opportunity activity, then passes the data to the LLM to compose a concise, actionable summary. The finished digest is delivered via Messaging (Slack, Teams, or Email) to each user.\n\nCarry this out as an AI agent: use the Backstory MCP to retrieve the relevant account, opportunity, and engagement data, reason over it, and deliver the result through the connected tools. Ask the user for anything you need (target account, thresholds, delivery channel) before running.",
    "integrations": [
      "Backstory MCP",
      "Slack",
      "Email"
    ],
    "tags": [
      "recurring",
      "daily"
    ],
    "model": "claude-opus-4-8"
  },
  {
    "id": "02-meeting-brief",
    "name": "Meeting Brief",
    "description": "Prepares an AI-generated briefing document before each upcoming meeting.",
    "category": "Daily Intelligence",
    "instructions": "Prepares an AI-generated briefing document before each upcoming meeting. A parent cron workflow fires every 15 minutes and invokes this sub-workflow for meetings approaching on the calendar. The workflow fetches account context from Backstory via MCP — recent activity, engagement history, key contacts — and passes it to the LLM to produce a concise meeting brief. The brief is delivered to the meeting owner via Messaging (Slack, Teams, or Email) so they walk in fully prepared.\n\nCarry this out as an AI agent: use the Backstory MCP to retrieve the relevant account, opportunity, and engagement data, reason over it, and deliver the result through the connected tools. Ask the user for anything you need (target account, thresholds, delivery channel) before running.",
    "integrations": [
      "Backstory MCP",
      "Slack",
      "Email"
    ],
    "tags": [
      "recurring",
      "daily"
    ],
    "model": "claude-opus-4-8"
  },
  {
    "id": "03-silence-contract-monitor",
    "name": "Silence & Contract Monitor",
    "description": "Monitors accounts for engagement gaps that may signal churn risk.",
    "category": "Account Monitoring",
    "instructions": "Monitors accounts for engagement gaps that may signal churn risk. Every morning at 6:30 AM, the workflow pulls accounts and checks for those that have \"gone silent\" — no meaningful engagement activity within a configured lookback window. For flagged accounts, it uses the LLM to assess the severity of the silence, considering deal stage, contract dates, and historical patterns. Accounts deemed concerning are surfaced via Alert (Slack, Teams, or Email) so the owning rep or CSM can re-engage.\n\nCarry this out as an AI agent: use the Backstory MCP to retrieve the relevant account, opportunity, and engagement data, reason over it, and deliver the result through the connected tools. Ask the user for anything you need (target account, thresholds, delivery channel) before running.",
    "integrations": [
      "Backstory MCP",
      "Slack",
      "Email"
    ],
    "tags": [
      "recurring",
      "account"
    ],
    "model": "claude-opus-4-8"
  },
  {
    "id": "04-opportunity-discovery",
    "name": "Opportunity Discovery",
    "description": "Surfaces hidden revenue opportunities by identifying accounts with recent engagement activity but no corresponding open opportunities in the pipeline.",
    "category": "Pipeline & Forecasting",
    "instructions": "Surfaces hidden revenue opportunities by identifying accounts with recent engagement activity but no corresponding open opportunities in the pipeline. On a weekly cadence, the workflow cross-references Backstory activity data against the CRM pipeline, flags accounts showing buying signals without active deals, and uses the LLM to analyze the strength of those signals. Findings are posted via Messaging (Slack, Teams, or Email) and optionally emailed, giving reps a curated list of accounts worth pursuing.\n\nCarry this out as an AI agent: use the Backstory MCP to retrieve the relevant account, opportunity, and engagement data, reason over it, and deliver the result through the connected tools. Ask the user for anything you need (target account, thresholds, delivery channel) before running.",
    "integrations": [
      "Backstory MCP",
      "Slack",
      "Email",
      "SMTP"
    ],
    "tags": [
      "recurring",
      "pipeline"
    ],
    "model": "claude-opus-4-8"
  },
  {
    "id": "05-forecast-coach",
    "name": "Forecast Coach",
    "description": "Provides AI-powered coaching insights for sales leaders by analyzing their team's open pipeline each week.",
    "category": "Pipeline & Forecasting",
    "instructions": "Provides AI-powered coaching insights for sales leaders by analyzing their team's open pipeline each week. Every Monday, the workflow pulls each leader's team pipeline from Backstory, filters for active deals, and uses the LLM to assess deal health — looking at engagement recency, stakeholder coverage, stage velocity, and risk indicators. The result is a per-leader coaching report delivered via email, highlighting deals that need attention and suggesting specific coaching actions.\n\nCarry this out as an AI agent: use the Backstory MCP to retrieve the relevant account, opportunity, and engagement data, reason over it, and deliver the result through the connected tools. Ask the user for anything you need (target account, thresholds, delivery channel) before running.",
    "integrations": [
      "Backstory MCP",
      "SMTP"
    ],
    "tags": [
      "recurring",
      "pipeline"
    ],
    "model": "claude-opus-4-8"
  },
  {
    "id": "06-executive-inbox",
    "name": "Executive Inbox",
    "description": "Automates executive email triage by reading unread email messages, identifying those from customers or prospects, enriching them with CRM context from Backstory, and using AI to classify and route each message.",
    "category": "Account Monitoring",
    "instructions": "Automates executive email triage by reading unread email messages, identifying those from customers or prospects, enriching them with CRM context from Backstory, and using AI to classify and route each message. The AI Agent analyzes the email content alongside account history to determine urgency, category (support escalation, deal progression, renewal, executive outreach, etc.), and the appropriate internal channel or person. Routed messages land in the right Messaging channel (Slack, Teams, or Email) or trigger follow-up workflows, ensuring nothing falls through the cracks.\n\nCarry this out as an AI agent: use the Backstory MCP to retrieve the relevant account, opportunity, and engagement data, reason over it, and deliver the result through the connected tools. Ask the user for anything you need (target account, thresholds, delivery channel) before running.",
    "integrations": [
      "Backstory MCP",
      "Email",
      "Slack",
      "Project Management"
    ],
    "tags": [
      "recurring",
      "account"
    ],
    "model": "claude-opus-4-8"
  },
  {
    "id": "07-churn-risk-scorecard",
    "name": "Churn Risk Scorecard",
    "description": "Generates a weekly churn risk scorecard for the customer success team.",
    "category": "Customer Success",
    "instructions": "Generates a weekly churn risk scorecard for the customer success team. The workflow pulls engagement trends, support ticket volumes, champion contact activity, and product usage signals from Backstory and the CRM. An AI agent scores each account on a 1-10 churn risk scale, identifies the top risk drivers, and suggests specific save plays. The scorecard is delivered to CS managers via Messaging with accounts ranked by risk severity.\n\nCarry this out as an AI agent: use the Backstory MCP to retrieve the relevant account, opportunity, and engagement data, reason over it, and deliver the result through the connected tools. Ask the user for anything you need (target account, thresholds, delivery channel) before running.",
    "integrations": [
      "Backstory MCP",
      "CRM",
      "Slack",
      "Email"
    ],
    "tags": [
      "recurring",
      "customer"
    ],
    "model": "claude-opus-4-8"
  },
  {
    "id": "08-renewal-prep-brief",
    "name": "Renewal Prep Brief",
    "description": "Automatically generates renewal preparation briefs at 60, 30, and 15 days before each account's renewal date.",
    "category": "Customer Success",
    "instructions": "Automatically generates renewal preparation briefs at 60, 30, and 15 days before each account's renewal date. The workflow queries the CRM for upcoming renewals, enriches each account with Backstory engagement trends, support history, expansion signals, and key contact activity. An AI agent produces a structured brief covering account health, risk factors, expansion opportunities, and a recommended renewal strategy. Briefs are delivered to the assigned CSM and account executive via Messaging.\n\nCarry this out as an AI agent: use the Backstory MCP to retrieve the relevant account, opportunity, and engagement data, reason over it, and deliver the result through the connected tools. Ask the user for anything you need (target account, thresholds, delivery channel) before running.",
    "integrations": [
      "Backstory MCP",
      "CRM",
      "Slack",
      "Email"
    ],
    "tags": [
      "recurring",
      "customer"
    ],
    "model": "claude-opus-4-8"
  },
  {
    "id": "09-onboarding-pulse",
    "name": "Onboarding Pulse",
    "description": "Monitors newly closed deals during their first 90 days to detect accounts going dark before they become a retention problem.",
    "category": "Customer Success",
    "instructions": "Monitors newly closed deals during their first 90 days to detect accounts going dark before they become a retention problem. The workflow identifies recently closed-won accounts, checks Backstory engagement data for post-sale activity (meetings booked, emails exchanged, contacts engaged), and flags accounts with below-threshold engagement. An AI agent assesses each flagged account and recommends specific re-engagement actions. Alerts are sent to the CSM and sales handoff team via Messaging.\n\nCarry this out as an AI agent: use the Backstory MCP to retrieve the relevant account, opportunity, and engagement data, reason over it, and deliver the result through the connected tools. Ask the user for anything you need (target account, thresholds, delivery channel) before running.",
    "integrations": [
      "Backstory MCP",
      "CRM",
      "Slack",
      "Email"
    ],
    "tags": [
      "recurring",
      "customer"
    ],
    "model": "claude-opus-4-8"
  },
  {
    "id": "10-activity-gap-detector",
    "name": "Activity Gap Detector",
    "description": "Compares each rep's weekly activity patterns against team benchmarks and top performer profiles using Backstory activity data.",
    "category": "Coaching & Enablement",
    "instructions": "Compares each rep's weekly activity patterns against team benchmarks and top performer profiles using Backstory activity data. Identifies reps with low outbound activity, thin multi-threading on key deals, or single-threaded opportunities missing executive engagement. An AI agent generates personalized coaching nudges for sales managers, highlighting specific gaps and suggesting actionable improvement areas. Delivered weekly to frontline managers via Messaging.\n\nCarry this out as an AI agent: use the Backstory MCP to retrieve the relevant account, opportunity, and engagement data, reason over it, and deliver the result through the connected tools. Ask the user for anything you need (target account, thresholds, delivery channel) before running.",
    "integrations": [
      "Backstory MCP",
      "Slack",
      "Email"
    ],
    "tags": [
      "recurring",
      "coaching"
    ],
    "model": "claude-opus-4-8"
  },
  {
    "id": "11-deal-hygiene-audit",
    "name": "Deal Hygiene Audit",
    "description": "Performs a weekly pipeline hygiene audit by scanning all open opportunities in the CRM and cross-referencing with Backstory engagement data.",
    "category": "Coaching & Enablement",
    "instructions": "Performs a weekly pipeline hygiene audit by scanning all open opportunities in the CRM and cross-referencing with Backstory engagement data. Flags deals with stale close dates, no recent activity, missing next steps, single-threaded contacts, or no executive engagement. An AI agent prioritizes the issues and generates a per-rep action list with specific cleanup tasks. Delivered to reps and their managers via Messaging every Monday morning.\n\nCarry this out as an AI agent: use the Backstory MCP to retrieve the relevant account, opportunity, and engagement data, reason over it, and deliver the result through the connected tools. Ask the user for anything you need (target account, thresholds, delivery channel) before running.",
    "integrations": [
      "Backstory MCP",
      "CRM",
      "Slack",
      "Email"
    ],
    "tags": [
      "recurring",
      "coaching"
    ],
    "model": "claude-opus-4-8"
  },
  {
    "id": "12-win-loss-debrief",
    "name": "Win/Loss Debrief Generator",
    "description": "Automatically generates a structured win/loss debrief when any deal closes (won or lost).",
    "category": "Coaching & Enablement",
    "instructions": "Automatically generates a structured win/loss debrief when any deal closes (won or lost). Triggered by a CRM webhook on stage change, the workflow pulls the full engagement timeline from Backstory — every meeting, email, contact involved, and engagement cadence throughout the deal cycle. An AI agent analyzes the timeline to produce a structured debrief: what worked, where engagement dropped, key turning points, multi-threading effectiveness, and lessons learned. The debrief is delivered to the rep, their manager, and optionally a shared enablement channel.\n\nCarry this out as an AI agent: use the Backstory MCP to retrieve the relevant account, opportunity, and engagement data, reason over it, and deliver the result through the connected tools. Ask the user for anything you need (target account, thresholds, delivery channel) before running.",
    "integrations": [
      "Backstory MCP",
      "CRM",
      "Slack",
      "Email"
    ],
    "tags": [
      "coaching"
    ],
    "model": "claude-opus-4-8"
  },
  {
    "id": "13-competitive-displacement-alert",
    "name": "Competitive Displacement Alert",
    "description": "Monitors customer accounts for early signs of competitive displacement.",
    "category": "Strategic Intelligence",
    "instructions": "Monitors customer accounts for early signs of competitive displacement. The workflow scans Backstory engagement data for accounts where internal engagement has suddenly dropped while simultaneously checking for competitor mentions in email subjects, meeting titles, or CRM notes. An AI agent evaluates the combined signals to assess displacement risk and recommends defensive actions. High-risk alerts are sent immediately to the account owner and their manager via Messaging.\n\nCarry this out as an AI agent: use the Backstory MCP to retrieve the relevant account, opportunity, and engagement data, reason over it, and deliver the result through the connected tools. Ask the user for anything you need (target account, thresholds, delivery channel) before running.",
    "integrations": [
      "Backstory MCP",
      "CRM",
      "Slack",
      "Email"
    ],
    "tags": [
      "recurring",
      "strategic"
    ],
    "model": "claude-opus-4-8"
  },
  {
    "id": "14-territory-heat-map",
    "name": "Territory Heat Map",
    "description": "Generates a weekly territory heat map digest for each rep, showing which accounts in their territory are heating up (increased inbound, new contacts engaging, meeting frequency rising) versus cooling down (declining engagement, unresponsive contacts).",
    "category": "Strategic Intelligence",
    "instructions": "Generates a weekly territory heat map digest for each rep, showing which accounts in their territory are heating up (increased inbound, new contacts engaging, meeting frequency rising) versus cooling down (declining engagement, unresponsive contacts). The workflow pulls Backstory engagement data across all accounts in each rep's territory, calculates week-over-week momentum scores, and uses an AI agent to summarize trends and recommend where to focus time. Delivered every Monday to help reps prioritize their week.\n\nCarry this out as an AI agent: use the Backstory MCP to retrieve the relevant account, opportunity, and engagement data, reason over it, and deliver the result through the connected tools. Ask the user for anything you need (target account, thresholds, delivery channel) before running.",
    "integrations": [
      "Backstory MCP",
      "Slack",
      "Email"
    ],
    "tags": [
      "recurring",
      "strategic"
    ],
    "model": "claude-opus-4-8"
  },
  {
    "id": "15-qbr-auto-prep",
    "name": "QBR Auto-Prep",
    "description": "Automatically prepares quarterly business review materials for every account on an upcoming QBR agenda.",
    "category": "Strategic Intelligence",
    "instructions": "Automatically prepares quarterly business review materials for every account on an upcoming QBR agenda. The workflow scans the calendar for meetings tagged as QBRs (or matching configurable title patterns), then for each account on the agenda, pulls the full quarter's engagement data from Backstory: meeting frequency, email volume, contacts engaged, key relationship changes, and deal progression. An AI agent generates a structured QBR prep document with executive summary, engagement trends, wins/risks, and talking points. Delivered to the account team 48 hours before the QBR.\n\nCarry this out as an AI agent: use the Backstory MCP to retrieve the relevant account, opportunity, and engagement data, reason over it, and deliver the result through the connected tools. Ask the user for anything you need (target account, thresholds, delivery channel) before running.",
    "integrations": [
      "Backstory MCP",
      "CRM",
      "Calendar",
      "Slack",
      "Email"
    ],
    "tags": [
      "recurring",
      "strategic"
    ],
    "model": "claude-opus-4-8"
  },
  {
    "id": "16-executive-sponsor-tracker",
    "name": "Executive Sponsor Tracker",
    "description": "Monitors executive-level contact engagement across strategic deals to ensure champion and sponsor relationships stay active.",
    "category": "Strategic Intelligence",
    "instructions": "Monitors executive-level contact engagement across strategic deals to ensure champion and sponsor relationships stay active. The workflow identifies open opportunities above a configurable deal value threshold, checks Backstory for executive contact engagement (VP+ titles), and flags deals where executive sponsors have gone silent (no meetings or emails in the configured lookback window). An AI agent assesses the risk of each silent-sponsor situation and recommends re-engagement tactics. Alerts are sent to the deal owner and sales leadership via Messaging.\n\nCarry this out as an AI agent: use the Backstory MCP to retrieve the relevant account, opportunity, and engagement data, reason over it, and deliver the result through the connected tools. Ask the user for anything you need (target account, thresholds, delivery channel) before running.",
    "integrations": [
      "Backstory MCP",
      "CRM",
      "Slack",
      "Email"
    ],
    "tags": [
      "recurring",
      "strategic"
    ],
    "model": "claude-opus-4-8"
  },
  {
    "id": "17-marketing-sales-handoff-scorer",
    "name": "Marketing-to-Sales Handoff Scorer",
    "description": "Enriches marketing-qualified leads at the moment of handoff by checking Backstory for existing engagement history.",
    "category": "Pipeline & Forecasting",
    "instructions": "Enriches marketing-qualified leads at the moment of handoff by checking Backstory for existing engagement history. When a new MQL is created in the CRM or marketing automation platform, the workflow queries Backstory to see if the account already has relationship history — prior meetings, email threads, known contacts, or past opportunities. An AI agent scores the handoff quality (hot / warm / cold) and generates a context brief for the receiving SDR or AE, so they never walk into a \"cold\" call that's actually warm. Delivered instantly via Messaging.\n\nCarry this out as an AI agent: use the Backstory MCP to retrieve the relevant account, opportunity, and engagement data, reason over it, and deliver the result through the connected tools. Ask the user for anything you need (target account, thresholds, delivery channel) before running.",
    "integrations": [
      "Backstory MCP",
      "CRM",
      "Slack",
      "Email"
    ],
    "tags": [
      "pipeline"
    ],
    "model": "claude-opus-4-8"
  },
  {
    "id": "18-channel-pulse",
    "name": "Channel Pulse",
    "description": "Sends quick, 60-second scannable updates to internal customer channels with relevant account information from the last 7 days.",
    "category": "Account Monitoring",
    "instructions": "Sends quick, 60-second scannable updates to internal customer channels with relevant account information from the last 7 days. Designed to keep the extended team and executives abreast of what's happening in key accounts without requiring them to dig through CRM data or attend every meeting.\n\nCarry this out as an AI agent: use the Backstory MCP to retrieve the relevant account, opportunity, and engagement data, reason over it, and deliver the result through the connected tools. Ask the user for anything you need (target account, thresholds, delivery channel) before running.",
    "integrations": [
      "Backstory MCP",
      "Slack",
      "Email"
    ],
    "tags": [
      "recurring",
      "account"
    ],
    "model": "claude-opus-4-8"
  },
  {
    "id": "19-customer-stack-blueprint",
    "name": "Customer Stack Blueprint",
    "description": "Turns a customer workflow request and tool-stack intake into a reusable implementation blueprint that recommends the closest validated asset, the right orchestration recipe, and the connector substitutions required for CRM, delivery, and meeting-source differences.",
    "category": "Platform Enablement",
    "instructions": "Turns a customer workflow request and tool-stack intake into a reusable implementation blueprint that recommends the closest validated asset, the right orchestration recipe, and the connector substitutions required for CRM, delivery, and meeting-source differences.\n\nCarry this out as an AI agent: use the Backstory MCP to retrieve the relevant account, opportunity, and engagement data, reason over it, and deliver the result through the connected tools. Ask the user for anything you need (target account, thresholds, delivery channel) before running.",
    "integrations": [
      "Request intake source",
      "Workflow library knowledge",
      "Slack",
      "Email"
    ],
    "tags": [
      "platform"
    ],
    "model": "claude-opus-4-8"
  },
  {
    "id": "20-crm-signal-normalizer",
    "name": "CRM Signal Normalizer",
    "description": "Normalizes Salesforce, Dynamics 365, HubSpot, or custom CRM records into a canonical account, contact, opportunity, and activity payload so downstream Backstory workflows can be reused without forking business logic by CRM.",
    "category": "Platform Enablement",
    "instructions": "Normalizes Salesforce, Dynamics 365, HubSpot, or custom CRM records into a canonical account, contact, opportunity, and activity payload so downstream Backstory workflows can be reused without forking business logic by CRM.\n\nCarry this out as an AI agent: use the Backstory MCP to retrieve the relevant account, opportunity, and engagement data, reason over it, and deliver the result through the connected tools. Ask the user for anything you need (target account, thresholds, delivery channel) before running.",
    "integrations": [
      "CRM",
      "Event sink"
    ],
    "tags": [
      "recurring",
      "platform"
    ],
    "model": "claude-opus-4-8"
  },
  {
    "id": "21-meeting-intelligence-normalizer",
    "name": "Meeting Intelligence Normalizer",
    "description": "Normalizes meetings, transcripts, attendees, and action items from Gong, Zoom, Teams, Otter, Fireflies, Fathom, and other note-taker systems into one reusable meeting-intelligence payload for prep, coaching, and QBR workflows.",
    "category": "Platform Enablement",
    "instructions": "Normalizes meetings, transcripts, attendees, and action items from Gong, Zoom, Teams, Otter, Fireflies, Fathom, and other note-taker systems into one reusable meeting-intelligence payload for prep, coaching, and QBR workflows.\n\nCarry this out as an AI agent: use the Backstory MCP to retrieve the relevant account, opportunity, and engagement data, reason over it, and deliver the result through the connected tools. Ask the user for anything you need (target account, thresholds, delivery channel) before running.",
    "integrations": [
      "Calendar"
    ],
    "tags": [
      "recurring",
      "platform"
    ],
    "model": "claude-opus-4-8"
  },
  {
    "id": "22-multi-channel-delivery-router",
    "name": "Multi-Channel Delivery Router",
    "description": "Receives a ready-to-send insight payload, resolves whether it should land in Slack, Teams, email, or a webhook, adapts the format for that surface, and applies fallback routing without cloning the business logic for each tool.",
    "category": "Platform Enablement",
    "instructions": "Receives a ready-to-send insight payload, resolves whether it should land in Slack, Teams, email, or a webhook, adapts the format for that surface, and applies fallback routing without cloning the business logic for each tool.\n\nCarry this out as an AI agent: use the Backstory MCP to retrieve the relevant account, opportunity, and engagement data, reason over it, and deliver the result through the connected tools. Ask the user for anything you need (target account, thresholds, delivery channel) before running.",
    "integrations": [
      "Delivery credentials",
      "Fallback sink"
    ],
    "tags": [
      "platform"
    ],
    "model": "claude-opus-4-8"
  },
  {
    "id": "23-identity-resolution-hub",
    "name": "Identity Resolution Hub",
    "description": "Resolves people, account, owner, and channel identities across CRM, messaging, and meeting systems into a canonical identity layer so downstream workflows stop breaking on duplicate humans, alias drift, and ambiguous account ownership.",
    "category": "Platform Enablement",
    "instructions": "Resolves people, account, owner, and channel identities across CRM, messaging, and meeting systems into a canonical identity layer so downstream workflows stop breaking on duplicate humans, alias drift, and ambiguous account ownership.\n\nCarry this out as an AI agent: use the Backstory MCP to retrieve the relevant account, opportunity, and engagement data, reason over it, and deliver the result through the connected tools. Ask the user for anything you need (target account, thresholds, delivery channel) before running.",
    "integrations": [
      "Identity source access"
    ],
    "tags": [
      "platform"
    ],
    "model": "claude-opus-4-8"
  },
  {
    "id": "24-workflow-contract-validator",
    "name": "Workflow Contract Validator",
    "description": "Validates canonical payloads between workflow steps so schema drift, missing fields, enum changes, and connector-specific shape changes are caught before they break downstream automations.",
    "category": "Platform Enablement",
    "instructions": "Validates canonical payloads between workflow steps so schema drift, missing fields, enum changes, and connector-specific shape changes are caught before they break downstream automations.\n\nCarry this out as an AI agent: use the Backstory MCP to retrieve the relevant account, opportunity, and engagement data, reason over it, and deliver the result through the connected tools. Ask the user for anything you need (target account, thresholds, delivery channel) before running.",
    "integrations": [
      "Payload source",
      "Contract registry",
      "Quarantine sink"
    ],
    "tags": [
      "platform"
    ],
    "model": "claude-opus-4-8"
  },
  {
    "id": "25-implementation-gap-audit",
    "name": "Implementation Gap Audit",
    "description": "Audits a customer stack or internal workflow request against the current library to identify what is already validated, what only has recipe coverage, and what still needs productization work before rollout.",
    "category": "Platform Enablement",
    "instructions": "Audits a customer stack or internal workflow request against the current library to identify what is already validated, what only has recipe coverage, and what still needs productization work before rollout.\n\nCarry this out as an AI agent: use the Backstory MCP to retrieve the relevant account, opportunity, and engagement data, reason over it, and deliver the result through the connected tools. Ask the user for anything you need (target account, thresholds, delivery channel) before running.",
    "integrations": [
      "Audit intake source",
      "Workflow library knowledge",
      "Delivery or backlog surface"
    ],
    "tags": [
      "platform"
    ],
    "model": "claude-opus-4-8"
  },
  {
    "id": "26-orchestrator-migration-planner",
    "name": "Orchestrator Migration Planner",
    "description": "Transforms a validated workflow pattern plus source-tool implementation details into a migration plan for n8n, Make, Power Automate, Zapier, Workato, or custom code without losing workflow order, state handling, payload contracts, or delivery behavior.",
    "category": "Platform Enablement",
    "instructions": "Transforms a validated workflow pattern plus source-tool implementation details into a migration plan for n8n, Make, Power Automate, Zapier, Workato, or custom code without losing workflow order, state handling, payload contracts, or delivery behavior.\n\nCarry this out as an AI agent: use the Backstory MCP to retrieve the relevant account, opportunity, and engagement data, reason over it, and deliver the result through the connected tools. Ask the user for anything you need (target account, thresholds, delivery channel) before running.",
    "integrations": [
      "Source workflow reference",
      "Target orchestrator constraints",
      "Workflow library knowledge"
    ],
    "tags": [
      "platform"
    ],
    "model": "claude-opus-4-8"
  },
  {
    "id": "27-adapter-regression-monitor",
    "name": "Adapter Regression Monitor",
    "description": "Replays golden payloads through CRM, meeting, identity, and delivery adapters to catch functional regressions before connector changes break reusable workflow patterns.",
    "category": "Platform Enablement",
    "instructions": "Replays golden payloads through CRM, meeting, identity, and delivery adapters to catch functional regressions before connector changes break reusable workflow patterns.\n\nCarry this out as an AI agent: use the Backstory MCP to retrieve the relevant account, opportunity, and engagement data, reason over it, and deliver the result through the connected tools. Ask the user for anything you need (target account, thresholds, delivery channel) before running.",
    "integrations": [
      "Adapter execution surfaces"
    ],
    "tags": [
      "recurring",
      "platform"
    ],
    "model": "claude-opus-4-8"
  },
  {
    "id": "28-rollout-readiness-scorecard",
    "name": "Rollout Readiness Scorecard",
    "description": "Scores whether a customer stack is actually ready for deployment by evaluating connector access, identity coverage, delivery routes, ownership, security prerequisites, and QA gates before a workflow goes live.",
    "category": "Platform Enablement",
    "instructions": "Scores whether a customer stack is actually ready for deployment by evaluating connector access, identity coverage, delivery routes, ownership, security prerequisites, and QA gates before a workflow goes live.\n\nCarry this out as an AI agent: use the Backstory MCP to retrieve the relevant account, opportunity, and engagement data, reason over it, and deliver the result through the connected tools. Ask the user for anything you need (target account, thresholds, delivery channel) before running.",
    "integrations": [
      "Readiness intake source",
      "Workflow library knowledge",
      "Security and ownership inputs"
    ],
    "tags": [
      "platform"
    ],
    "model": "claude-opus-4-8"
  },
  {
    "id": "29-digital-chief-of-staff",
    "name": "Digital Chief of Staff",
    "description": "Reference-grade Digital Chief of Staff workflow that combines account-channel updates, executive briefing synthesis, and calendar task generation using shared n8n sub-workflows plus bounded MCP enrichment.",
    "category": "Strategic Intelligence",
    "instructions": "Reference-grade Digital Chief of Staff workflow that combines account-channel updates, executive briefing synthesis, and calendar task generation using shared n8n sub-workflows plus bounded MCP enrichment.\n\nCarry this out as an AI agent: use the Backstory MCP to retrieve the relevant account, opportunity, and engagement data, reason over it, and deliver the result through the connected tools. Ask the user for anything you need (target account, thresholds, delivery channel) before running.",
    "integrations": [
      "Backstory MCP",
      "Slack",
      "Calendar",
      "Source system adapter"
    ],
    "tags": [
      "recurring",
      "strategic"
    ],
    "model": "claude-opus-4-8"
  },
  {
    "id": "30-market-research-brief",
    "name": "Market Research Brief",
    "description": "Builds a weekly market-intelligence digest for target accounts by combining normalized external company-signal packets with Backstory relationship and opportunity context.",
    "category": "Strategic Intelligence",
    "instructions": "Builds a weekly market-intelligence digest for target accounts by combining normalized external company-signal packets with Backstory relationship and opportunity context.\n\nCarry this out as an AI agent: use the Backstory MCP to retrieve the relevant account, opportunity, and engagement data, reason over it, and deliver the result through the connected tools. Ask the user for anything you need (target account, thresholds, delivery channel) before running.",
    "integrations": [
      "Market-intelligence source feed",
      "Backstory MCP",
      "Slack",
      "Email"
    ],
    "tags": [
      "recurring",
      "strategic"
    ],
    "model": "claude-opus-4-8"
  },
  {
    "id": "31-deal-inspection",
    "name": "Deal Inspection (Slack /dealcheck)",
    "description": "Runs a slash-command deal inspection by resolving the requested account and opportunity, pulling Backstory deal context, and returning the top risk, supporting evidence, and next actions in Slack.",
    "category": "Pipeline & Forecasting",
    "instructions": "Runs a slash-command deal inspection by resolving the requested account and opportunity, pulling Backstory deal context, and returning the top risk, supporting evidence, and next actions in Slack.\n\nCarry this out as an AI agent: use the Backstory MCP to retrieve the relevant account, opportunity, and engagement data, reason over it, and deliver the result through the connected tools. Ask the user for anything you need (target account, thresholds, delivery channel) before running.",
    "integrations": [
      "Backstory MCP",
      "Slack"
    ],
    "tags": [
      "pipeline"
    ],
    "model": "claude-opus-4-8"
  },
  {
    "id": "32-revenue-orchestration",
    "name": "Revenue Orchestration (Approval-Gated)",
    "description": "Takes an external revenue signal, builds a proposed CRM update plus owner message, and pauses for Slack approval before sending the approved action downstream.",
    "category": "Pipeline & Forecasting",
    "instructions": "Takes an external revenue signal, builds a proposed CRM update plus owner message, and pauses for Slack approval before sending the approved action downstream.\n\nCarry this out as an AI agent: use the Backstory MCP to retrieve the relevant account, opportunity, and engagement data, reason over it, and deliver the result through the connected tools. Ask the user for anything you need (target account, thresholds, delivery channel) before running.",
    "integrations": [
      "Backstory MCP",
      "Slack",
      "n8n public callback URL"
    ],
    "tags": [
      "pipeline"
    ],
    "model": "claude-opus-4-8"
  },
  {
    "id": "33-prospecting-brief",
    "name": "Prospecting Brief",
    "description": "Builds an on-demand prospecting brief by combining account status, recent account activity, and situation context into tailored outreach angles and next steps.",
    "category": "Strategic Intelligence",
    "instructions": "Builds an on-demand prospecting brief by combining account status, recent account activity, and situation context into tailored outreach angles and next steps.\n\nCarry this out as an AI agent: use the Backstory MCP to retrieve the relevant account, opportunity, and engagement data, reason over it, and deliver the result through the connected tools. Ask the user for anything you need (target account, thresholds, delivery channel) before running.",
    "integrations": [
      "Backstory MCP",
      "Slack"
    ],
    "tags": [
      "strategic"
    ],
    "model": "claude-opus-4-8"
  },
  {
    "id": "34-manager-coaching-brief",
    "name": "Manager Coaching Brief",
    "description": "Creates an on-demand manager coaching brief by combining opportunity status, scorecard signal, and situation context into coaching points for the rep and manager.",
    "category": "Coaching & Enablement",
    "instructions": "Creates an on-demand manager coaching brief by combining opportunity status, scorecard signal, and situation context into coaching points for the rep and manager.\n\nCarry this out as an AI agent: use the Backstory MCP to retrieve the relevant account, opportunity, and engagement data, reason over it, and deliver the result through the connected tools. Ask the user for anything you need (target account, thresholds, delivery channel) before running.",
    "integrations": [
      "Backstory MCP",
      "Slack"
    ],
    "tags": [
      "coaching"
    ],
    "model": "claude-opus-4-8"
  },
  {
    "id": "35-grounded-follow-up",
    "name": "Content Generation — Grounded Follow-Up",
    "description": "Generates a grounded follow-up draft using recent opportunity activity, deal-risk context, and situation evidence so the outbound message stays tied to the actual deal state.",
    "category": "Coaching & Enablement",
    "instructions": "Generates a grounded follow-up draft using recent opportunity activity, deal-risk context, and situation evidence so the outbound message stays tied to the actual deal state.\n\nCarry this out as an AI agent: use the Backstory MCP to retrieve the relevant account, opportunity, and engagement data, reason over it, and deliver the result through the connected tools. Ask the user for anything you need (target account, thresholds, delivery channel) before running.",
    "integrations": [
      "Backstory MCP",
      "Slack"
    ],
    "tags": [
      "coaching"
    ],
    "model": "claude-opus-4-8"
  },
  {
    "id": "36-pipeline-forecast-digest",
    "name": "Pipeline & Forecast Digest",
    "description": "Builds a pipeline and forecast digest by pulling top records, expanding at-risk opportunities, enriching each one with context, and summarizing the highest-priority forecast issues in Slack.",
    "category": "Pipeline & Forecasting",
    "instructions": "Builds a pipeline and forecast digest by pulling top records, expanding at-risk opportunities, enriching each one with context, and summarizing the highest-priority forecast issues in Slack.\n\nCarry this out as an AI agent: use the Backstory MCP to retrieve the relevant account, opportunity, and engagement data, reason over it, and deliver the result through the connected tools. Ask the user for anything you need (target account, thresholds, delivery channel) before running.",
    "integrations": [
      "Backstory MCP",
      "Slack"
    ],
    "tags": [
      "pipeline"
    ],
    "model": "claude-opus-4-8"
  },
  {
    "id": "37-deal-risk-next-actions",
    "name": "AI Agents — Deal Risk + Next Actions",
    "description": "Creates an on-demand deal-risk brief by merging opportunity status, recent activity, engaged-person context, and situation evidence into a concise risk and next-action recommendation.",
    "category": "Pipeline & Forecasting",
    "instructions": "Creates an on-demand deal-risk brief by merging opportunity status, recent activity, engaged-person context, and situation evidence into a concise risk and next-action recommendation.\n\nCarry this out as an AI agent: use the Backstory MCP to retrieve the relevant account, opportunity, and engagement data, reason over it, and deliver the result through the connected tools. Ask the user for anything you need (target account, thresholds, delivery channel) before running.",
    "integrations": [
      "Backstory MCP",
      "Slack"
    ],
    "tags": [
      "pipeline"
    ],
    "model": "claude-opus-4-8"
  },
  {
    "id": "38-account-planning-strategy",
    "name": "Account Planning & Strategy",
    "description": "Generates an account-planning strategy brief by combining account status, recent account activity, stakeholder engagement, and situation context into account-level priorities and next steps.",
    "category": "Strategic Intelligence",
    "instructions": "Generates an account-planning strategy brief by combining account status, recent account activity, stakeholder engagement, and situation context into account-level priorities and next steps.\n\nCarry this out as an AI agent: use the Backstory MCP to retrieve the relevant account, opportunity, and engagement data, reason over it, and deliver the result through the connected tools. Ask the user for anything you need (target account, thresholds, delivery channel) before running.",
    "integrations": [
      "Backstory MCP",
      "Slack"
    ],
    "tags": [
      "strategic"
    ],
    "model": "claude-opus-4-8"
  }
]

export const GET = withAuthenticatedApi(async (request, auth) => {
  const stored = await prisma.agentTemplate.findMany({
    where: { organizationId: auth.organizationId, isActive: true },
    orderBy: { updatedAt: 'desc' },
  })
  const templates = [...builtInTemplates, ...stored.map(serializeTemplate)]
  const limit = Number(request.nextUrl.searchParams.get('limit'))
  return { success: true, templates: limit > 0 ? templates.slice(0, limit) : templates }
})

export const POST = withAuthenticatedApi(async (request, auth) => {
  const data = templateSchema.parse(await request.json())
  const template = await prisma.agentTemplate.create({
    data: {
      name: data.name,
      description: data.description,
      type: data.category,
      configuration: {
        instructions: data.instructions,
        integrations: data.integrations,
        tags: data.tags,
        model: data.model,
      },
      userId: auth.dbUser.id,
      organizationId: auth.organizationId,
    },
  })
  return { success: true, template: serializeTemplate(template) }
})

export const PUT = withAuthenticatedApi(async (request, auth) => {
  const body = z.object({ id: z.string().min(1) }).merge(templateSchema.partial()).parse(await request.json())
  const existing = await prisma.agentTemplate.findFirst({
    where: { id: body.id, organizationId: auth.organizationId },
  })
  if (!existing) throw new ApiError('Template not found', 404, 'NOT_FOUND')
  const config = (existing.configuration && typeof existing.configuration === 'object' ? existing.configuration : {}) as any
  const template = await prisma.agentTemplate.update({
    where: { id: body.id },
    data: {
      ...(body.name !== undefined && { name: body.name }),
      ...(body.description !== undefined && { description: body.description }),
      ...(body.category !== undefined && { type: body.category }),
      configuration: {
        ...config,
        ...(body.instructions !== undefined && { instructions: body.instructions }),
        ...(body.integrations !== undefined && { integrations: body.integrations }),
        ...(body.tags !== undefined && { tags: body.tags }),
        ...(body.model !== undefined && { model: body.model }),
      },
    },
  })
  return { success: true, template: serializeTemplate(template) }
})

export const DELETE = withAuthenticatedApi(async (request, auth) => {
  const { id } = z.object({ id: z.string().min(1) }).parse(await request.json())
  const result = await prisma.agentTemplate.deleteMany({
    where: { id, organizationId: auth.organizationId },
  })
  if (!result.count) throw new ApiError('Template not found', 404, 'NOT_FOUND')
  return { success: true }
})
