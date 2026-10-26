import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { runHook } from './hook'
import { lastTurnStats, NUDGE_REASON, nudgeDecision, shouldNudge } from './nudge'

const user = (content: unknown) => JSON.stringify({ type: 'user', message: { role: 'user', content } })
const tool = (...names: string[]) => JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: names.map((name, i) => ({ type: 'tool_use', id: `t${i}`, name, input: {} })) } })
const result = () => user([{ type: 'tool_result', tool_use_id: 't0', content: 'ok' }])
const transcript = (...lines: string[]) => lines.join('\n')

describe('PROACTIVE.md §4: the one-time "track it" nudge', () => {
  it('counts the last turn only, from the founder message on', () => {
    const t = transcript(user('earlier'), tool('Edit', 'Edit', 'Edit'), user('fix the header and the footer'), tool('Read'), result(), tool('Edit', 'Write'), result())
    expect(lastTurnStats(t)).toEqual({ tools: 3, edits: 2, board: false, prompt: 'fix the header and the footer' })
  })

  it('nudges untracked multi-step work, never board-tracked work or plain questions', () => {
    const edits = transcript(user('fix the header and the footer'), tool('Edit', 'Edit'))
    expect(shouldNudge(lastTurnStats(edits))).toBe(true)
    expect(shouldNudge(lastTurnStats(transcript(user('fix the header'), tool('Edit', 'mcp__hive__task_update'))))).toBe(false)
    expect(shouldNudge(lastTurnStats(transcript(user('x'), tool('Edit', 'Edit', 'mcp__hive__company_file_task'))))).toBe(false)
    // a question that read a lot but changed nothing
    expect(shouldNudge(lastTurnStats(transcript(user('how does auth work?'), tool(...Array(10).fill('Read')))))).toBe(false)
    // one quick edit
    expect(shouldNudge(lastTurnStats(transcript(user('rename it'), tool('Edit'))))).toBe(false)
    // many steps, no edits, not a question
    expect(shouldNudge(lastTurnStats(transcript(user('run the release checks'), tool(...Array(8).fill('Bash')))))).toBe(true)
  })

  it('blocks once: stop_hook_active always lets the turn end; bad input never blocks', () => {
    const t = transcript(user('fix a and b'), tool('Edit', 'Edit'))
    expect(nudgeDecision({ hook_event_name: 'Stop', transcript_path: '/t.jsonl' }, () => t)).toEqual({ decision: 'block', reason: NUDGE_REASON })
    expect(nudgeDecision({ hook_event_name: 'Stop', transcript_path: '/t.jsonl', stop_hook_active: true }, () => t)).toBeNull()
    expect(nudgeDecision({ hook_event_name: 'Stop' }, () => t)).toBeNull()
    expect(nudgeDecision({ hook_event_name: 'Stop', transcript_path: '/t.jsonl' }, () => { throw new Error('gone') })).toBeNull()
  })

  it('the hook script prints the context file and the nudge decision, and logs neither', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'principia-nudge-'))
    try {
      const events = path.join(dir, 'events.jsonl')
      const ctxFile = path.join(dir, 'principia-context.md')
      fs.writeFileSync(ctxFile, 'Use Principia rules\n')
      const io = (input: string) => {
        const stdin = new PassThrough()
        let out = ''
        stdin.end(input)
        return { stdin, stdout: { write: (s: string) => (out += s) }, out: () => out }
      }
      const a = io(JSON.stringify({ hook_event_name: 'SessionStart', source: 'resume' }))
      await runHook(['--events', events, '--dir', dir, '--context', ctxFile], a)
      expect(a.out()).toBe('Use Principia rules\n')
      const tr = path.join(dir, 't.jsonl')
      fs.writeFileSync(tr, transcript(user('fix a and b'), tool('Edit', 'Edit')))
      const b = io(JSON.stringify({ hook_event_name: 'Stop', transcript_path: tr, stop_hook_active: false }))
      await runHook(['--events', events, '--dir', dir, '--provider', 'claude', '--nudge'], b)
      expect(JSON.parse(b.out())).toEqual({ decision: 'block', reason: NUDGE_REASON })
      expect(fs.existsSync(events)).toBe(false)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
