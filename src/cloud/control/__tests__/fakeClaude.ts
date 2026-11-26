/**
 * A runtime `chats` whose processes speak Claude's stream-json like the real CLI does: they answer `initialize`, and
 * each user message replays a recorded turn (src/main/chat/__fixtures__/probe-new.jsonl). That turn asks to run Bash
 * (can_use_tool) and waits for the answer, as the CLI does, before it finishes.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ChatProcInfo, ChatProcSpec, ChatSink, CloudChats } from '../../contract'

const TURN = readFileSync(join(__dirname, '../../../main/chat/__fixtures__/probe-new.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>)
const ASK = TURN.findIndex((l) => l.type === 'control_request')

interface Proc { info: ChatProcInfo; buf: string; sinks: Set<ChatSink>; spec: ChatProcSpec; waiting: string | null; inbuf: string }

export interface FakeClaude extends CloudChats {
  specs: ChatProcSpec[]
  /** user messages each chat got, in order */
  said: Map<string, string[]>
  transcripts: Map<string, string>
}

export function fakeClaudeChats(): FakeClaude {
  const procs = new Map<string, Proc>()
  const said = new Map<string, string[]>()
  const transcripts = new Map<string, string>()
  const specs: ChatProcSpec[] = []
  const emit = (p: Proc, o: unknown) => {
    const d = `${JSON.stringify(o)}\n`
    const at = p.info.out
    p.buf += d
    p.info.out += d.length
    for (const s of p.sinks) s.out(d, at)
  }
  const state = (p: Proc) => { for (const s of p.sinks) s.state({ ...p.info }) }
  const replay = (p: Proc, from: number, to: number) => {
    for (const l of TURN.slice(from, to)) {
      if (l.type === 'control_request') {
        p.waiting = l.request_id as string
        emit(p, l)
        return
      }
      emit(p, { ...l, session_id: p.spec.conversationId })
    }
  }
  const onLine = (p: Proc, o: Record<string, unknown>) => {
    if (o.type === 'control_request') {
      const req = o.request as { subtype: string }
      const response = req.subtype === 'initialize' ? { commands: [], models: [{ value: 'opus', displayName: 'Opus' }], current_permission_mode: p.spec.permissionMode ?? 'default', account: {} } : {}
      emit(p, { type: 'control_response', response: { subtype: 'success', request_id: o.request_id, response } })
      return
    }
    if (o.type === 'control_response') {
      const r = o.response as { request_id: string }
      if (r.request_id === p.waiting) {
        p.waiting = null
        replay(p, ASK + 1, TURN.length)
        transcripts.set(p.spec.id, `${JSON.stringify({ type: 'user', message: { role: 'user', content: (said.get(p.spec.id) ?? []).at(-1) ?? '' }, uuid: 'u1', timestamp: new Date().toISOString() })}\n`)
      }
      return
    }
    if (o.type === 'user') {
      const c = (o.message as { content: unknown }).content
      const text = typeof c === 'string' ? c : (c as { type: string; text?: string }[]).filter((b) => b.type === 'text').map((b) => b.text).join('')
      said.set(p.spec.id, [...(said.get(p.spec.id) ?? []), text])
      emit(p, { ...TURN[0], session_id: p.spec.conversationId })
      emit(p, { type: 'user', message: { role: 'user', content: text }, session_id: p.spec.conversationId, parent_tool_use_id: null, uuid: `u-${Date.now()}`, isReplay: true })
      replay(p, 3, TURN.length)
    }
  }
  const chats: FakeClaude = {
    specs, said, transcripts,
    async start(spec) {
      specs.push(spec)
      const prev = procs.get(spec.id)
      const p: Proc = { info: { id: spec.id, state: 'running', detail: null, startedAt: new Date().toISOString(), endedAt: null, exitCode: null, signal: null, error: null, repo: spec.repo ? spec.repo.url.replace('https://github.com/', '') : null, out: 0 }, buf: '', sinks: prev?.sinks ?? new Set(), spec, waiting: null, inbuf: '' }
      procs.set(spec.id, p)
      state(p)
      return { ...p.info }
    },
    attach(id, from, sink) {
      const p = procs.get(id)
      if (!p) return null
      if (from < p.info.out) sink.out(p.buf.slice(from), from)
      sink.state({ ...p.info })
      p.sinks.add(sink)
      return () => void p.sinks.delete(sink)
    },
    write(id, data) {
      const p = procs.get(id)
      if (!p || p.info.state === 'exited') return false
      p.inbuf += data
      let i: number
      while ((i = p.inbuf.indexOf('\n')) >= 0) {
        const line = p.inbuf.slice(0, i)
        p.inbuf = p.inbuf.slice(i + 1)
        if (line.trim()) queueMicrotask(() => onLine(p, JSON.parse(line) as Record<string, unknown>))
      }
      return true
    },
    end(id) { chats.signal(id, 'SIGTERM') },
    signal(id, sig) {
      const p = procs.get(id)
      if (!p || p.info.state === 'exited') return false
      p.info = { ...p.info, state: 'exited', signal: sig, endedAt: new Date().toISOString() }
      state(p)
      return true
    },
    async stop(id) { chats.signal(id, 'SIGTERM') },
    async remove(id) { chats.signal(id, 'SIGTERM'); procs.delete(id); transcripts.delete(id) },
    list: () => [...procs.values()].map((p) => ({ ...p.info })),
    live: () => [...procs.values()].filter((p) => p.info.state !== 'exited').length,
    transcript: (id) => transcripts.get(id) ?? null
  }
  return chats
}
