// The Northwind fixture vault (41 notes, PASSPORT.md §14 P8.3) and its hand labels, plus the eval metrics shared by
// the CI gates in memory.test.ts and the opt-in real-CLI smoke test: brief recall@k and suggester precision.
import fs from 'node:fs'
import path from 'node:path'
import type { Candidate } from '../../../vault/suggest/candidates'

export const FIXTURE_VAULT = path.join(__dirname, 'Passport')

export interface FixtureLabels {
  company: { id: string; name: string }
  brief: { prompt: string; expect: string[] }[]
  links: [string, string][]
  retarget: [string, string][]
  entities: string[]
}

export const LABELS = JSON.parse(fs.readFileSync(path.join(__dirname, 'labels.json'), 'utf8')) as FixtureLabels

/** Copies the fixture notes into `root` (a fresh vault folder); returns the vault-relative paths. */
export function copyFixtureVault(root: string): string[] {
  const out: string[] = []
  const visit = (from: string, rel: string): void => {
    for (const e of fs.readdirSync(from, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) visit(path.join(from, e.name), r)
      else if (e.name.endsWith('.md')) {
        fs.mkdirSync(path.join(root, ...rel.split('/').filter(Boolean)), { recursive: true })
        fs.copyFileSync(path.join(from, e.name), path.join(root, ...r.split('/')))
        out.push(r)
      }
    }
  }
  visit(FIXTURE_VAULT, '')
  return out.sort()
}

/** The notes listed under one `## Section` of a brief, in order, as titles (`- [[Title]] …` lines). */
export function briefSectionTitles(brief: string, head: string): string[] {
  const lines = brief.split('\n')
  const i = lines.indexOf(head)
  if (i < 0) return []
  const out: string[] = []
  for (let j = i + 1; j < lines.length && !lines[j].startsWith('## ') && !lines[j].startsWith('</'); j++) {
    const m = /^- \[\[([^\]|#]+)/.exec(lines[j])
    if (m) out.push(m[1])
  }
  return out
}

export interface RecallResult {
  recall: number
  perPrompt: { prompt: string; expect: string[]; got: string[]; hits: number }[]
}

/** Mean over prompts of |expected ∩ first k ranked notes| / |expected|. */
export function recallAtK(cases: FixtureLabels['brief'], rank: (prompt: string) => string[], k: number): RecallResult {
  const perPrompt = cases.map((c) => {
    const got = rank(c.prompt).slice(0, k)
    const want = new Set(c.expect.map((t) => t.toLowerCase()))
    const hits = got.filter((t) => want.has(t.toLowerCase())).length
    return { prompt: c.prompt, expect: c.expect, got, hits }
  })
  const recall = perPrompt.reduce((s, p) => s + p.hits / p.expect.length, 0) / Math.max(1, perPrompt.length)
  return { recall, perPrompt }
}

export interface PrecisionResult {
  precision: number
  proposed: number
  correct: number
  falsePositives: string[]
  /** labelled items no candidate proposed (recall, informational) */
  missed: string[]
}

/** Precision of candidates against a labelled set of `describe(candidate)` strings. */
export function precisionOf(cands: Candidate[], describe: (c: Candidate) => string, truth: string[]): PrecisionResult {
  const want = new Set(truth.map((t) => t.toLowerCase()))
  const got = cands.map(describe)
  const correct = got.filter((g) => want.has(g.toLowerCase()))
  const seen = new Set(got.map((g) => g.toLowerCase()))
  return {
    precision: got.length ? correct.length / got.length : 1,
    proposed: got.length,
    correct: correct.length,
    falsePositives: got.filter((g) => !want.has(g.toLowerCase())),
    missed: truth.filter((t) => !seen.has(t.toLowerCase()))
  }
}
