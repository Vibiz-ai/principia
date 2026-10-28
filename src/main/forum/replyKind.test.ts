import { describe, expect, it } from 'vitest'
import { classifyReply, parseReplyKind } from './replyKind'
import type { ModelCall } from '../company/router'

describe('replyKind: answer or not (never a real model call here)', () => {
  it('reads the JSON, a fenced block or the bare word; anything else is null', () => {
    expect(parseReplyKind('{"kind":"answer"}')).toBe('answer')
    expect(parseReplyKind('```json\n{"kind": "status_question"}\n```')).toBe('status_question')
    expect(parseReplyKind('new_request')).toBe('new_request')
    expect(parseReplyKind('{"kind":"maybe"}')).toBeNull()
    expect(parseReplyKind('I think it is an answer')).toBeNull()
  })
  it('sends the question, its options and the reply, redacted; a failure or a timeout is null', async () => {
    let input = ''
    const ok: ModelCall = async (req) => ((input = req.input), '{"kind":"answer"}')
    expect(await classifyReply(ok, { question: 'Which app?', options: ['Main', 'New'], reply: 'main one, key sk-secret' }, { redact: (s) => s.replace('sk-secret', '••••') })).toBe('answer')
    expect(input).toContain('Question: Which app?')
    expect(input).toContain('Options: Main | New')
    expect(input).toContain('Message: main one, key ••••')
    expect(await classifyReply(async () => { throw new Error('the route call failed') }, { question: 'Q', reply: 'r' })).toBeNull()
    let aborted = false
    const slow: ModelCall = (req) => new Promise((resolve) => { req.signal.addEventListener('abort', () => { aborted = true; resolve('{"kind":"answer"}') }) })
    expect(await classifyReply(slow, { question: 'Q', reply: 'r' }, { timeoutMs: 20 })).toBeNull()
    expect(aborted).toBe(true)
    expect(await classifyReply(null, { question: 'Q', reply: 'r' })).toBeNull()
  })
})

describe('notStarted: a reply never claims a start that did not happen', () => {
  it('swaps "back on" / "Starting" for the true state, and "I started" for "I filed"', async () => {
    const { notStarted } = await import('./agentApi')
    const line = 'Julia is running 3 tasks; VO-16 starts when one finishes.'
    expect(notStarted('Got it, back on VO-16.', 'VO-16', line)).toBe(line)
    expect(notStarted('Starting VO-16 now.', 'VO-16', line)).toBe(line)
    expect(notStarted("I started VO-16: Landing page. I'll post the result here.", 'VO-16', line)).toBe(`I filed VO-16: Landing page. I'll post the result here. ${line}`)
    expect(notStarted('Sure.', 'VO-16', line)).toBe(`Sure. ${line}`)
  })
})
