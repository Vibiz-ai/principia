/**
 * Logo detection from a company's repositories. Pure Node (no Electron), so it is unit-tested over temp folders.
 *
 * Where it looks: a bounded walk of each repo (depth ≤ 5, ≤ 6000 entries, a time budget) that skips dependency and
 * build output, keeping image files whose name or folder says "logo / brand / icon" (logo*.svg, brand/…, icon.png,
 * Next's app/icon.* and app/apple-icon.*, favicon.*, apple-touch-icon*, android-chrome-*), plus the icons listed in a
 * site.webmanifest / manifest.json and the first local image of the README.
 *
 * How it ranks (`scoreCandidate`): the name first (logo/brand, or the repo or company name, over app icons, over
 * favicons), then the format (svg > png > webp > jpg > ico), the size (≥ 128 px over tiny), the shape (square-ish
 * over wide wordmarks), and a little for the usual folders (public/, app/, assets/) and for shallow paths.
 * Social cards, screenshots, heroes and backgrounds are dropped. `confident` (score ≥ AUTO_SCORE) is what the app
 * applies on its own; anything else waits for the picker.
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export const IMAGE_EXTS = ['svg', 'png', 'webp', 'jpg', 'jpeg', 'ico', 'gif'] as const
export type ImageExt = (typeof IMAGE_EXTS)[number]
export const MIME: Record<ImageExt, string> = {
  svg: 'image/svg+xml', png: 'image/png', webp: 'image/webp', jpg: 'image/jpeg', jpeg: 'image/jpeg', ico: 'image/x-icon', gif: 'image/gif'
}
/** a candidate over this is skipped (and a picked file refused) */
export const MAX_LOGO_BYTES = 4 * 1024 * 1024
/** the score at which the best candidate is used without asking */
export const AUTO_SCORE = 70

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', '.next', '.nuxt', '.output', '.svelte-kit', '.turbo', '.vercel',
  '.netlify', '.cache', '.parcel-cache', 'coverage', 'vendor', 'target', 'Pods', 'DerivedData', '.venv', 'venv', '__pycache__',
  'tmp', '.tmp', 'storybook-static', '.expo', '.gradle', 'bower_components', 'jspm_packages', '.yarn', '.pnpm-store',
  'release', 'releases', 'test-results', 'playwright-report', '__snapshots__', 'fixtures', '__fixtures__', 'e2e', 'cypress'
])
/** out-cloud/, dist-electron/, build_web/…: build output by another name */
const OUTPUT_PREFIX = /^(out|dist|build)[-_.]/i
/** folders whose every image counts as a brand asset */
const BRAND_DIRS = /^(brand|branding|brand-assets|logo|identity|press-kit|presskit)$/i
/** folders of OTHER companies' logos (integrations, partners, customers): only the company's own name counts there */
const THIRD_PARTY_DIRS = /^(logos|partners|partner|integrations|integration|clients|customers|sponsors|providers|brands|companies|tools|vendors|third-party|social|payments|connections)$/i
/** build output we still read one file of: electron-builder's app icon */
const PROBES = ['build/icon.png', 'build/icon.svg', 'build/appicon.png']
/** the usual homes of a site's logo */
const LIKELY_DIRS = new Set(['public', 'static', 'assets', 'app', 'src', 'images', 'img', 'icons', 'media', 'resources', 'www', 'web'])
/** never a logo even when named like one */
const REJECT = /(^|[-_.\s])(og|opengraph|open-graph|twitter|social|screenshot|screen|banner|hero|placeholder|preview|cover|splash|poster|thumbnail|thumb|sprite|loading|spinner|example|sample|demo|mock|test|ad|ads|creative|campaign|post|story|mockup)([-_.\s\d]|$)/i
const LOGO_NAME = /logo|wordmark|logotype|emblem|(^|[-_. ])brand(mark|ing)?([-_. ](logo|mark|icon)|$)/i
const APP_ICON = /^(icon|app-icon|appicon|app_icon|apple-icon|apple-touch-icon.*|android-chrome.*|android-icon.*|mstile.*|pwa-.*|maskable.*|icon[-_]?\d+.*|icon[-_](light|dark|white|black|192|512).*)$/i
const FAVICON = /^favicon.*$/i
const MANIFESTS = new Set(['site.webmanifest', 'manifest.webmanifest', 'manifest.json'])

export interface RepoRoot {
  /** shown in labels ("vibiz/public/logo.svg") */
  name: string
  path: string
}
export interface DetectOptions {
  /** extra names that count as the brand (the company name) */
  brandNames?: string[]
  maxDepth?: number
  maxEntries?: number
  /** wall-clock budget per repository */
  budgetMs?: number
  now?: () => number
}
export interface DetectedLogo {
  path: string
  repo: string
  /** path inside the repo, '/'-separated */
  rel: string
  ext: ImageExt
  bytes: number
  width: number | null
  height: number | null
  /** listed in a web manifest / the README's first image */
  hints: ('manifest' | 'readme')[]
  score: number
  confident: boolean
}

// ---------- image sizes (header sniffing; no decoding) ----------
/** Width and height from the file header for png/gif/jpeg/webp/ico/svg; null when unknown. */
export function imageSize(buf: Buffer, ext: ImageExt): { width: number; height: number } | null {
  try {
    if (ext === 'svg') return svgSize(buf.toString('utf8', 0, Math.min(buf.length, 4096)))
    if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47) return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
    if (buf.length >= 10 && buf.toString('ascii', 0, 3) === 'GIF') return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) }
    if (buf.length >= 6 && buf.readUInt16LE(0) === 0 && buf.readUInt16LE(2) === 1) {
      // ICO: the largest entry (0 means 256)
      const n = buf.readUInt16LE(4)
      let best = 0
      for (let i = 0; i < n && 6 + i * 16 + 2 <= buf.length; i++) best = Math.max(best, buf[6 + i * 16] || 256)
      return best ? { width: best, height: best } : null
    }
    if (buf.length >= 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
      const kind = buf.toString('ascii', 12, 16)
      if (kind === 'VP8X') return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) }
      if (kind === 'VP8 ') return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff }
      if (kind === 'VP8L') {
        const b = buf.readUInt32LE(21)
        return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 }
      }
    }
    if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
      let i = 2
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) return null
        const marker = buf[i + 1]!
        const len = buf.readUInt16BE(i + 2)
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) }
        i += 2 + len
      }
    }
  } catch {
    /* truncated header */
  }
  return null
}
function svgSize(head: string): { width: number; height: number } | null {
  const tag = head.match(/<svg\b[^>]*>/i)?.[0]
  if (!tag) return null
  const vb = tag.match(/viewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i)
  if (vb) return { width: Number(vb[1]), height: Number(vb[2]) }
  const w = tag.match(/\bwidth\s*=\s*["']?\s*([\d.]+)(px)?["'\s>]/i)
  const h = tag.match(/\bheight\s*=\s*["']?\s*([\d.]+)(px)?["'\s>]/i)
  return w && h ? { width: Number(w[1]), height: Number(h[1]) } : null
}

// ---------- ranking ----------
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
/** What kind of name: 'logo' (logo/brand/repo name), 'icon' (app icon), 'favicon', or null (not a logo by name). */
export function nameKind(rel: string, brandNames: string[] = []): 'logo' | 'brand' | 'icon' | 'favicon' | null {
  const parts = rel.split('/')
  const file = parts[parts.length - 1]!
  const stem = file.replace(/\.[^.]+$/, '')
  if (REJECT.test(stem)) return null
  const n = norm(stem)
  const brands = brandNames.map(norm).filter((b) => b.length >= 3)
  const own = brands.some((b) => n.includes(b))
  // someone else's logo in an integrations / partners folder
  if (!own && parts.slice(0, -1).some((d) => THIRD_PARTY_DIRS.test(d))) return null
  if (LOGO_NAME.test(stem)) return 'logo'
  if (brands.some((b) => n === b || n === `${b}icon` || n === `${b}mark`)) return 'brand'
  if (parts.slice(0, -1).some((d) => BRAND_DIRS.test(d))) return 'logo'
  if (FAVICON.test(stem)) return 'favicon'
  if (APP_ICON.test(stem)) return 'icon'
  return null
}

export function scoreCandidate(c: Pick<DetectedLogo, 'rel' | 'ext' | 'width' | 'height' | 'hints' | 'bytes'>, brandNames: string[] = []): number {
  const kind = nameKind(c.rel, brandNames)
  const hinted = c.hints.length > 0
  if (!kind && !hinted) return 0
  let s = kind === 'logo' ? 60 : kind === 'brand' ? 55 : kind === 'icon' ? 38 : kind === 'favicon' ? 30 : 20
  const stem = c.rel.split('/').pop()!.replace(/\.[^.]+$/, '')
  // logo AND the brand name ("vibiz-logo", "logo-vibiz") is as sure as it gets
  if (kind === 'logo' && brandNames.map(norm).filter((b) => b.length >= 3).some((b) => norm(stem).includes(b))) s += 20
  if (/apple-touch-icon|apple-icon|android-chrome-512|icon-512|512x512/i.test(stem)) s += 6
  s += { svg: 26, png: 10, webp: 8, gif: 0, jpg: 2, jpeg: 2, ico: -6 }[c.ext]
  const w = c.width ?? 0
  const h = c.height ?? 0
  if (c.ext !== 'svg') {
    const max = Math.max(w, h)
    s += max >= 256 ? 14 : max >= 128 ? 10 : max >= 64 ? 3 : max > 0 ? -20 : -4
  }
  if (w > 0 && h > 0) {
    const ratio = Math.max(w, h) / Math.min(w, h)
    s += ratio <= 1.25 ? 16 : ratio <= 1.8 ? 2 : ratio <= 2.6 ? -14 : -28
  }
  if (c.hints.includes('manifest')) s += 12
  if (c.hints.includes('readme')) s += 8
  const dirs = c.rel.split('/').slice(0, -1)
  if (dirs.some((d) => LIKELY_DIRS.has(d.toLowerCase()))) s += 5
  // Next.js file-based metadata: app/icon.* and app/apple-icon.* are the site's own icon by definition
  if (/(^|\/)app\/(icon|apple-icon)\.[a-z]+$/i.test(c.rel)) s += 12
  // inside a UI icon set ("components/icons/arrow.svg" is filtered by name; "icons/logo.svg" still counts)
  if (dirs.length && /^icons?$/i.test(dirs[dirs.length - 1]!) && kind === 'icon') s -= 10
  s -= Math.max(0, dirs.length - 2) * 3
  if (c.bytes < 120) s -= 30
  return Math.round(s)
}

// ---------- the walk ----------
function readHead(file: string, n = 4096): Buffer {
  const fd = fs.openSync(file, 'r')
  try {
    const buf = Buffer.alloc(n)
    const len = fs.readSync(fd, buf, 0, n, 0)
    return buf.subarray(0, len)
  } finally {
    fs.closeSync(fd)
  }
}
const extOf = (file: string): ImageExt | null => {
  const e = path.extname(file).slice(1).toLowerCase()
  return (IMAGE_EXTS as readonly string[]).includes(e) ? (e as ImageExt) : null
}
const inside = (child: string, parent: string) => {
  const r = path.relative(parent, child)
  return !!r && !r.startsWith('..') && !path.isAbsolute(r)
}

/** Icons a web manifest lists (src relative to the manifest, else to a sibling public/). */
function manifestIcons(file: string, root: string): string[] {
  try {
    const json = JSON.parse(fs.readFileSync(file, 'utf8')) as { icons?: { src?: unknown }[] }
    const out: string[] = []
    for (const i of json.icons ?? []) {
      if (typeof i?.src !== 'string' || /^[a-z]+:/i.test(i.src)) continue
      const src = i.src.split(/[?#]/)[0]!
      const tries = src.startsWith('/') ? [path.join(path.dirname(file), src), path.join(root, 'public', src), path.join(root, 'static', src)] : [path.join(path.dirname(file), src)]
      const hit = tries.find((t) => inside(t, root) && fs.existsSync(t))
      if (hit) out.push(hit)
    }
    return out
  } catch {
    return []
  }
}
/** The README's first image when it is a file in the repo (no URLs). */
function readmeImage(root: string): string | null {
  for (const name of ['README.md', 'readme.md', 'Readme.md', 'README.MD']) {
    const file = path.join(root, name)
    let text: string
    try {
      text = fs.readFileSync(file, 'utf8').slice(0, 6000)
    } catch {
      continue
    }
    const m = text.match(/!\[[^\]]*\]\(\s*<?([^)\s>]+)>?[^)]*\)|<img[^>]*\bsrc\s*=\s*["']([^"']+)["']/i)
    const src = m?.[1] ?? m?.[2]
    if (!src || /^[a-z]+:/i.test(src) || src.startsWith('//')) return null
    const p = path.join(root, src.replace(/^\.?\//, '').split(/[?#]/)[0]!)
    return inside(p, root) && fs.existsSync(p) ? p : null
  }
  return null
}

/** Every logo-like image of one repository, unranked. */
export function scanRepo(repo: RepoRoot, opts: DetectOptions = {}): Omit<DetectedLogo, 'score' | 'confident'>[] {
  const maxDepth = opts.maxDepth ?? 5
  const maxEntries = opts.maxEntries ?? 6000
  const now = opts.now ?? Date.now
  const deadline = now() + (opts.budgetMs ?? 1500)
  const root = repo.path
  const found = new Map<string, Omit<DetectedLogo, 'score' | 'confident'>>()
  const hints = new Map<string, Set<'manifest' | 'readme'>>()
  const hint = (p: string, h: 'manifest' | 'readme') => (hints.get(p) ?? hints.set(p, new Set()).get(p)!).add(h)
  const brand = [repo.name, path.basename(root), ...(opts.brandNames ?? [])]
  const files: string[] = []
  let seen = 0
  const queue: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }]
  while (queue.length && seen < maxEntries && now() < deadline) {
    const { dir, depth } = queue.shift()!
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    const subdirs: string[] = []
    for (const e of entries) {
      if (++seen > maxEntries) break
      const full = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (depth < maxDepth && !SKIP_DIRS.has(e.name) && !e.name.startsWith('.') && !OUTPUT_PREFIX.test(e.name)) subdirs.push(e.name)
      } else if (e.isFile()) {
        if (MANIFESTS.has(e.name)) for (const icon of manifestIcons(full, root)) { hint(icon, 'manifest'); files.push(icon) }
        else if (extOf(e.name)) files.push(full)
      }
    }
    // the usual homes of a logo first, so a big repo spends its entry budget where logos live
    const rank = (d: string) => (BRAND_DIRS.test(d) ? 0 : LIKELY_DIRS.has(d.toLowerCase()) ? 1 : 2)
    for (const d of subdirs.sort((a, b) => rank(a) - rank(b))) queue.push({ dir: path.join(dir, d), depth: depth + 1 })
  }
  for (const p of PROBES) if (fs.existsSync(path.join(root, p))) files.push(path.join(root, p))
  const readme = readmeImage(root)
  if (readme) { hint(readme, 'readme'); files.push(readme) }
  for (const file of files) {
    if (found.has(file)) continue
    const ext = extOf(file)
    if (!ext) continue
    const rel = path.relative(root, file).split(path.sep).join('/')
    if (!hints.has(file) && !nameKind(rel, brand)) continue
    let st: fs.Stats
    try {
      st = fs.statSync(file)
    } catch {
      continue
    }
    if (!st.isFile() || st.size > MAX_LOGO_BYTES || st.size === 0) continue
    let size: { width: number; height: number } | null = null
    try {
      size = imageSize(readHead(file, ext === 'jpg' || ext === 'jpeg' ? 65536 : 4096), ext)
    } catch {
      /* unreadable: still listed, unsized */
    }
    found.set(file, { path: file, repo: repo.name, rel, ext, bytes: st.size, width: size?.width ?? null, height: size?.height ?? null, hints: [...(hints.get(file) ?? [])] })
  }
  return [...found.values()]
}

/**
 * Ranked logo candidates across the repositories (best first), duplicates (the same bytes in two places) collapsed
 * to their best-scoring copy, at most `limit`.
 */
export function detectLogos(repos: RepoRoot[], opts: DetectOptions & { limit?: number } = {}): DetectedLogo[] {
  const brandNames = opts.brandNames ?? []
  const all: DetectedLogo[] = []
  for (const repo of repos) {
    try {
      if (!fs.statSync(repo.path).isDirectory()) continue
    } catch {
      continue
    }
    for (const c of scanRepo(repo, opts)) {
      const score = scoreCandidate(c, [repo.name, path.basename(repo.path), ...brandNames])
      if (score > 0) all.push({ ...c, score, confident: score >= AUTO_SCORE })
    }
  }
  all.sort((a, b) => b.score - a.score || a.rel.length - b.rel.length || a.path.localeCompare(b.path))
  const seenHash = new Set<string>()
  const out: DetectedLogo[] = []
  for (const c of all) {
    let key = c.path
    try {
      key = createHash('sha1').update(fs.readFileSync(c.path)).digest('hex')
    } catch {
      /* keep by path */
    }
    if (seenHash.has(key)) continue
    seenHash.add(key)
    out.push(c)
    if (out.length >= (opts.limit ?? 24)) break
  }
  return out
}
