/**
 * Read-only transcript preview of a Claude Code session (AUTHORING.md §8.3): typed user prompts, assistant text,
 * one-line tool calls, tool errors and compact boundaries; sidechain lines skipped. <= 400 entries (newest kept),
 * everything redacted, <= 300 KB in total. Opens the file O_RDONLY (streamed), never writes. No Electron imports.
 */
import fs from 'node:fs'
import path from 'node:path'
import type { ClaudeHistorySession, ClaudeTranscript, ClaudeTranscriptEntry } from '../../shared/authoring'
import { summarizeTool } from '../engine/live/summary'
import { typedPromptText } from './index'

export const MAX_ENTRIES = 400
export const MAX_BYTES = 300 * 1024
const ENTRY_CAP = 4000

const cap = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

function* lines(file: string): Generator<string> {
  const fd = fs.openSync(file, fs.constants.O_RDONLY)
  try {
    const buf = Buffer.alloc(1024 * 1024)
    let pos = 0
    let rest = ''
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, pos)
      if (n <= 0) break
      pos += n
      const parts = (rest + buf.subarray(0, n).toString('utf8')).split('\n')
      rest = parts.pop() ?? ''
      yield* parts
    }
    if (rest) yield rest
  } finally {
    fs.closeSync(fd)
  }
}

export function entriesFrom(rec: Record<string, unknown>): ClaudeTranscriptEntry[] {
  if (rec.isSidechain === true) return []
  const ts = typeof rec.timestamp === 'string' ? rec.timestamp : null
  const out: ClaudeTranscriptEntry[] = []
  if (rec.type === 'system' && (rec.subtype === 'compact_boundary' || /compact/i.test(String(rec.content ?? '')))) {
    out.push({ ts, role: 'system', text: 'Conversation compacted' })
    return out
  }
  if (rec.type === 'user') {
    const typed = typedPromptText(rec)
    if (typed) {
      out.push({ ts, role: 'user', text: typed })
      return out
    }
    const c = (rec.message as { content?: unknown } | undefined)?.content
    if (Array.isArray(c)) {
      for (const b of c) {
        if (b && typeof b === 'object' && (b as { type?: unknown }).type === 'tool_result' && (b as { is_error?: unknown }).is_error === true) {
          const content = (b as { content?: unknown }).content
          const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map((x) => (x && typeof x === 'object' ? String((x as { text?: unknown }).text ?? '') : '')).join(' ') : ''
          out.push({ ts, role: 'tool', text: `Tool error: ${cap(text.replace(/\s+/g, ' ').trim(), 300)}` })
        }
      }
    }
    return out
  }
  if (rec.type === 'assistant') {
    const c = (rec.message as { content?: unknown } | undefined)?.content
    if (!Array.isArray(c)) return out
    for (const b of c) {
      if (!b || typeof b !== 'object') continue
      const blk = b as { type?: unknown; text?: unknown; name?: unknown; input?: unknown }
      if (blk.type === 'text' && typeof blk.text === 'string' && blk.text.trim()) out.push({ ts, role: 'assistant', text: blk.text.trim() })
      else if (blk.type === 'tool_use' && typeof blk.name === 'string') {
        let line = blk.name
        try {
          line = summarizeTool('claude', blk.name, blk.input).line
        } catch {
          /* keep the name */
        }
        out.push({ ts, role: 'tool', text: line })
      }
    }
  }
  return out
}

export function readTranscript(session: ClaudeHistorySession, redact: (s: string) => string): ClaudeTranscript {
  let entries: ClaudeTranscriptEntry[] = []
  let truncated = false
  for (const l of lines(session.path)) {
    if (!l) continue
    let rec: Record<string, unknown> | null = null
    try {
      const v = JSON.parse(l)
      rec = v && typeof v === 'object' && !Array.isArray(v) ? v : null
    } catch {
      rec = null
    }
    if (!rec) continue
    for (const e of entriesFrom(rec)) {
      entries.push(e)
      if (entries.length > MAX_ENTRIES * 2) {
        entries = entries.slice(-MAX_ENTRIES)
        truncated = true
      }
    }
  }
  if (entries.length > MAX_ENTRIES) {
    entries = entries.slice(-MAX_ENTRIES)
    truncated = true
  }
  entries = entries.map((e) => ({ ...e, text: cap(redact(e.text), ENTRY_CAP) }))
  // total size cap: drop the oldest until it fits
  let bytes = entries.reduce((n, e) => n + e.text.length + 40, 0)
  while (bytes > MAX_BYTES && entries.length) {
    bytes -= entries[0].text.length + 40
    entries.shift()
    truncated = true
  }
  const subagents: ClaudeTranscript['subagents'] = []
  const dir = path.join(path.dirname(session.path), session.id, 'subagents')
  let files: string[] = []
  try {
    files = fs.readdirSync(dir).filter((f) => /^agent-.*\.jsonl$/.test(f))
  } catch {
    files = []
  }
  for (const f of files.slice(0, 50)) {
    let agentType: string | null = null
    let description: string | null = null
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(dir, f.replace(/\.jsonl$/, '.meta.json')), 'utf8')) as Record<string, unknown>
      agentType = typeof meta.agentType === 'string' ? meta.agentType : null
      description = typeof meta.description === 'string' ? cap(redact(meta.description), 300) : null
    } catch {
      /* no meta */
    }
    let messages = 0
    try {
      for (const l of lines(path.join(dir, f))) if (l.includes('"type":"user"') || l.includes('"type":"assistant"')) messages++
    } catch {
      /* unreadable */
    }
    subagents.push({ file: f, agentType, description, messages })
  }
  return { session, entries, truncated, subagents }
}
