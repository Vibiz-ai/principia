/**
 * CHAT-UI.md §8: is the person's message the answer to the task's open question? Said back as one of the ask's options
 * it is (no call). Otherwise one cheap model call (routeCall.ts: the cheap tier, no tools) reads the question, its
 * options and the message and says answer | status_question | new_request | other. Only "answer" routes the message
 * to the task; a failure, a timeout or anything unclear leaves it to the agent (never an automatic route).
 */
import type { ModelCall } from '../company/router'

export type ReplyKind = 'answer' | 'status_question' | 'new_request' | 'other'
export const REPLY_KINDS: readonly ReplyKind[] = ['answer', 'status_question', 'new_request', 'other']
export const REPLY_KIND_TIMEOUT_MS = 12_000

const SYSTEM = [
  "A task asked the person a question in a chat. Classify the person's next message:",
  '- answer: it answers the question (a choice, a fact, a decision, a yes/no, a go-ahead with details)',
  '- status_question: it asks how the work is going (are you working on it, any update, is it done)',
  '- new_request: it asks for something else',
  '- other: anything else (a greeting, a complaint, unclear)',
  'Reply with JSON only: {"kind":"answer"} (or status_question, new_request, other).'
].join('\n')

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/** The model's word for the message, or null (no model, a failure, a timeout, an answer it did not give). Never throws. */
export async function classifyReply(
  call: ModelCall | null,
  input: { question: string; options?: readonly string[] | null; reply: string },
  opts: { timeoutMs?: number; redact?: (s: string) => string } = {}
): Promise<ReplyKind | null> {
  if (!call) return null
  const redact = opts.redact ?? ((s: string) => s)
  const opt = input.options?.length ? `\nOptions: ${input.options.map((o) => clip(o, 80)).join(' | ')}` : ''
  const text = `Question: ${clip(redact(input.question), 1200)}${opt}\nMessage: ${clip(redact(input.reply), 800)}`
  const timeoutMs = opts.timeoutMs ?? REPLY_KIND_TIMEOUT_MS
  const ac = new AbortController()
  let timer: NodeJS.Timeout | null = null
  try {
    const out = await Promise.race([
      call({ system: SYSTEM, input: text, tools: [], headless: true, maxTurns: 1, timeoutMs, signal: ac.signal }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('timed out')), timeoutMs)
        timer.unref?.()
      })
    ])
    return parseReplyKind(out)
  } catch {
    ac.abort()
    return null
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** {"kind":"answer"}, a fenced block of it, or the bare word. Null for anything else. */
export function parseReplyKind(raw: string): ReplyKind | null {
  const s = String(raw ?? '').trim()
  const json = s.match(/\{[\s\S]*?\}/)?.[0]
  if (json) {
    try {
      const k = (JSON.parse(json) as { kind?: unknown }).kind
      return typeof k === 'string' && (REPLY_KINDS as readonly string[]).includes(k) ? (k as ReplyKind) : null
    } catch {
      /* the bare word below */
    }
  }
  const word = s.toLowerCase().replace(/[^a-z_]/g, '')
  return (REPLY_KINDS as readonly string[]).includes(word) ? (word as ReplyKind) : null
}
