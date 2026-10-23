import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  clone,
  cloneScratchDir,
  cloneTarget,
  CLONE_TIMEOUT_MS,
  filterRepos,
  ghEnv,
  ghStatus,
  GH_LIST_FIELDS,
  GH_LIST_TIMEOUT_MS,
  listRepos,
  parseProgressLine,
  parseRepoList,
  remoteIdentity,
  type CloneProgress,
  type GhExec,
  type GhRunOpts,
  type GhRunResult
} from '../github'

const GH = path.join(__dirname, 'fixtures', 'gh')
const read = (f: string): string => fs.readFileSync(path.join(GH, f), 'utf8')
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ob-gh-')))
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))
const TOKEN = ['ghp', '_', 'Q'.repeat(18), '4'.repeat(18)].join('')

interface Call {
  file: string
  args: string[]
  opts: GhRunOpts
}
/** Fake exec: `run` decides the result (and may write files to simulate git); records calls; kill resolves a pending run. */
function fake(run: (c: Call) => Partial<GhRunResult> | Promise<Partial<GhRunResult>>, calls: Call[] = []): GhExec & { killed: number } {
  const f = ((file: string, args: string[], opts: GhRunOpts) => {
    const c = { file, args, opts }
    calls.push(c)
    let killResolve: ((r: Partial<GhRunResult>) => void) | null = null
    const killedP = new Promise<Partial<GhRunResult>>((r) => (killResolve = r))
    const promise = Promise.race([Promise.resolve(run(c)), killedP]).then((r) => ({ code: 0, stdout: '', stderr: '', timedOut: false, ...r }))
    return {
      promise,
      kill: async () => {
        f.killed++
        killResolve!({ code: null, killed: true })
      }
    }
  }) as GhExec & { killed: number }
  f.killed = 0
  return f
}
const ENOENT: Partial<GhRunResult> = { code: null, spawnError: 'spawn gh ENOENT', stderr: 'spawn gh ENOENT' }

describe('ghStatus', () => {
  it('missing / signedOut / ok with login (new and old gh wording)', async () => {
    expect(await ghStatus({ exec: fake(() => ENOENT), env: {} })).toEqual({ gh: 'missing' })
    expect(await ghStatus({ exec: fake(() => ({ code: 1, stderr: 'You are not logged into any GitHub hosts.' })), env: {} })).toEqual({ gh: 'signedOut' })
    expect(await ghStatus({ exec: fake(() => ({ code: 0, stdout: read('auth-status-ok.txt') })), env: {} })).toEqual({ gh: 'ok', login: 'octocat' })
    expect(await ghStatus({ exec: fake(() => ({ code: 0, stderr: read('auth-status-old.txt') })), env: {} })).toEqual({ gh: 'ok', login: 'monalisa' })
    expect(await ghStatus({ exec: fake(() => ({ code: 0, stdout: 'something else' })), env: {} })).toEqual({ gh: 'ok' })
    expect(await ghStatus({ exec: fake(() => ({ code: null, timedOut: true })), env: {} })).toEqual({ gh: 'signedOut' })
  })
  it('runs gh auth status without prompts', async () => {
    const calls: Call[] = []
    await ghStatus({ exec: fake(() => ({}), calls), env: { PATH: '/bin' } })
    expect(calls[0].file).toBe('gh')
    expect(calls[0].args).toEqual(['auth', 'status', '--hostname', 'github.com'])
    expect(calls[0].opts.env).toMatchObject({ PATH: '/bin', GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0' })
  })
})

describe('listRepos', () => {
  it('runs gh repo list --limit 100 with the json fields, prompts off, 15 s', async () => {
    const calls: Call[] = []
    const repos = await listRepos(undefined, { exec: fake(() => ({ stdout: read('repo-list.json') }), calls), env: {} })
    expect(calls[0].args).toEqual(['repo', 'list', '--limit', '100', '--json', GH_LIST_FIELDS])
    expect(GH_LIST_FIELDS).toBe('name,owner,description,url,homepageUrl,primaryLanguage,isPrivate,pushedAt')
    expect(calls[0].opts.timeoutMs).toBe(GH_LIST_TIMEOUT_MS)
    expect(GH_LIST_TIMEOUT_MS).toBe(15_000)
    expect(calls[0].opts.env.GH_PROMPT_DISABLED).toBe('1')
    expect(repos).toEqual([
      { name: 'acme-web', owner: 'acme', fullName: 'acme/acme-web', description: 'Online ordering for bakeries', url: 'https://github.com/acme/acme-web', homepageUrl: 'https://acme.com', primaryLanguage: 'TypeScript', isPrivate: true, pushedAt: '2026-10-01T10:00:00Z' },
      { name: 'notes', owner: 'acme', fullName: 'acme/notes', description: null, url: 'https://github.com/acme/notes', homepageUrl: null, primaryLanguage: null, isPrivate: false, pushedAt: '2026-09-01T10:00:00Z' }
    ])
  })
  it('filters by query on name and description', async () => {
    const repos = parseRepoList(read('repo-list.json'))
    expect(filterRepos(repos, 'BAKER').map((r) => r.name)).toEqual(['acme-web'])
    expect(filterRepos(repos, 'acme/no').map((r) => r.name)).toEqual(['notes'])
    expect(filterRepos(repos, '  ')).toHaveLength(2)
    expect((await listRepos('notes', { exec: fake(() => ({ stdout: read('repo-list.json') })), env: {} })).map((r) => r.name)).toEqual(['notes'])
  })
  it('bad JSON is an empty list; descriptions are redacted', () => {
    expect(parseRepoList('not json')).toEqual([])
    expect(parseRepoList('{"a":1}')).toEqual([])
    const r = parseRepoList(JSON.stringify([{ name: 'x', owner: { login: 'o' }, description: `key ${TOKEN}`, url: `https://u:${TOKEN}@github.com/o/x` }]))
    expect(JSON.stringify(r)).not.toContain(TOKEN)
    expect(r[0].url).toBe('https://github.com/o/x')
  })
  it('missing gh, signed out and timeout throw founder copy', async () => {
    await expect(listRepos(undefined, { exec: fake(() => ENOENT), env: {} })).rejects.toThrow(/not installed/)
    await expect(listRepos(undefined, { exec: fake(() => ({ code: 1, stderr: 'auth' })), env: {} })).rejects.toThrow(/gh auth login/)
    await expect(listRepos(undefined, { exec: fake(() => ({ code: null, timedOut: true })), env: {} })).rejects.toThrow(/too long/)
  })
})

describe('clone sources', () => {
  it('accepts owner/repo, https, ssh:// and git@; strips credentials', () => {
    expect(cloneTarget({ fullName: 'acme/acme-web' })).toMatchObject({ kind: 'gh', arg: 'acme/acme-web', repo: 'acme-web', identity: 'github.com/acme/acme-web' })
    expect(cloneTarget({ url: `https://me:${TOKEN}@github.com/acme/acme-web.git` })).toMatchObject({ kind: 'git', arg: 'https://github.com/acme/acme-web.git', repo: 'acme-web' })
    expect(cloneTarget({ url: `https://${TOKEN}@gitlab.com/g/sub/proj` })).toMatchObject({ arg: 'https://gitlab.com/g/sub/proj', repo: 'proj' })
    expect(cloneTarget({ url: 'ssh://git:secret@github.com/acme/acme-web.git' })).toMatchObject({ arg: 'ssh://git@github.com/acme/acme-web.git', repo: 'acme-web' })
    expect(cloneTarget({ url: 'git@github.com:acme/acme-web.git' })).toMatchObject({ arg: 'git@github.com:acme/acme-web.git', repo: 'acme-web', identity: 'github.com/acme/acme-web' })
  })
  it.each([
    'http://github.com/a/b', 'file:///tmp/repo', 'ext::sh -c touch% /tmp/pwned', '--upload-pack=touch /tmp/x', '-c core.x=y', 'git://github.com/a/b',
    'https://github.com/a/..', 'https://github.com/', 'git@github.com:/etc/passwd', 'git@github.com:-oProxyCommand=x', 'https://github.com/a/b?x=1',
    'git@-oProxy:a/b', 'https://github.com/a/b c', 'ssh://-oProxyCommand=x/a/b', 'user@github.com:a/b'
  ])('refuses %s', (url) => {
    expect(() => cloneTarget({ url })).toThrow(/https:\/\/, ssh:\/\/ or git@/)
  })
  it('refuses bad full names', () => {
    for (const fullName of ['acme/..', 'acme/.', '-acme/web', 'acme', 'a/b/c']) expect(() => cloneTarget({ fullName })).toThrow()
  })
  it('remoteIdentity matches the same repo across forms', () => {
    const id = 'github.com/acme/acme-web'
    for (const r of ['https://github.com/acme/acme-web.git', 'https://x:y@github.com/Acme/acme-web', 'git@github.com:acme/acme-web.git', 'ssh://git@github.com/acme/acme-web', 'acme/acme-web']) expect(remoteIdentity(r)).toBe(id)
    expect(remoteIdentity('https://github.com/acme/other')).not.toBe(id)
    expect(remoteIdentity('nonsense')).toBeNull()
  })
  it('progress lines', () => {
    expect(parseProgressLine('Receiving objects:  45% (54/120)')).toEqual({ percent: 45, line: 'Receiving objects:  45% (54/120)' })
    expect(parseProgressLine('remote: Counting objects: 100% (1/1)')?.percent).toBeNull()
    expect(parseProgressLine('   ')).toBeNull()
  })
})

describe('clone', () => {
  let n = 0
  const parent = (): string => {
    const d = path.join(tmp, `parent-${n++}`)
    fs.mkdirSync(d)
    return d
  }
  const snap = (d: string): string[] => fs.readdirSync(d, { recursive: true }).map(String).sort()
  /** Simulates a successful git clone: writes dest/.git/config with the given origin, streams progress. */
  const gitOk = (origin: string) => (c: Call): Partial<GhRunResult> => {
    const dest = c.file === 'gh' ? c.args[3] : c.args[c.args.length - 1]
    fs.mkdirSync(path.join(dest, '.git'), { recursive: true })
    fs.writeFileSync(path.join(dest, '.git', 'config'), `[remote "origin"]\n\turl = ${origin}\n`)
    fs.writeFileSync(path.join(dest, 'README.md'), '# hi\n')
    for (const chunk of read('clone-progress.txt').match(/[\s\S]{1,37}/g)!) c.opts.onStderr?.(chunk)
    return { code: 0 }
  }

  it('gh repo clone with --filter=blob:none into <parent>/<repo>; progress parsed; writes only the destination', async () => {
    const p = parent()
    fs.writeFileSync(path.join(p, 'other.txt'), 'keep')
    const before = snap(p)
    const calls: Call[] = []
    const progress: CloneProgress[] = []
    const res = await clone({ fullName: 'acme/acme-web' }, p, (x) => progress.push(x), { exec: fake(gitOk('https://github.com/acme/acme-web.git'), calls), env: {} }).promise
    const dest = path.join(p, 'acme-web')
    expect(res).toEqual({ path: dest, reused: false, label: 'acme/acme-web' })
    expect(calls[0].file).toBe('gh')
    // written to the scratch folder, renamed into place once finished
    expect(calls[0].args).toEqual(['repo', 'clone', 'acme/acme-web', cloneScratchDir(p, 'acme-web'), '--', '--filter=blob:none', '--progress'])
    expect(fs.existsSync(cloneScratchDir(p, 'acme-web'))).toBe(false)
    expect(fs.existsSync(path.join(dest, '.git', 'config'))).toBe(true)
    expect(calls[0].opts).toMatchObject({ timeoutMs: CLONE_TIMEOUT_MS, cwd: p })
    expect(calls[0].opts.env).toMatchObject({ GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1', GIT_ALLOW_PROTOCOL: 'https:ssh' })
    expect(progress.map((x) => x.percent).filter((x) => x !== null)).toEqual([12, 45, 100, 100])
    expect(progress.every((x) => !/[\r\n]/.test(x.line))).toBe(true)
    // nothing outside <parent>/acme-web changed
    expect(snap(p).filter((f) => !f.startsWith('acme-web'))).toEqual(before)
  })

  it('git clone for a URL: credentials stripped, `--` before the URL', async () => {
    const p = parent()
    const calls: Call[] = []
    await clone({ url: `https://me:${TOKEN}@github.com/acme/site.git` }, p, undefined, { exec: fake(gitOk('https://github.com/acme/site.git'), calls), env: {} }).promise
    expect(calls[0].file).toBe('git')
    expect(calls[0].args).toEqual(['clone', '--filter=blob:none', '--progress', '--', 'https://github.com/acme/site.git', cloneScratchDir(p, 'site')])
    expect(fs.existsSync(path.join(p, 'site', '.git'))).toBe(true)
    expect(JSON.stringify(calls)).not.toContain(TOKEN)
  })

  it('refuses an existing folder that is not the same repo (and runs nothing)', async () => {
    const p = parent()
    const calls: Call[] = []
    fs.mkdirSync(path.join(p, 'acme-web'))
    fs.writeFileSync(path.join(p, 'acme-web', 'mine.txt'), 'x')
    const exec = fake(gitOk('x'), calls)
    await expect(clone({ fullName: 'acme/acme-web' }, p, undefined, { exec, env: {} }).promise).rejects.toThrow(/A folder named acme-web already exists in .*\. Choose another folder\./)
    // a git repo with another origin
    fs.mkdirSync(path.join(p, 'other', '.git'), { recursive: true })
    fs.writeFileSync(path.join(p, 'other', '.git', 'config'), '[remote "origin"]\n\turl = https://github.com/someone/else.git\n')
    await expect(clone({ fullName: 'acme/other' }, p, undefined, { exec, env: {} }).promise).rejects.toThrow(/already exists/)
    // a symlink with the repo's name
    fs.symlinkSync(tmp, path.join(p, 'linked'))
    await expect(clone({ fullName: 'acme/linked' }, p, undefined, { exec, env: {} }).promise).rejects.toThrow(/already exists/)
    expect(calls).toHaveLength(0)
    expect(fs.readFileSync(path.join(p, 'acme-web', 'mine.txt'), 'utf8')).toBe('x')
  })

  it('reuses an existing clone with the same origin', async () => {
    const p = parent()
    fs.mkdirSync(path.join(p, 'acme-web', '.git'), { recursive: true })
    fs.writeFileSync(path.join(p, 'acme-web', '.git', 'config'), `[remote "origin"]\n\turl = https://x:${TOKEN}@github.com/acme/acme-web.git\n`)
    const calls: Call[] = []
    const res = await clone({ url: 'git@github.com:acme/acme-web.git' }, p, undefined, { exec: fake(gitOk('x'), calls), env: {} }).promise
    expect(res).toEqual({ path: path.join(p, 'acme-web'), reused: true, label: 'git@github.com:acme/acme-web.git' })
    expect(calls).toHaveLength(0)
  })

  it('a failed clone removes only its partial folder; the error is scrubbed', async () => {
    const p = parent()
    fs.writeFileSync(path.join(p, 'keep.txt'), 'k')
    const exec = fake((c) => {
      fs.mkdirSync(path.join(c.args[c.args.length - 1], '.git'), { recursive: true })
      c.opts.onStderr?.(`Cloning into 'x'...\nfatal: unable to access 'https://u:${TOKEN}@github.com/acme/x.git/': 403\n`)
      return { code: 128 }
    })
    const err = await clone({ url: 'https://github.com/acme/x.git' }, p, undefined, { exec, env: {} }).promise.catch((e: Error) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toMatch(/^Couldn't clone https:\/\/github.com\/acme\/x.git: fatal: unable to access/)
    expect((err as Error).message).not.toContain(TOKEN)
    expect(fs.readdirSync(p)).toEqual(['keep.txt'])
  })

  it('timeout and kill', async () => {
    const p = parent()
    await expect(clone({ fullName: 'acme/slow' }, p, undefined, { exec: fake(() => ({ code: null, timedOut: true })), env: {} }).promise).rejects.toThrow(/longer than 5 minutes/)
    const exec = fake(() => new Promise<Partial<GhRunResult>>(() => undefined))
    const job = clone({ fullName: 'acme/hang' }, p, undefined, { exec, env: {} })
    await job.kill()
    await expect(job.promise).rejects.toThrow(/cancelled/)
    expect(exec.killed).toBe(1)
    expect(fs.existsSync(path.join(p, 'hang'))).toBe(false)
  })

  it('a missing parent is refused unless createParent; a relative parent is refused', async () => {
    const missing = path.join(tmp, `nope-${n++}`, 'Projects')
    await expect(clone({ fullName: 'acme/a' }, missing, undefined, { exec: fake(gitOk('https://github.com/acme/a')), env: {} }).promise).rejects.toThrow(/doesn't exist/)
    expect(fs.existsSync(missing)).toBe(false)
    const res = await clone({ fullName: 'acme/a' }, missing, undefined, { exec: fake(gitOk('https://github.com/acme/a')), env: {}, createParent: true }).promise
    expect(res.path).toBe(path.join(fs.realpathSync(missing), 'a'))
    await expect(clone({ fullName: 'acme/a' }, 'relative/dir', undefined, { exec: fake(() => ({})), env: {} }).promise).rejects.toThrow(/Choose a folder/)
  })

  it('bad sources are refused before anything runs', async () => {
    const calls: Call[] = []
    await expect(clone({ url: 'file:///etc' }, parent(), undefined, { exec: fake(() => ({}), calls), env: {} }).promise).rejects.toThrow()
    await expect(clone({ fullName: 'acme/..' }, parent(), undefined, { exec: fake(() => ({}), calls), env: {} }).promise).rejects.toThrow()
    expect(calls).toHaveLength(0)
  })

  it('the destination never holds a half clone; a crashed attempt is cleared and redone (resume)', async () => {
    const p = parent()
    // an app killed mid-clone left its scratch folder behind (with an origin already written)
    const scratch = cloneScratchDir(p, 'acme-web')
    fs.mkdirSync(path.join(scratch, '.git'), { recursive: true })
    fs.writeFileSync(path.join(scratch, '.git', 'config'), '[remote "origin"]\n\turl = https://github.com/acme/acme-web.git\n')
    fs.writeFileSync(path.join(scratch, 'half.txt'), 'partial')
    let destDuringClone: boolean | null = null
    const calls: Call[] = []
    const exec = fake((c) => {
      destDuringClone = fs.existsSync(path.join(p, 'acme-web'))
      expect(fs.existsSync(path.join(scratch, 'half.txt'))).toBe(false)
      return gitOk('https://github.com/acme/acme-web.git')(c)
    }, calls)
    const res = await clone({ fullName: 'acme/acme-web' }, p, undefined, { exec, env: {} }).promise
    expect(res.reused).toBe(false)
    expect(calls).toHaveLength(1)
    expect(destDuringClone).toBe(false)
    expect(fs.readdirSync(p)).toEqual(['acme-web'])
    expect(fs.existsSync(path.join(p, 'acme-web', 'half.txt'))).toBe(false)
  })

  it('a kill mid-clone leaves no destination, so a retry clones again instead of reusing a half repo', async () => {
    const p = parent()
    const exec = fake((c) => {
      fs.mkdirSync(path.join(c.args[3], '.git'), { recursive: true })
      fs.writeFileSync(path.join(c.args[3], '.git', 'config'), '[remote "origin"]\n\turl = https://github.com/acme/w.git\n')
      return new Promise<Partial<GhRunResult>>(() => undefined)
    })
    const job = clone({ fullName: 'acme/w' }, p, undefined, { exec, env: {} })
    await new Promise((r) => setTimeout(r, 5))
    await job.kill()
    await expect(job.promise).rejects.toThrow(/cancelled/)
    expect(fs.readdirSync(p)).toEqual([])
    const calls: Call[] = []
    const res = await clone({ fullName: 'acme/w' }, p, undefined, { exec: fake(gitOk('https://github.com/acme/w.git'), calls), env: {} }).promise
    expect(res).toMatchObject({ reused: false })
    expect(calls).toHaveLength(1)
  })

  it('a Retry while the same clone runs joins it; another repo with the same folder name is refused', async () => {
    const p = parent()
    let release: () => void = () => undefined
    const calls: Call[] = []
    const exec = fake(async (c) => {
      await new Promise<void>((r) => (release = r))
      return gitOk('https://github.com/acme/web.git')(c)
    }, calls)
    const first = clone({ fullName: 'acme/web' }, p, undefined, { exec, env: {} })
    const again = clone({ url: 'https://github.com/acme/web.git' }, p, undefined, { exec, env: {} })
    const other = clone({ fullName: 'someone/web' }, p, undefined, { exec, env: {} })
    await expect(other.promise).rejects.toThrow(/A folder named web already exists/)
    await new Promise((r) => setTimeout(r, 5))
    release()
    const [a, b] = await Promise.all([first.promise, again.promise])
    expect(a).toEqual(b)
    expect(calls).toHaveLength(1)
    // once finished, the next call reuses the completed clone
    expect((await clone({ fullName: 'acme/web' }, p, undefined, { exec, env: {} }).promise).reused).toBe(true)
  })

  it('reuse reads origin only from a regular .git/config inside the folder', async () => {
    const p = parent()
    const outside = path.join(tmp, `outside-${n++}`)
    fs.writeFileSync(outside, '[remote "origin"]\n\turl = https://github.com/acme/linkcfg.git\n')
    fs.mkdirSync(path.join(p, 'linkcfg', '.git'), { recursive: true })
    fs.symlinkSync(outside, path.join(p, 'linkcfg', '.git', 'config'))
    const calls: Call[] = []
    await expect(clone({ fullName: 'acme/linkcfg' }, p, undefined, { exec: fake(() => ({}), calls), env: {} }).promise).rejects.toThrow(/already exists/)
    expect(calls).toHaveLength(0)
  })

  it('ghEnv never prompts and keeps a user ssh command', () => {
    expect(ghEnv({ GIT_ASKPASS: '/x', SSH_ASKPASS: '/y' })).toMatchObject({ GIT_SSH_COMMAND: 'ssh -o BatchMode=yes', GIT_TERMINAL_PROMPT: '0' })
    expect(ghEnv({ GIT_ASKPASS: '/x' }).GIT_ASKPASS).toBeUndefined()
    expect(ghEnv({ GIT_SSH_COMMAND: 'ssh -i k' }).GIT_SSH_COMMAND).toBe('ssh -i k')
  })
})
