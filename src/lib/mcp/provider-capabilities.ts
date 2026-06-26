// Curated set of Klavis-backed MCP providers. The `klavisName` MUST match
// Klavis's serverName enum exactly (verified against the live API), or
// instance creation returns a 422.
export const PROVIDER_CAPABILITIES = {
  github: { klavisName: 'GitHub', description: 'Manage GitHub repositories, pull requests, and issues', verbs: ['list_repositories', 'list_pull_requests', 'create_issue', 'comment'] },
  slack: { klavisName: 'Slack', description: 'Read and send Slack messages', verbs: ['list_channels', 'read_messages', 'send_message'] },
  linear: { klavisName: 'Linear', description: 'Manage Linear issues and projects', verbs: ['list_issues', 'create_issue', 'update_issue'] },
  asana: { klavisName: 'Asana', description: 'Manage Asana projects and tasks', verbs: ['list_tasks', 'create_task', 'update_task'] },
  jira: { klavisName: 'Jira', description: 'Manage Jira projects and issues', verbs: ['list_issues', 'create_issue', 'update_issue'] },
  monday: { klavisName: 'Monday', description: 'Manage Monday.com boards and items', verbs: ['list_boards', 'create_item', 'update_item'] },
  zendesk: { klavisName: 'Zendesk', description: 'Manage Zendesk tickets', verbs: ['list_tickets', 'create_ticket', 'update_ticket'] },
  notion: { klavisName: 'Notion', description: 'Read and update Notion pages and databases', verbs: ['search', 'read_page', 'create_page', 'update_page'] },
  gmail: { klavisName: 'Gmail', description: 'Read, draft, and send Gmail messages', verbs: ['list_messages', 'read_message', 'send_message', 'create_draft'] },
  google_drive: { klavisName: 'Google Drive', description: 'Browse and read Google Drive files', verbs: ['list_files', 'read_file', 'search'] },
  google_sheets: { klavisName: 'Google Sheets', description: 'Read and write Google Sheets', verbs: ['read_range', 'append_row', 'update_range'] },
  hubspot: { klavisName: 'HubSpot', description: 'Manage HubSpot CRM contacts and deals', verbs: ['list_contacts', 'create_contact', 'list_deals', 'update_deal'] },
} as const

export type MCPProvider = keyof typeof PROVIDER_CAPABILITIES

export const PROVIDERS = Object.keys(PROVIDER_CAPABILITIES) as MCPProvider[]

export function klavisServerName(provider: string): string | null {
  const entry = (PROVIDER_CAPABILITIES as Record<string, { klavisName: string }>)[provider.toLowerCase()]
  return entry ? entry.klavisName : null
}
