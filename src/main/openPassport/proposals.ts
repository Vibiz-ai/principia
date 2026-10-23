// Vendored from open-passport 0.1.0 (packages/js/src/core/proposals.ts). Do not edit here: change it upstream and re-run scripts/vendor.mjs.
// Local proposals (SPEC.md §8.4): writes an app or an importer wants to make, kept for a person to review. A local
// passport keeps them as JSON files under `.open-passport/proposals/` (tool state: never part of the passport, never
// packed); a desktop app (Principia) moves them into its review inbox, and `open-passport proposals` lists and
// applies them. Hosts keep the same thing server-side (§11.5).
import { cleanText, formatObservation, formatRelation, isPolarity, parseLine, type Line, type Polarity } from './grammar'
import { credentialHit, executableHit, imperativeHit } from './screen'
import type { WriteRequest } from './tools'

export const PROPOSALS_DIR = '.open-passport/proposals'

export interface ProposalNote {
  title: string
  type: string | null
  /** observation / taste / relation lines in §4 grammar, without ids or provenance */
  lines: string[]
}
export interface ProposalTaste {
  scope: string
  polarity: Polarity
  text: string
  example: string
  stated_by_user: boolean
}

export interface LocalProposal {
  open_passport_proposal: 1
  id: string
  created: string
  /** who asked: an app (`claude-desktop`, `cursor`) or an importer (`import`) */
  app: string
  /** `mcp`, `import:chatgpt`, `import:claude`, `import:folder`, `import:url`, `import:text`, ... */
  source: string
  kind: 'notes' | 'taste'
  notes?: ProposalNote[]
  taste?: ProposalTaste
  /** why: quotes from the source (shown to the reviewer, never written) */
  evidence?: string[]
  /** 0..1, higher first in review */
  score?: number
}

export const PROPOSAL_LIMITS = { notes: 10, linesPerNote: 20, line: 500, evidence: 5, evidenceLen: 300 }

export function newProposalId(random: (n: number) => Uint8Array = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n))): string {
  return `pp-${[...random(8)].map((b) => b.toString(16).padStart(2, '0')).join('')}`
}

/** The line as stored in a proposal: grammar without id or provenance. */
export function proposalLine(l: Line): string {
  if (l.kind === 'relation') return formatRelation({ rel: l.rel, target: l.target, context: l.context, prov: null, id: null })
  if (l.kind === 'observation') return formatObservation({ category: l.category, text: l.text, prov: null, id: null })
  return ''
}

export function proposalFromWrite(w: WriteRequest, meta: { app: string; source: string; now: string; id?: string; evidence?: string[] }): LocalProposal {
  const base = { open_passport_proposal: 1 as const, id: meta.id ?? newProposalId(), created: meta.now, app: meta.app, source: meta.source, ...(meta.evidence?.length ? { evidence: meta.evidence } : {}) }
  if (w.tool === 'taste') return { ...base, kind: 'taste', taste: { ...w.feedback, stated_by_user: w.stated } }
  return { ...base, kind: 'notes', notes: [{ title: w.note, type: w.type, lines: w.lines.map(proposalLine).filter(Boolean) }] }
}

/**
 * Validates and screens a proposal read from disk or the network: unknown shapes are refused, lines that fail the
 * §10 screens are dropped (reported in `dropped`). Returns null when nothing usable is left.
 */
export function parseLocalProposal(raw: unknown): { proposal: LocalProposal; dropped: string[] } | null {
  if (!raw || typeof raw !== 'object') return null
  const p = raw as Record<string, unknown>
  if (p.open_passport_proposal !== 1 || typeof p.id !== 'string' || !/^pp-[0-9a-f]{4,64}$/.test(p.id)) return null
  const dropped: string[] = []
  const screen = (s: string) => credentialHit(s) ?? executableHit(s) ?? imperativeHit(s)
  const evidence = Array.isArray(p.evidence)
    ? p.evidence
        .filter((e): e is string => typeof e === 'string')
        .slice(0, PROPOSAL_LIMITS.evidence)
        .map((e) => cleanText(e).slice(0, PROPOSAL_LIMITS.evidenceLen))
        .filter((e) => !screen(e))
    : []
  const out: LocalProposal = {
    open_passport_proposal: 1,
    id: p.id,
    created: typeof p.created === 'string' ? p.created.slice(0, 40) : '',
    app: typeof p.app === 'string' ? p.app.slice(0, 80) : 'app',
    source: typeof p.source === 'string' ? p.source.slice(0, 40) : 'mcp',
    kind: p.kind === 'taste' ? 'taste' : 'notes',
    ...(evidence.length ? { evidence } : {}),
    ...(typeof p.score === 'number' && p.score >= 0 && p.score <= 1 ? { score: p.score } : {})
  }
  if (out.kind === 'taste') {
    const t = (p.taste ?? {}) as Record<string, unknown>
    const polarity = String(t.polarity ?? '')
    const text = cleanText(String(t.text ?? '')).replace(/;/g, ',').slice(0, 200)
    const example = cleanText(String(t.example ?? '')).slice(0, 300)
    const scope = String(t.scope ?? 'company')
    if (!isPolarity(polarity) || text.length < 3 || !example || !/^(company|department:[a-z0-9][a-z0-9-]*)$/.test(scope)) return null
    if (screen(`${text} ${example}`)) return null
    out.taste = { scope, polarity, text, example, stated_by_user: t.stated_by_user === true }
    return { proposal: out, dropped }
  }
  const notes: ProposalNote[] = []
  for (const n of (Array.isArray(p.notes) ? p.notes : []).slice(0, PROPOSAL_LIMITS.notes) as Record<string, unknown>[]) {
    const title = cleanText(String(n?.title ?? '')).replace(/[[\]#^|]/g, '').slice(0, 200)
    if (!title) continue
    const lines: string[] = []
    for (const l of (Array.isArray(n.lines) ? n.lines : []).slice(0, PROPOSAL_LIMITS.linesPerNote)) {
      const s = String(l).slice(0, PROPOSAL_LIMITS.line)
      const parsed = parseLine(s.startsWith('- ') ? s : `- ${s}`)
      const why = !parsed || parsed.kind === 'history' ? 'not an observation or relation line' : screen(s)
      if (why) dropped.push(`${s} (${why})`)
      else lines.push(proposalLine(parsed!))
    }
    if (lines.length) notes.push({ title, type: typeof n.type === 'string' && /^[a-z-]{2,40}$/.test(n.type) ? n.type : null, lines })
  }
  if (!notes.length) return null
  out.notes = notes
  return { proposal: out, dropped }
}

/** The proposal as an `open-passport-notes` block (SPEC.md §9.6), for review in a terminal or a text editor. */
export function proposalsToNotesBlock(ps: LocalProposal[]): string {
  const byNote = new Map<string, { type: string | null; lines: string[] }>()
  const add = (title: string, type: string | null, line: string) => {
    const e = byNote.get(title) ?? { type, lines: [] }
    if (!e.lines.includes(line)) e.lines.push(line)
    byNote.set(title, e)
  }
  for (const p of ps) {
    if (p.kind === 'taste' && p.taste) {
      const ex = /^\[\[[^[\]]+\]\]$/.test(p.taste.example) ? p.taste.example : `"${p.taste.example.replace(/["()]/g, "'")}"`
      add(p.taste.scope === 'company' ? 'Taste' : p.taste.scope.slice('department:'.length), p.taste.scope === 'company' ? 'taste' : 'department', `- [${p.taste.polarity}] ${p.taste.text} (example: ${ex})`)
    }
    for (const n of p.notes ?? []) for (const l of n.lines) add(n.title, n.type, l)
  }
  const body = [...byNote.entries()].map(([t, e]) => [`### [[${t}]]${e.type ? ` (${e.type})` : ''}`, ...e.lines].join('\n')).join('\n')
  return `\`\`\`open-passport-notes\n${body}\n\`\`\`\n`
}
