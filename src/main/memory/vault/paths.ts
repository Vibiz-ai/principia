// Vault and index locations (PASSPORT.md §2). The vault root is `<userData>/companies/<slug>/Passport`
// unless `company_passports.vault_path` overrides it; the index lives outside every vault so Obsidian
// Sync and iCloud never carry it. Everything Principia owns inside a vault sits under `.principia/`.

import path from 'node:path'
import { DEPARTMENT_NOTE_FOLDER } from '../../../shared/passport'
import { isIgnoredVaultPath } from '../../../shared/vault/slug'

export const INDEX_DB_FILE = 'passport-index.db'
export const PRINCIPIA_DIR = '.principia'
export const OBSIDIAN_DIR = '.obsidian'

/** `<userData>/passport-index.db`: one file for every company (company_id on every row). */
export function indexDbPath(userData: string): string {
  return path.join(userData, INDEX_DB_FILE)
}

/** Default vault root for a company slug (Personal is `companies/personal/Passport`). */
export function defaultVaultRoot(userData: string, slug: string): string {
  return path.join(userData, 'companies', slug, 'Passport')
}

export interface VaultFiles {
  root: string
  principia: string
  vaultJson: string
  writerLock: string
  log: string
  snapshots: string
  migrationJson: string
}

export function vaultFiles(root: string): VaultFiles {
  const principia = path.join(root, PRINCIPIA_DIR)
  return {
    root,
    principia,
    vaultJson: path.join(principia, 'vault.json'),
    writerLock: path.join(principia, 'writer.lock'),
    log: path.join(principia, 'log.jsonl'),
    snapshots: path.join(principia, 'snapshots'),
    migrationJson: path.join(principia, 'migration.json')
  }
}

/** Snapshot file for a note key: `n-x.md` for real ids, `h-<hash>.md` for path-keyed notes. */
export function snapshotFile(root: string, noteKey: string, keyHash: (s: string) => string): string {
  const name = /^n-[0-9a-z]{10}$/.test(noteKey) ? noteKey : `h-${keyHash(noteKey).slice(0, 20)}`
  return path.join(vaultFiles(root).snapshots, `${name}.md`)
}

/** Vault-relative, `/`-separated path. Throws when `abs` is outside the vault. */
export function toVaultRel(root: string, abs: string): string {
  const rel = path.relative(root, abs)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`${abs} is outside the vault`)
  return rel.split(path.sep).join('/')
}

/** Absolute path for a vault-relative path. Refuses `..`, absolute paths and empty segments. */
export function toVaultAbs(root: string, rel: string): string {
  const clean = rel.replace(/\\/g, '/')
  const segs = clean.split('/')
  if (!clean || clean.startsWith('/') || /^[A-Za-z]:/.test(clean) || segs.some((s) => s === '..' || s === '.' || s === '')) {
    throw new Error(`"${rel}" is not a vault-relative path`)
  }
  return path.join(root, ...segs)
}

// Sync-tool conflict copies are never indexed (§6.3): Dropbox / Obsidian Sync "(… conflicted copy …)",
// Syncthing ".sync-conflict-…", Nextcloud "(conflicted copy …)", Google Drive / OneDrive "-conflict-".
const CONFLICT_COPY_RE = /conflicted copy|\.sync-conflict-|\(conflict\)|-conflict-\d|\bconflict \d{4}-\d{2}-\d{2}/i

export function isConflictCopy(rel: string): boolean {
  return CONFLICT_COPY_RE.test(rel.split('/').pop() ?? rel)
}

/** Scaffolding folders Principia seeds: the ontology note and templates are read as files, never indexed as notes. */
export const SYSTEM_FOLDERS = ['_schema', '_templates']

/** True for a vault-relative path the indexer owns: `*.md`, outside dot-folders and `_schema/` `_templates/`, not a conflict copy. */
export function isNotePath(rel: string): boolean {
  const name = rel.split('/').pop() ?? ''
  if (!/\.md$/i.test(name) || name.startsWith('.')) return false
  if (rel.includes('/') && SYSTEM_FOLDERS.includes(rel.split('/')[0])) return false
  return !isIgnoredVaultPath(rel) && !isConflictCopy(rel)
}

/** `Departments/<stem>.md`: where a department's passport note lives (DEPARTMENTS.md §7). `stem` is already a safe filename. */
export function departmentNotePath(stem: string): string {
  return `${DEPARTMENT_NOTE_FOLDER}/${stem}.md`
}

/** iCloud Drive folders lag under fs.watch; the UI warns (§6.3). */
export function isOnICloud(root: string): boolean {
  return /\/Library\/Mobile Documents\//.test(root.split(path.sep).join('/'))
}
