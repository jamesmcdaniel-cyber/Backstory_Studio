'use client'

import { useState } from 'react'
import { Check, Code2, Copy, Eye } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * Tag names whose presence signals a genuine HTML document/fragment rather
 * than prose with an occasional inline tag (e.g. a lone `<br>`). Kept
 * conservative on purpose: markdown output must never trip this.
 */
const STRUCTURAL_TAGS = ['!doctype', 'html', 'table', 'div', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'section', 'body']
const LEADING_TAG_PATTERN = new RegExp(`<(${STRUCTURAL_TAGS.join('|')})\\b`, 'i')
// `!doctype` has no closing tag, so the paired-tag fallback below excludes it.
const PAIRABLE_TAGS = STRUCTURAL_TAGS.filter((tag) => tag !== '!doctype')

/**
 * True when `value` looks like an HTML document or fragment (as opposed to
 * markdown or prose that merely contains a stray tag like `<br>`).
 *
 * Two ways in:
 *  1. The trimmed content starts with `<` and that leading tag is one of the
 *     structural tags above (`<!doctype`, `<html>`, `<div>`, `<table>`, …).
 *  2. The content isn't tag-first, but it contains a matched opening AND
 *     closing pair for the same structural tag (HTML embedded mid-text).
 *     A single unmatched tag (e.g. "Use <br> to break lines") never matches.
 */
export function looksLikeHtml(value: string): boolean {
  const trimmed = value.trim()
  if (!trimmed) return false
  if (trimmed.startsWith('<') && LEADING_TAG_PATTERN.test(trimmed)) return true
  return PAIRABLE_TAGS.some((tag) => {
    const openPattern = new RegExp(`<${tag}\\b`, 'i')
    const closePattern = new RegExp(`</${tag}\\s*>`, 'i')
    return openPattern.test(trimmed) && closePattern.test(trimmed)
  })
}

/** Wraps a raw HTML fragment in a minimal document skeleton so it renders
 *  with sane defaults (font, color, wrapping) inside the sandboxed iframe.
 *  Skipped when the content already declares its own `<html>` root. */
function toDocument(html: string): string {
  if (/<html[\s>]/i.test(html)) return html
  return `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;font-family:ui-sans-serif,system-ui,sans-serif;color:#1f2937;font-size:14px;line-height:1.55;word-break:break-word}</style></head><body>${html}</body></html>`
}

/**
 * Renders agent-produced HTML (e.g. an email-brief body) as actual formatted
 * markup instead of raw text — without pulling in a sanitizer dependency.
 *
 * Safety: the iframe uses `sandbox=""` with NEITHER `allow-scripts` NOR
 * `allow-same-origin`. That combination makes the iframe's origin opaque and
 * scripts inert, so any `<script>`, inline event handler, or `javascript:`
 * link in the agent's HTML simply does not execute, and the frame can't read
 * or write cookies/localStorage. This is what makes rendering untrusted
 * agent HTML directly safe.
 *
 * A side effect of that same origin lockdown: the parent document is denied
 * access to `iframe.contentDocument` (cross-origin per the spec), so we
 * cannot measure `contentDocument.body.scrollHeight` on load to auto-size
 * the frame the way you normally would. Instead we use a fixed collapsed
 * height with internal scrolling, plus an explicit Expand/Collapse toggle.
 */
export function HtmlPreview({ html, className }: { html: string; className?: string }) {
  const [expanded, setExpanded] = useState(false)
  const [showRaw, setShowRaw] = useState(false)
  const [copied, setCopied] = useState(false)
  const height = expanded ? 1000 : 320

  const copyHtml = async () => {
    try {
      await navigator.clipboard.writeText(html)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard unavailable */
    }
  }

  return (
    <div className={cn('min-h-[120px] w-full', className)}>
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="mono-label text-gray-400">Rendered output</span>
        <span className="flex items-center gap-1">
          <button
            type="button"
            onClick={copyHtml}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            title="Copy the HTML source"
          >
            {copied ? <Check className="h-3 w-3 text-green-600" /> : <Copy className="h-3 w-3" />}
            {copied ? 'Copied' : 'Copy HTML'}
          </button>
          <button
            type="button"
            onClick={() => setShowRaw((value) => !value)}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            {showRaw ? <Eye className="h-3 w-3" /> : <Code2 className="h-3 w-3" />}
            {showRaw ? 'Rendered' : 'Raw'}
          </button>
        </span>
      </div>

      {showRaw ? (
        <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-muted/40 p-3 font-mono text-xs leading-relaxed">
          {html}
        </pre>
      ) : (
        <>
          <iframe
            title="Agent HTML output"
            srcDoc={toDocument(html)}
            sandbox=""
            scrolling={expanded ? 'yes' : 'no'}
            className={cn('w-full rounded-lg border border-border bg-white', !expanded && 'overflow-hidden')}
            style={{ height }}
          />
          <button
            type="button"
            onClick={() => setExpanded((value) => !value)}
            className="mt-1 text-[11px] font-medium text-muted-foreground hover:text-foreground"
          >
            {expanded ? 'Collapse' : 'Expand'}
          </button>
        </>
      )}
    </div>
  )
}
