/**
 * Read-only Nango doctor. Loads .env.local, calls listIntegrations() against
 * YOUR Nango environment, and cross-checks each enabled integration's
 * unique_key against the code's provider config keys — the one string that
 * links the dashboard catalog to the agent tool registry. Never prints the key.
 */
import { readFileSync } from 'node:fs'
import { Nango } from '@nangohq/node'

// Mirrors PROVIDER_CONFIG_KEYS in src/lib/nango/provider-tools.ts (+ delivery).
// provider -> accepted Nango unique_keys.
const PROVIDER_CONFIG_KEYS: Record<string, string[]> = {
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
  airtable: ['airtable'],
  figma: ['figma'],
}
const KEY_TO_PROVIDER = new Map<string, string>()
for (const [p, keys] of Object.entries(PROVIDER_CONFIG_KEYS)) for (const k of keys) KEY_TO_PROVIDER.set(k, p)

// --- Load .env.local, collecting ALL values per key (to catch duplicates) ---
function loadEnvLocalMulti(path: string): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  let raw = ''
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return out
  }
  for (const line of raw.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i)
    if (!m) continue
    let v = m[2].trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    ;(out[m[1]] ??= []).push(v)
  }
  return out
}

/** Try a key against Nango. Returns the integration configs, or null + status. */
async function tryKey(secretKey: string, host?: string) {
  try {
    const nango = new Nango({ secretKey, ...(host ? { host } : {}) })
    const { configs } = await nango.listIntegrations()
    return { ok: true as const, configs }
  } catch (e: any) {
    return { ok: false as const, status: e?.response?.status as number | undefined, message: e?.message ?? String(e) }
  }
}

async function main() {
  const env = loadEnvLocalMulti('/Users/james.mcdaniel/Backstory_Studio/.env.local')
  const host = env.NANGO_HOST?.[0] || process.env.NANGO_HOST
  const rawKeys = env.NANGO_SECRET_KEY ?? (process.env.NANGO_SECRET_KEY ? [process.env.NANGO_SECRET_KEY] : [])
  // Distinct values, order preserved.
  const keys = [...new Set(rawKeys.filter(Boolean))]

  if (keys.length === 0) {
    console.log('❌ NANGO_SECRET_KEY not found in .env.local')
    process.exit(1)
  }
  if (rawKeys.length > 1) {
    console.log(`⚠️  NANGO_SECRET_KEY is set ${rawKeys.length}× in .env.local (${keys.length} distinct value(s)) — remove the duplicate; the loader's choice is ambiguous.`)
  }
  console.log(`Testing ${keys.length} distinct key value(s)${host ? ` against host=${host}` : ' against US Nango Cloud (api.nango.dev)'}…\n`)

  let configs: Array<{ unique_key: string; provider: string }> | null = null
  for (let i = 0; i < keys.length; i++) {
    const label = `key #${i + 1} (${keys[i].length} chars)`
    const res = await tryKey(keys[i], host)
    if (res.ok) {
      console.log(`   ✅ ${label}: authenticated`)
      configs = res.configs
      break
    }
    console.log(`   ❌ ${label}: HTTP ${res.status ?? '?'}${res.status === 401 ? ' (not authorized for this environment)' : ''}`)
  }

  if (!configs) {
    console.log('\n❌ No configured NANGO_SECRET_KEY authenticated. Checklist:')
    console.log('   • Use the SECRET key (Nango dashboard → Environment Settings), not the public key.')
    console.log('   • Match the ENVIRONMENT: the key and the enabled integrations must be in the same Nango env (Dev vs Prod).')
    console.log('   • EU region? set NANGO_HOST=https://api-eu.nango.dev (currently defaulting to US Cloud).')
    console.log('   • Remove the duplicate NANGO_SECRET_KEY line so the right value is used.')
    process.exit(1)
  }

  console.log(`\n✅ Auth OK. ${configs.length} integration(s) enabled in your Nango environment:\n`)

  const enabledKeys = new Set(configs.map((c) => c.unique_key))
  const matched: string[] = []
  const mismatched: string[] = []
  for (const c of configs) {
    const provider = KEY_TO_PROVIDER.get(c.unique_key)
    if (provider) {
      matched.push(c.unique_key)
      console.log(`   ✅ ${c.unique_key.padEnd(20)} → ${provider} (agent tools wired)`)
    } else {
      mismatched.push(c.unique_key)
      console.log(`   ⚠️  ${c.unique_key.padEnd(20)} → connectable, but NO agent tools (unique_key matches no config key)`)
    }
  }

  // Which supported providers are not enabled at all?
  const missing = Object.entries(PROVIDER_CONFIG_KEYS).filter(
    ([, keys]) => !keys.some((k) => enabledKeys.has(k)),
  )

  console.log('\n── Summary ──────────────────────────────────────────')
  console.log(`   ${matched.length}/${configs.length} enabled integrations map to agent tools`)
  if (mismatched.length) {
    console.log(`   ⚠️  ${mismatched.length} enabled with NO tools: ${mismatched.join(', ')}`)
    console.log('       (rename the dashboard unique_key to the canonical value in docs/nango-setup.md)')
  }
  if (missing.length) {
    console.log(`   ⏳ ${missing.length} supported provider(s) not yet enabled in the dashboard:`)
    console.log(`       ${missing.map(([p, keys]) => `${p} (set unique_key="${keys[0]}")`).join(', ')}`)
  }
  if (!mismatched.length && !missing.length) {
    console.log('   🎉 Every supported provider is enabled and correctly keyed.')
  }
}

main().catch((e) => {
  console.log('❌ Unexpected error:', e?.message ?? e)
  process.exit(1)
})
