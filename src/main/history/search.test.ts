import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { searchSessions, snippetAround } from './search'

const line = (o: unknown): string => JSON.stringify(o)
const you = (text: string, cwd = '/Users/me/Projects/shop') => line({ type: 'user', promptSource: 'typed', cwd, message: { role: 'user', content: text } })
const claude = (text: string) => line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }, { type: 'tool_use', name: 'Bash', input: { command: 'stripe webhook secret' } }] } })
const tool = (text: string) => line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: text }] } })

function roots(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'psearch-'))
  const dir = path.join(root, '-Users-me-Projects-shop')
  fs.mkdirSync(dir)
  const write = (id: string, lines: string[], ageMin: number) => {
    const f = path.join(dir, `${id}.jsonl`)
    fs.writeFileSync(f, lines.join('\n') + '\n')
    const t = new Date(Date.now() - ageMin * 60_000)
    fs.utimesSync(f, t, t)
  }
  write('aaaaaaaa-0001', [you('Fix the checkout page'), claude('The Stripe webhook was missing the signing secret, so I added it.'), tool('stripe secret in a tool result')], 60)
  write('aaaaaaaa-0002', [you('Why does the Stripe webhook fail on staging?'), claude('Looking at it.')], 5)
  write('aaaaaaaa-0003', [you('Write the newsletter'), claude('Done.'), tool('the stripe webhook')], 1)
  return root
}

describe('search inside Claude sessions', () => {
  it('finds every word in what you typed or Claude wrote, newest first, never in tool output', async () => {
    const root = roots()
    for (const rg of [null, '/opt/homebrew/bin/rg']) {
      if (rg && !fs.existsSync(rg)) continue
      const r = await searchSessions({ roots: [root], query: 'stripe WEBHOOK', rg })
      expect(r.hits.map((h) => h.id)).toEqual(['aaaaaaaa-0002', 'aaaaaaaa-0001'])
      expect(r.hits[0]).toMatchObject({ title: 'Why does the Stripe webhook fail on staging?', role: 'you', cwd: '/Users/me/Projects/shop' })
      expect(r.hits[1]).toMatchObject({ title: 'Fix the checkout page', role: 'claude', snippet: 'The Stripe webhook was missing the signing secret, so I added it.' })
    }
    expect((await searchSessions({ roots: [root], query: 'signing secret', rg: null })).hits.map((h) => h.id)).toEqual(['aaaaaaaa-0001'])
    expect((await searchSessions({ roots: [root], query: 'a', rg: null })).hits).toEqual([])
  })

  it('snips around the first match', () => {
    const text = `${'x'.repeat(300)} the needle is here ${'y'.repeat(300)}`
    const s = snippetAround(text, ['needle'])
    expect(s.startsWith('…')).toBe(true)
    expect(s).toContain('needle is here')
    expect(s.length).toBeLessThan(170)
  })
})
