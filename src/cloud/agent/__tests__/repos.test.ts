import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { askpassScript, gitFailureDetail, repoFolderName, scrubToken, syncRepo } from '../repos'
import { ProcessSandbox } from '../sandbox'
import { tmp } from './fakes'

const TOKEN = 'github_pat_11ABCDEFG0123456789_secretsecretsecretsecret'
const URL = 'https://github.com/acme/site.git'
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'pipe' }).toString()

/** A bare repo with main and dev, and a fake `git` that logs argv/env, exercises GIT_ASKPASS, then runs real git against the bare repo. */
function fixture() {
  const root = tmp()
  const src = join(root, 'src')
  mkdirSync(src)
  git(src, 'init', '-q', '-b', 'main')
  writeFileSync(join(src, 'README.md'), 'hello\n')
  git(src, 'add', '.')
  git(src, 'commit', '-qm', 'init')
  git(src, 'checkout', '-qb', 'dev')
  writeFileSync(join(src, 'dev.txt'), 'dev\n')
  git(src, 'add', '.')
  git(src, 'commit', '-qm', 'dev')
  git(src, 'checkout', '-q', 'main')
  const bare = join(root, 'site.git')
  git(root, 'clone', '-q', '--bare', src, bare)
  const log = join(root, 'git.log')
  const fake = join(root, 'fake-git')
  writeFileSync(
    fake,
    `#!/usr/bin/env node
const { spawnSync, execFileSync } = require('node:child_process'); const fs = require('node:fs')
const args = process.argv.slice(2)
const rec = { args, env: process.env }
if ((args.includes('clone') || args.includes('fetch')) && process.env.GIT_ASKPASS) {
  const script = fs.readFileSync(process.env.GIT_ASKPASS, 'utf8')
  const file = /cat '([^']+)'/.exec(script)[1]
  const user = execFileSync(process.env.GIT_ASKPASS, ["Username for 'https://github.com': "]).toString().trim()
  const pw = execFileSync(process.env.GIT_ASKPASS, ["Password for 'https://x-access-token@github.com': "]).toString().trim()
  rec.askpass = { user, pwMatches: pw === ${JSON.stringify(TOKEN)}, tokenFileMode: (fs.statSync(file).mode & 0o777).toString(8), scriptMode: (fs.statSync(process.env.GIT_ASKPASS).mode & 0o777).toString(8) }
}
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(rec) + '\\n')
const real = ['-c', ${JSON.stringify(`url.file://${bare}.insteadOf=${URL}`)}, ...args]
const r = spawnSync('git', real, { stdio: 'inherit', env: process.env })
process.exit(r.status ?? 1)
`
  )
  chmodSync(fake, 0o755)
  const sandbox = new ProcessSandbox({ runtimeDir: join(root, 'runtime'), workspaceDir: join(root, 'workspace'), hostEnv: { PATH: process.env.PATH } })
  const deps = {
    git: fake,
    baseEnv: () => sandbox.baseEnv(),
    companyDir: (id: string) => sandbox.companyDir(id),
    tmpDir: join(root, 'runtime', 'tmp'),
    hooksDir: join(root, 'runtime', 'push-guard'),
    redact: (s: string) => s.split(TOKEN).join('[REDACTED]')
  }
  return { root, log, deps, sandbox, src, bare }
}

describe('repos: GIT_ASKPASS token hygiene', () => {
  it('clones with the token only through askpass: never argv, env, the remote URL or .git/config', async () => {
    const f = fixture()
    const r = await syncRepo(f.deps, 'co_acme', { id: 'repo_1', name: 'site', url: URL, branch: null, token: TOKEN })
    expect(r).toEqual({ ok: true, detail: 'Cloned · main' })
    const dest = join(f.sandbox.companyDir('co_acme'), 'site')
    expect(readFileSync(join(dest, 'README.md'), 'utf8')).toBe('hello\n')
    const lines = readFileSync(f.log, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    // the token reached git through askpass only
    const clone = lines.find((l) => l.args.includes('clone'))
    expect(clone.askpass).toEqual({ user: 'x-access-token', pwMatches: true, tokenFileMode: '600', scriptMode: '700' })
    expect(readFileSync(f.log, 'utf8')).not.toContain(TOKEN)
    expect(clone.args).toContain('credential.helper=')
    expect(clone.env.GIT_TERMINAL_PROMPT).toBe('0')
    const config = readFileSync(join(dest, '.git', 'config'), 'utf8')
    expect(config).not.toContain(TOKEN)
    expect(config).toContain(`url = ${URL}`)
    expect(config).toContain(`hooksPath = ${f.deps.hooksDir}`)
    expect(existsSync(join(f.deps.hooksDir, 'pre-push'))).toBe(true)
    // the askpass folder is gone
    expect(readdirSync(f.deps.tmpDir)).toEqual([])
  })

  it('fetches and moves a branch on the next sync; a public repo gets no askpass', async () => {
    const f = fixture()
    await syncRepo(f.deps, 'co_acme', { id: 'repo_1', name: 'site', url: URL, branch: null, token: null })
    const lines = readFileSync(f.log, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    expect(lines.every((l) => !l.env.GIT_ASKPASS)).toBe(true)
    const r = await syncRepo(f.deps, 'co_acme', { id: 'repo_1', name: 'site', url: URL, branch: 'dev', token: TOKEN })
    expect(r).toEqual({ ok: true, detail: 'Cloned · dev' })
    expect(existsSync(join(f.sandbox.companyDir('co_acme'), 'site', 'dev.txt'))).toBe(true)
  })

  it('refuses non-GitHub URLs and bad branch names; failures are plain sentences', async () => {
    const f = fixture()
    expect(await syncRepo(f.deps, 'co_acme', { id: 'r', name: 'x', url: 'http://github.com/acme/site', branch: null, token: null })).toEqual({ ok: false, detail: 'Only https://github.com/<owner>/<repo> repositories are supported.' })
    expect(await syncRepo(f.deps, 'co_acme', { id: 'r', name: 'x', url: 'https://gitlab.com/acme/site', branch: null, token: null })).toMatchObject({ ok: false })
    expect(await syncRepo(f.deps, 'co_acme', { id: 'r', name: 'x', url: URL, branch: '--upload-pack=evil', token: null })).toEqual({ ok: false, detail: 'That branch name is not valid.' })
    expect(gitFailureDetail('remote: Invalid username or password.\nfatal: Authentication failed', 'acme/site')).toBe('GitHub said the token cannot read acme/site.')
    expect(gitFailureDetail('fatal: repository not found', 'acme/site')).toBe('GitHub could not find acme/site, or the token cannot see it.')
    expect(repoFolderName({ name: '../evil', url: URL })).toBe('evil')
    expect(askpassScript("/tmp/it's/token")).toContain(`cat '/tmp/it'\\''s/token'`)
  })

  it('scrubs a token that shows up in .git/config', () => {
    const f = fixture()
    const cfg = join(f.root, 'config')
    writeFileSync(cfg, `[remote "origin"]\n\turl = https://x:${TOKEN}@github.com/acme/site.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`)
    expect(scrubToken(cfg, TOKEN)).toBe(true)
    expect(readFileSync(cfg, 'utf8')).not.toContain(TOKEN)
    expect(scrubToken(cfg, TOKEN)).toBe(false)
  })
})
