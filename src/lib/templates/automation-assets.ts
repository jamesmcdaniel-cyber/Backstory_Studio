/**
 * Shared quality contract for automation-library templates.
 *
 * Kept deterministic (rather than relying on the proposal model to remember
 * it) so built-in and AI-generated templates produce the same implementation-
 * ready assets. User-authored templates are intentionally left untouched.
 */
export const AUTOMATION_ASSET_CONTRACT_MARKER = '## Automation asset quality contract'

export const AUTOMATION_ASSET_CONTRACT = `${AUTOMATION_ASSET_CONTRACT_MARKER}

When the deliverable is a report, brief, scorecard, dashboard, or other human-facing artifact, create a polished, self-contained HTML document in addition to the concise channel-native summary. The HTML must:
- Be responsive, accessible, and presentation-ready, with a clear visual hierarchy, KPI cards, useful tables, status badges, and restrained data visualization where it improves comprehension.
- Use semantic HTML, embedded CSS, and only minimal embedded JavaScript. Do not require a build step or external assets unless the user explicitly requests them.
- Include generated-at time, source/coverage notes, confidence or data-gap states, empty and error states, and print-friendly styling.
- Use verified live data only. Label estimates and illustrative values clearly, and never fabricate missing facts.

When the user asks to build, deploy, export, document, or adapt the automation, also return an implementation package with these assets:

1. Canonical workflow JSON
- Return valid JSON in a fenced \`json\` block; never include comments or trailing commas.
- Include \`schemaVersion\`, \`name\`, \`purpose\`, \`trigger\`, \`inputs\`, \`connections\`, \`variables\`, \`steps\`, \`branches\`, \`outputs\`, and \`observability\`.
- Give every step a stable \`id\`, explicit \`type\`, \`uses\`, \`inputMapping\`, \`outputMapping\`, \`dependsOn\`, \`retry\`, \`timeoutSeconds\`, and \`onError\` policy.
- Model pagination, batching, rate limits, idempotency keys, deduplication, approval gates, secret references, timezone behavior, partial failure, and replay safety whenever relevant.
- Use placeholders such as \`$secrets.SALESFORCE_TOKEN\`; never place credentials or real secrets in the JSON.
- Treat this as a platform-neutral source of truth. Do not claim it is directly importable unless it matches a platform's documented export schema exactly.

2. Platform implementation guides
- Provide a canonical-step mapping table for n8n, Make, Zapier, Workato, and Microsoft Power Automate. For each platform, name the trigger, connector/module/action, key field mappings, filters or branches, loop/batch behavior, credential setup, and error-handling configuration.
- Give detailed build steps for the user's requested platform. If none is specified, recommend the best fit with a short rationale and fully detail that platform; keep the other four mappings concise but actionable.
- Call out platform limitations and any HTTP/webhook or code step needed to close capability gaps. Do not invent connector features.

3. Operations README
- Document prerequisites, required permissions, configurable parameters and defaults, setup order, test fixtures, happy-path test, failure-path tests, deployment checklist, monitoring/alerting, rollback, ownership, and maintenance notes.
- Finish with assumptions, open questions, and a concrete definition of done.

Keep the primary business result first. Put implementation assets after it so a reader can act on the insight without reading deployment detail.`

/** Append the contract once, preserving the template's domain-specific instructions. */
export function enhanceAutomationInstructions(instructions: string): string {
  const base = typeof instructions === 'string' ? instructions.trim() : ''
  if (base.includes(AUTOMATION_ASSET_CONTRACT_MARKER)) return base
  return [base, AUTOMATION_ASSET_CONTRACT].filter(Boolean).join('\n\n')
}
