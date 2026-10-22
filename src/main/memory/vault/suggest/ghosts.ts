/**
 * Stage 0 ghost suggestions (PASSPORT.md §5, §12). Fuzzy matches never auto-resolve; they become proposals:
 *
 * - `retarget`: a ghost that is a near miss of exactly one existing note (plural or " (Type)" stripping, Damerau <= 2 on
 *   names of 6+ characters, token Jaccard >= 0.75). Accepting adds the ghost text as an alias of the note, which
 *   resolves every link to it (§5 step 5); the Inbox "add alias" checkbox maps to that op.
 * - `entity`: a ghost with 3+ inbound links from 2+ notes and no retarget candidate becomes a new note. The type comes
 *   from the relation ranges pointing at it (§4), the summary is drafted from the linking lines.
 *
 * Ambiguous ghosts and attachment embeds are left alone.
 */
import { parseBulletLine } from '../../../../shared/vault/grammar'
import { guessTargetType } from '../../../../shared/vault/ontology'
import { damerauLevenshtein, normName, tokenJaccard } from '../../../../shared/vault/resolve'
import { singularName, stripTypeSuffix } from '../../../../shared/fuzzy'
import type { Candidate, VaultView, ViewGhost, ViewNote } from './candidates'
import { liveNotes } from './candidates'

export const PROMOTE_MIN_INBOUND = 3
export const PROMOTE_MIN_SOURCES = 2

const ATTACHMENT_RE = /\.[A-Za-z0-9]{1,8}$/

/** How close a ghost name is to a note name (0 = not a candidate). */
export function retargetScore(ghost: string, name: string): number {
  const g = normName(ghost)
  const c = normName(name)
  if (!g || !c || g === c) return 0
  // [[Pricing v2]] vs "Pricing v3", [[Q3 plan]] vs "Q4 plan": different numbers name different things
  if ((g.match(/\d+/g) ?? []).join(',') !== (c.match(/\d+/g) ?? []).join(',')) return 0
  if (singularName(g) === singularName(c) || stripTypeSuffix(g) === stripTypeSuffix(c)) return 0.85
  if (Math.min(g.length, c.length) >= 6) {
    const d = damerauLevenshtein(g, c, 2)
    if (d <= 2) return 0.8 - d * 0.05
  }
  if (tokenJaccard(g, c) >= 0.75) return 0.7
  return 0
}

/** The single best note for a ghost, or null when none or a tie. */
export function retargetTarget(ghost: ViewGhost, notes: ViewNote[]): { note: ViewNote; score: number; matched: string } | null {
  let best: { note: ViewNote; score: number; matched: string } | null = null
  let tie = false
  for (const n of notes) {
    let top = 0
    let matched = ''
    for (const name of [n.title, n.stem, ...n.aliases]) {
      const s = retargetScore(ghost.text, name)
      if (s > top) {
        top = s
        matched = name
      }
    }
    if (!top) continue
    if (!best || top > best.score) {
      best = { note: n, score: top, matched }
      tie = false
    } else if (top === best.score) tie = true
  }
  return best && !tie ? best : null
}

/** Majority range type of the relations pointing at the ghost (`works_at` -> company), else `note` (Inbox). */
export function guessGhostType(ghost: ViewGhost): string {
  const votes = new Map<string, number>()
  for (const rel of ghost.rels) {
    const t = guessTargetType(rel)
    if (t) votes.set(t, (votes.get(t) ?? 0) + 1)
  }
  const top = [...votes.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]
  return top ? top[0] : 'note'
}

/** "Referenced by [[A]] and [[B]]: <first linking line>" (plain text of the line, no provenance or block id). */
export function draftSummary(ghost: ViewGhost, view: VaultView): string {
  const from = ghost.samples.map((s) => view.byId.get(s.from)).filter((n): n is ViewNote => !!n)
  const names = from.map((n) => `[[${n.stem}]]`)
  const more = ghost.sources - names.length
  const list = names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')}${more > 0 ? ', ' : ' and '}${names[names.length - 1]}${more > 0 ? ` and ${more} more` : ''}`
  const ctx = ghost.samples.map((s) => lineText(s.context)).find((t) => t.length >= 8)
  return `Referenced by ${list}.${ctx ? ` "${ctx.slice(0, 160)}"` : ''}`
}

function lineText(context: string): string {
  const b = parseBulletLine(context)
  const t = b?.kind === 'observation' || b?.kind === 'history' ? b.text : context.replace(/^\s*[-*+]\s+/, '')
  return t.replace(/\s+/g, ' ').trim()
}

function evidence(ghost: ViewGhost, view: VaultView, note: string): Candidate['evidence'] {
  return ghost.samples.map((s) => ({ path: view.byId.get(s.from)?.path ?? null, line: s.line, quote: s.context.slice(0, 300), note }))
}

/** `retarget` and `entity` candidates for the company's ghosts (optionally only those linked from `noteIds`). */
export function ghostCandidates(view: VaultView, noteIds?: string[] | null): Candidate[] {
  const live = liveNotes(view)
  const focus = noteIds ? new Set(noteIds) : null
  const out: Candidate[] = []
  for (const g of view.ghosts) {
    if (g.ambiguous || g.embed || (ATTACHMENT_RE.test(g.text) && !/\.md$/i.test(g.text))) continue
    if (focus && !g.samples.some((s) => focus.has(s.from))) continue
    const hit = retargetTarget(g, live)
    if (hit) {
      out.push({
        kind: 'retarget',
        source: 'ghosts',
        ops: [{ op: 'addAlias', note: hit.note.stem, alias: g.text }],
        evidence: evidence(g, view, `[[${g.text}]] has no note; did you mean [[${hit.note.stem}]]?`),
        score: hit.score,
        key: `retarget:${g.norm}:${hit.note.id}`
      })
      continue
    }
    if (g.inbound >= PROMOTE_MIN_INBOUND && g.sources >= PROMOTE_MIN_SOURCES) {
      const type = guessGhostType(g)
      out.push({
        kind: 'entity',
        source: 'ghosts',
        ops: [{ op: 'createNote', title: g.text, type, summary: draftSummary(g, view) }],
        evidence: evidence(g, view, `${g.inbound} links from ${g.sources} notes`),
        score: Math.min(0.9, 0.6 + (g.inbound - PROMOTE_MIN_INBOUND) * 0.05 + (g.sources - PROMOTE_MIN_SOURCES) * 0.05),
        key: `entity:${g.norm}`
      })
    }
  }
  return out
}
