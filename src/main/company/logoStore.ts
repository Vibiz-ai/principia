/**
 * Company logos (the rail coin and the sidebar chips). The chosen image is COPIED to
 * `<companiesRoot>/<slug>/logo/logo.<ext>` with its state in `logo/logo.json`, so the logo survives the repo moving,
 * changing or being removed. Pure Node: Electron's image resizing comes in through `shrink`.
 *
 * - `auto` (the default): the best confident candidate of the company's repositories (logoDetect.ts), re-detected
 *   whenever the set of repositories changes (`repoKey`), so adding a repo with a logo fills an empty coin.
 * - `manual` (a picked candidate or file) and `none` ("Use initials") are never touched by a detection.
 * Personal never gets a detected logo (its repos are every unassigned folder).
 */
import fs from 'node:fs'
import path from 'node:path'
import type { CompanyLogo, CompanyLogoSource, CompanyPassport, LogoCandidate } from '../../shared/company'
import { HiveError } from '../../shared/errors'
import { emblemSvg, type EmblemVariant } from '../../shared/chatCompany'
import { IMAGE_EXTS, MAX_LOGO_BYTES, MIME, detectLogos, type DetectedLogo, type ImageExt, type RepoRoot } from './logoDetect'

export interface LogoState {
  source: CompanyLogoSource
  /** file name inside the logo folder; null = initials */
  file: string | null
  origin: string | null
  /** the repositories the last detection looked at (auto only) */
  repoKey: string | null
  updatedAt: string | null
}
type Company = Pick<CompanyPassport, 'id' | 'slug' | 'name' | 'system' | 'repoIds'>
/** Downscale a big raster for storage (Electron nativeImage in the app); null keeps the bytes as they are. */
export type Shrink = (buf: Buffer, ext: ImageExt, max: number) => { buf: Buffer; ext: ImageExt } | null
export interface LogoStoreDeps {
  /** the company's repository folders (name + absolute path) */
  reposOf: (company: Company) => RepoRoot[]
  shrink?: Shrink
  detect?: typeof detectLogos
  now?: () => Date
}
const STORE_MAX_PX = 512
const THUMB_MAX_PX = 128

const extOf = (p: string): ImageExt | null => {
  const e = path.extname(p).slice(1).toLowerCase()
  return (IMAGE_EXTS as readonly string[]).includes(e) ? (e as ImageExt) : null
}
export const dataUrl = (buf: Buffer, ext: ImageExt) => `data:${MIME[ext]};base64,${buf.toString('base64')}`
const inside = (child: string, parent: string) => {
  const r = path.relative(parent, child)
  return !!r && !r.startsWith('..') && !path.isAbsolute(r)
}

export class CompanyLogoStore {
  constructor(readonly companiesRoot: string | null, private readonly deps: LogoStoreDeps) {}

  private dir(c: Company): string {
    if (!this.companiesRoot) throw new HiveError('conflict', 'Company folders are not available')
    return path.join(this.companiesRoot, c.slug, 'logo')
  }
  private now(): string { return (this.deps.now?.() ?? new Date()).toISOString() }
  repoKey(c: Company): string { return this.deps.reposOf(c).map((r) => r.path).sort().join('\n') }

  state(c: Company): LogoState {
    const empty: LogoState = { source: 'auto', file: null, origin: null, repoKey: null, updatedAt: null }
    if (!this.companiesRoot) return empty
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(this.dir(c), 'logo.json'), 'utf8')) as Partial<LogoState>
      const source: CompanyLogoSource = raw.source === 'manual' || raw.source === 'none' ? raw.source : 'auto'
      const file = typeof raw.file === 'string' && /^logo\.[a-z]+$/.test(raw.file) ? raw.file : null
      return { source, file, origin: typeof raw.origin === 'string' ? raw.origin : null, repoKey: typeof raw.repoKey === 'string' ? raw.repoKey : null, updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null }
    } catch {
      return empty
    }
  }
  private writeState(c: Company, s: LogoState): void {
    const dir = this.dir(c)
    fs.mkdirSync(dir, { recursive: true })
    const tmp = path.join(dir, `.logo.json.${process.pid}.tmp`)
    fs.writeFileSync(tmp, JSON.stringify(s, null, 2), { mode: 0o600 })
    fs.renameSync(tmp, path.join(dir, 'logo.json'))
  }
  /** Copies `buf` in as the logo file (dropping the previous one) and returns its file name. */
  private writeImage(c: Company, buf: Buffer, ext: ImageExt): string {
    const small = ext !== 'svg' && ext !== 'ico' ? this.deps.shrink?.(buf, ext, STORE_MAX_PX) : null
    const out = small ?? { buf, ext }
    const dir = this.dir(c)
    fs.mkdirSync(dir, { recursive: true })
    const file = `logo.${out.ext === 'jpeg' ? 'jpg' : out.ext}`
    for (const f of fs.readdirSync(dir)) if (/^logo\.[a-z]+$/.test(f) && f !== file) fs.rmSync(path.join(dir, f), { force: true })
    fs.writeFileSync(path.join(dir, file), out.buf, { mode: 0o600 })
    return file
  }
  private view(c: Company, s: LogoState): CompanyLogo {
    let url: string | null = null
    if (s.file && s.source !== 'none') {
      try {
        const ext = extOf(s.file)
        if (ext) url = dataUrl(fs.readFileSync(path.join(this.dir(c), s.file)), ext)
      } catch {
        url = null
      }
    }
    return { companyId: c.id, source: s.source, dataUrl: url, origin: url ? s.origin : null, updatedAt: s.updatedAt }
  }

  /** The current logo; an `auto` logo whose repositories changed is re-detected first. */
  get(c: Company): CompanyLogo {
    if (!this.companiesRoot) return { companyId: c.id, source: 'auto', dataUrl: null, origin: null, updatedAt: null }
    const s = this.state(c)
    if (s.source === 'auto' && c.system !== 'personal' && s.repoKey !== this.repoKey(c)) return this.detectNow(c)
    return this.view(c, s)
  }
  list(companies: Company[]): CompanyLogo[] {
    return companies.map((c) => {
      try {
        return this.get(c)
      } catch {
        return { companyId: c.id, source: 'auto', dataUrl: null, origin: null, updatedAt: null }
      }
    })
  }
  private detected(c: Company): DetectedLogo[] {
    if (c.system === 'personal') return []
    return (this.deps.detect ?? detectLogos)(this.deps.reposOf(c), { brandNames: [c.name] })
  }
  /** Re-runs detection for an `auto` company: the best confident candidate, else the initials. */
  detectNow(c: Company): CompanyLogo {
    const key = this.repoKey(c)
    const best = this.detected(c).find((d) => d.confident)
    let next: LogoState = { source: 'auto', file: null, origin: null, repoKey: key, updatedAt: this.now() }
    if (best) {
      try {
        const file = this.writeImage(c, fs.readFileSync(best.path), best.ext)
        next = { ...next, file, origin: `${best.repo}/${best.rel}` }
      } catch {
        /* unreadable: initials */
      }
    } else this.clearImage(c)
    this.writeState(c, next)
    return this.view(c, next)
  }
  private clearImage(c: Company): void {
    try {
      const dir = this.dir(c)
      for (const f of fs.readdirSync(dir)) if (/^logo\.[a-z]+$/.test(f)) fs.rmSync(path.join(dir, f), { force: true })
    } catch {
      /* nothing stored */
    }
  }

  /** The picker grid: every candidate with a small preview. */
  candidates(c: Company): LogoCandidate[] {
    const out: LogoCandidate[] = []
    for (const d of this.detected(c)) {
      try {
        const buf = fs.readFileSync(d.path)
        const small = d.ext !== 'svg' && d.ext !== 'ico' ? this.deps.shrink?.(buf, d.ext, THUMB_MAX_PX) : null
        out.push({ path: d.path, label: `${d.repo}/${d.rel}`, dataUrl: small ? dataUrl(small.buf, small.ext) : dataUrl(buf, d.ext), width: d.width, height: d.height, score: d.score, confident: d.confident })
      } catch {
        /* vanished since the scan */
      }
    }
    return out
  }

  /** A picked image from one of the company's repositories (must be an image inside one of them). */
  setCandidate(c: Company, file: string): CompanyLogo {
    const repos = this.deps.reposOf(c)
    const repo = repos.find((r) => inside(path.resolve(file), r.path))
    if (!repo) throw new HiveError('bad_request', 'That image is not in one of this company’s repositories')
    return this.setManual(c, file, `${repo.name}/${path.relative(repo.path, file).split(path.sep).join('/')}`)
  }
  /** A file the user chose (open dialog). */
  setFile(c: Company, file: string): CompanyLogo { return this.setManual(c, file, path.basename(file)) }
  private setManual(c: Company, file: string, origin: string): CompanyLogo {
    const ext = extOf(file)
    if (!ext) throw new HiveError('bad_request', 'Choose an SVG, PNG, WebP, JPEG, GIF or ICO image')
    let buf: Buffer
    try {
      const st = fs.statSync(file)
      if (!st.isFile()) throw new Error('not a file')
      if (st.size > MAX_LOGO_BYTES) throw new HiveError('bad_request', 'That image is over 4 MB')
      buf = fs.readFileSync(file)
    } catch (e) {
      if (e instanceof HiveError) throw e
      throw new HiveError('not_found', 'That image could not be read')
    }
    const name = this.writeImage(c, buf, ext)
    const s: LogoState = { source: 'manual', file: name, origin, repoKey: null, updatedAt: this.now() }
    this.writeState(c, s)
    return this.view(c, s)
  }
  /** "Use initials": kept until the user picks again (a detection never overrides it). */
  setNone(c: Company): CompanyLogo {
    this.clearImage(c)
    const s: LogoState = { source: 'none', file: null, origin: null, repoKey: null, updatedAt: this.now() }
    this.writeState(c, s)
    return this.view(c, s)
  }
  /**
   * The generated line-art monogram (shared/chatCompany.ts), stored like a picked file (`manual`, so a later detection
   * never replaces it; Change Logo… does). `keepDetected`: a company that already shows a detected or picked image
   * keeps it (a company made from a chat with a repo uses the repo's logo when there is one).
   */
  setEmblem(c: Company, variant: EmblemVariant, keepDetected = false): CompanyLogo {
    if (keepDetected) {
      const cur = this.get(c)
      if (cur.dataUrl || cur.source === 'none') return cur
    }
    const file = this.writeImage(c, Buffer.from(emblemSvg(c.name, variant), 'utf8'), 'svg')
    const s: LogoState = { source: 'manual', file, origin: 'Generated emblem', repoKey: null, updatedAt: this.now() }
    this.writeState(c, s)
    return this.view(c, s)
  }
  /** Back to automatic detection, run now. */
  setAuto(c: Company): CompanyLogo { return this.detectNow(c) }
}
