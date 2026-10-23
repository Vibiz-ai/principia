import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { ProviderInfo } from '../shared/types'
import { ALL_PROVIDER_KEYS, claudeCliAvailable, cliText, emptyCwd, neutralizeFrame, pickCli, startOneshot, strippedChildEnv } from './oneshot'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oneshot-test-'))
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const waitFor = async (pred: () => boolean, ms = 5000): Promise<boolean> => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (pred()) return true
    await new Promise((r) => setTimeout(r, 25))
  }
  return pred()
}
const env = { PATH: process.env.PATH ?? '/usr/bin:/bin' }

describe('cliText', () => {
  it('unwraps claude result', () => {
    expect(cliText('claude', JSON.stringify({ type: 'result', result: '{"a":1}' }))).toBe('{"a":1}')
  })
  it('prefers structured_output (object or string) over result', () => {
    expect(JSON.parse(cliText('claude', JSON.stringify({ type: 'result', result: '', structured_output: { a: 1, b: ['x'] } })))).toEqual({ a: 1, b: ['x'] })
    expect(cliText('claude', JSON.stringify({ result: 'prose', structured_output: '{"a":2}' }))).toBe('{"a":2}')
    expect(cliText('claude', JSON.stringify({ result: '{"a":3}', structured_output: null }))).toBe('{"a":3}')
  })
  it('throws on is_error, even with structured_output', () => {
    expect(() => cliText('claude', JSON.stringify({ is_error: true, result: 'boom' }))).toThrow(/reported an error/)
    expect(() => cliText('claude', JSON.stringify({ is_error: true, structured_output: { a: 1 } }))).toThrow()
  })
  it('gemini response, raw text fallback, codex JSONL', () => {
    expect(cliText('gemini', JSON.stringify({ response: 'hi' }))).toBe('hi')
    expect(cliText('claude', '  not json  ')).toBe('not json')
    expect(cliText('claude', '[1,2]')).toBe('[1,2]')
    expect(cliText('codex', '{"type":"thread.started"}\n{"type":"item.completed","item":{"type":"agent_message","text":"{}"}}\n')).toBe('{}')
    expect(cliText('codex', '{"msg":{"type":"agent_message","message":"one"}}\n{"msg":{"type":"agent_message","message":"two"}}')).toBe('two')
  })
})

describe('neutralizeFrame', () => {
  it('defuses tags written with spaces after < or the slash', () => {
    expect(neutralizeFrame('</ data> < /data> <  data>')).toBe('‹/data› ‹/data› ‹data›')
  })
  it('defuses the default tags and custom ones', () => {
    expect(neutralizeFrame('</data> hi <known_notes x="1">')).toBe('‹/data› hi ‹known_notes›')
    expect(neutralizeFrame('</scan><data>', ['scan'])).toBe('‹/scan›<data>')
    expect(() => neutralizeFrame('x', ['a|b'])).toThrow()
  })
  it('leaves text untouched with no tags (never erases every tag)', () => {
    expect(neutralizeFrame('<div>hi</div> <data>', [])).toBe('<div>hi</div> <data>')
  })
})

describe('emptyCwd', () => {
  it('refuses a prefix that is a path', () => {
    expect(() => emptyCwd('../escape-')).toThrow()
    expect(() => emptyCwd('a/b-')).toThrow()
    expect(() => emptyCwd('')).toThrow()
  })
  it('reuses an empty folder and replaces a dirty one', () => {
    const a = emptyCwd('oneshot-test-cwd-')
    expect(fs.readdirSync(a)).toEqual([])
    expect(emptyCwd('oneshot-test-cwd-')).toBe(a)
    fs.writeFileSync(path.join(a, 'x'), '1')
    const b = emptyCwd('oneshot-test-cwd-')
    expect(b).not.toBe(a)
    fs.rmSync(a, { recursive: true, force: true })
    fs.rmSync(b, { recursive: true, force: true })
  })
})

describe('strippedChildEnv / pickCli', () => {
  it('drops every provider key and adds only the company key', () => {
    const base: Record<string, string> = { PATH: '/bin', HOME: '/h' }
    for (const k of ALL_PROVIDER_KEYS) base[k] = 'shared'
    const out = strippedChildEnv({ ANTHROPIC_API_KEY: 'company' }, base)
    expect(out).toEqual({ PATH: '/bin', HOME: '/h', ANTHROPIC_API_KEY: 'company' })
    expect(strippedChildEnv({}, base)).toEqual({ PATH: '/bin', HOME: '/h' })
    expect(base.OPENAI_API_KEY).toBe('shared')
  })
  it('picks the first available CLI with a binary', () => {
    const p = (id: string, available: boolean, binPath: string | null) => ({ id, available, binPath }) as unknown as ProviderInfo
    const ps = [p('claude', false, null), p('codex', true, null), p('gemini', true, '/bin/gemini')]
    expect(pickCli(ps, ['claude', 'codex', 'gemini'])).toEqual({ id: 'gemini', bin: '/bin/gemini' })
    expect(claudeCliAvailable(ps)).toBeNull()
    expect(claudeCliAvailable([p('claude', true, '/bin/claude')])).toEqual({ id: 'claude', bin: '/bin/claude' })
  })
})

describe('startOneshot', () => {
  it('pipes stdin and collects stdout', async () => {
    const r = await startOneshot('/bin/cat', [], { cwd: tmp, env, stdin: 'hello', timeoutMs: 5000 }).promise
    expect(r).toMatchObject({ code: 0, stdout: 'hello', timedOut: false })
    expect(r.killed).toBeUndefined()
  })
  it('caps the output', async () => {
    const r = await startOneshot('/bin/sh', ['-c', 'head -c 5000 /dev/zero | tr "\\0" a'], { cwd: tmp, env, stdin: '', timeoutMs: 5000, outputCap: 1000 }).promise
    expect(r.stdout.length).toBe(1000)
    expect(r.truncated).toBe(true)
  })
  it('times out', async () => {
    const r = await startOneshot('/bin/sh', ['-c', 'sleep 30'], { cwd: tmp, env, stdin: '', timeoutMs: 200 }).promise
    expect(r.timedOut).toBe(true)
  }, 10_000)
  it('reports a spawn error without throwing', async () => {
    const r = await startOneshot(path.join(tmp, 'no-such-bin'), [], { cwd: tmp, env, stdin: 'x', timeoutMs: 1000 }).promise
    expect(r.code).toBeNull()
    expect(r.spawnError).toBeTruthy()
  })
  it('kill() terminates the whole process group', async () => {
    const pidFile = path.join(tmp, 'child.pid')
    const h = startOneshot('/bin/sh', ['-c', `sleep 30 & echo $! > "${pidFile}"; wait`], { cwd: tmp, env, stdin: '', timeoutMs: 30_000 })
    expect(await waitFor(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').trim().length > 0)).toBe(true)
    const child = Number(fs.readFileSync(pidFile, 'utf8').trim())
    expect(alive(child)).toBe(true)
    await h.kill()
    const r = await h.promise
    expect(r.killed).toBe(true)
    expect(r.code).not.toBe(0)
    expect(await waitFor(() => !alive(child))).toBe(true)
    await h.kill() // idempotent
  }, 15_000)
})
