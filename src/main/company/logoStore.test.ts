import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RepoRoot } from './logoDetect'
import { CompanyLogoStore } from './logoStore'

let tmp: string
let root: string
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'logo-store-'))
  root = path.join(tmp, 'companies')
})
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

const svg = (tag: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><title>${tag}</title><circle cx="32" cy="32" r="30"/>${' '.repeat(200)}</svg>`
function makeRepo(name: string, files: Record<string, string>): RepoRoot {
  const p = path.join(tmp, 'repos', name)
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(p, rel)), { recursive: true })
    fs.writeFileSync(path.join(p, rel), body)
  }
  fs.mkdirSync(p, { recursive: true })
  return { name, path: p }
}
const decode = (url: string | null) => (url ? Buffer.from(url.split(',')[1]!, 'base64').toString('utf8') : null)

describe('CompanyLogoStore', () => {
  const repos = new Map<string, RepoRoot>()
  const company = (repoIds: string[]) => ({ id: 'co_acme', slug: 'acme', name: 'Acme', system: null, repoIds })
  const store = () => new CompanyLogoStore(root, { reposOf: (c) => c.repoIds.map((id) => repos.get(id)!).filter(Boolean) })
  beforeEach(() => repos.clear())

  it('uses a confident detected logo automatically, as a copy in the company folder', () => {
    repos.set('repo_a', makeRepo('acme-web', { 'public/logo.svg': svg('detected') }))
    const s = store()
    const logo = s.get(company(['repo_a']))
    expect(logo.source).toBe('auto')
    expect(logo.origin).toBe('acme-web/public/logo.svg')
    expect(decode(logo.dataUrl)).toContain('detected')
    // a copy: the repo file can go away and the logo stays
    fs.rmSync(path.join(repos.get('repo_a')!.path, 'public/logo.svg'))
    expect(fs.existsSync(path.join(root, 'acme', 'logo', 'logo.svg'))).toBe(true)
    expect(decode(store().get(company(['repo_a'])).dataUrl)).toContain('detected')
    expect(JSON.parse(fs.readFileSync(path.join(root, 'acme', 'logo', 'logo.json'), 'utf8'))).toMatchObject({ source: 'auto', file: 'logo.svg' })
  })

  it('stays on the initials without a confident candidate, and re-detects when a repository is added', () => {
    repos.set('repo_a', makeRepo('plain', { 'app/favicon.ico': 'x'.repeat(300) }))
    const s = store()
    expect(s.get(company(['repo_a'])).dataUrl).toBeNull()
    repos.set('repo_b', makeRepo('brand', { 'assets/brand/acme.svg': svg('added') }))
    const after = s.get(company(['repo_a', 'repo_b']))
    expect(after.source).toBe('auto')
    expect(decode(after.dataUrl)).toContain('added')
  })

  it('a manual pick is never overridden by a later detection, and survives a restart', () => {
    const a = makeRepo('acme-web', { 'public/logo.svg': svg('auto'), 'public/images/mark-alt.svg': svg('picked') })
    repos.set('repo_a', a)
    const s = store()
    s.get(company(['repo_a']))
    const picked = s.setCandidate(company(['repo_a']), path.join(a.path, 'public/images/mark-alt.svg'))
    expect(picked.source).toBe('manual')
    expect(picked.origin).toBe('acme-web/public/images/mark-alt.svg')
    repos.set('repo_b', makeRepo('other', { 'public/logo.svg': svg('newer') }))
    const later = store().get(company(['repo_a', 'repo_b']))
    expect(later.source).toBe('manual')
    expect(decode(later.dataUrl)).toContain('picked')
  })

  it('"Use initials" sticks too; "Detect automatically" goes back to the best candidate', () => {
    repos.set('repo_a', makeRepo('acme-web', { 'public/logo.svg': svg('auto') }))
    const s = store()
    expect(s.setNone(company(['repo_a'])).dataUrl).toBeNull()
    expect(fs.readdirSync(path.join(root, 'acme', 'logo'))).toEqual(['logo.json'])
    repos.set('repo_b', makeRepo('other', { 'public/logo.svg': svg('other') }))
    expect(s.get(company(['repo_a', 'repo_b']))).toMatchObject({ source: 'none', dataUrl: null })
    const back = s.setAuto(company(['repo_a']))
    expect(back.source).toBe('auto')
    expect(decode(back.dataUrl)).toContain('auto')
  })

  it('a chosen file is copied in (replacing the old extension) and refused when it is not an image', () => {
    const s = store()
    const file = path.join(tmp, 'Downloads', 'acme.png')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, Buffer.from('89504e47', 'hex'))
    repos.set('repo_a', makeRepo('acme-web', { 'public/logo.svg': svg('auto') }))
    s.get(company(['repo_a']))
    const l = s.setFile(company(['repo_a']), file)
    expect(l).toMatchObject({ source: 'manual', origin: 'acme.png' })
    expect(l.dataUrl?.startsWith('data:image/png;base64,')).toBe(true)
    expect(fs.readdirSync(path.join(root, 'acme', 'logo')).sort()).toEqual(['logo.json', 'logo.png'])
    fs.writeFileSync(path.join(tmp, 'notes.txt'), 'hi')
    expect(() => s.setFile(company([]), path.join(tmp, 'notes.txt'))).toThrow(/SVG, PNG/)
  })

  it('refuses a "candidate" outside the company’s repositories', () => {
    repos.set('repo_a', makeRepo('acme-web', { 'public/logo.svg': svg('auto') }))
    const outside = path.join(tmp, 'elsewhere', 'logo.svg')
    fs.mkdirSync(path.dirname(outside), { recursive: true })
    fs.writeFileSync(outside, svg('x'))
    expect(() => store().setCandidate(company(['repo_a']), outside)).toThrow(/not in one of this company/)
    expect(() => store().setCandidate(company(['repo_a']), path.join(repos.get('repo_a')!.path, '..', '..', 'elsewhere', 'logo.svg'))).toThrow(/not in one of this company/)
  })

  it('lists candidates with previews for the picker, and Personal never gets a detected logo', () => {
    repos.set('repo_a', makeRepo('acme-web', { 'public/logo.svg': svg('one'), 'app/icon.svg': svg('two') }))
    const list = store().candidates(company(['repo_a']))
    expect(list.map((c) => c.label)).toEqual(['acme-web/public/logo.svg', 'acme-web/app/icon.svg'])
    expect(list.every((c) => c.dataUrl.startsWith('data:image/svg+xml;base64,'))).toBe(true)
    const personal = { id: 'co_personal', slug: 'personal', name: 'Personal', system: 'personal' as const, repoIds: ['repo_a'] }
    expect(store().get(personal).dataUrl).toBeNull()
    expect(store().candidates(personal)).toEqual([])
  })

  it('a generated emblem (company from a chat) is stored as a picked svg; keepDetected leaves a found logo alone', () => {
    const s = store()
    const plain = s.setEmblem(company([]), 'ring')
    expect(plain).toMatchObject({ source: 'manual', origin: 'Generated emblem' })
    expect(decode(plain.dataUrl)).toMatch(/>A<\/text>/)
    expect(fs.readdirSync(path.join(root, 'acme', 'logo')).sort()).toEqual(['logo.json', 'logo.svg'])
    // a repo with its own logo wins over the emblem when keepDetected
    repos.set('repo_a', makeRepo('acme-web', { 'public/logo.svg': svg('detected') }))
    s.setAuto(company(['repo_a']))
    const kept = s.setEmblem(company(['repo_a']), 'arch', true)
    expect(kept.source).toBe('auto')
    expect(decode(kept.dataUrl)).toContain('detected')
    // no logo in the repo: the emblem
    repos.set('repo_b', makeRepo('acme-api', { 'README.md': '# api' }))
    const other = { ...company(['repo_b']), id: 'co_other', slug: 'other', name: 'Other Co' }
    expect(decode(s.setEmblem(other, 'arch', true).dataUrl)).toMatch(/>OC<\/text>/)
  })

  it('without company folders (in-memory db) everything is the initials', () => {
    const s = new CompanyLogoStore(null, { reposOf: () => [] })
    expect(s.get(company([]))).toMatchObject({ source: 'auto', dataUrl: null })
  })
})
