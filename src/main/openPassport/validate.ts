// Vendored from open-passport 0.1.0 (packages/js/src/core/validate.ts). Do not edit here: change it upstream and re-run scripts/vendor.mjs.
// Validation (SPEC.md §11 conformance): manifest, hashes, renders, notes, taste evidence, security screens.
import { LINE_ID_RE } from './grammar'
import { contentDigest, isContentPath, MANIFEST, SPEC_VERSION, textFiles, type AnyFiles, type Manifest } from './manifest'
import { isNotePath, loadPassport } from './passport'
import { estimateTokens, TIER_BUDGETS } from './render'
import { sha256Hex, utf8 } from './sha256'
import { ALLOWED_EXT, credentialHit, executableHit, imperativeHit, MAX_FILE_BYTES, MAX_FILES, MAX_TOTAL_BYTES, safeRelPath } from './screen'

export interface Issue {
  code: string
  message: string
  path?: string
  line?: number
}
export interface ValidationReport {
  ok: boolean
  errors: Issue[]
  warnings: Issue[]
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** Structural check of passport.json against schema/manifest.schema.json (required keys and types). */
export function checkManifestShape(m: unknown): string[] {
  const errs: string[] = []
  if (!isObj(m)) return ['passport.json is not an object']
  const str = (k: string) => typeof m[k] === 'string' || errs.push(`${k} must be a string`)
  for (const k of ['open_passport', 'id', 'name', 'created', 'updated', 'digest']) str(k)
  if (typeof m.open_passport === 'string' && m.open_passport.split('.')[0] !== SPEC_VERSION.split('.')[0]) errs.push(`unsupported open_passport major version ${m.open_passport}`)
  if (!Number.isInteger(m.revision) || (m.revision as number) < 1) errs.push('revision must be an integer >= 1')
  if (typeof m.digest === 'string' && !/^sha256:[0-9a-f]{64}$/.test(m.digest)) errs.push('digest must be sha256:<64 hex>')
  if (m.parent !== null && !(isObj(m.parent) && Number.isInteger(m.parent.revision) && typeof m.parent.digest === 'string')) errs.push('parent must be null or {revision, digest}')
  if (!isObj(m.origin) || typeof m.origin.generator !== 'string') errs.push('origin.generator must be a string')
  if (m.card !== null && typeof m.card !== 'string') errs.push('card must be a path or null')
  if (m.taste !== null && typeof m.taste !== 'string') errs.push('taste must be a path or null')
  if (!Array.isArray(m.departments) || !m.departments.every((d) => isObj(d) && typeof d.slug === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(d.slug) && typeof d.path === 'string' && typeof d.render === 'string'))
    errs.push('departments must be [{slug, name, path, render, tokens}] with lowercase slugs')
  if (!isObj(m.renders) || !isObj(m.renders.l0) || !isObj(m.renders.departments) || typeof m.renders.source_digest !== 'string') errs.push('renders must hold l0, departments and source_digest')
  if (!Array.isArray(m.files) || !m.files.every((f) => isObj(f) && typeof f.path === 'string' && typeof f.sha256 === 'string' && Number.isInteger(f.bytes))) errs.push('files must be [{path, type, sha256, bytes, tokens}]')
  return errs
}

/** Validates a passport (folder contents or an unpacked zip). `ok` is false when any error is reported. */
export function validate(files: AnyFiles): ValidationReport {
  const errors: Issue[] = []
  const warnings: Issue[] = []
  const err = (code: string, message: string, path?: string, line?: number) => errors.push({ code, message, ...(path ? { path } : {}), ...(line !== undefined ? { line } : {}) })
  const warn = (code: string, message: string, path?: string, line?: number) => warnings.push({ code, message, ...(path ? { path } : {}), ...(line !== undefined ? { line } : {}) })

  // files: paths, types, sizes
  if (files.size > MAX_FILES) err('too_many_files', `more than ${MAX_FILES} files`)
  let total = 0
  for (const [p, v] of files) {
    const n = typeof v === 'string' ? utf8(v).length : v.length
    total += n
    if (!safeRelPath(p)) err('unsafe_path', 'path is absolute, escapes the passport or is malformed', p)
    if (!ALLOWED_EXT.test(p) && p !== MANIFEST) err('disallowed_type', 'file type not allowed in a passport', p)
    if (n > MAX_FILE_BYTES) err('file_too_large', `over ${MAX_FILE_BYTES} bytes`, p)
  }
  if (total > MAX_TOTAL_BYTES) err('passport_too_large', `over ${MAX_TOTAL_BYTES} bytes in total`)

  // manifest
  const text = textFiles(files)
  let manifest: Manifest | null = null
  const mj = text.get(MANIFEST)
  if (!mj) err('manifest_missing', 'passport.json is missing')
  else {
    try {
      const parsed = JSON.parse(mj) as unknown
      const shape = checkManifestShape(parsed)
      for (const s of shape) err('manifest_invalid', s, MANIFEST)
      if (!shape.length) manifest = parsed as Manifest
    } catch (e) {
      err('manifest_invalid', `not JSON: ${e instanceof Error ? e.message : String(e)}`, MANIFEST)
    }
  }
  if (manifest) {
    const listed = new Set<string>()
    for (const f of manifest.files) {
      listed.add(f.path)
      const v = files.get(f.path)
      if (v === undefined) err('file_missing', 'listed in passport.json but absent', f.path)
      else if (sha256Hex(typeof v === 'string' ? utf8(v) : v) !== f.sha256) err('hash_mismatch', 'sha256 differs from passport.json', f.path)
    }
    for (const p of files.keys()) if (isContentPath(p) && !listed.has(p)) warn('file_unlisted', 'content file not listed in passport.json', p)
    const digest = contentDigest(files)
    if (digest !== manifest.digest) err('digest_mismatch', 'content digest differs from passport.json', MANIFEST)
    if (manifest.renders.source_digest !== manifest.digest) warn('renders_stale', 'renders were computed from older content; rebuild them', MANIFEST)
    const renders = [manifest.renders.l0, ...Object.values(manifest.renders.departments)]
    for (const r of renders) {
      const t = text.get(r.path)
      if (t === undefined) {
        err('render_missing', 'declared render is absent', r.path)
        continue
      }
      if (sha256Hex(t) !== r.sha256) err('hash_mismatch', 'render sha256 differs from passport.json', r.path)
      const budget = r === manifest.renders.l0 ? TIER_BUDGETS.l0 : TIER_BUDGETS.l1
      if (estimateTokens(t) > budget) err('render_over_budget', `${estimateTokens(t)} tokens > ${budget}`, r.path)
    }
    for (const d of manifest.departments) {
      if (!files.has(d.path)) err('file_missing', `department ${d.slug} note is absent`, d.path)
      if (!manifest.renders.departments[d.slug]) err('render_missing', `no L1 render for department ${d.slug}`, MANIFEST)
    }
    if (manifest.card && !files.has(manifest.card)) err('file_missing', 'card note is absent', manifest.card)
  }

  // notes
  const model = loadPassport(text)
  if (!model.card) err('card_missing', 'no company card (a note with type: company)')
  const ids = new Map<string, string>()
  const noteIds = new Map<string, string>()
  for (const n of model.notes) {
    if (n.id) {
      if (noteIds.has(n.id)) err('duplicate_note_id', `note id ${n.id} also used by ${noteIds.get(n.id)}`, n.path)
      noteIds.set(n.id, n.path)
    }
    for (const { line, index } of n.lines) {
      if (line.id) {
        if (!LINE_ID_RE.test(line.id)) err('bad_line_id', `line id ${line.id}`, n.path, index + 1)
        const at = `${n.path}:${index + 1}`
        if (ids.has(line.id)) err('duplicate_line_id', `^${line.id} also at ${ids.get(line.id)}`, n.path, index + 1)
        ids.set(line.id, at)
      }
      if (line.kind === 'observation' && line.taste && !line.taste.examples.length) warn('taste_missing_example', 'taste lines need evidence: (example: [[Note]] or "quote")', n.path, index + 1)
    }
  }
  const slugs = new Set<string>()
  for (const d of model.departments) {
    if (slugs.has(d.slug)) err('duplicate_department', `department slug ${d.slug} used twice`, d.note.path)
    slugs.add(d.slug)
  }

  // security screens over every text file
  for (const [p, t] of text) {
    const lines = t.split(/\r?\n/)
    lines.forEach((l, i) => {
      const c = credentialHit(l)
      if (c) err('secret', `${c} in content`, p, i + 1)
      const x = executableHit(l)
      if (x) err('executable_content', x, p, i + 1)
      const imp = isNotePath(p) ? imperativeHit(l) : null
      if (imp) warn('imperative_content', `${imp}: quarantine or rephrase`, p, i + 1)
    })
  }
  return { ok: errors.length === 0, errors, warnings }
}
