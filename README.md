# SprintIQ

SprintIQ is a focused AI-agent workspace modeled after Den: create agents, connect tools, run tasks, inspect live tool calls and errors, ask follow-up questions about an execution, and build operational dashboards.

## Product Surface

- `/dashboard`: agent list, grouped run activity, output, tool calls, errors, and follow-up chat
- `/dashboard/custom`: dashboards composed from activity, error, and integration widgets
- `/integrations`: Klavis MCP tool connections and Pipedream embedded integrations
- `/templates`: reusable agent templates

## Architecture

- Next.js App Router owns the UI and authenticated API routes.
- Supabase owns user authentication.
- Prisma/PostgreSQL stores tenants, agents, executions, tool events, templates, dashboards, and connection state.
- One Fastify/BullMQ worker runtime executes manual and scheduled agents.
- Klavis provides MCP tool servers called by agents.
- Pipedream provides embedded integration account connections.
- OpenAI plans tool calls and answers follow-up questions about completed runs.

## Local Setup

```bash
cp .env.example .env.local
npm install
npm run db:push
npm run dev:all
```

The web app runs on `http://localhost:3000`; the worker health endpoint runs on `http://localhost:3002/health`.

Supabase projects must install [`supabase/handle-new-user.sql`](supabase/handle-new-user.sql) so every authenticated user receives a tenant and matching Prisma user record.

## Commands

```bash
npm run dev          # Next.js only
npm run dev:all      # Next.js plus the worker runtime
npm run check        # typecheck, lint, and production build
npm run db:migrate   # create a Prisma migration
npm run db:deploy    # apply migrations in production
```
