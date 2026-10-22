import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { PERSONAL_COMPANY_ID } from '../../../shared/company'
import { RepoScanSummarySchema, ScanSummarySchema } from '../../../shared/onboarding'
import type { GhExec, GhRunResult } from '../github'
import { detectStack, inspectFolders, readmeFacts, runScan, scanGithub, scanRepo, scanRepos, SCAN_LISTING_MAX, STACK_MARKERS, toSummary, type FolderStore } from '../scan'

const FIX = path.join(__dirname, 'fixtures', 'repos')
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ob-scan-')))
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

// built at runtime so no credential-shaped string is committed
const TOKEN = ['ghp', '_', 'Zq9', 'X'.repeat(12), '7'.repeat(12), 'kLmN0p'].join('')
const VAULT_VALUE = 'vault-secret-value-1234'

/** Copies a fixture repo into tmp, optionally with a .git/config. */
function fixture(name: string, gitConfig?: string): string {
  const dest = path.join(tmp, `${name}-${Math.random().toString(36).slice(2, 8)}`)
  fs.cpSync(path.join(FIX, name), dest, { recursive: true })
  if (gitConfig !== undefined) {
    fs.mkdirSync(path.join(dest, '.git'), { recursive: true })
    fs.writeFileSync(path.join(dest, '.git', 'config'), gitConfig)
  }
  return dest
}
const allStrings = (v: unknown): string => JSON.stringify(v)

describe('scanRepo: Next.js fixture', () => {
  const dir = fixture('next-app', `[core]\n\tbare = false\n[remote "origin"]\n\turl = https://me:${TOKEN}@github.com/acme/acme-web.git\n`)
  const s = scanRepo(dir)

  it('detects the stack, Next.js first, in marker order', () => {
    expect(s.stack[0]).toBe('Next.js')
    expect(s.stack).toEqual(expect.arrayContaining(['React', 'TypeScript', 'Tailwind', 'Node.js', 'Prisma', 'Stripe']))
    expect(s.stack).not.toContain('Python')
    expect(s.stack).not.toContain('Vite')
  })
  it('reads package.json, CNAME and README facts', () => {
    expect(s.source).toBe('local')
    expect(s.label).toBe(path.basename(dir))
    expect(s.path).toBe(dir)
    expect(s.packageName).toBe('acme-web')
    expect(s.description).toBe('Online ordering for neighbourhood bakeries')
    expect(s.homepage).toBe('https://acme.com')
    expect(s.cname).toBe('acme.com')
    expect(s.readmeHeading).toBe('Acme Web')
    expect(s.readmeLine).toBe('Acme Web lets neighbourhood bakeries take orders online.')
    expect(s.readmeLink).toBe('https://docs.acme.com/start')
    expect(s.readmeExcerpt).toContain('# Acme Web')
  })
  it('strips credentials from the origin remote', () => {
    expect(s.remote).toBe('https://github.com/acme/acme-web.git')
    expect(allStrings(s)).not.toContain(TOKEN)
  })
  it('lists top-level entries without dotfiles, dirs marked', () => {
    expect(s.listing).toContain('app/')
    expect(s.listing).toContain('package.json')
    expect(s.listing.some((n) => n.startsWith('.'))).toBe(false)
  })
  it('the summary fits the shared schema', () => {
    const { listing: _l, ...summary } = s
    expect(() => RepoScanSummarySchema.parse(summary)).not.toThrow()
    const sum = toSummary([s])
    expect(() => ScanSummarySchema.parse(sum)).not.toThrow()
    expect(sum.stack[0]).toBe('Next.js')
    expect('listing' in sum.repos[0]).toBe(false)
  })
})

describe('scanRepo: other stacks', () => {
  it('Python: FastAPI, Django, Postgres, Stripe; README.rst', () => {
    const s = scanRepo(fixture('python-app'))
    expect(s.stack[0]).toBe('Python')
    expect(s.stack).toEqual(expect.arrayContaining(['Django', 'FastAPI', 'Postgres', 'Stripe']))
    expect(s.stack).not.toContain('Node.js')
    expect(s.readmeLine).toBe('Ledgerly keeps the books for freelancers who hate spreadsheets.')
    expect(s.packageName).toBeUndefined()
    expect(s.remote).toBeUndefined()
  })
  it('Rust: Rust, Axum', () => {
    const s = scanRepo(fixture('rust-app'))
    expect(s.stack).toEqual(['Rust', 'Axum'])
    expect(s.readmeHeading).toBe('Tidepool')
    expect(s.readmeLine).toBe('Tidepool is a tiny status page for small teams.')
  })
  it('bare folder: no stack, no README, listing only', () => {
    const s = scanRepo(fixture('bare'))
    expect(s.stack).toEqual([])
    expect(s.readmeLine).toBeUndefined()
    expect(s.listing).toEqual(['notes.txt'])
    const { listing: _l, ...summary } = s
    expect(() => RepoScanSummarySchema.parse(summary)).not.toThrow()
  })
  it('STACK_MARKERS is data: labels are unique and short', () => {
    const labels = STACK_MARKERS.map((m) => m.label)
    expect(new Set(labels).size).toBe(labels.length)
    expect(labels.every((l) => l.length <= 40)).toBe(true)
    expect(detectStack(fixture('bare'), [], new Set(['next']), [{ label: 'X', deps: ['next'] }])).toEqual(['X'])
  })
})

describe('redaction', () => {
  it('no output string contains a planted token or a vault value', () => {
    const dir = fixture('bare')
    fs.writeFileSync(
      path.join(dir, 'README.md'),
      `# Secret ${TOKEN}\n\nDeploy with token ${TOKEN} and key ${VAULT_VALUE} please.\n\nhttps://user:${TOKEN}@example.com/x\n${'x'.repeat(2030)}${TOKEN}\n`
    )
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'leaky', description: `uses ${TOKEN}`, homepage: `https://u:${TOKEN}@leaky.dev` }))
    fs.writeFileSync(path.join(dir, `file-${VAULT_VALUE}`), '')
    const s = scanRepo(dir, { redact: (t) => t.split(VAULT_VALUE).join('••••MY_KEY') })
    const out = allStrings(s)
    expect(out).not.toContain(TOKEN)
    expect(out).not.toContain(TOKEN.slice(0, 20))
    expect(out).not.toContain(VAULT_VALUE)
    expect(out).toContain('••••credential')
    expect(out).toContain('••••MY_KEY')
    expect(s.homepage).toBe('https://leaky.dev')
  })
  it('a token in a quoted git config url is stripped', () => {
    const s = scanRepo(fixture('bare', `[remote "origin"]\n\turl = "https://x:${TOKEN}@github.com/a/b.git"\n`))
    expect(s.remote).toBe('https://github.com/a/b.git')
  })
})

describe('symlinks and caps', () => {
  const outside = path.join(tmp, 'outside-secret')
  fs.mkdirSync(outside, { recursive: true })
  fs.writeFileSync(path.join(outside, 'README.md'), '# Outside\n\nThis text lives outside the repo and must not be read.\n')
  fs.writeFileSync(path.join(outside, 'package.json'), JSON.stringify({ name: 'outside', dependencies: { next: '1' } }))
  fs.writeFileSync(path.join(outside, 'config'), '[remote "origin"]\n\turl = https://github.com/evil/outside.git\n')

  it('never follows symlinks out of the repo', () => {
    const dir = fixture('bare')
    fs.symlinkSync(path.join(outside, 'README.md'), path.join(dir, 'README.md'))
    fs.symlinkSync(path.join(outside, 'package.json'), path.join(dir, 'package.json'))
    fs.mkdirSync(path.join(dir, '.git'))
    fs.symlinkSync(path.join(outside, 'config'), path.join(dir, '.git', 'config'))
    fs.symlinkSync(outside, path.join(dir, 'supabase'))
    fs.symlinkSync(path.join(outside, 'package.json'), path.join(dir, 'next.config.js'))
    const s = scanRepo(dir)
    expect(s.readmeLine).toBeUndefined()
    expect(s.packageName).toBeUndefined()
    expect(s.remote).toBeUndefined()
    expect(s.stack).not.toContain('Next.js')
    expect(s.stack).not.toContain('Supabase')
    expect(s.stack).not.toContain('Node.js')
    expect(allStrings(s)).not.toContain('Outside')
  })
  it('follows a symlink that stays inside the repo', () => {
    const dir = fixture('bare')
    fs.writeFileSync(path.join(dir, 'README-real.md'), '# Inside\n\nThis readme is a link that stays inside.\n')
    fs.symlinkSync(path.join(dir, 'README-real.md'), path.join(dir, 'README.md'))
    expect(scanRepo(dir).readmeLine).toBe('This readme is a link that stays inside.')
  })
  it.skipIf(process.platform === 'win32')('a FIFO named README.md, package.json or .git/config never blocks the scan', () => {
    const dir = fixture('bare')
    fs.mkdirSync(path.join(dir, '.git'))
    for (const f of ['README.md', 'package.json', path.join('.git', 'config')]) execFileSync('mkfifo', [path.join(dir, f)])
    const s = scanRepo(dir)
    expect(s.readmeLine).toBeUndefined()
    expect(s.packageName).toBeUndefined()
    expect(s.remote).toBeUndefined()
  })
  it('a relative path is refused, never resolved against the app cwd', () => {
    expect(() => scanRepo('src')).toThrow()
    expect(scanRepos(['src']).warnings).toHaveLength(1)
  })
  it('caps each file at 64 KB and the listing at 60 entries', () => {
    const dir = fixture('bare')
    fs.writeFileSync(path.join(dir, 'README.md'), `# Big\n\n${'a'.repeat(70 * 1024)}\n\nLATE LINE after the cap should never appear.\n`)
    for (let i = 0; i < 80; i++) fs.writeFileSync(path.join(dir, `f${String(i).padStart(3, '0')}.txt`), '')
    fs.mkdirSync(path.join(dir, 'node_modules'))
    fs.writeFileSync(path.join(dir, '.env'), 'X=1')
    const s = scanRepo(dir)
    expect(s.listing.length).toBe(SCAN_LISTING_MAX)
    expect(s.listing).not.toContain('node_modules/')
    expect(s.listing).not.toContain('.env')
    expect(allStrings(s)).not.toContain('LATE LINE')
    expect(s.readmeExcerpt!.length).toBeLessThanOrEqual(2048)
  })
  it('a package.json over 64 KB is ignored, not half-parsed', () => {
    const dir = fixture('bare')
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'huge', pad: 'p'.repeat(70 * 1024), dependencies: { next: '1' } }))
    const s = scanRepo(dir)
    expect(s.packageName).toBeUndefined()
    expect(s.stack).toEqual(['Node.js'])
  })
})

describe('readmeFacts', () => {
  it('skips badges, code fences and image links', () => {
    const f = readmeFacts('[![x](https://img.shields.io/a.svg)](https://x)\n\n![logo](https://cdn.x.com/logo.png)\n\n# Title\n\n```\nnot a line here at all\n```\n\nThe real first line is here.\n')
    expect(f.heading).toBe('Title')
    expect(f.line).toBe('The real first line is here.')
    expect(f.link).toBeUndefined()
  })
})

describe('scanRepos', () => {
  it('unreadable paths become warnings', () => {
    const r = scanRepos([path.join(tmp, 'nope'), fixture('rust-app')])
    expect(r.repos).toHaveLength(1)
    expect(r.warnings).toEqual(['Couldn\'t read nope'])
    expect(r.partial).toBe(false)
  })
  it('stops at the deadline', () => {
    const r = scanRepos([fixture('rust-app')], { deadline: Date.now() - 1 })
    expect(r.repos).toHaveLength(0)
    expect(r.partial).toBe(true)
  })
})

// ---------- GitHub ----------

const GH = path.join(__dirname, 'fixtures', 'gh')
function fakeExec(routes: Record<string, Partial<GhRunResult>>, calls: string[][] = []): GhExec {
  return (file, args) => {
    calls.push([file, ...args])
    const key = args[args.length - 1]
    const r = routes[key] ?? { code: 1, stderr: 'HTTP 404: Not Found' }
    return { promise: Promise.resolve({ code: 0, stdout: '', stderr: '', timedOut: false, ...r }), kill: async () => undefined }
  }
}

describe('scanGithub', () => {
  const readme = `# Acme Web\n\nAcme Web lets bakeries take orders. Token ${TOKEN}.\n\nSee https://acme.com/about\n`
  const routes = {
    'repos/acme/acme-web': { stdout: fs.readFileSync(path.join(GH, 'repo.json'), 'utf8') },
    'repos/acme/acme-web/readme': { stdout: JSON.stringify({ encoding: 'base64', content: Buffer.from(readme).toString('base64').replace(/(.{60})/g, '$1\n') }) }
  }
  it('reads description, homepage, language and README via gh api', async () => {
    const calls: string[][] = []
    const s = await scanGithub('acme/acme-web', { exec: fakeExec(routes, calls), env: {} })
    expect(calls[0]).toEqual(['gh', 'api', '--hostname', 'github.com', '--method', 'GET', 'repos/acme/acme-web'])
    expect(s.source).toBe('github')
    expect(s.fullName).toBe('acme/acme-web')
    expect(s.description).toBe('Online ordering for neighbourhood bakeries')
    expect(s.homepage).toBe('https://acme.com')
    expect(s.primaryLanguage).toBe('TypeScript')
    expect(s.stack).toEqual(['TypeScript'])
    expect(s.readmeHeading).toBe('Acme Web')
    expect(s.readmeLink).toBe('https://acme.com/about')
    expect(allStrings(s)).not.toContain(TOKEN)
    const { listing: _l, ...summary } = s
    expect(() => RepoScanSummarySchema.parse(summary)).not.toThrow()
  })
  it('a missing README is fine', async () => {
    const s = await scanGithub('acme/acme-web', { exec: fakeExec({ 'repos/acme/acme-web': routes['repos/acme/acme-web'] }), env: {} })
    expect(s.readmeLine).toBeUndefined()
    expect(s.description).toBeTruthy()
  })
  it('refuses a bad name before running anything', async () => {
    const calls: string[][] = []
    await expect(scanGithub('acme/..', { exec: fakeExec({}, calls), env: {} })).rejects.toThrow()
    await expect(scanGithub('-x/y', { exec: fakeExec({}, calls), env: {} })).rejects.toThrow()
    expect(calls).toHaveLength(0)
  })
})

describe('runScan', () => {
  it('combines local and GitHub; a failed GitHub read is a warning', async () => {
    const r = await runScan({ paths: [fixture('next-app')], github: { fullName: 'acme/missing' } }, { exec: fakeExec({}), env: {} })
    expect(r.repos).toHaveLength(1)
    expect(r.summary.stack[0]).toBe('Next.js')
    expect(r.warnings).toEqual(["Couldn't read acme/missing: not found"])
    expect(r.partial).toBe(false)
    expect(r.elapsedMs).toBeGreaterThanOrEqual(0)
  })
  it('gh not installed', async () => {
    const exec: GhExec = () => ({ promise: Promise.resolve({ code: null, stdout: '', stderr: 'spawn gh ENOENT', timedOut: false, spawnError: 'spawn gh ENOENT' }), kill: async () => undefined })
    const r = await runScan({ github: { fullName: 'acme/web' } }, { exec, env: {} })
    expect(r.warnings[0]).toContain('not installed')
  })
  it('scans write nothing', async () => {
    const dir = fixture('next-app', '[remote "origin"]\n\turl = https://github.com/acme/acme-web.git\n')
    const snap = (d: string): string[] => fs.readdirSync(d, { recursive: true }).map(String).sort()
    const before = snap(dir)
    await runScan({ paths: [dir] })
    expect(snap(dir)).toEqual(before)
  })
})

describe('inspectFolders', () => {
  const store = (rows: Record<string, { id: string; companyId: string }>): FolderStore => ({
    getRepoByPath: (p) => rows[p] ?? null,
    companyName: (id) => (id === PERSONAL_COMPANY_ID ? 'Personal' : id === 'co_acme' ? 'Acme' : null)
  })
  it('realpaths, de-duplicates and reports git, owner and blocks', () => {
    const git = fixture('next-app', '')
    const plain = fixture('bare')
    const personal = fixture('rust-app', '')
    const acme = fixture('python-app')
    const link = path.join(tmp, `link-${Date.now()}`)
    fs.symlinkSync(git, link)
    const file = path.join(plain, 'notes.txt')
    const res = inspectFolders([link, git, plain, personal, acme, file, path.join(tmp, 'missing')], store({ [personal]: { id: 'r1', companyId: PERSONAL_COMPANY_ID }, [acme]: { id: 'r2', companyId: 'co_acme' } }))
    expect(res.map((r) => r.path)).toEqual([git, plain, personal, acme, file, path.join(tmp, 'missing')])
    expect(res[0]).toMatchObject({ isGit: true, ownedBy: null })
    expect(res[0].blockedReason).toBeUndefined()
    expect(res[1]).toMatchObject({ isGit: false, ownedBy: null })
    expect(res[2]).toMatchObject({ existingRepoId: 'r1', ownedBy: { companyId: PERSONAL_COMPANY_ID, name: 'Personal', personal: true } })
    expect(res[2].blockedReason).toBeUndefined()
    expect(res[3]).toMatchObject({ existingRepoId: 'r2', ownedBy: { companyId: 'co_acme', name: 'Acme', personal: false }, blockedReason: "Belongs to Acme, can't add" })
    expect(res[4].blockedReason).toBe('Not a folder')
    expect(res[5].blockedReason).toBe('Folder not found')
  })
  it('refuses the home folder and the disk root', () => {
    const res = inspectFolders([os.homedir(), '/'], store({}))
    expect(res[0].blockedReason).toMatch(/home folder/)
    expect(res[1].blockedReason).toMatch(/whole disk/)
  })
})
