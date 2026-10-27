import { describe, expect, it } from 'vitest'
import { HELP_ENTRIES, helpAnswer, helpTokens, searchHelp } from './help'
import { parseDeepLink } from './deepLink'

const top = (q: string): string | undefined => searchHelp(q)[0]?.id

describe('shared/help: the knowledge base behind principia_help', () => {
  it('every principia:// link parses, so the KB cannot rot silently', () => {
    for (const e of HELP_ENTRIES) {
      expect(e.links.length, e.id).toBeGreaterThan(0)
      for (const l of e.links) expect(parseDeepLink(l.href), `${e.id}: ${l.href}`).not.toBeNull()
      // a link written inside the text must parse too
      for (const href of e.how.match(/principia:\/\/[^\s,;)"']+/g) ?? []) expect(parseDeepLink(href.replace(/[.:]$/, '')), `${e.id}: ${href}`).not.toBeNull()
    }
  })

  it('ids are unique, entries short, and there are 25 to 40 of them', () => {
    expect(new Set(HELP_ENTRIES.map((e) => e.id)).size).toBe(HELP_ENTRIES.length)
    expect(HELP_ENTRIES.length).toBeGreaterThanOrEqual(25)
    expect(HELP_ENTRIES.length).toBeLessThanOrEqual(40)
    for (const e of HELP_ENTRIES) expect(e.how.length, e.id).toBeLessThan(1000)
  })

  it('the phone questions find the phone entry, with the Settings › Phone link', () => {
    for (const q of ['how can I connect with my phone', 'use principia on my iPhone', 'how can I use Principia from my phone?', 'is there a mobile app', 'TestFlight'])
      expect(top(q), q).toBe('phone')
    const a = helpAnswer('use principia on my iPhone')
    expect(a.entries[0]!.links.map((l) => l.href)).toContain('principia://settings/phone')
    expect(a.entries[0]!.how).toContain('TestFlight')
  })

  it('"start a new chat" finds the conversation entry', () => {
    for (const q of ['start a new chat', 'how do I start a new conversation', 'talk to one agent privately']) expect(top(q), q).toBe('conversation')
    expect(searchHelp('start a new chat')[0]!.how).toContain('⌥⌘N')
  })

  it('the other topics answer their own questions', () => {
    const cases: [string, string][] = [
      ['add my own MCP server', 'mcp'],
      ['connect slack', 'slack'],
      ['sync with linear', 'linear'],
      ['turn on autopilot', 'autopilot'],
      ['use a git worktree for a branch', 'worktrees'],
      ['switch to codex or gemini', 'harness'],
      ['where are my API keys', 'keys'],
      ['how much does it cost', 'spend'],
      ['invite someone to the forum', 'forum'],
      ['does my data stay private', 'privacy'],
      ['update to the latest version', 'updates'],
      ['hire a new agent', 'departments'],
      ['schedule a recurring routine', 'routines'],
      ['run agents while my mac sleeps', 'cloud'],
      ['can I talk to it by voice', 'voice']
    ]
    for (const [q, id] of cases) expect(top(q), q).toBe(id)
  })

  it('returns 1 to 3 entries, deterministically, and every topic title when nothing matches', () => {
    expect(searchHelp('slack linear browser autopilot').length).toBeLessThanOrEqual(3)
    expect(searchHelp('use principia on my iPhone')).toEqual(searchHelp('use principia on my iPhone'))
    expect(helpTokens('How do I use Principia?')).toEqual([])
    const none = helpAnswer('zxqv blorp')
    expect(none.entries).toEqual([])
    expect(none.topics).toEqual(HELP_ENTRIES.map((e) => e.title))
    expect(helpAnswer('the phone app').note).toContain('principia://')
  })
})
