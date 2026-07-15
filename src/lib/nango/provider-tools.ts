/**
 * Nango multi-provider agent tools.
 *
 * Replaces Klavis's hosted per-provider MCP servers: each tool here is a
 * hand-authored adapter that maps tool args → a provider REST/GraphQL call
 * through Nango's proxy (credentials never touch our process). Unlike the
 * write-only delivery adapters, these carry a per-tool `isWrite` flag so read
 * tools (list/search/get) skip the approval gate while writes (create/update/
 * comment) keep it.
 *
 * Adding a provider = append its read + write specs here (mirroring the tool
 * set the Klavis `provider-capabilities.ts` catalog offered) and map its Nango
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

/** Every authored provider tool. Grows as providers are migrated off Klavis. */
export const NANGO_PROVIDER_TOOLS: NangoToolSpec[] = [...GITHUB_TOOLS, ...LINEAR_TOOLS]

/** Tools for one provider (or [] if none authored yet). */
export function toolsForProvider(provider: string): NangoToolSpec[] {
  return NANGO_PROVIDER_TOOLS.filter((tool) => tool.provider === provider)
}
