/** PR-55: the chat box grows with what you type, then scrolls past a third of the window. */
import { describe, expect, it, vi } from 'vitest'

vi.stubGlobal('window', { hive: { on: () => () => {} }, addEventListener: () => {}, removeEventListener: () => {}, innerHeight: 900, innerWidth: 1440 })
vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} })

describe('composerHeight', () => {
  it('shows every line of a short or medium message', async () => {
    const { composerHeight } = await import('./ConversationKit')
    expect(composerHeight(48, 900)).toEqual({ height: 48, scrolls: false })
    expect(composerHeight(240, 900)).toEqual({ height: 240, scrolls: false })
  })
  it('stops at a third of the window (never under 160px) and scrolls from there', async () => {
    const { composerHeight } = await import('./ConversationKit')
    expect(composerHeight(900, 900)).toEqual({ height: 300, scrolls: true })
    expect(composerHeight(400, 300)).toEqual({ height: 160, scrolls: true })
  })
})
