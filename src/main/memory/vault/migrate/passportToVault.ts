// Company hub and repo notes from the Passport profiles (PASSPORT.md §9 step 3). Pure planning over a VaultView (what
// the vault folder holds right now), so a dry run and a re-run see exactly what a real run would add:
//
// - the hub note `<Name>.md` (seeded with the mission as its summary) gets one `[category]` observation per non-empty
//   profile field and a `- sells [[Product]]` ghost per product name, as writer ops (the writer dedups both)
// - every repo the company owns becomes `Repos/<name>.md` (`type: repo`, `repo_id`, `- part_of [[<Company>]]`)

import fs from 'node:fs'
import type { CompanyPassport } from '../../../../shared/company'
import type { VaultOp } from '../../../../shared/passport'
import type { Repo } from '../../../../shared/types'
import { formatObservation, parseBulletLine } from '../../../../shared/vault/grammar'
import { newBlockId, newNoteId, textHash } from '../../../../shared/vault/ids'
import { normalizeRelType } from '../../../../shared/vault/ontology'
import { parseNote, type ParsedNote } from '../../../../shared/vault/parse'
import { normName, pathStem } from '../../../../shared/vault/resolve'
import { isoDate, renderNote } from '../../../../shared/vault/serialize'
import { pathForNewNote, sanitizeFilename } from '../../../../shared/vault/slug'
import { walkNotes } from '../fsutil'

// ---------- the vault as it is on disk ----------

export interface ViewNote {
  path: string
  /** frontmatter id (`n-…`) or null for hand-written notes */
  id: string | null
  title: string
  type: string
  repoId: string | null
  summary: string
  /** every block id on the note (observations, relations, History) */
  blockIds: Set<string>
  /** text hashes of active observations (the writer's per-note dedup key) */
  activeHashes: Set<string>
  /** `normRel|normTarget` of active relations */
  relKeys: Set<string>
}

export interface VaultView {
  companyId: string
  root: string
  exists: boolean
  notes: ViewNote[]
  byId: Map<string, ViewNote>
  /** block ids anywhere in the vault: a line a user moved to another note is not migrated twice */
  blockIds: Set<string>
  /** normalized basenames in use, plus the ones this run plans */
  taken: Set<string>
  /** the root-level `type: company` note */
  hub: ViewNote | null
}

export function viewNote(rel: string, parsed: ParsedNote): ViewNote {
  const blockIds = new Set<string>()
  const activeHashes = new Set<string>()
  const relKeys = new Set<string>()
  for (const f of parsed.facts) {
    if (f.blockId) blockIds.add(f.blockId)
    if (f.status === 'active') activeHashes.add(textHash(f.text))
  }
  for (const r of parsed.relations) {
    if (r.blockId) blockIds.add(r.blockId)
    if (r.status === 'active') relKeys.add(`${r.normRel}|${normName(r.link.target)}`)
  }
  return { path: rel, id: parsed.id, title: parsed.title, type: parsed.type, repoId: parsed.repoId, summary: parsed.summary, blockIds, activeHashes, relKeys }
}

/** Parses every note of a vault folder (missing folder = empty view). */
export function readVaultView(companyId: string, root: string): VaultView {
  const view: VaultView = { companyId, root, exists: fs.existsSync(root), notes: [], byId: new Map(), blockIds: new Set(), taken: new Set(), hub: null }
  if (!view.exists) return view
  for (const f of walkNotes(root)) {
    let text: string
    try {
      text = fs.readFileSync(f.abs, 'utf8')
    } catch {
      continue
    }
    const n = viewNote(f.rel, parseNote(text, { path: f.rel }))
    view.notes.push(n)
    if (n.id) view.byId.set(n.id, n)
    for (const b of n.blockIds) view.blockIds.add(b)
    view.taken.add(normName(pathStem(f.rel)))
    if (!view.hub && n.type === 'company' && !f.rel.includes('/')) view.hub = n
  }
  return view
}

/**
 * `[[…]]` target for a note basename. A stem ending in something that looks like a file extension
 * (`scripts-sync-migration.sh`) is written with `.md`, or Obsidian and the grammar read it as an attachment link.
 */
export function noteLinkTarget(stem: string): string {
  return /\.[A-Za-z0-9]{1,8}$/.test(stem) && !/\.md$/i.test(stem) ? `${stem}.md` : stem
}

// ---------- hub note ----------

/** Profile field -> observation category (§9 step 3). */
export const PROFILE_CATEGORIES: ReadonlyArray<[keyof CompanyPassport & string, string]> = [
  ['mission', 'mission'],
  ['brandVoice', 'brand'],
  ['audience', 'audience'],
  ['products', 'product'],
  ['goals', 'goal'],
  ['context', 'context'],
  ['constraints', 'constraint']
]

const MAX_PRODUCT_WORDS = 4
const MAX_PRODUCT_CHARS = 60

/**
 * Product names out of the free-text `products` field: one per line, bullet or `;`, the description after ` - `,
 * `: ` or ` (` dropped, then comma lists split. Phrases that read like prose (articles, long) are skipped.
 */
export function productNames(text: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of text.split(/\r?\n|;|•/)) {
    const line = raw
      .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '')
      .replace(/\[\[([^\]|]*)(?:\|[^\]]*)?\]\]/g, '$1')
      .split(/\s[—–-]\s|:\s|\s\(/)[0]
    for (const part of line.split(',')) {
      const name = part
        .replace(/[[\]|#^]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/[.!]+$/, '')
      if (!name || name.length > MAX_PRODUCT_CHARS || name.split(' ').length > MAX_PRODUCT_WORDS) continue
      if (/^(a|an|the|and|or|our|we)\b/i.test(name)) continue
      const key = normName(name)
      if (seen.has(key)) continue
      seen.add(key)
      out.push(name)
    }
  }
  return out
}

/** The hub note's path: the one in the vault, else the one seedVault creates. */
export function hubPathOf(company: Pick<CompanyPassport, 'name'>, view: VaultView): string {
  return view.hub?.path ?? `${sanitizeFilename(company.name || 'Company')}.md`
}

export interface HubPlan {
  companyId: string
  hubPath: string
  /** the hub's link target (its basename, see noteLinkTarget) */
  hubStem: string
  /** observe + relate ops on the hub, only those not already true */
  ops: VaultOp[]
  observations: number
  ghosts: number
}

/** The writer's dedup key for an observation (writer.ts `observe`). */
function observationHash(category: string, text: string): string {
  const probe = parseBulletLine(formatObservation({ category, text }))
  return textHash(probe && probe.kind === 'observation' ? probe.text : text)
}

export function planHub(company: CompanyPassport, view: VaultView): HubPlan {
  const hubPath = hubPathOf(company, view)
  const hubStem = noteLinkTarget(pathStem(hubPath))
  // seeding creates the hub before anything else: reserve its basename so a dry run places notes like the real run
  view.taken.add(normName(pathStem(hubPath)))
  const hashes = view.hub?.activeHashes ?? new Set<string>()
  const rels = view.hub?.relKeys ?? new Set<string>()
  const ops: VaultOp[] = []
  let observations = 0
  let ghosts = 0
  for (const [field, category] of PROFILE_CATEGORIES) {
    const value = String(company[field] ?? '').trim()
    if (!value) continue
    // one line: list items joined with `; `
    const text = value
      .split(/\r?\n/)
      .map((l) => l.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '').trim())
      .filter(Boolean)
      .join('; ')
    if (hashes.has(observationHash(category, text))) continue
    ops.push({ op: 'observe', note: hubPath, category, text })
    observations++
  }
  const sells = normalizeRelType('sells')
  for (const name of productNames(company.products ?? '')) {
    if (normName(name) === normName(hubStem) || normName(name) === normName(company.name)) continue
    if (rels.has(`${sells}|${normName(name)}`)) continue
    ops.push({ op: 'relate', from: hubPath, rel: 'sells', to: name })
    ghosts++
  }
  return { companyId: company.id, hubPath, hubStem, ops, observations, ghosts }
}

// ---------- repo notes ----------

export interface NoteCreate {
  companyId: string
  path: string
  noteId: string
  title: string
  type: string
  text: string
  /** v1 entity id, when the note comes from memory.db */
  v1Id: string | null
  observations: number
  historyLines: number
  relations: number
}

export interface RepoPlan {
  creates: NoteCreate[]
  /** repo id -> link target of its note (existing or planned, see noteLinkTarget) */
  stems: Map<string, string>
}

/** `Repos/<name>.md` for every owned repo that has no note yet (matched by `repo_id`). Reserves the basenames. */
export function planRepoNotes(company: CompanyPassport, repos: Repo[], view: VaultView, hubStem: string, now: Date): RepoPlan {
  const creates: NoteCreate[] = []
  const stems = new Map<string, string>()
  const date = isoDate(now)
  for (const n of view.notes) if (n.type === 'repo' && n.repoId && !stems.has(n.repoId)) stems.set(n.repoId, noteLinkTarget(pathStem(n.path)))
  for (const repoId of company.repoIds ?? []) {
    if (stems.has(repoId)) continue
    const repo = repos.find((r) => r.id === repoId)
    if (!repo) continue
    const rel = pathForNewNote({ title: repo.name, type: 'repo' }, (k) => view.taken.has(k))
    view.taken.add(normName(pathStem(rel)))
    const noteId = newNoteId()
    const text = renderNote({
      id: noteId,
      title: repo.name,
      type: 'repo',
      properties: [
        ['company', `[[${hubStem}]]`],
        ['repo_id', repo.id]
      ],
      created: date,
      source: 'migration',
      relations: [{ rel: 'part_of', target: hubStem, prov: { actor: 'migration', date }, blockId: newBlockId('r') }]
    })
    stems.set(repoId, noteLinkTarget(pathStem(rel)))
    creates.push({ companyId: company.id, path: rel, noteId, title: repo.name, type: 'repo', text, v1Id: null, observations: 0, historyLines: 0, relations: 1 })
  }
  return { creates, stems }
}
