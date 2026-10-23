import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { cleanRemote, fsRepoMeta } from './repoMeta'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'repometa-test-'))
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

function repo(name: string, gitConfig: string | null, readme?: [string, string]): string {
  const d = path.join(tmp, name)
  fs.mkdirSync(path.join(d, '.git'), { recursive: true })
  if (gitConfig !== null) fs.writeFileSync(path.join(d, '.git', 'config'), gitConfig)
  if (readme) fs.writeFileSync(path.join(d, readme[0]), readme[1])
  return d
}

describe('cleanRemote', () => {
  it('strips credentials from URL remotes', () => {
    expect(cleanRemote('https://x-access-token:ghp_abc123@github.com/acme/web.git')).toBe('https://github.com/acme/web.git')
    expect(cleanRemote('https://oauth2:glpat-xyz@gitlab.com/acme/web')).toBe('https://gitlab.com/acme/web')
    expect(cleanRemote('https://ghp_tokenonly@github.com/acme/web.git')).toBe('https://github.com/acme/web.git')
    expect(cleanRemote('ssh://git@github.com/acme/web.git')).toBe('ssh://github.com/acme/web.git')
    expect(cleanRemote('git+ssh://me:tok_1@host.example/acme/web')).toBe('git+ssh://host.example/acme/web')
    expect(cleanRemote('git+https://me:tok_2@host.example/acme/web')).toBe('git+https://host.example/acme/web')
    expect(cleanRemote('https://gitlab.com/acme/web.git?access_token=glpat-abc#x')).toBe('https://gitlab.com/acme/web.git')
  })
  it('leaves clean remotes alone', () => {
    expect(cleanRemote('https://github.com/acme/web.git')).toBe('https://github.com/acme/web.git')
    expect(cleanRemote('git@github.com:acme/web.git')).toBe('git@github.com:acme/web.git')
  })
})

describe('fsRepoMeta', () => {
  it('reads origin without its credentials and the README first line', () => {
    const d = repo(
      'a',
      '[core]\n\tbare = false\n[remote "upstream"]\n\turl = https://github.com/other/x.git\n[remote "origin"]\n\turl = https://me:ghp_secret@github.com/acme/web.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n',
      ['README.md', '<p align="center"><img src="x.png"></p>\n\n# Acme Web\n\nMore text\n']
    )
    const m = fsRepoMeta(d)
    expect(m).toEqual({ remote: 'https://github.com/acme/web.git', readme: 'Acme Web' })
    expect(JSON.stringify(m)).not.toContain('ghp_secret')
  })
  it('strips credentials from a quoted or commented url value', () => {
    const d = repo('q', '[remote "origin"]\n\turl = "https://me:ghp_quoted@github.com/acme/web.git" ; note\n')
    expect(fsRepoMeta(d).remote).toBe('https://github.com/acme/web.git')
    const e = repo('q2', '[remote "origin"]\n\turl = https://me:ghp_comment@github.com/acme/web.git # mine\n')
    expect(fsRepoMeta(e).remote).toBe('https://github.com/acme/web.git')
    expect(fsRepoMeta(repo('q3', '[remote "origin"]\n\turl = ""\n')).remote).toBeNull()
  })
  it('falls back to any remote, and handles missing files', () => {
    const d = repo('b', '[remote "upstream"]\n\turl = https://u:p@example.com/r.git\n')
    expect(fsRepoMeta(d)).toEqual({ remote: 'https://example.com/r.git', readme: null })
    expect(fsRepoMeta(repo('c', null))).toEqual({ remote: null, readme: null })
    expect(fsRepoMeta(path.join(tmp, 'missing'))).toEqual({ remote: null, readme: null })
  })
  it('caps a long README line', () => {
    const d = repo('d', null, ['README', `${'x'.repeat(500)}\n`])
    const r = fsRepoMeta(d).readme!
    expect(r.length).toBe(200)
    expect(r.endsWith('…')).toBe(true)
  })
})

describe('fsRepoMeta file safety', () => {
  it.skipIf(process.platform === 'win32')('never blocks on a FIFO named README.md or .git/config', () => {
    const d = repo('fifo', null)
    execFileSync('mkfifo', [path.join(d, '.git', 'config')])
    execFileSync('mkfifo', [path.join(d, 'README.md')])
    expect(fsRepoMeta(d)).toEqual({ remote: null, readme: null })
  })

  it('never reads a README or config symlinked from outside the repo', () => {
    const outside = path.join(tmp, 'outside-secret.md')
    fs.writeFileSync(outside, '# Top secret line\n')
    const cfg = path.join(tmp, 'outside-config')
    fs.writeFileSync(cfg, '[remote "origin"]\n  url = https://github.com/evil/x.git\n')
    const d = repo('symlinked', null)
    fs.symlinkSync(outside, path.join(d, 'README.md'))
    fs.symlinkSync(cfg, path.join(d, '.git', 'config'))
    expect(fsRepoMeta(d)).toEqual({ remote: null, readme: null })
  })
})
