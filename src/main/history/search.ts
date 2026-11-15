/**
 * Search inside your Claude sessions (the sidebar's Search): finds a word or phrase in what you typed and what Claude
 * answered, across every transcript under the history roots (index.ts, read-only, symlinks never followed). Newest
 * sessions first; each hit carries the session's first prompt as its title and a short snippet around the match.
 *
 * Fast path: ripgrep, when this Mac has it, lists the files that contain the words; otherwise the newest files are read
 * for at most 5 seconds. Either way only matching lines are parsed. No Electron imports.
 */
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { SessionHit, SessionSearchResult } from '../../shared/authoring'
import { typedPromptText } from './index'

export type { SessionHit, SessionSearchResult }

const SESSION_FILE = /^([0-9a-zA-Z-]{8,64})\.jsonl$/
const MAX_FILE = 48 * 1024 * 1024
/** without ripgrep, newest files are read for this long, then the answer says it stopped */
const BUDGET_MS = 5_000

interface Found {
  file: string
  id: string
  mtimeMs: number
  size: number
}

/** Transcript files under the roots, newest first (projects/<folder>/<id>.jsonl; lstat, no symlinks). */
export function transcriptFiles(roots: string[]): Found[] {
  const out: Found[] = []
  for (const root of roots) {
    let dirs: fs.Dirent[] = []
    try {
      dirs = fs.readdirSync(root, { withFileTypes: true })
    } catch {
      continue
    }
    for (const d of dirs) {
      if (!d.isDirectory()) continue
      const dir = path.join(root, d.name)
      let files: fs.Dirent[] = []
      try {
        files = fs.readdirSync(dir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const f of files) {
        const m = SESSION_FILE.exec(f.name)
        if (!m || !f.isFile()) continue
        const file = path.join(dir, f.name)
        try {
          const st = fs.lstatSync(file)
          if (st.isFile()) out.push({ file, id: m[1]!, mtimeMs: st.mtimeMs, size: st.size })
        } catch {
          /* gone */
        }
      }
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs)
}

/** The visible text of one transcript line: what you typed, or Claude's written answer (not tools). */
export function lineText(rec: Record<string, unknown>): { role: 'you' | 'claude'; text: string } | null {
  const you = typedPromptText(rec)
  if (you) return { role: 'you', text: you }
  if (rec.type !== 'assistant' || rec.isSidechain === true) return null
  const c = (rec.message as { content?: unknown } | undefined)?.content
  if (!Array.isArray(c)) return null
  const text = c
    .filter((b): b is { type: 'text'; text: string } => !!b && typeof b === 'object' && (b as { type?: unknown }).type === 'text' && typeof (b as { text?: unknown }).text === 'string')
    .map((b) => b.text)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
  return text ? { role: 'claude', text } : null
}

export function snippetAround(text: string, words: string[], width = 160): string {
  const low = text.toLowerCase()
  const at = Math.max(0, Math.min(...words.map((w) => low.indexOf(w)).filter((i) => i >= 0)))
  const start = Math.max(0, at - Math.floor(width / 3))
  const s = text.slice(start, start + width).trim()
  return `${start > 0 ? '…' : ''}${s}${start + width < text.length ? '…' : ''}`
}

/** Every word must appear (case-insensitive) in one message. */
const matches = (text: string, words: string[]): boolean => {
  const low = text.toLowerCase()
  return words.every((w) => low.includes(w))
}

/** One file: its first prompt (title), cwd, and the newest matching message. */
export function searchFile(f: Found, words: string[]): SessionHit | null {
  if (f.size > MAX_FILE) return null
  let raw: string
  try {
    raw = fs.readFileSync(f.file, 'utf8')
  } catch {
    return null
  }
  const low = raw.toLowerCase()
  if (!words.every((w) => low.includes(w))) return null
  let title: string | null = null
  let cwd: string | null = null
  let best: { role: 'you' | 'claude'; text: string } | null = null
  let count = 0
  for (const line of raw.split('\n')) {
    if (!line) continue
    const hasWord = words.some((w) => line.toLowerCase().includes(w))
    if (title && cwd && !hasWord) continue
    let rec: Record<string, unknown>
    try {
      rec = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    if (!cwd && typeof rec.cwd === 'string') cwd = rec.cwd
    const t = lineText(rec)
    if (!t) continue
    if (!title && t.role === 'you') title = t.text.slice(0, 120)
    if (hasWord && matches(t.text, words)) {
      count++
      best = t
    }
  }
  if (!best) return null
  return { id: f.id, title: title ?? 'Claude session', cwd, at: new Date(f.mtimeMs).toISOString(), role: best.role, snippet: snippetAround(best.text, words), matches: count }
}

/** Files that contain the first word, by ripgrep (null when there is no rg or it failed). */
function rgFiles(roots: string[], word: string, rg: string): Promise<Set<string> | null> {
  return new Promise((resolve) => {
    execFile(rg, ['-l', '-i', '-F', '--no-follow', '--glob', '*.jsonl', '--max-filesize', '48M', '--', word, ...roots], { timeout: 10_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      // rg exits 1 when nothing matched: that is an answer, not a failure
      if (err && (err as { code?: unknown }).code !== 1) return resolve(null)
      resolve(new Set(stdout.split('\n').filter(Boolean)))
    })
  })
}

export async function searchSessions(o: { roots: string[]; query: string; limit?: number; rg?: string | null; budgetMs?: number }): Promise<SessionSearchResult> {
  const words = o.query.toLowerCase().split(/\s+/).map((w) => w.trim()).filter((w) => w.length >= 2).slice(0, 6)
  if (!words.length) return { hits: [], scanned: 0, truncated: false }
  const limit = Math.min(o.limit ?? 30, 100)
  let files = transcriptFiles(o.roots)
  let truncated = false
  const pre = o.rg ? await rgFiles(o.roots, words.sort((a, b) => b.length - a.length)[0]!, o.rg) : null
  if (pre) files = files.filter((f) => pre.has(f.file))
  const started = Date.now()
  const hits: SessionHit[] = []
  let scanned = 0
  for (const f of files) {
    if (!pre && Date.now() - started > (o.budgetMs ?? BUDGET_MS)) {
      truncated = true
      break
    }
    scanned++
    const h = searchFile(f, words)
    if (h) hits.push(h)
    if (hits.length >= limit) {
      truncated = truncated || scanned < files.length
      break
    }
    // keep the main process responsive on a long scan
    if (scanned % 20 === 0) await new Promise((r) => setImmediate(r))
  }
  return { hits, scanned, truncated }
}
