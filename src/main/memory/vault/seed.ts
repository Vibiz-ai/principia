// Vault seeding (PASSPORT.md §2, §9 step 2). Creates what is missing and never overwrites anything: the type folders,
// the company hub note, `_schema/Relations.md`, `_templates/<Type>.md`, `.principia/vault.json`, and `.obsidian/`
// defaults only when the folder is absent (an existing Obsidian vault keeps its own settings, and Principia never
// writes `.obsidian/` afterwards).

import fs from 'node:fs'
import path from 'node:path'
import { DEPARTMENT_ID_KEY, DEPARTMENT_NOTE_SECTIONS, DEPARTMENT_NOTE_TYPE } from '../../../shared/passport'
import { NOTE_TYPES, TYPE_FOLDER } from '../../../shared/vault/grammar'
import { newNoteId } from '../../../shared/vault/ids'
import { renderOntologyNote } from '../../../shared/vault/ontology'
import { parseNote } from '../../../shared/vault/parse'
import { isoDate, renderNote, renderTemplate } from '../../../shared/vault/serialize'
import { sanitizeFilename, typeLabel, uniqueStem } from '../../../shared/vault/slug'
import { atomicWrite, walkNotes } from './fsutil'
import { VAULT_FORMAT_VERSION } from './indexSchema'
import { departmentNotePath, OBSIDIAN_DIR, PRINCIPIA_DIR, vaultFiles } from './paths'

export interface SeedInput {
  companyId: string
  /** Hub note title (the company name). */
  companyName: string
  summary?: string | null
  now?: Date
}

export interface SeedResult {
  root: string
  created: string[]
  /** Vault-relative path of the hub note (existing or new). */
  hubPath: string
  obsidianSeeded: boolean
}

/** Folders created on seed (§2 layout). */
export const SEED_FOLDERS = [
  'People',
  'Customers',
  'Offers',
  'Products',
  'Brand',
  'Repos',
  'Decisions',
  'Conventions',
  'Gotchas',
  'Processes',
  'Meetings',
  'Concepts',
  'Components',
  'Files',
  'Inbox',
  '_schema',
  '_templates'
]

/** `.obsidian/app.json`: shortest wikilinks, links updated on rename, Principia's folder hidden. */
export const OBSIDIAN_APP = {
  newLinkFormat: 'shortest',
  useMarkdownLinks: false,
  alwaysUpdateLinks: true,
  userIgnoreFilters: [`${PRINCIPIA_DIR}/`]
}

const FOLDER_COLORS: Array<[string, number]> = [
  ['People', 0x4f9dde],
  ['Customers', 0x43b581],
  ['Offers', 0xf2a33a],
  ['Products', 0xe8618c],
  ['Brand', 0xb57edc],
  ['Repos', 0x7a8899],
  ['Decisions', 0xe0b93e],
  ['Conventions', 0x5fb3b3],
  ['Gotchas', 0xe5534b],
  ['Processes', 0x8bc34a],
  ['Meetings', 0x9e9e9e],
  ['Concepts', 0x64b5f6],
  ['Inbox', 0xbdbdbd]
]

/** `.obsidian/graph.json`: colour groups by folder. */
export function obsidianGraphConfig(): Record<string, unknown> {
  return {
    colorGroups: FOLDER_COLORS.map(([folder, rgb]) => ({ query: `path:"${folder}"`, color: { a: 1, rgb } })),
    showTags: false,
    showAttachments: false,
    hideUnresolved: false
  }
}

/** Writes `abs` only when it does not exist. Returns true when created. */
function createIfAbsent(abs: string, text: string): boolean {
  if (fs.existsSync(abs)) return false
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  try {
    fs.writeFileSync(abs, text, { encoding: 'utf8', flag: 'wx' })
    return true
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw e
  }
}

/** Finds an existing `type: company` note (a vault the user brought may name its hub differently). */
function findHub(root: string): string | null {
  for (const f of walkNotes(root)) {
    if (f.rel.includes('/')) continue
    try {
      if (parseNote(fs.readFileSync(f.abs, 'utf8'), { path: f.rel }).type === 'company') return f.rel
    } catch {
      // unreadable: skip
    }
  }
  return null
}

/** Seeds a company vault. Idempotent: a second call creates nothing. */
export function seedVault(root: string, input: SeedInput): SeedResult {
  const now = input.now ?? new Date()
  const created: string[] = []
  const files = vaultFiles(root)
  const obsidianSeeded = !fs.existsSync(path.join(root, OBSIDIAN_DIR))
  fs.mkdirSync(root, { recursive: true })

  for (const folder of SEED_FOLDERS) {
    const abs = path.join(root, folder)
    if (!fs.existsSync(abs)) {
      fs.mkdirSync(abs, { recursive: true })
      created.push(`${folder}/`)
    }
  }

  // .obsidian is seeded once, as a whole, only when absent
  if (obsidianSeeded) {
    const dir = path.join(root, OBSIDIAN_DIR)
    fs.mkdirSync(dir, { recursive: true })
    if (createIfAbsent(path.join(dir, 'app.json'), `${JSON.stringify(OBSIDIAN_APP, null, 2)}\n`)) created.push(`${OBSIDIAN_DIR}/app.json`)
    if (createIfAbsent(path.join(dir, 'graph.json'), `${JSON.stringify(obsidianGraphConfig(), null, 2)}\n`)) created.push(`${OBSIDIAN_DIR}/graph.json`)
  }

  fs.mkdirSync(files.snapshots, { recursive: true })
  if (createIfAbsent(files.vaultJson, `${JSON.stringify({ companyId: input.companyId, formatVersion: VAULT_FORMAT_VERSION, createdAt: now.toISOString() }, null, 2)}\n`)) {
    created.push(`${PRINCIPIA_DIR}/vault.json`)
  }

  if (createIfAbsent(path.join(root, '_schema', 'Relations.md'), renderOntologyNote())) created.push('_schema/Relations.md')
  for (const type of NOTE_TYPES) {
    // the department template arrives with the first department note, so a vault without departments gains no file;
    // the taste note (Open Passport) is written by taste capture or an import, never as an empty template
    if (type === DEPARTMENT_NOTE_TYPE || type === 'taste') continue
    const rel = `_templates/${typeLabel(type)}.md`
    if (createIfAbsent(path.join(root, '_templates', `${typeLabel(type)}.md`), renderTemplate(type))) created.push(rel)
  }

  let hubPath = findHub(root)
  if (!hubPath) {
    const stem = sanitizeFilename(input.companyName || 'Company')
    hubPath = `${TYPE_FOLDER.company ? `${TYPE_FOLDER.company}/` : ''}${stem}.md`
    const text = renderNote({ id: newNoteId(), title: input.companyName || stem, type: 'company', created: isoDate(now), source: 'user', summary: input.summary ?? null })
    if (createIfAbsent(path.join(root, ...hubPath.split('/')), text)) created.push(hubPath)
  }
  return { root, created, hubPath, obsidianSeeded }
}

export interface DepartmentSeedInput {
  departmentId: string
  /** the department name: the note title */
  name: string
  /** link target of the company hub note (its filename stem) */
  companyLink: string
  /** charter "does": the note summary */
  summary?: string | null
  /** contextFallback (already redacted): the first observation, so the slot keeps saying what it said before the vault */
  context?: string | null
  /** basename keys already used by other notes (`Marketing` taken by a concept → `Marketing (Department).md`) */
  isTaken?: (key: string) => boolean
  now?: Date
}

/**
 * DEPARTMENTS.md §7: creates `Departments/<Name>.md` (`type: department`, `department_id`, `part_of [[Company]]`, the
 * sections Observations / Processes / Relations). Never overwrites: an existing file at the path is left as it is and
 * reported as not created. The caller checks the index first, so a renamed note is found by its `department_id`.
 */
export function seedDepartmentNote(root: string, input: DepartmentSeedInput): { path: string; created: boolean; text: string | null } {
  const now = input.now ?? new Date()
  const title = input.name.replace(/\s+/g, ' ').trim() || 'Department'
  const rel = departmentNotePath(uniqueStem(title, DEPARTMENT_NOTE_TYPE, input.isTaken ?? (() => false)))
  const date = isoDate(now)
  const context = input.context?.replace(/\s+/g, ' ').trim()
  const rendered = renderNote({
    id: newNoteId(),
    title,
    type: DEPARTMENT_NOTE_TYPE,
    properties: [[DEPARTMENT_ID_KEY, input.departmentId]],
    created: date,
    source: 'user',
    summary: input.summary ?? null,
    observations: context ? [{ category: 'context', text: context, prov: { actor: 'user', date } }] : [],
    relations: [{ rel: 'part_of', target: input.companyLink, prov: null }]
  })
  const text = withSections(rendered)
  const created = createIfAbsent(path.join(root, ...rel.split('/')), text)
  createIfAbsent(path.join(root, '_templates', `${typeLabel(DEPARTMENT_NOTE_TYPE)}.md`), renderTemplate(DEPARTMENT_NOTE_TYPE))
  return { path: rel, created, text: created ? text : null }
}

/** Adds the empty department headings renderNote omits, in the order Observations / Processes / Relations. */
function withSections(text: string): string {
  const lines = text.replace(/\n$/, '').split('\n')
  const at = (h: string) => lines.indexOf(`## ${h}`)
  for (const h of DEPARTMENT_NOTE_SECTIONS) {
    if (at(h) >= 0) continue
    const next = DEPARTMENT_NOTE_SECTIONS.slice(DEPARTMENT_NOTE_SECTIONS.indexOf(h) + 1).map(at).find((i) => i >= 0)
    if (next === undefined) lines.push('', `## ${h}`)
    else lines.splice(next, 0, `## ${h}`, '')
  }
  return `${lines.join('\n')}\n`
}

/** `.principia/vault.json`, or null when the folder is not a seeded vault. */
export function readVaultJson(root: string): { companyId: string; formatVersion: number; createdAt: string } | null {
  try {
    return JSON.parse(fs.readFileSync(vaultFiles(root).vaultJson, 'utf8'))
  } catch {
    return null
  }
}

/** Rewrites vault.json for a vault adopted by another company id ("Use existing folder…"). */
export function writeVaultJson(root: string, companyId: string, now = new Date()): void {
  const prev = readVaultJson(root)
  atomicWrite(vaultFiles(root).vaultJson, `${JSON.stringify({ companyId, formatVersion: VAULT_FORMAT_VERSION, createdAt: prev?.createdAt ?? now.toISOString() }, null, 2)}\n`)
}
