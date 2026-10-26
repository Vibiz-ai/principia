/** Global ⌘-chords. The app menu sends the same commands via `ui:command`; runCommand dedupes. */
import type { AdapterId } from '@shared/types'
import { SWITCHER_ADAPTERS } from '@shared/types'
import { attempt, enterCompanySlot, getState, hive, multiCompany, navigate, openPalette, runCommand, setProvider } from '../state/store'

import { doorForDigit } from '../lib/nav'

function inTerminal(t: EventTarget | null): boolean {
  return !!(t as HTMLElement | null)?.closest?.('.xterm')
}

export function installKeyboard(): () => void {
  const onKey = (e: KeyboardEvent): void => {
    if (e.defaultPrevented) return
    const term = inTerminal(e.target)
    // COMPANY.md §8.2: with companies, ⌃1…⌃9 select company N and ⌃0 selects All (the rail order). Personal-only users
    // keep ⌃1-4 as the provider switcher. Never steal Ctrl chords from a focused terminal.
    if (e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && !term && multiCompany() && /^Digit[0-9]$/.test(e.code)) {
      e.preventDefault()
      enterCompanySlot(Number(e.code.slice(5)))
      return
    }
    if (e.ctrlKey && !e.metaKey && !e.altKey && !term && /^Digit[1-4]$/.test(e.code)) {
      e.preventDefault()
      setProvider(SWITCHER_ADAPTERS[Number(e.code.slice(5)) - 1] as AdapterId)
      return
    }
    if (!e.metaKey || e.ctrlKey) return
    const code = e.code
    const handled = (): void => e.preventDefault()
    if (/^Digit[1-5]$/.test(code) && !e.shiftKey && !e.altKey) {
      // five doors: ⌘1-⌘5 = Home, Team, Board, Chats, Knowledge in every mode (the app menu sends the same commands)
      handled()
      runCommand({ kind: 'navigate', view: doorForDigit(Number(code.slice(5)))! })
    } else if (code === 'KeyA' && e.shiftKey && !e.altKey) {
      // the old Agents hub: Chats on Live
      handled()
      runCommand({ kind: 'navigate', view: 'agents' })
    } else if (code === 'KeyL' && e.shiftKey && !e.altKey) {
      // SLACK.md §12.2: ⌘⇧L opens the Slack page
      handled()
      void navigate({ name: 'slack', nonce: Date.now() })
    } else if (code === 'KeyF' && e.shiftKey && !e.altKey) {
      // FORUM.md §8: ⇧⌘F opens the company Forum
      handled()
      void navigate({ name: 'forum', nonce: Date.now() })
    } else if (code === 'KeyJ' && !e.shiftKey && !e.altKey) {
      handled()
      runCommand({ kind: 'nextNeedsYou' })
    } else if (code === 'KeyK' && !e.shiftKey && !e.altKey) {
      handled()
      runCommand({ kind: 'commandPalette' })
    } else if (code === 'KeyN') {
      handled()
      if (e.altKey) runCommand({ kind: 'newChat' })
      else if (e.shiftKey) runCommand({ kind: 'newWorkflow' })
      else runCommand({ kind: 'newSession' })
    } else if (code === 'KeyO' && !e.shiftKey && !e.altKey) {
      handled()
      runCommand({ kind: 'addRepo' })
    } else if (code === 'KeyO' && e.shiftKey && !e.altKey) {
      // ⇧⌘O: company switcher in the palette
      handled()
      openPalette('companies')
    } else if (code === 'Comma') {
      handled()
      runCommand({ kind: 'openSettings' })
    } else if (code === 'KeyB' && !e.shiftKey && !e.altKey) {
      handled()
      runCommand({ kind: 'toggleSidebar' })
    } else if (code === 'KeyW') {
      handled()
      if (e.shiftKey) void attempt(() => hive.app.hideWindow())
      else runCommand({ kind: 'closeSession' })
    } else if ((code === 'Equal' || code === 'Minus' || code === 'Digit0') && !e.altKey) {
      const v = getState().view.name
      if (v === 'session' || v === 'canvas') {
        handled()
        runCommand({ kind: 'zoom', dir: code === 'Equal' ? 'in' : code === 'Minus' ? 'out' : 'reset' })
      }
    }
  }
  window.addEventListener('keydown', onKey)
  return () => window.removeEventListener('keydown', onKey)
}
