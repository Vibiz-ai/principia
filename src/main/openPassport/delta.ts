// Vendored from open-passport 0.1.0 (packages/js/src/core/delta.ts). Do not edit here: change it upstream and re-run scripts/vendor.mjs.
// Line deltas (SPEC.md §7.4, schema/delta.schema.json): what changed between two revisions, as line operations a
// client can push or pull instead of whole bundles. A receiver materializes theirs = base + ops and runs merge3.
import { formatHistory, formatTasteText, parseLine, type Line } from './grammar'
import { byteOrder, MANIFEST, RENDERS_DIR, type AnyFiles } from './manifest'
import { appendToSection } from './notes'

export type DeltaOp =
  | { op: 'add'; note: string; section?: string; line: string }
  | { op: 'update'; id: string; line: string; section?: string; base_line?: string }
  | { op: 'history'; id: string; state: 'superseded' | 'invalidated'; by?: string; reason?: string }
  | { op: 'reinforce'; id: string; by: number; example?: string }
  | { op: 'note'; path: string; text: string }

export interface Delta {
  passport_id: string
  base: { revision: number; digest: string }
  author?: string
  ops: DeltaOp[]
}

export const DELTA_LIMITS = { ops: 1000, line: 2000, note: 200_000 }

const isMeta = (p: string) => p === MANIFEST || p.startsWith(`${RENDERS_DIR}/`)
const asText = (v: string | Uint8Array | undefined) => (v === undefined ? undefined : typeof v === 'string' ? v : new TextDecoder().decode(v))

interface IdLine {
  index: number
  raw: string
  section: string
  line: Line
}

function linesById(text: string): { lines: string[]; ids: Map<string, IdLine>; rest: string[] } {
  const lines = text.split('\n')
  const ids = new Map<string, IdLine>()
  const rest: string[] = []
  let section = ''
  let fence = false
  lines.forEach((raw, index) => {
    if (/^ {0,3}(```|~~~)/.test(raw)) fence = !fence
    const h = !fence && /^ {0,3}##\s+(.*?)\s*$/.exec(raw)
    if (h) section = h[1]
    const line = fence || h ? null : parseLine(raw, section.toLowerCase() === 'history')
    if (line?.id) ids.set(line.id, { index, raw, section, line })
    else rest.push(raw)
  })
  return { lines, ids, rest }
}

/**
 * The ops that turn `base` into `next`. Notes whose only changes are id'd lines become `add` / `update` ops; any other
 * change (prose, frontmatter, lines without ids) sends the whole note as a `note` op. Merges never delete, so a note
 * missing from `next` produces nothing.
 */
export function diffFiles(base: AnyFiles, next: AnyFiles): DeltaOp[] {
  const ops: DeltaOp[] = []
  for (const p of [...next.keys()].filter((x) => !isMeta(x) && /\.md$/i.test(x)).sort(byteOrder)) {
    const n = asText(next.get(p))!
    const b = asText(base.get(p))
    if (b === n) continue
    if (b === undefined) {
      ops.push({ op: 'note', path: p, text: n })
      continue
    }
    const bl = linesById(b)
    const nl = linesById(n)
    if (bl.rest.join('\n') !== nl.rest.join('\n')) {
      ops.push({ op: 'note', path: p, text: n })
      continue
    }
    for (const [id, l] of nl.ids) {
      const was = bl.ids.get(id)
      if (!was) ops.push({ op: 'add', note: p, section: l.section || 'Observations', line: l.raw })
      else if (was.raw !== l.raw) ops.push({ op: 'update', id, line: l.raw, base_line: was.raw, ...(was.section !== l.section ? { section: l.section } : {}) })
    }
  }
  return ops
}

/** Where a line id lives in a set of files. */
function findLine(files: AnyFiles, id: string): { path: string; text: string; at: IdLine } | null {
  for (const [p, v] of files) {
    if (!/\.md$/i.test(p) || isMeta(p)) continue
    const text = asText(v)!
    if (!text.includes(`^${id}`)) continue
    const at = linesById(text).ids.get(id)
    if (at) return { path: p, text, at }
  }
  return null
}

function noteByRef(files: AnyFiles, ref: string): string | null {
  if (files.has(ref)) return ref
  for (const [p, v] of files) {
    if (!/\.md$/i.test(p)) continue
    const m = /^---\r?\n[\s\S]*?^id:\s*(\S+)\s*$/m.exec(asText(v)!)
    if (m && m[1] === ref) return p
  }
  return null
}

/** Replaces line `index` (moving it to `section` when that differs). */
function replaceLine(text: string, index: number, raw: string, section: string | undefined, current: string): string {
  const lines = text.split('\n')
  if (!section || section === current) {
    lines[index] = raw
    return lines.join('\n')
  }
  lines.splice(index, 1)
  return appendToSection(lines.join('\n'), section, [raw])
}

/**
 * Applies a delta to a copy of `files` (the delta's base revision). Ops whose target is missing are returned as
 * `skipped`, never guessed.
 */
export function applyDelta(files: AnyFiles, ops: DeltaOp[]): { files: AnyFiles; skipped: { op: DeltaOp; reason: string }[] } {
  const out: AnyFiles = new Map(files)
  const skipped: { op: DeltaOp; reason: string }[] = []
  for (const op of ops.slice(0, DELTA_LIMITS.ops)) {
    switch (op.op) {
      case 'note':
        if (op.text.length > DELTA_LIMITS.note || !/\.md$/i.test(op.path)) skipped.push({ op, reason: 'not a note or too large' })
        else out.set(op.path, op.text)
        break
      case 'add': {
        const p = noteByRef(out, op.note)
        const l = parseLine(op.line)
        if (!p) skipped.push({ op, reason: `unknown note ${op.note}` })
        else if (!l?.id || op.line.length > DELTA_LIMITS.line) skipped.push({ op, reason: 'an added line needs a ^f-/^r- id' })
        else if (findLine(out, l.id)) skipped.push({ op, reason: `^${l.id} already exists` })
        else out.set(p, appendToSection(asText(out.get(p))!, op.section ?? (l.kind === 'relation' ? 'Relations' : 'Observations'), [op.line]))
        break
      }
      case 'update': {
        const hit = findLine(out, op.id)
        if (!hit || op.line.length > DELTA_LIMITS.line) skipped.push({ op, reason: `unknown line ^${op.id}` })
        else out.set(hit.path, replaceLine(hit.text, hit.at.index, op.line, op.section, hit.at.section))
        break
      }
      case 'history': {
        const hit = findLine(out, op.id)
        if (!hit || hit.at.line.kind === 'history') {
          skipped.push({ op, reason: `no live line ^${op.id}` })
          break
        }
        const l = hit.at.line
        const text = l.kind === 'relation' ? `${l.rel} [[${l.target}]]${l.context ? ` (${l.context})` : ''}` : l.text
        const raw = formatHistory({ state: op.state, text, supersededBy: op.by ?? null, reason: op.reason ?? null, prov: l.prov, id: op.id })
        out.set(hit.path, replaceLine(hit.text, hit.at.index, raw, 'History', hit.at.section))
        break
      }
      case 'reinforce': {
        const hit = findLine(out, op.id)
        const l = hit?.at.line
        if (!hit || l?.kind !== 'observation' || !l.taste) {
          skipped.push({ op, reason: `no taste line ^${op.id}` })
          break
        }
        const ex = op.example?.trim()
        const examples = ex && !l.taste.examples.includes(ex) ? [...l.taste.examples, ex].slice(-5) : l.taste.examples
        const next = formatTasteText({ statement: l.taste.statement, examples, count: l.taste.count + Math.max(1, op.by) })
        const raw = hit.at.raw.slice(0, hit.at.raw.indexOf(l.text)) + next + hit.at.raw.slice(hit.at.raw.indexOf(l.text) + l.text.length)
        out.set(hit.path, replaceLine(hit.text, hit.at.index, raw, undefined, hit.at.section))
        break
      }
    }
  }
  return { files: out, skipped }
}
