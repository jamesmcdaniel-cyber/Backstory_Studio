import { redirect } from 'next/navigation'

// Templates no longer has its own page — it lives on the dashboard behind the
// Agents/Templates toggle. Old links (and the /templates/[id] back button) land
// on that view.
export default function TemplatesPage() {
  redirect('/agents?view=templates')
}
