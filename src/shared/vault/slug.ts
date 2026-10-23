// Note filenames (PASSPORT.md §2). The title with `# | ^ : [ ] \ / * " < > ?` replaced by `-`;
// `title:` keeps the original. Basenames are unique per vault (case-insensitive, like macOS and
// Obsidian's shortest-path links); on a collision the type is suffixed: `Mercury (Customer).md`.

import { type NoteType, TYPE_FOLDER, normalizeNoteType } from './grammar'
import { normName } from './resolve'

const FORBIDDEN_RE = /[#|^:[\]\\/*"<>?]/g
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/g
const WINDOWS_RESERVED_RE = /^(con|prn|aux|nul|com\d|lpt\d)$/i
/** UTF-8 bytes; leaves room for ` (Customer) 12.md` within the 255-byte name limit of APFS/ext4. */
const MAX_STEM_BYTES = 180
const utf8 = new TextEncoder()

/** Cuts whole code points until the UTF-8 encoding fits `max` bytes. */
function truncateBytes(s: string, max: number): string {
  if (utf8.encode(s).length <= max) return s
  let out = ''
  let bytes = 0
  for (const ch of s) {
    const n = utf8.encode(ch).length
    if (bytes + n > max) break
    out += ch
    bytes += n
  }
  return out
}

/** Filename stem for a title (no folder, no `.md`). Never empty. */
export function sanitizeFilename(title: string): string {
  let s = title.normalize('NFC').replace(CONTROL_RE, ' ').replace(FORBIDDEN_RE, '-').replace(/\s+/g, ' ').trim()
  s = s.replace(/^\.+/, '').replace(/[.\s]+$/, '')
  const cut = truncateBytes(s, MAX_STEM_BYTES)
  if (cut !== s) s = cut.replace(/[.\s]+$/, '')
  if (WINDOWS_RESERVED_RE.test(s)) s = `${s}-`
  return s || 'Untitled'
}

/** `customer` -> `Customer`. */
export function typeLabel(type: NoteType | string): string {
  const t = normalizeNoteType(type)
  return t.charAt(0).toUpperCase() + t.slice(1)
}

export function defaultFolder(type: NoteType | string): string {
  return TYPE_FOLDER[normalizeNoteType(type)]
}

export function joinNotePath(folder: string, stem: string): string {
  const f = folder.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  return f ? `${f}/${stem}.md` : `${stem}.md`
}

/**
 * A basename stem unique in the vault: the sanitized title, then `Title (Type)`, then `Title (Type) 2`…
 * `isTaken` receives a normalized stem (see `stemKey`).
 */
export function uniqueStem(title: string, type: NoteType | string, isTaken: (key: string) => boolean): string {
  const base = sanitizeFilename(title)
  if (!isTaken(stemKey(base))) return base
  const typed = `${base} (${typeLabel(type)})`
  if (!isTaken(stemKey(typed))) return typed
  for (let n = 2; ; n++) {
    const cand = `${typed} ${n}`
    if (!isTaken(stemKey(cand))) return cand
  }
}

/** Case-insensitive basename key (matches `normName(pathStem(path))` in resolve.ts). */
export function stemKey(stem: string): string {
  return normName(stem)
}

/** Vault-relative path for a new note: default folder from the type unless one is given. */
export function pathForNewNote(
  note: { title: string; type: NoteType | string; folder?: string | null },
  isTaken: (key: string) => boolean
): string {
  const folder = note.folder ?? defaultFolder(note.type)
  return joinNotePath(folder, uniqueStem(note.title, note.type, isTaken))
}

/** True when a vault-relative path is inside a folder Principia and Obsidian never index. */
export function isIgnoredVaultPath(path: string): boolean {
  return path
    .replace(/\\/g, '/')
    .split('/')
    .slice(0, -1)
    .some((seg) => seg.startsWith('.'))
}
