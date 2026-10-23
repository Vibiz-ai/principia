import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { gitConfigValue, originFromConfig, readOriginRemote } from '../gitConfig'

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ob-gitcfg-')))
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))
const TOKEN = ['ghp', '_', 'W'.repeat(18), '3'.repeat(18)].join('')

describe('gitConfig', () => {
  it('parses values like git: quotes, escapes, comments', () => {
    expect(gitConfigValue('"https://a/b" # c')).toBe('https://a/b')
    expect(gitConfigValue('x\\"y ; z')).toBe('x"y')
  })
  it('prefers origin, falls back to the first remote, strips credentials', () => {
    expect(originFromConfig(`[remote "up"]\n\turl = https://h/up\n[remote "origin"]\n\turl = "https://u:${TOKEN}@github.com/a/b.git"\n`)).toBe('https://github.com/a/b.git')
    expect(originFromConfig('[remote "up"]\n\turl = git@h:a/up.git\n')).toBe('git@h:a/up.git')
    expect(originFromConfig('[core]\n\tbare = false\n')).toBeNull()
  })
  it('reads only a regular config inside the repo', () => {
    const repo = path.join(tmp, 'r')
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true })
    expect(readOriginRemote(repo)).toBeNull()
    fs.writeFileSync(path.join(tmp, 'outside'), '[remote "origin"]\n\turl = https://evil/x\n')
    fs.symlinkSync(path.join(tmp, 'outside'), path.join(repo, '.git', 'config'))
    expect(readOriginRemote(repo)).toBeNull()
    fs.unlinkSync(path.join(repo, '.git', 'config'))
    fs.writeFileSync(path.join(repo, '.git', 'config'), '[remote "origin"]\n\turl = https://github.com/a/b\n')
    expect(readOriginRemote(repo)).toBe('https://github.com/a/b')
  })
})
