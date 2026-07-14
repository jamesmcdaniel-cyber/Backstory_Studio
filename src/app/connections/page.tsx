import { redirect } from 'next/navigation'

// MCP Servers was folded into Integrations (its own tab). This route stays so
// existing deep links and OAuth returnTo=/connections round-trips still land
// somewhere valid — they now resolve to the MCP servers tab.
export default function ConnectionsRedirect() {
  redirect('/integrations?tab=servers')
}
