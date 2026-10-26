/**
 * FORUM.md §1: what a message's text points at. Pure. Mentions (`@handle`, `@department`, `@here`) and refs (PRN-12,
 * [[Note]], art_…, r_…, m3fk, URLs) are parsed on write; the store resolves handles and message refs against the
 * company, so a token that matches nothing stays plain text.
 */
import type { ForumRef } from '../../shared/forum'

export interface ParsedText {
  /** lowercase handles after @ (without @here / @channel) */
  handles: string[]
  /** @here / @channel present */
  broadcast: boolean
  refs: ForumRef[]
  /** m3fk-shaped tokens (resolved by the store) */
  messageRefs: string[]
}

const MAX_REFS = 12
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

export function parseText(text: string): ParsedText {
  const handles = new Set<string>()
  let broadcast = false
  for (const m of text.matchAll(/(^|[^\w@/.])@([a-z0-9][a-z0-9._-]{0,31})/gi)) {
    const h = m[2].toLowerCase().replace(/[._-]+$/, '')
    if (h === 'here' || h === 'channel' || h === 'everyone') broadcast = true
    else if (h) handles.add(h)
  }
  const refs: ForumRef[] = []
  const seen = new Set<string>()
  const add = (r: ForumRef) => {
    const k = `${r.kind}:${r.id}`
    if (seen.has(k) || refs.length >= MAX_REFS) return
    seen.add(k)
    refs.push(r)
  }
  const urls: string[] = []
  for (const m of text.matchAll(/https?:\/\/[^\s<>()"'`]+[^\s<>()"'`.,;:!?]/g)) {
    urls.push(m[0])
    add({ kind: 'url', id: clip(m[0], 500), label: clip(m[0].replace(/^https?:\/\//, ''), 60) })
  }
  // tokens inside URLs are not refs
  const bare = urls.reduce((t, u) => t.split(u).join(' '), text)
  // five doors step 2: every company has its own prefix (NC-12, LA-3); uppercase only, so prose never reads as a task
  for (const m of bare.matchAll(/\b([A-Z][A-Z0-9]{1,4}-\d{1,7})\b/g)) add({ kind: 'task', id: m[1].toUpperCase(), label: m[1].toUpperCase() })
  for (const m of bare.matchAll(/\[\[([^[\]\n|#^]{1,200})(?:[#^|][^\]\n]*)?\]\]/g)) {
    const title = m[1].trim()
    if (title) add({ kind: 'note', id: title, label: `[[${title}]]` })
  }
  for (const m of bare.matchAll(/\b(art_[0-9a-z]{6,16})\b/g)) add({ kind: 'artifact', id: m[1], label: m[1] })
  for (const m of bare.matchAll(/\b(r_[0-9a-z]{6,16})\b/g)) add({ kind: 'run', id: m[1], label: m[1] })
  const messageRefs: string[] = []
  for (const m of bare.matchAll(/(^|[\s(])(m[0-9a-z]{1,8})(?=$|[\s),.:;!?])/g)) {
    // must contain a digit: plain words like "me" or "mom" are never refs
    if (/\d/.test(m[2]) && !messageRefs.includes(m[2])) messageRefs.push(m[2])
  }
  return { handles: [...handles], broadcast, refs, messageRefs }
}

/** One explicit ref string from the protocol's `refs` argument (PRN-12, [[Note]], art_…, r_…, m3fk, URL). */
export function parseRefArg(raw: string): ForumRef | { message: string } | null {
  const s = raw.trim()
  if (!s) return null
  if (/^https?:\/\//.test(s)) return { kind: 'url', id: clip(s, 500), label: clip(s.replace(/^https?:\/\//, ''), 60) }
  const task = /^[A-Z][A-Z0-9]{1,4}-\d{1,7}$/i.exec(s)
  if (task) return { kind: 'task', id: s.toUpperCase(), label: s.toUpperCase() }
  const note = /^\[\[(.{1,200})\]\]$/.exec(s)
  if (note) return { kind: 'note', id: note[1].trim(), label: `[[${note[1].trim()}]]` }
  if (/^art_[0-9a-z]{6,16}$/.test(s)) return { kind: 'artifact', id: s, label: s }
  if (/^r_[0-9a-z]{6,16}$/.test(s)) return { kind: 'run', id: s, label: s }
  if (/^m[0-9a-z]{1,10}$/.test(s)) return { message: s }
  // a bare note title is the most useful reading of anything else
  return { kind: 'note', id: clip(s, 200), label: `[[${clip(s, 200)}]]` }
}
