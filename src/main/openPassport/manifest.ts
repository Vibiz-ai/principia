// Vendored from open-passport 0.1.0 (packages/js/src/core/manifest.ts). Do not edit here: change it upstream and re-run scripts/vendor.mjs.
// passport.json (SPEC.md §5): the manifest, content digest and precomputed tier renders.
import { loadPassport, isNotePath, type Files } from './passport'
import { parseNote } from './note'
import { estimateTokens, renderL0, renderL1, TIER_BUDGETS, utf8Length } from './render'
import { sha256Hex, utf8 } from './sha256'
import { cpCompare } from './grammar'

export const SPEC_VERSION = '0.1.0'
export const MANIFEST = 'passport.json'
export const RENDERS_DIR = 'renders'
export const L0_PATH = 'renders/l0.md'
export const l1Path = (slug: string) => `renders/departments/${slug}.l1.md`
export const TOKEN_ESTIMATOR = 'utf8_bytes/4'

export interface ManifestFile {
  path: string
  /** note type for `.md` notes, null for attachments */
  type: string | null
  sha256: string
  bytes: number
  tokens: number
}
export interface ManifestRender {
  path: string
  sha256: string
  bytes: number
  tokens: number
  budget_tokens: number
}
export interface ManifestDepartment {
  slug: string
  name: string
  path: string
  /** the L1 render path */
  render: string
  tokens: number
}
export interface Manifest {
  open_passport: string
  id: string
  name: string
  /** monotonic content revision: +1 whenever `digest` changes */
  revision: number
  created: string
  updated: string
  /** `sha256:<hex>` over the content files (SPEC.md §5.3) */
  digest: string
  parent: { revision: number; digest: string } | null
  origin: { generator: string; host?: string | null; url?: string | null; fork_of?: string | null }
  card: string | null
  taste: string | null
  departments: ManifestDepartment[]
  renders: {
    estimator: string
    /** the digest the renders were computed from; renders are stale when it differs from `digest` */
    source_digest: string
    l0: ManifestRender
    departments: Record<string, ManifestRender>
  }
  files: ManifestFile[]
  tokens: { l0: number; l1_max: number; notes: number }
}

export type AnyFiles = Map<string, string | Uint8Array>

const bytesOf = (v: string | Uint8Array) => (typeof v === 'string' ? utf8(v) : v)

/** Content files: everything but the manifest, the renders and dot paths. */
export function isContentPath(p: string): boolean {
  return p !== MANIFEST && !p.startsWith(`${RENDERS_DIR}/`) && !/(^|\/)\./.test(p)
}

/** SPEC.md §5.3: sha256 over `<sha256>  <path>\n` of every content file, sorted by path (byte order). */
export function contentDigest(files: AnyFiles): string {
  const lines = [...files.keys()]
    .filter(isContentPath)
    .sort(byteOrder)
    .map((p) => `${sha256Hex(bytesOf(files.get(p)!))}  ${p}\n`)
  return `sha256:${sha256Hex(lines.join(''))}`
}

/** Paths sort in UTF-8 byte order, which is Unicode code point order. */
export const byteOrder = cpCompare

export function textFiles(files: AnyFiles): Files {
  const out: Files = new Map()
  const dec = new TextDecoder()
  for (const [p, v] of files) if (/\.(md|json|txt)$/i.test(p)) out.set(p, typeof v === 'string' ? v : dec.decode(v))
  return out
}

export interface BuildOptions {
  /** ISO timestamp for created/updated */
  now: string
  generator?: string
  /** passport id for a new manifest (an existing manifest keeps its own) */
  id?: string
  name?: string
  origin?: Partial<Manifest['origin']>
}

const renderEntry = (path: string, text: string, budget: number): ManifestRender => ({ path, sha256: sha256Hex(text), bytes: utf8Length(text), tokens: estimateTokens(text), budget_tokens: budget })

/**
 * Builds passport.json and the tier renders for a set of files (the previous passport.json, if any, gives id, revision,
 * created and origin). Returns the manifest and the render files to write next to it.
 */
export function buildManifest(files: AnyFiles, opts: BuildOptions): { manifest: Manifest; renders: Map<string, string> } {
  let prev: Manifest | null = null
  const pj = files.get(MANIFEST)
  if (pj) {
    try {
      prev = JSON.parse(typeof pj === 'string' ? pj : new TextDecoder().decode(pj)) as Manifest
    } catch {
      prev = null
    }
  }
  const text = textFiles(files)
  // roles come from note types: drop the previous manifest's pointers so renamed or new notes are picked up
  text.delete(MANIFEST)
  const model = loadPassport(text)
  const name = opts.name ?? prev?.name ?? model.name
  model.name = name
  const digest = contentDigest(files)
  const renders = new Map<string, string>()
  const l0 = renderL0(model)
  renders.set(L0_PATH, l0)
  const depRenders: Record<string, ManifestRender> = {}
  const departments: ManifestDepartment[] = []
  for (const d of model.departments) {
    const r = renderL1(model, d)
    const path = l1Path(d.slug)
    renders.set(path, r)
    depRenders[d.slug] = renderEntry(path, r, TIER_BUDGETS.l1)
    departments.push({ slug: d.slug, name: d.name, path: d.note.path, render: path, tokens: estimateTokens(r) })
  }
  const list: ManifestFile[] = [...files.keys()]
    .filter(isContentPath)
    .sort(byteOrder)
    .map((p) => {
      const b = bytesOf(files.get(p)!)
      return { path: p, type: isNotePath(p) ? parseNote(p, text.get(p) ?? '').type : null, sha256: sha256Hex(b), bytes: b.length, tokens: Math.ceil(b.length / 4) }
    })
  const changed = !prev || prev.digest !== digest
  const manifest: Manifest = {
    open_passport: SPEC_VERSION,
    id: prev?.id ?? opts.id ?? `op-${sha256Hex(`${name}\u0000${opts.now}`).slice(0, 16)}`,
    name,
    revision: prev ? (changed ? prev.revision + 1 : prev.revision) : 1,
    created: prev?.created ?? opts.now,
    updated: changed ? opts.now : prev!.updated,
    digest,
    parent: prev ? (changed ? { revision: prev.revision, digest: prev.digest } : prev.parent) : null,
    origin: { generator: opts.generator ?? 'open-passport-js', ...(prev?.origin ?? {}), ...(opts.origin ?? {}) },
    card: model.card?.path ?? null,
    taste: model.tasteNote?.path ?? null,
    departments,
    renders: { estimator: TOKEN_ESTIMATOR, source_digest: digest, l0: renderEntry(L0_PATH, l0, TIER_BUDGETS.l0), departments: depRenders },
    files: list,
    tokens: {
      l0: estimateTokens(l0),
      l1_max: Math.max(0, ...departments.map((d) => d.tokens)),
      notes: list.filter((f) => f.type !== null).reduce((s, f) => s + f.tokens, 0)
    }
  }
  if (opts.generator) manifest.origin.generator = opts.generator
  return { manifest, renders }
}

/** Stable JSON: two-space indent, trailing newline. */
export function manifestJson(m: Manifest): string {
  return `${JSON.stringify(m, null, 2)}\n`
}
