import { describe, expect, it } from 'vitest'
import { hotkeyBlocked } from './hotkeys'

/** A minimal element: `matches` = the selectors it (or an ancestor) satisfies, `inside` = the card that contains it. */
const el = (matches: string[], inside: object | null = null): EventTarget => {
  const self = {
    inside,
    closest: (sel: string) => (sel.split(',').some((s) => matches.includes(s.trim())) ? self : null)
  }
  return self as unknown as EventTarget
}
const card = { contains: (n: never) => (n as { inside: object | null }).inside === card }

describe('hotkeyBlocked', () => {
  it('lets a card hotkey through from the page body and from the card’s own fields', () => {
    expect(hotkeyBlocked(el([]), card)).toBe(false)
    expect(hotkeyBlocked(el(['textarea'], card), card)).toBe(false)
    expect(hotkeyBlocked(null, card)).toBe(false)
  })
  it('ignores ⌘↩ / ⌘⌫ typed in a field outside the card (the sidebar board-ask answer) and in a terminal', () => {
    expect(hotkeyBlocked(el(['textarea']), card)).toBe(true)
    expect(hotkeyBlocked(el(['input']), card)).toBe(true)
    expect(hotkeyBlocked(el(['[contenteditable="true"]']), card)).toBe(true)
    expect(hotkeyBlocked(el(['.xterm'], card), card)).toBe(true)
    // the card not mounted yet: any field is foreign
    expect(hotkeyBlocked(el(['textarea']), null)).toBe(true)
  })
})
