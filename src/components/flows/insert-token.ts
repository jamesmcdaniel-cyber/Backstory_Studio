/**
 * Insert `token` into `current` at the element's caret (replacing any
 * selection) and restore focus. Appends when no element/caret is available.
 */
export function insertAtCaret(
  current: string,
  token: string,
  el: HTMLInputElement | HTMLTextAreaElement | null,
): string {
  if (!el || typeof el.selectionStart !== 'number') return current ? `${current} ${token}` : token
  const start = el.selectionStart
  const end = el.selectionEnd ?? start
  const next = current.slice(0, start) + token + current.slice(end)
  const pos = start + token.length
  requestAnimationFrame(() => {
    try {
      el.focus()
      el.setSelectionRange(pos, pos)
    } catch {
      /* element unmounted */
    }
  })
  return next
}
