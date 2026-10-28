/**
 * Wall-clock limits in tests. A busy machine (the parallel suite, agents running, a shared CI runner) makes code
 * slower without making it wrong, so `npm test` must not fail on a stopwatch. Two kinds of limit:
 * - waits (a poll deadline, a fake host's delay, a test timeout): written for an idle laptop and scaled with
 *   budget(): TEST_TIME_SCALE (default 5) multiplies them. Scale a "we did not wait for X" limit and X together.
 * - speed checks ("lays out 150 nodes in under 100 ms"): expectFast() in ./perf, enforced only by
 *   `npm run test:perf` (TEST_PERF=1, scale 1, one file at a time, on an idle machine). `npm test` still runs the code.
 */
export const DEFAULT_TIME_SCALE = 5

export function timeScale(raw: string | undefined = process.env.TEST_TIME_SCALE): number {
  const n = Number(raw)
  return raw !== undefined && raw.trim() !== '' && Number.isFinite(n) && n > 0 ? n : DEFAULT_TIME_SCALE
}

/** `ms` as written for an idle laptop, scaled for this run. */
export const budget = (ms: number, scale = timeScale()): number => Math.round(ms * scale)

/** True in `npm run test:perf`, where speed checks are enforced. */
export const isPerfRun = (raw: string | undefined = process.env.TEST_PERF): boolean => raw === '1'
