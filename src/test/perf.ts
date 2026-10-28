import { expect } from 'vitest'
import { isPerfRun } from './timing'

/**
 * A speed check: `elapsedMs` must stay under `limitMs` (idle-laptop numbers). Enforced only in `npm run test:perf`;
 * in `npm test` a busy machine must not fail the suite, and a runaway still hits the scaled test timeout.
 * A file that calls this must be listed in package.json's test:perf script (src/test/timing.test.ts checks it).
 */
export function expectFast(elapsedMs: number, limitMs: number, what = 'it'): void {
  if (isPerfRun()) expect(elapsedMs, `${what} took ${Math.round(elapsedMs)} ms, limit ${limitMs} ms`).toBeLessThan(limitMs)
}
