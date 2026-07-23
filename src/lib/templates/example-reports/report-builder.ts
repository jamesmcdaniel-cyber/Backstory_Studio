import { reportDocument } from '@/features/agents/report-format'

/**
 * Builders for the templates gallery's illustrative outputs. Every built-in
 * template advertises the same house report format a live run produces (see
 * src/features/agents/report-format.ts) — hero, stat row, executive summary,
 * evidence-backed tables, evidence trail, outcome banner — so the gallery
 * preview and the real deliverable are the same artifact.
 */

/** A table cell: plain text, or text plus a house class (`prio-high`, `right`, `muted`). */
export type Cell = string | { v: string; c: string }

const cell = (tag: 'td' | 'th', c: Cell) =>
  typeof c === 'string' ? `<${tag}>${c}</${tag}>` : `<${tag} class="${c.c}">${c.v}</${tag}>`

const row = (tag: 'td' | 'th', cells: Cell[]) => `<tr>${cells.map((c) => cell(tag, c)).join('')}</tr>`

/** High-priority cell (green). */
export const high = (v: string): Cell => ({ v, c: 'prio-high' })
/** Medium-priority cell (amber). */
export const med = (v: string): Cell => ({ v, c: 'prio-med' })
/** Right-aligned numeric cell. */
export const num = (v: string): Cell => ({ v, c: 'right' })
/** De-emphasised cell (sources, row numbers, dates). */
export const dim = (v: string): Cell => ({ v, c: 'muted' })

export type ReportSpec = {
  /** Uppercase report kind, e.g. "Pipeline intelligence report". */
  eyebrow: string
  title: string
  /** One sentence describing what the run did. */
  sub: string
  /** Status pill text, e.g. "3 of 20 need action · Delivered". */
  pill: string
  /** 3–5 headline metrics: [emoji, value, label]. */
  stats: [string, string, string][]
  /** 2–4 grounded sentences: situation, momentum, single most important next move. */
  summary: string
  sections: Section[]
  /** Evidence trail cards: [source, what it contributed, freshness]. */
  evidence: [string, string, string][]
  /** Dark outcome banner. */
  banner: string
}

export type Section =
  | {
      kind: 'table'
      eyebrow: string
      heading: string
      /** Right-hand chip, e.g. "Top 5 of 18 scored". */
      count: string
      head: Cell[]
      rows: Cell[][]
      /** Optional caption printed under the table. */
      note?: string
    }
  | { kind: 'note'; heading: string; body: string }

const tableSection = (s: Extract<Section, { kind: 'table' }>) =>
  `<div class="card"><p class="eyebrow">${s.eyebrow}</p><div class="head"><h2>${s.heading}</h2>` +
  `<span class="count">${s.count}</span></div><table>${row('th', s.head)}` +
  `${s.rows.map((r) => row('td', r)).join('')}</table>` +
  `${s.note ? `<p class="sub" style="margin-top:10px">${s.note}</p>` : ''}</div>`

const noteSection = (s: Extract<Section, { kind: 'note' }>) =>
  `<div class="card summary"><h2>${s.heading}</h2><p>${s.body}</p></div>`

/** Renders a spec into the self-contained house HTML document. */
export function report(spec: ReportSpec): string {
  const hero =
    `<div class="card hero"><div><p class="eyebrow">${spec.eyebrow}</p><h1>${spec.title}</h1>` +
    `<p class="sub">${spec.sub}</p></div><span class="pill"><span class="dot"></span>${spec.pill}</span></div>`
  const stats =
    `<div class="stats">${spec.stats
      .map(([icon, value, label]) => `<div class="stat">${icon} <b>${value}</b><span>${label}</span></div>`)
      .join('')}</div>`
  const summary = `<div class="card summary"><h2>✨ Executive summary</h2><p>${spec.summary}</p></div>`
  const sections = spec.sections
    .map((s) => (s.kind === 'table' ? tableSection(s) : noteSection(s)))
    .join('\n')
  const evidence =
    `<div class="card"><h2>🧾 Evidence trail</h2><div class="cards">${spec.evidence
      .map(([name, what, when]) => `<div class="mini"><b>${name}</b><p>${what}</p><small>↻ ${when}</small></div>`)
      .join('')}</div></div>`
  const banner = `<div class="banner">${spec.banner}</div>`
  return reportDocument([hero, stats, summary, sections, evidence, banner].join('\n'))
}

/** Standard "recommended execution" action-plan section. */
export function actionPlan(rows: [string, string, string][], count = 'Owner + date assigned'): Section {
  return {
    kind: 'table',
    eyebrow: 'Recommended execution',
    heading: '✅ Action plan',
    count,
    head: ['#', 'Next action', 'Owner', 'Due'],
    rows: rows.map(([action, owner, due], i) => [dim(String(i + 1)), action, owner, due]),
  }
}
