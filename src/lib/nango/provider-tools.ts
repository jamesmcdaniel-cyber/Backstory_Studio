/**
 * Nango multi-provider agent tools.
 *
 * Each tool is a hand-authored adapter that maps tool args → a provider REST/GraphQL call
 * through Nango's proxy (credentials never touch our process). Unlike the
 * write-only delivery adapters, these carry a per-tool `isWrite` flag so read
 * tools (list/search/get) skip the approval gate while writes (create/update/
 * comment) keep it.
 *
 * Adding a provider = append its read + write specs here and map its Nango
 * connection config key(s) in PROVIDER_CONFIG_KEYS.
 */

import { type DeliveryConnection, type NangoProxy, defaultProxy } from './delivery'

export type NangoToolSpec = {
  /** Capability/provider key, e.g. 'github'. Runtime provider id is `nango:<provider>`. */
  provider: string
  /** Tool name exposed to the agent, e.g. 'github_list_repositories'. */
  name: string
  description: string
  /** Read tools skip the approval gate; writes are gated + audited. */
  isWrite: boolean
  inputSchema: Record<string, unknown>
  run: (connection: DeliveryConnection, args: Record<string, unknown>, proxy?: NangoProxy) => Promise<unknown>
}

/**
 * Provider key → Nango connection config key(s) to resolve a connection from.
 * The first is the canonical Nango dashboard integration id; alternates cover
 * naming variants. Extend as providers are added.
 */
export const PROVIDER_CONFIG_KEYS: Record<string, readonly string[]> = {
  github: ['github'],
  linear: ['linear'],
  jira: ['jira', 'atlassian'],
  asana: ['asana'],
  notion: ['notion'],
  hubspot: ['hubspot'],
  confluence: ['confluence'],
  zendesk: ['zendesk'],
  monday: ['monday'],
  google_drive: ['google-drive', 'google_drive'],
  google_sheets: ['google-sheet', 'google-sheets', 'google_sheets'],
  slack: ['slack'],
  gmail: ['google-mail', 'gmail'],
  salesforce: ['salesforce', 'salesforce-sandbox'],
}

/** Provider keys offered to agent drafting and template generation. */
export const NANGO_PROVIDERS = Object.keys(PROVIDER_CONFIG_KEYS)

const str = (v: unknown) => (v == null ? '' : String(v))
const num = (v: unknown, fallback: number) => {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

// ── GitHub (REST v3) ──────────────────────────────────────────────────────────

const GITHUB_TOOLS: NangoToolSpec[] = [
  {
    provider: 'github',
    name: 'github_list_repositories',
    description: 'List repositories for the connected user, or for a given user/organization.',
    isWrite: false,
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Optional user or org login. Omit for the connected account’s repos.' },
        per_page: { type: 'number', description: 'Max repos to return (default 30).' },
      },
    },
    run: (connection, args, proxy = defaultProxy()) => {
      const owner = str(args.owner).trim()
      const endpoint = owner ? `/users/${owner}/repos` : '/user/repos'
      return proxy({
        method: 'GET',
        endpoint,
        connectionId: connection.connectionId,
        providerConfigKey: connection.providerConfigKey,
        params: { per_page: num(args.per_page, 30), sort: 'updated' },
      }).then((r) => r.data)
    },
  },
  {
    provider: 'github',
    name: 'github_list_pull_requests',
    description: 'List and read pull requests on a repository.',
    isWrite: false,
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        state: { type: 'string', description: 'open | closed | all (default open).' },
      },
      required: ['owner', 'repo'],
    },
    run: (connection, args, proxy = defaultProxy()) =>
      proxy({
        method: 'GET',
        endpoint: `/repos/${str(args.owner)}/${str(args.repo)}/pulls`,
        connectionId: connection.connectionId,
        providerConfigKey: connection.providerConfigKey,
        params: { state: str(args.state) || 'open', per_page: num(args.per_page, 30) },
      }).then((r) => r.data),
  },
  {
    provider: 'github',
    name: 'github_create_issue',
    description: 'Open a new issue on a repository with a title and body.',
    isWrite: true,
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        title: { type: 'string' },
        body: { type: 'string' },
      },
      required: ['owner', 'repo', 'title'],
    },
    run: (connection, args, proxy = defaultProxy()) =>
      proxy({
        method: 'POST',
        endpoint: `/repos/${str(args.owner)}/${str(args.repo)}/issues`,
        connectionId: connection.connectionId,
        providerConfigKey: connection.providerConfigKey,
        data: { title: str(args.title), ...(args.body != null ? { body: str(args.body) } : {}) },
      }).then((r) => r.data),
  },
  {
    provider: 'github',
    name: 'github_comment',
    description: 'Add a comment to an issue or pull request.',
    isWrite: true,
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        issue_number: { type: 'number', description: 'Issue or PR number.' },
        body: { type: 'string' },
      },
      required: ['owner', 'repo', 'issue_number', 'body'],
    },
    run: (connection, args, proxy = defaultProxy()) =>
      proxy({
        method: 'POST',
        endpoint: `/repos/${str(args.owner)}/${str(args.repo)}/issues/${num(args.issue_number, 0)}/comments`,
        connectionId: connection.connectionId,
        providerConfigKey: connection.providerConfigKey,
        data: { body: str(args.body) },
      }).then((r) => r.data),
  },
]

// ── Linear (GraphQL) ──────────────────────────────────────────────────────────

const linearGraphql = (connection: DeliveryConnection, query: string, variables: Record<string, unknown>, proxy: NangoProxy) =>
  proxy({
    method: 'POST',
    endpoint: '/graphql',
    connectionId: connection.connectionId,
    providerConfigKey: connection.providerConfigKey,
    data: { query, variables },
  }).then((r) => r.data)

const LINEAR_TOOLS: NangoToolSpec[] = [
  {
    provider: 'linear',
    name: 'linear_list_issues',
    description: 'Search and list Linear issues, optionally filtered by a text query.',
    isWrite: false,
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Optional free-text search.' },
        first: { type: 'number', description: 'Max issues (default 25).' },
      },
    },
    run: (connection, args, proxy = defaultProxy()) => {
      const q = str(args.query).trim()
      const gql = `query Issues($first: Int!, $filter: IssueFilter) {
        issues(first: $first, filter: $filter) {
          nodes { id identifier title state { name } assignee { name } updatedAt }
        }
      }`
      const filter = q ? { searchableContent: { contains: q } } : undefined
      return linearGraphql(connection, gql, { first: num(args.first, 25), filter }, proxy)
    },
  },
  {
    provider: 'linear',
    name: 'linear_create_issue',
    description: 'Create a Linear issue in a team with a title and optional description/assignee.',
    isWrite: true,
    inputSchema: {
      type: 'object',
      properties: {
        teamId: { type: 'string', description: 'Linear team id the issue belongs to.' },
        title: { type: 'string' },
        description: { type: 'string' },
        assigneeId: { type: 'string' },
      },
      required: ['teamId', 'title'],
    },
    run: (connection, args, proxy = defaultProxy()) => {
      const gql = `mutation Create($input: IssueCreateInput!) {
        issueCreate(input: $input) { success issue { id identifier url } }
      }`
      const input: Record<string, unknown> = { teamId: str(args.teamId), title: str(args.title) }
      if (args.description != null) input.description = str(args.description)
      if (args.assigneeId != null) input.assigneeId = str(args.assigneeId)
      return linearGraphql(connection, gql, { input }, proxy)
    },
  },
  {
    provider: 'linear',
    name: 'linear_update_issue',
    description: 'Update a Linear issue’s state, assignee, or title.',
    isWrite: true,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Issue id to update.' },
        stateId: { type: 'string' },
        assigneeId: { type: 'string' },
        title: { type: 'string' },
      },
      required: ['id'],
    },
    run: (connection, args, proxy = defaultProxy()) => {
      const gql = `mutation Update($id: String!, $input: IssueUpdateInput!) {
        issueUpdate(id: $id, input: $input) { success issue { id identifier state { name } } }
      }`
      const input: Record<string, unknown> = {}
      if (args.stateId != null) input.stateId = str(args.stateId)
      if (args.assigneeId != null) input.assigneeId = str(args.assigneeId)
      if (args.title != null) input.title = str(args.title)
      return linearGraphql(connection, gql, { id: str(args.id), input }, proxy)
    },
  },
]

// ── Jira (REST v3) ────────────────────────────────────────────────────────────

const JIRA_TOOLS: NangoToolSpec[] = [
  {
    provider: 'jira', name: 'jira_list_issues', isWrite: false,
    description: 'Search Jira issues with JQL, or list a project’s issues.',
    inputSchema: { type: 'object', properties: { jql: { type: 'string', description: 'JQL query.' }, project: { type: 'string', description: 'Project key (used when jql is omitted).' } } },
    run: (c, a, proxy = defaultProxy()) => {
      const jql = str(a.jql).trim() || (str(a.project) ? `project = ${str(a.project)} ORDER BY updated DESC` : 'ORDER BY updated DESC')
      return proxy({ method: 'GET', endpoint: '/rest/api/3/search', connectionId: c.connectionId, providerConfigKey: c.providerConfigKey, params: { jql, maxResults: num(a.maxResults, 25) } }).then((r) => r.data)
    },
  },
  {
    provider: 'jira', name: 'jira_create_issue', isWrite: true,
    description: 'Create a Jira issue in a project.',
    inputSchema: { type: 'object', properties: { project: { type: 'string', description: 'Project key.' }, summary: { type: 'string' }, issueType: { type: 'string', description: 'e.g. Task, Bug (default Task).' }, description: { type: 'string' } }, required: ['project', 'summary'] },
    run: (c, a, proxy = defaultProxy()) => proxy({
      method: 'POST', endpoint: '/rest/api/3/issue', connectionId: c.connectionId, providerConfigKey: c.providerConfigKey,
      data: { fields: { project: { key: str(a.project) }, summary: str(a.summary), issuetype: { name: str(a.issueType) || 'Task' }, ...(a.description != null ? { description: str(a.description) } : {}) } },
    }).then((r) => r.data),
  },
  {
    provider: 'jira', name: 'jira_update_issue', isWrite: true,
    description: 'Edit fields on an existing Jira issue.',
    inputSchema: { type: 'object', properties: { issueKey: { type: 'string' }, fields: { type: 'object', description: 'Jira field map to set.' } }, required: ['issueKey', 'fields'] },
    run: (c, a, proxy = defaultProxy()) => proxy({
      method: 'PUT', endpoint: `/rest/api/3/issue/${str(a.issueKey)}`, connectionId: c.connectionId, providerConfigKey: c.providerConfigKey,
      data: { fields: (a.fields as Record<string, unknown>) ?? {} },
    }).then((r) => r.data),
  },
]

// ── Asana (REST 1.0) ──────────────────────────────────────────────────────────

const ASANA_TOOLS: NangoToolSpec[] = [
  {
    provider: 'asana', name: 'asana_list_tasks', isWrite: false,
    description: 'List tasks in a project.',
    inputSchema: { type: 'object', properties: { project: { type: 'string', description: 'Project gid.' } }, required: ['project'] },
    run: (c, a, proxy = defaultProxy()) => proxy({ method: 'GET', endpoint: '/api/1.0/tasks', connectionId: c.connectionId, providerConfigKey: c.providerConfigKey, params: { project: str(a.project), limit: num(a.limit, 50) } }).then((r) => r.data),
  },
  {
    provider: 'asana', name: 'asana_create_task', isWrite: true,
    description: 'Create an Asana task with a name, notes, and optional due date.',
    inputSchema: { type: 'object', properties: { project: { type: 'string' }, name: { type: 'string' }, notes: { type: 'string' }, due_on: { type: 'string', description: 'YYYY-MM-DD.' } }, required: ['project', 'name'] },
    run: (c, a, proxy = defaultProxy()) => proxy({
      method: 'POST', endpoint: '/api/1.0/tasks', connectionId: c.connectionId, providerConfigKey: c.providerConfigKey,
      data: { data: { name: str(a.name), projects: [str(a.project)], ...(a.notes != null ? { notes: str(a.notes) } : {}), ...(a.due_on != null ? { due_on: str(a.due_on) } : {}) } },
    }).then((r) => r.data),
  },
  {
    provider: 'asana', name: 'asana_update_task', isWrite: true,
    description: 'Update an Asana task’s fields or completion state.',
    inputSchema: { type: 'object', properties: { taskGid: { type: 'string' }, fields: { type: 'object', description: 'Fields to set, e.g. {completed:true}.' } }, required: ['taskGid', 'fields'] },
    run: (c, a, proxy = defaultProxy()) => proxy({ method: 'PUT', endpoint: `/api/1.0/tasks/${str(a.taskGid)}`, connectionId: c.connectionId, providerConfigKey: c.providerConfigKey, data: { data: (a.fields as Record<string, unknown>) ?? {} } }).then((r) => r.data),
  },
]

// ── Notion (REST v1; requires a version header) ───────────────────────────────

const NOTION_VERSION = '2022-06-28'
const notionHeaders = { 'Notion-Version': NOTION_VERSION }

const NOTION_TOOLS: NangoToolSpec[] = [
  {
    provider: 'notion', name: 'notion_search', isWrite: false,
    description: 'Search Notion pages and databases by keyword.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
    run: (c, a, proxy = defaultProxy()) => proxy({ method: 'POST', endpoint: '/v1/search', connectionId: c.connectionId, providerConfigKey: c.providerConfigKey, headers: notionHeaders, data: { query: str(a.query) } }).then((r) => r.data),
  },
  {
    provider: 'notion', name: 'notion_read_page', isWrite: false,
    description: 'Read a Notion page’s block content.',
    inputSchema: { type: 'object', properties: { pageId: { type: 'string' } }, required: ['pageId'] },
    run: (c, a, proxy = defaultProxy()) => proxy({ method: 'GET', endpoint: `/v1/blocks/${str(a.pageId)}/children`, connectionId: c.connectionId, providerConfigKey: c.providerConfigKey, headers: notionHeaders }).then((r) => r.data),
  },
  {
    provider: 'notion', name: 'notion_create_page', isWrite: true,
    description: 'Create a Notion page under a parent page or database.',
    inputSchema: { type: 'object', properties: { parentId: { type: 'string', description: 'Parent page or database id.' }, title: { type: 'string' } }, required: ['parentId', 'title'] },
    run: (c, a, proxy = defaultProxy()) => proxy({
      method: 'POST', endpoint: '/v1/pages', connectionId: c.connectionId, providerConfigKey: c.providerConfigKey, headers: notionHeaders,
      data: { parent: { page_id: str(a.parentId) }, properties: { title: { title: [{ text: { content: str(a.title) } }] } } },
    }).then((r) => r.data),
  },
  {
    provider: 'notion', name: 'notion_update_page', isWrite: true,
    description: 'Append text blocks to a Notion page.',
    inputSchema: { type: 'object', properties: { pageId: { type: 'string' }, text: { type: 'string' } }, required: ['pageId', 'text'] },
    run: (c, a, proxy = defaultProxy()) => proxy({
      method: 'PATCH', endpoint: `/v1/blocks/${str(a.pageId)}/children`, connectionId: c.connectionId, providerConfigKey: c.providerConfigKey, headers: notionHeaders,
      data: { children: [{ paragraph: { rich_text: [{ text: { content: str(a.text) } }] } }] },
    }).then((r) => r.data),
  },
]

// ── HubSpot (CRM v3) ──────────────────────────────────────────────────────────

const HUBSPOT_TOOLS: NangoToolSpec[] = [
  {
    provider: 'hubspot', name: 'hubspot_list_contacts', isWrite: false,
    description: 'List CRM contacts.',
    inputSchema: { type: 'object', properties: { limit: { type: 'number' } } },
    run: (c, a, proxy = defaultProxy()) => proxy({ method: 'GET', endpoint: '/crm/v3/objects/contacts', connectionId: c.connectionId, providerConfigKey: c.providerConfigKey, params: { limit: num(a.limit, 50) } }).then((r) => r.data),
  },
  {
    provider: 'hubspot', name: 'hubspot_create_contact', isWrite: true,
    description: 'Create a HubSpot contact.',
    inputSchema: { type: 'object', properties: { properties: { type: 'object', description: 'e.g. {email,firstname,lastname}.' } }, required: ['properties'] },
    run: (c, a, proxy = defaultProxy()) => proxy({ method: 'POST', endpoint: '/crm/v3/objects/contacts', connectionId: c.connectionId, providerConfigKey: c.providerConfigKey, data: { properties: (a.properties as Record<string, unknown>) ?? {} } }).then((r) => r.data),
  },
  {
    provider: 'hubspot', name: 'hubspot_list_deals', isWrite: false,
    description: 'List deals in the pipeline.',
    inputSchema: { type: 'object', properties: { limit: { type: 'number' } } },
    run: (c, a, proxy = defaultProxy()) => proxy({ method: 'GET', endpoint: '/crm/v3/objects/deals', connectionId: c.connectionId, providerConfigKey: c.providerConfigKey, params: { limit: num(a.limit, 50) } }).then((r) => r.data),
  },
  {
    provider: 'hubspot', name: 'hubspot_update_deal', isWrite: true,
    description: 'Update a deal’s stage or properties.',
    inputSchema: { type: 'object', properties: { dealId: { type: 'string' }, properties: { type: 'object' } }, required: ['dealId', 'properties'] },
    run: (c, a, proxy = defaultProxy()) => proxy({ method: 'PATCH', endpoint: `/crm/v3/objects/deals/${str(a.dealId)}`, connectionId: c.connectionId, providerConfigKey: c.providerConfigKey, data: { properties: (a.properties as Record<string, unknown>) ?? {} } }).then((r) => r.data),
  },
]

// ── Confluence (REST) ─────────────────────────────────────────────────────────

const CONFLUENCE_TOOLS: NangoToolSpec[] = [
  {
    provider: 'confluence', name: 'confluence_search', isWrite: false,
    description: 'Search Confluence content with CQL.',
    inputSchema: { type: 'object', properties: { cql: { type: 'string', description: 'CQL query, e.g. text~"launch".' } }, required: ['cql'] },
    run: (c, a, proxy = defaultProxy()) => proxy({ method: 'GET', endpoint: '/wiki/rest/api/search', connectionId: c.connectionId, providerConfigKey: c.providerConfigKey, params: { cql: str(a.cql), limit: num(a.limit, 25) } }).then((r) => r.data),
  },
  {
    provider: 'confluence', name: 'confluence_read_page', isWrite: false,
    description: 'Read a Confluence page’s content.',
    inputSchema: { type: 'object', properties: { pageId: { type: 'string' } }, required: ['pageId'] },
    run: (c, a, proxy = defaultProxy()) => proxy({ method: 'GET', endpoint: `/wiki/rest/api/content/${str(a.pageId)}`, connectionId: c.connectionId, providerConfigKey: c.providerConfigKey, params: { expand: 'body.storage' } }).then((r) => r.data),
  },
  {
    provider: 'confluence', name: 'confluence_create_page', isWrite: true,
    description: 'Create a Confluence page in a space.',
    inputSchema: { type: 'object', properties: { spaceKey: { type: 'string' }, title: { type: 'string' }, body: { type: 'string', description: 'Storage-format HTML.' } }, required: ['spaceKey', 'title', 'body'] },
    run: (c, a, proxy = defaultProxy()) => proxy({
      method: 'POST', endpoint: '/wiki/rest/api/content', connectionId: c.connectionId, providerConfigKey: c.providerConfigKey,
      data: { type: 'page', space: { key: str(a.spaceKey) }, title: str(a.title), body: { storage: { value: str(a.body), representation: 'storage' } } },
    }).then((r) => r.data),
  },
]

// ── Google Drive (v3) ─────────────────────────────────────────────────────────

const GDRIVE_TOOLS: NangoToolSpec[] = [
  {
    provider: 'google_drive', name: 'google_drive_list_files', isWrite: false,
    description: 'List Google Drive files and folders, optionally filtered.',
    inputSchema: { type: 'object', properties: { q: { type: 'string', description: 'Drive query, e.g. name contains "report".' } } },
    run: (c, a, proxy = defaultProxy()) => proxy({ method: 'GET', endpoint: '/drive/v3/files', connectionId: c.connectionId, providerConfigKey: c.providerConfigKey, params: { ...(str(a.q) ? { q: str(a.q) } : {}), pageSize: num(a.pageSize, 50), fields: 'files(id,name,mimeType,modifiedTime)' } }).then((r) => r.data),
  },
  {
    provider: 'google_drive', name: 'google_drive_read_file', isWrite: false,
    description: 'Read a Google Drive file’s metadata (and text when exportable).',
    inputSchema: { type: 'object', properties: { fileId: { type: 'string' } }, required: ['fileId'] },
    run: (c, a, proxy = defaultProxy()) => proxy({ method: 'GET', endpoint: `/drive/v3/files/${str(a.fileId)}`, connectionId: c.connectionId, providerConfigKey: c.providerConfigKey, params: { fields: 'id,name,mimeType,webViewLink' } }).then((r) => r.data),
  },
]

// ── Google Sheets (v4) ────────────────────────────────────────────────────────

const GSHEETS_TOOLS: NangoToolSpec[] = [
  {
    provider: 'google_sheets', name: 'google_sheets_read_range', isWrite: false,
    description: 'Read values from a Google Sheets range (A1 notation).',
    inputSchema: { type: 'object', properties: { spreadsheetId: { type: 'string' }, range: { type: 'string', description: 'e.g. Sheet1!A1:D10.' } }, required: ['spreadsheetId', 'range'] },
    run: (c, a, proxy = defaultProxy()) => proxy({ method: 'GET', endpoint: `/v4/spreadsheets/${str(a.spreadsheetId)}/values/${encodeURIComponent(str(a.range))}`, connectionId: c.connectionId, providerConfigKey: c.providerConfigKey }).then((r) => r.data),
  },
  {
    provider: 'google_sheets', name: 'google_sheets_append_row', isWrite: true,
    description: 'Append a row of values to a Google Sheet.',
    inputSchema: { type: 'object', properties: { spreadsheetId: { type: 'string' }, range: { type: 'string' }, values: { type: 'array', description: 'One row: array of cell values.' } }, required: ['spreadsheetId', 'range', 'values'] },
    run: (c, a, proxy = defaultProxy()) => proxy({
      method: 'POST', endpoint: `/v4/spreadsheets/${str(a.spreadsheetId)}/values/${encodeURIComponent(str(a.range))}:append`, connectionId: c.connectionId, providerConfigKey: c.providerConfigKey,
      params: { valueInputOption: 'USER_ENTERED' }, data: { values: [Array.isArray(a.values) ? a.values : [a.values]] },
    }).then((r) => r.data),
  },
  {
    provider: 'google_sheets', name: 'google_sheets_update_range', isWrite: true,
    description: 'Write values into a Google Sheets range.',
    inputSchema: { type: 'object', properties: { spreadsheetId: { type: 'string' }, range: { type: 'string' }, values: { type: 'array', description: 'Rows: array of arrays.' } }, required: ['spreadsheetId', 'range', 'values'] },
    run: (c, a, proxy = defaultProxy()) => proxy({
      method: 'PUT', endpoint: `/v4/spreadsheets/${str(a.spreadsheetId)}/values/${encodeURIComponent(str(a.range))}`, connectionId: c.connectionId, providerConfigKey: c.providerConfigKey,
      params: { valueInputOption: 'USER_ENTERED' }, data: { values: (a.values as unknown[]) ?? [] },
    }).then((r) => r.data),
  },
]

// ── Monday (GraphQL v2) ───────────────────────────────────────────────────────

const mondayGraphql = (c: DeliveryConnection, query: string, proxy: NangoProxy) =>
  proxy({ method: 'POST', endpoint: '/v2', connectionId: c.connectionId, providerConfigKey: c.providerConfigKey, data: { query } }).then((r) => r.data)

const MONDAY_TOOLS: NangoToolSpec[] = [
  {
    provider: 'monday', name: 'monday_list_boards', isWrite: false,
    description: 'List Monday.com boards and their columns.',
    inputSchema: { type: 'object', properties: {} },
    run: (c, _a, proxy = defaultProxy()) => mondayGraphql(c, 'query { boards (limit: 50) { id name columns { id title type } } }', proxy),
  },
  {
    provider: 'monday', name: 'monday_create_item', isWrite: true,
    description: 'Add an item to a Monday.com board.',
    inputSchema: { type: 'object', properties: { boardId: { type: 'string' }, itemName: { type: 'string' } }, required: ['boardId', 'itemName'] },
    run: (c, a, proxy = defaultProxy()) => mondayGraphql(c, `mutation { create_item (board_id: ${str(a.boardId)}, item_name: ${JSON.stringify(str(a.itemName))}) { id } }`, proxy),
  },
]

// ── Zendesk (API v2) ──────────────────────────────────────────────────────────

const ZENDESK_TOOLS: NangoToolSpec[] = [
  {
    provider: 'zendesk', name: 'zendesk_list_tickets', isWrite: false,
    description: 'List Zendesk support tickets.',
    inputSchema: { type: 'object', properties: {} },
    run: (c, _a, proxy = defaultProxy()) => proxy({ method: 'GET', endpoint: '/api/v2/tickets.json', connectionId: c.connectionId, providerConfigKey: c.providerConfigKey }).then((r) => r.data),
  },
  {
    provider: 'zendesk', name: 'zendesk_create_ticket', isWrite: true,
    description: 'Open a Zendesk ticket.',
    inputSchema: { type: 'object', properties: { subject: { type: 'string' }, body: { type: 'string' } }, required: ['subject', 'body'] },
    run: (c, a, proxy = defaultProxy()) => proxy({ method: 'POST', endpoint: '/api/v2/tickets.json', connectionId: c.connectionId, providerConfigKey: c.providerConfigKey, data: { ticket: { subject: str(a.subject), comment: { body: str(a.body) } } } }).then((r) => r.data),
  },
  {
    provider: 'zendesk', name: 'zendesk_update_ticket', isWrite: true,
    description: 'Update a Zendesk ticket’s status/priority or add a comment.',
    inputSchema: { type: 'object', properties: { ticketId: { type: 'string' }, ticket: { type: 'object', description: 'Ticket fields to set.' } }, required: ['ticketId', 'ticket'] },
    run: (c, a, proxy = defaultProxy()) => proxy({ method: 'PUT', endpoint: `/api/v2/tickets/${str(a.ticketId)}.json`, connectionId: c.connectionId, providerConfigKey: c.providerConfigKey, data: { ticket: (a.ticket as Record<string, unknown>) ?? {} } }).then((r) => r.data),
  },
]

// ── Slack read tools (the write send lives in delivery.ts) ────────────────────

const SLACK_READ_TOOLS: NangoToolSpec[] = [
  {
    provider: 'slack', name: 'slack_list_channels', isWrite: false,
    description: 'List Slack channels the connected account can access.',
    inputSchema: { type: 'object', properties: {} },
    run: (c, _a, proxy = defaultProxy()) => proxy({ method: 'GET', endpoint: '/conversations.list', connectionId: c.connectionId, providerConfigKey: c.providerConfigKey, params: { limit: 100, types: 'public_channel,private_channel' } }).then((r) => r.data),
  },
  {
    provider: 'slack', name: 'slack_read_messages', isWrite: false,
    description: 'Read recent messages from a Slack channel.',
    inputSchema: { type: 'object', properties: { channel: { type: 'string', description: 'Channel id.' }, limit: { type: 'number' } }, required: ['channel'] },
    run: (c, a, proxy = defaultProxy()) => proxy({ method: 'GET', endpoint: '/conversations.history', connectionId: c.connectionId, providerConfigKey: c.providerConfigKey, params: { channel: str(a.channel), limit: num(a.limit, 30) } }).then((r) => r.data),
  },
]

// ── Salesforce read/update (create lives in delivery.ts) ──────────────────────

const SALESFORCE_TOOLS: NangoToolSpec[] = [
  {
    provider: 'salesforce', name: 'salesforce_query', isWrite: false,
    description: 'Run a SOQL query over Salesforce records.',
    inputSchema: { type: 'object', properties: { soql: { type: 'string', description: 'e.g. SELECT Id, Name FROM Account LIMIT 10.' } }, required: ['soql'] },
    run: (c, a, proxy = defaultProxy()) => proxy({ method: 'GET', endpoint: '/services/data/v60.0/query', connectionId: c.connectionId, providerConfigKey: c.providerConfigKey, params: { q: str(a.soql) } }).then((r) => r.data),
  },
  {
    provider: 'salesforce', name: 'salesforce_get_record', isWrite: false,
    description: 'Read a Salesforce record by object type and id.',
    inputSchema: { type: 'object', properties: { sobject: { type: 'string' }, id: { type: 'string' } }, required: ['sobject', 'id'] },
    run: (c, a, proxy = defaultProxy()) => proxy({ method: 'GET', endpoint: `/services/data/v60.0/sobjects/${str(a.sobject)}/${str(a.id)}`, connectionId: c.connectionId, providerConfigKey: c.providerConfigKey }).then((r) => r.data),
  },
  {
    provider: 'salesforce', name: 'salesforce_update_record', isWrite: true,
    description: 'Update fields on an existing Salesforce record.',
    inputSchema: { type: 'object', properties: { sobject: { type: 'string' }, id: { type: 'string' }, fields: { type: 'object' } }, required: ['sobject', 'id', 'fields'] },
    run: (c, a, proxy = defaultProxy()) => proxy({ method: 'PATCH', endpoint: `/services/data/v60.0/sobjects/${str(a.sobject)}/${str(a.id)}`, connectionId: c.connectionId, providerConfigKey: c.providerConfigKey, data: (a.fields as Record<string, unknown>) ?? {} }).then((r) => r.data),
  },
]

// ── Gmail read/draft (the write send lives in delivery.ts) ────────────────────

const GMAIL_READ_TOOLS: NangoToolSpec[] = [
  {
    provider: 'gmail', name: 'gmail_list_messages', isWrite: false,
    description: 'Search and list Gmail messages.',
    inputSchema: { type: 'object', properties: { q: { type: 'string', description: 'Gmail search, e.g. from:acme is:unread.' } } },
    run: (c, a, proxy = defaultProxy()) => proxy({ method: 'GET', endpoint: '/gmail/v1/users/me/messages', connectionId: c.connectionId, providerConfigKey: c.providerConfigKey, params: { ...(str(a.q) ? { q: str(a.q) } : {}), maxResults: num(a.maxResults, 25) } }).then((r) => r.data),
  },
  {
    provider: 'gmail', name: 'gmail_read_message', isWrite: false,
    description: 'Read the full content of a Gmail message.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    run: (c, a, proxy = defaultProxy()) => proxy({ method: 'GET', endpoint: `/gmail/v1/users/me/messages/${str(a.id)}`, connectionId: c.connectionId, providerConfigKey: c.providerConfigKey, params: { format: 'full' } }).then((r) => r.data),
  },
]

/** Every authored provider tool. */
export const NANGO_PROVIDER_TOOLS: NangoToolSpec[] = [
  ...GITHUB_TOOLS,
  ...LINEAR_TOOLS,
  ...JIRA_TOOLS,
  ...ASANA_TOOLS,
  ...NOTION_TOOLS,
  ...HUBSPOT_TOOLS,
  ...CONFLUENCE_TOOLS,
  ...GDRIVE_TOOLS,
  ...GSHEETS_TOOLS,
  ...MONDAY_TOOLS,
  ...ZENDESK_TOOLS,
  ...SLACK_READ_TOOLS,
  ...SALESFORCE_TOOLS,
  ...GMAIL_READ_TOOLS,
]

/** Tools for one provider (or [] if none authored yet). */
export function toolsForProvider(provider: string): NangoToolSpec[] {
  return NANGO_PROVIDER_TOOLS.filter((tool) => tool.provider === provider)
}
