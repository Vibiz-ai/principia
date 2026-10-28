import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { expectFast } from './perf'
import { budget, DEFAULT_TIME_SCALE, isPerfRun, timeScale } from './timing'

describe('test time budgets', () => {
  it('defaults to headroom for a busy machine', () => {
    expect(timeScale(undefined)).toBe(DEFAULT_TIME_SCALE)
    expect(DEFAULT_TIME_SCALE).toBeGreaterThan(1)
  })

  it('TEST_TIME_SCALE sets the scale, 1 is the strict perf run', () => {
    expect(timeScale('1')).toBe(1)
    expect(timeScale('2.5')).toBe(2.5)
    expect(budget(100, 1)).toBe(100)
    expect(budget(50, 2.5)).toBe(125)
  })

  it('ignores a bad value instead of turning every limit into 0 or NaN', () => {
    for (const bad of ['', ' ', 'fast', '0', '-2', 'Infinity']) expect(timeScale(bad)).toBe(DEFAULT_TIME_SCALE)
  })

  it('reads the env by default', () => {
    expect(budget(10)).toBe(Math.round(10 * timeScale()))
  })
})

describe('speed checks', () => {
  it('only test:perf enforces them', () => {
    expect(isPerfRun(undefined)).toBe(false)
    expect(isPerfRun('0')).toBe(false)
    expect(isPerfRun('1')).toBe(true)
  })

  afterEach(() => vi.unstubAllEnvs())

  it('expectFast fails a slow run only under test:perf', () => {
    vi.stubEnv('TEST_PERF', '')
    expect(() => expectFast(900, 50)).not.toThrow()
    vi.stubEnv('TEST_PERF', '1')
    expect(() => expectFast(900, 50, 'the layout')).toThrow(/the layout took 900 ms, limit 50 ms/)
    expect(() => expectFast(10, 50)).not.toThrow()
  })

  it('every file with an expectFast check runs in npm run test:perf, strict and one file at a time', () => {
    const root = join(__dirname, '..', '..')
    const script = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts['test:perf']
    expect(script).toMatch(/^TEST_PERF=1 TEST_TIME_SCALE=1 vitest run --no-file-parallelism /)
    const listed = script.split(' ').filter((a) => a.endsWith('.test.ts')).sort()
    const callers = execFileSync('git', ['grep', '-l', 'expectFast(', '--', 'src/*.test.ts'], { cwd: root, encoding: 'utf8' })
      .split('\n')
      .filter((f) => f && f !== 'src/test/timing.test.ts')
      .sort()
    expect(callers.length).toBeGreaterThan(0)
    expect(listed).toEqual(callers)
  })
})
