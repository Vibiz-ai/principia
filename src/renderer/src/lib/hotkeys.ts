/**
 * Window-level card hotkeys (⌘↩ allow / send, ⌘⌫ deny / discard) on the Needs-you cards. They must not fire while the
 * keystroke belongs to something else: a focused terminal, or a text field outside the card (the sidebar's inline
 * board-ask answer, a task comment). ⌘↩ there submits that field; it must never also approve a permission elsewhere.
 */
const FIELD = 'input, textarea, select, [contenteditable=""], [contenteditable="true"]'

type Closest = { closest?: (sel: string) => unknown }

/** True when a card hotkey should ignore this keydown. `card` = the card's root element (its own fields still work). */
export function hotkeyBlocked(target: EventTarget | null, card: { contains: (n: never) => boolean } | null): boolean {
  const el = target as Closest | null
  if (!el?.closest) return false
  if (el.closest('.xterm')) return true
  const field = el.closest(FIELD)
  return !!field && !card?.contains(field as never)
}
