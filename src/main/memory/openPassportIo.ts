/**
 * Open Passport export and import (open-passport SPEC.md; PASSPORT.md "Open Passport"). A company's vault is already
 * an Open Passport once it has a `passport.json` and `renders/`: export copies the notes (redacted), writes the
 * department charter, slug and agent seats into the department notes, builds the manifest and the L0/L1 renders, and
 * zips it. Import creates a company from a passport, or merges one into an existing company: line-id three-way merge
 * against the copy we last exported (or imported), conflicts kept as ours and filed as `import_conflict` proposals.
 *
 * Every export and import keeps its zip (one per content digest) under `.principia/exports/` (the merge base for a copy that comes back) and the
 * last manifest in `.principia/open-passport.json` (so revisions keep counting from it).
 */
import fs from 'node:fs'
import path from 'node:path'
import {
  buildManifest,
  loadPassport,
  manifestJson,
  merge3,
  parseFrontmatter,
  parseLine as opParseLine,
  renderL0,
  textFiles,
  validate,
  MANIFEST,
  type AnyFiles,
  type Manifest,
  type MergeConflict,
  type MergeStats,
  type PassportModel
} from '../openPassport'
import { readFolder, readPassport, writeZip } from '../openPassport/fs'
import { ACTORS, normalizeNoteType, parseBulletLine, TYPE_FOLDER } from '../../shared/vault/grammar'
import * as patch from '../../shared/vault/patch'
import { sanitizeFilename } from '../../shared/vault/slug'
import { normName, pathStem } from '../../shared/vault/resolve'
import type { OpenPassportPreview, VaultOp } from '../../shared/passport'
import type { IndexDB } from './vault/indexDb'
import { insertProposal } from './vault/indexDb'
import { fingerprintOf } from './vault/suggest/queue'
import { readFileState, sha1 } from './vault/fsutil'
import { PRINCIPIA_DIR } from './vault/paths'
import { departmentNote, hubNote } from './brief'

export const OPEN_PASSPORT_GENERATOR = 'principia'
const EXPORTS_DIR = 'exports'
const LAST_MANIFEST = 'open-passport.json'
/** Validation errors that refuse an import outright (hash or render problems only warn: a hand-edited copy is fine). */
const BLOCKING = new Set(['unsafe_path', 'disallowed_type', 'file_too_large', 'too_many_files', 'passport_too_large', 'secret', 'executable_content', 'manifest_invalid'])

/** A department as the export writes it into its note. */
export interface ExportDepartment {
  id: string
  /** the department's key: its Open Passport slug */
  key: string
  name: string
  charter: { does: string; doesNot: string }
  agents: { name: string; capabilities: string }[]
}

/** What the runtime gives this module (PassportRuntime). */
export interface OpenPassportHost {
  db: IndexDB
  ensure(companyId: string): string
  reindex(companyId: string): unknown
  expected: { register(abs: string, hash: string): void }
  writer: { save(companyId: string, req: { path: string; baseHash: string; text: string }, ctx: { actor: 'user' }): Promise<{ status: string }> }
  redact(text: string): string
  now(): Date
}

// ---------- files ----------

/** The vault's content as passport files: notes and allowed attachments; no tool state, templates or schema notes. */
export function vaultContent(root: string): AnyFiles {
  const files = readFolder(root)
  for (const p of [...files.keys()]) if (/^(_templates|_schema)\//.test(p) || p === MANIFEST || p.startsWith('renders/')) files.delete(p)
  return files
}

const stateDir = (root: string) => path.join(root, PRINCIPIA_DIR)

function readLastManifest(root: string): Manifest | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(stateDir(root), LAST_MANIFEST), 'utf8')) as Manifest
  } catch {
    return null
  }
}

/** Keeps a passport zip as a future merge base, named by its digest (nothing under memory/ ever removes a vault file). */
function keepSnapshot(root: string, manifest: Manifest, zip: Uint8Array, asLast: boolean): void {
  const dir = path.join(stateDir(root), EXPORTS_DIR)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `${manifest.digest.slice(7, 23)}.passport.zip`), zip)
  if (asLast) fs.writeFileSync(path.join(stateDir(root), LAST_MANIFEST), manifestJson(manifest))
}

/** Keeps a bundle we received (an import or a pull) as a future merge base. */
export function rememberBundle(root: string, inc: IncomingPassport): void {
  if (inc.manifest) keepSnapshot(root, inc.manifest, writeZip(inc.files), false)
}

/** The snapshot with this digest (content only), or null. */
function snapshot(root: string, digest: string | null | undefined): AnyFiles | null {
  if (!digest) return null
  const file = path.join(stateDir(root), EXPORTS_DIR, `${digest.slice(7, 23)}.passport.zip`)
  try {
    const files = readPassport(file)
    for (const p of [...files.keys()]) if (p === MANIFEST || p.startsWith('renders/')) files.delete(p)
    return files
  } catch {
    return null
  }
}

/** A stable line id for a line the export adds (charter, agents), so repeated exports do not churn ids. */
const stableId = (key: string) => `f-${sha1(key).slice(0, 10)}`

// ---------- export ----------

export interface ExportResult {
  manifest: Manifest
  zip: Uint8Array
  files: AnyFiles
}

/**
 * Builds the company's Open Passport: vault notes (redacted), department notes with `slug`, `[does]`, `[does-not]` and
 * `[agent]` lines when the note does not say them itself, then passport.json and the renders.
 */
export function exportOpenPassport(host: OpenPassportHost, companyId: string, company: { name: string }, departments: ExportDepartment[]): ExportResult {
  const root = host.ensure(companyId)
  const files = vaultContent(root)
  for (const [p, v] of files) if (typeof v === 'string') files.set(p, host.redact(v))
  for (const d of departments) {
    const note = departmentNote(host.db, companyId, { id: d.id, name: d.name, passportNote: null })
    const text = note ? files.get(note.path) : undefined
    if (!note || typeof text !== 'string') continue
    let t = patch.setProperty(text, 'slug', d.key).text
    const cats = new Set(loadPassport(new Map([[note.path, t]])).notes[0]?.lines.map((l) => (l.line.kind === 'observation' ? l.line.category : '')) ?? [])
    const add = (category: string, line: string, key: string) => {
      if (!line.trim()) return
      t = patch.appendObservation(t, { category, text: host.redact(line.replace(/\s+/g, ' ').trim()), blockId: stableId(`${d.id}:${key}`) }).text
    }
    if (!cats.has('does')) add('does', d.charter.does, 'does')
    if (!cats.has('does-not')) add('does-not', d.charter.doesNot, 'does-not')
    if (!cats.has('agent')) for (const a of d.agents) add('agent', a.capabilities.trim() ? `${a.name}: ${a.capabilities}` : a.name, `agent:${a.name}`)
    files.set(note.path, t)
  }
  const prev = readLastManifest(root)
  if (prev) files.set(MANIFEST, manifestJson(prev))
  const { manifest, renders } = buildManifest(files, { now: host.now().toISOString(), generator: OPEN_PASSPORT_GENERATOR, name: company.name })
  files.delete(MANIFEST)
  const all: AnyFiles = new Map([...files, ...renders, [MANIFEST, manifestJson(manifest)]])
  const zip = writeZip(all)
  keepSnapshot(root, manifest, zip, true)
  return { manifest, zip, files: all }
}

// ---------- reading an incoming passport ----------

export interface IncomingPassport {
  source: string
  files: AnyFiles
  model: PassportModel
  manifest: Manifest | null
  errors: string[]
  warnings: string[]
}

export function readIncoming(source: string): IncomingPassport {
  return incomingFromFiles(readPassport(source), source)
}

/** An in-memory passport (a bundle pulled from a host) as an import source. */
export function incomingFromFiles(files: AnyFiles, source: string): IncomingPassport {
  const report = validate(files)
  const fmt = (i: { code: string; message: string; path?: string }) => `${i.code}${i.path ? ` ${i.path}` : ''}: ${i.message}`
  const errors = report.errors.filter((e) => BLOCKING.has(e.code)).map(fmt)
  const warnings = [...report.errors.filter((e) => !BLOCKING.has(e.code)), ...report.warnings].map(fmt)
  const model = loadPassport(textFiles(files))
  return { source, files, model, manifest: model.manifest, errors, warnings }
}

export function previewIncoming(inc: IncomingPassport): OpenPassportPreview {
  const m = inc.model
  let taste = 0
  for (const n of m.notes) for (const l of n.lines) if (l.line.kind === 'observation' && l.line.taste && l.section.toLowerCase() !== 'history') taste++
  return {
    source: inc.source,
    name: m.name,
    id: inc.manifest?.id ?? null,
    revision: inc.manifest?.revision ?? null,
    digest: inc.manifest?.digest ?? null,
    card: renderL0(m),
    departments: m.departments.map((d) => ({ slug: d.slug, name: d.name, does: charterText(d.note, 'does') })),
    notes: m.notes.length,
    taste,
    errors: inc.errors,
    warnings: inc.warnings.slice(0, 20)
  }
}

function charterText(note: PassportModel['notes'][number], category: 'does' | 'does-not'): string {
  return note.lines
    .filter((l) => l.line.kind === 'observation' && l.line.category === category && l.section.toLowerCase() !== 'history')
    .map((l) => (l.line.kind === 'observation' ? l.line.text : ''))
    .join('; ')
}

/** The company profile fields a card's lines fill (first line of each category). */
export function profileFromCard(m: PassportModel): Record<'mission' | 'brandVoice' | 'audience' | 'products' | 'goals' | 'context' | 'constraints', string> {
  const first = (cat: string) => {
    const l = m.card?.lines.find((x) => x.line.kind === 'observation' && x.line.category === cat && x.section.toLowerCase() !== 'history')
    return l && l.line.kind === 'observation' ? l.line.text.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, t: string, a?: string) => a ?? t) : ''
  }
  return { mission: first('mission'), brandVoice: first('brand'), audience: first('audience'), products: first('product'), goals: first('goal'), context: first('context'), constraints: first('constraint') }
}

/** Department charters as the import creates them. */
export function incomingDepartments(m: PassportModel): { slug: string; name: string; does: string; doesNot: string }[] {
  return m.departments.map((d) => ({ slug: d.slug, name: d.name, does: charterText(d.note, 'does').slice(0, 300), doesNot: charterText(d.note, 'does-not').slice(0, 300) }))
}

// ---------- mapping an incoming passport onto this vault ----------

const KNOWN_ACTORS = new Set<string>(ACTORS)

/** Provenance actors this vault does not know (another harness) are kept as `migration`, so the tail still parses. */
function normalizeActors(text: string): string {
  if (!/\(([a-z][a-z0-9_-]{0,31})(?: via suggestion [A-Za-z0-9_-]+)?(?: run#[A-Za-z0-9_-]+)?(?: session#[A-Za-z0-9_-]+)?, \d{4}-\d{2}-\d{2}\)/.test(text)) return text
  return text
    .split('\n')
    .map((line) => {
      const l = opParseLine(line)
      if (!l?.prov || KNOWN_ACTORS.has(l.prov.actor)) return line
      const at = line.lastIndexOf(`(${l.prov.actor}`)
      return at < 0 ? line : `${line.slice(0, at)}(migration${line.slice(at + 1 + l.prov.actor.length)}`
    })
    .join('\n')
}

function noteIdOf(text: string): string | null {
  const v = parseFrontmatter(text).entries.find((e) => e.key === 'id')?.value
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

function withId(text: string, id: string | null): string {
  if (!id) return text
  return patch.setProperty(text, 'id', id).text
}

/**
 * Renames incoming notes to where this vault keeps them: the card onto the hub, departments onto their department
 * notes (by `department_id`, else by name), the taste note onto `Taste.md`, other notes into their type folder under
 * their title; notes this vault already has (same title) keep our path and id, so the merge matches them.
 */
export function alignIncoming(db: IndexDB, companyId: string, companyName: string, inc: IncomingPassport, departmentIds: Map<string, string> = new Map()): AnyFiles {
  const out: AnyFiles = new Map()
  const m = inc.model
  const ours = db.prepare(`SELECT id, path, title, type, frontmatter_json FROM mem_note WHERE company_id = ? AND removed_at IS NULL`).all(companyId) as { id: string; path: string; title: string; type: string; frontmatter_json: string | null }[]
  const byTitle = new Map(ours.map((n) => [normName(n.title), n]))
  const hub = hubNote(db, companyId, companyName)
  const taken = new Set(ours.map((n) => n.path.toLowerCase()))
  const place = (p: string) => {
    let q = p
    for (let i = 2; taken.has(q.toLowerCase()); i++) q = p.replace(/\.md$/i, ` (${i}).md`)
    taken.add(q.toLowerCase())
    return q
  }
  for (const [p, v] of inc.files) {
    if (p === MANIFEST || p.startsWith('renders/')) continue
    if (typeof v !== 'string' || !/\.md$/i.test(p)) {
      out.set(p, v)
      continue
    }
    const note = m.notes.find((n) => n.path === p)
    let text = normalizeActors(v)
    if (!note) {
      out.set(p, text)
      continue
    }
    const target = ((): { path: string; id: string | null } | null => {
      if (note === m.card && hub) return { path: hub.path, id: hub.id }
      if (note.type === 'department') {
        const dep = m.departments.find((d) => d.note === note)
        const depId = (dep && departmentIds.get(dep.slug)) ?? null
        const row = depId ? departmentNote(db, companyId, { id: depId, name: note.title, passportNote: null }, { anyStatus: true }) : null
        const mine = row ?? (byTitle.get(normName(note.title))?.type === 'department' ? byTitle.get(normName(note.title))! : null)
        if (depId) text = patch.setProperty(text, 'department_id', depId).text
        return mine ? { path: mine.path, id: mine.id } : null
      }
      const same = byTitle.get(normName(note.title))
      if (same && (same.type === note.type || note === m.tasteNote)) return { path: same.path, id: same.id }
      return null
    })()
    if (target) {
      out.set(target.path, noteIdOf(text) === target.id ? text : withId(text, target.id))
      continue
    }
    const type = normalizeNoteType(note.type)
    const folder = note === m.tasteNote ? '' : TYPE_FOLDER[type]
    const rel = place(`${folder ? `${folder}/` : ''}${sanitizeFilename(note.title)}.md`)
    out.set(rel, text)
  }
  return out
}

// ---------- import: new company ----------

/** Writes an aligned passport into a fresh vault (seeded hub and department notes are replaced), then reindexes. */
export function writeNewVault(host: OpenPassportHost, companyId: string, files: AnyFiles, inc: IncomingPassport): number {
  const root = host.ensure(companyId)
  let n = 0
  for (const [rel, v] of files) {
    const abs = path.join(root, ...rel.split('/'))
    if (!abs.startsWith(root + path.sep)) continue
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    if (typeof v === 'string') host.expected.register(abs, sha1(v))
    fs.writeFileSync(abs, v)
    n++
  }
  host.reindex(companyId)
  if (inc.manifest) keepSnapshot(root, inc.manifest, writeZip(inc.files), true)
  return n
}

// ---------- import: merge into an existing company ----------

export interface MergeImportResult {
  updated: number
  created: number
  conflicts: number
  proposals: string[]
  stats: MergeStats
  /** true when a copy we exported or imported was found as the common base */
  based: boolean
}

/**
 * Three-way merges an incoming passport into the company's vault. Changed notes go through the writer's
 * compare-and-swap save (a line removed by theirs moves to History, never vanishes); new notes are written as files.
 * Conflicts keep ours and become `import_conflict` proposals whose accept applies theirs.
 */
export async function mergeIntoVault(
  host: OpenPassportHost,
  companyId: string,
  companyName: string,
  inc: IncomingPassport,
  departmentIds: Map<string, string>,
  opts: { baseDigest?: string | null } = {}
): Promise<MergeImportResult> {
  const root = host.ensure(companyId)
  const theirs = alignIncoming(host.db, companyId, companyName, inc, departmentIds)
  const ours = vaultContent(root)
  // a sync names its base (the host revision it last saw); an imported copy is based on what we exported
  const base = opts.baseDigest !== undefined ? snapshot(root, opts.baseDigest) : (snapshot(root, inc.manifest?.parent?.digest) ?? snapshot(root, inc.manifest?.digest))
  const r = merge3(base, ours, theirs)
  let updated = 0
  let created = 0
  for (const [rel, v] of r.files) {
    const before = ours.get(rel)
    // attachments are never overwritten: a new one is added, a changed one stays ours
    if (before !== undefined && (before === v || typeof v !== 'string')) continue
    const abs = path.join(root, ...rel.split('/'))
    if (!abs.startsWith(root + path.sep)) continue
    if (before === undefined) {
      if (fs.existsSync(abs)) continue
      fs.mkdirSync(path.dirname(abs), { recursive: true })
      if (typeof v === 'string') host.expected.register(abs, sha1(v))
      fs.writeFileSync(abs, v)
      created++
      continue
    }
    const state = readFileState(abs)
    if (!state || typeof v !== 'string') continue
    const res = await host.writer.save(companyId, { path: rel, baseHash: state.hash, text: v }, { actor: 'user' })
    if (res.status === 'saved') updated++
    else r.conflicts.push({ path: rel, kind: 'file', key: null, base: null, ours: null, theirs: null })
  }
  if (created) host.reindex(companyId)
  const proposals = fileConflicts(host, companyId, inc.manifest?.digest ?? 'unversioned', r.conflicts)
  rememberBundle(root, inc)
  return { updated, created, conflicts: r.conflicts.length, proposals, stats: r.stats, based: !!base }
}

/** One `import_conflict` proposal per conflict; accept applies theirs where an op can say it (a line, a property). */
function fileConflicts(host: OpenPassportHost, companyId: string, digest: string, conflicts: MergeConflict[]): string[] {
  const ids: string[] = []
  const at = host.now().toISOString()
  for (const c of conflicts) {
    const ops: VaultOp[] = []
    const note = pathStem(c.path)
    if (c.kind === 'line' && c.theirs && /^[f]-[0-9a-z]{10}$/.test(c.key ?? '')) {
      const t = parseBulletLine(c.theirs)
      if (t?.kind === 'observation') ops.push({ op: 'supersede', blockId: c.key!, text: t.text })
    } else if (c.kind === 'frontmatter' && c.theirs && c.key && !['id', 'type', 'title'].includes(c.key)) {
      const v = parseFrontmatter(`---\n${c.theirs}\n---\n`).entries[0]?.value
      if (v !== undefined) ops.push({ op: 'setProperty', note, key: c.key, value: Array.isArray(v) ? v : String(v) })
    }
    const quote = (s: string | null) => (s ?? '').slice(0, 400)
    const id = insertProposal(host.db, {
      companyId,
      kind: 'import_conflict',
      payload: ops,
      evidence: [
        { path: c.path, line: null, quote: `ours: ${quote(c.ours)}`, note },
        { path: c.path, line: null, quote: `theirs: ${quote(c.theirs)}`, note }
      ],
      score: 0.8,
      source: 'import',
      fingerprint: fingerprintOf(`import:${digest}:${c.path}:${c.kind}:${c.key ?? ''}`),
      baseHashes: {},
      createdAt: at
    })
    if (id) ids.push(id)
  }
  return ids
}
