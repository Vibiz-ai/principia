// Line diff and diff3 merge (PASSPORT.md §6.4 "Principia editor saves"). When an editor save carries a
// stale base hash, merge3(base, ours = editor text, theirs = current file) either merges cleanly or
// returns regions for the merge view. Lines keep their terminators, so a clean merge is byte exact.
// Myers O(ND) diff over interned lines; no dependencies.

/** Splits text into lines that keep their terminators (`a\n`, `b\r\n`, `c`). */
export function splitKeepEol(text: string): string[] {
  const out: string[] = []
  let start = 0
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      out.push(text.slice(start, i + 1))
      start = i + 1
    }
  }
  if (start < text.length) out.push(text.slice(start))
  return out
}

/** Matched index pairs [i in a, j in b] of a shortest edit script, ascending. */
export function lcsPairs(a: string[], b: string[]): Array<[number, number]> {
  const ids = new Map<string, number>()
  const intern = (s: string): number => {
    let v = ids.get(s)
    if (v === undefined) ids.set(s, (v = ids.size))
    return v
  }
  const A = a.map(intern)
  const B = b.map(intern)
  // common prefix / suffix
  let pre = 0
  while (pre < A.length && pre < B.length && A[pre] === B[pre]) pre++
  let suf = 0
  while (suf < A.length - pre && suf < B.length - pre && A[A.length - 1 - suf] === B[B.length - 1 - suf]) suf++
  const pairs: Array<[number, number]> = []
  for (let i = 0; i < pre; i++) pairs.push([i, i])
  const x = A.slice(pre, A.length - suf)
  const y = B.slice(pre, B.length - suf)
  for (const [i, j] of myers(x, y)) pairs.push([i + pre, j + pre])
  for (let k = suf; k > 0; k--) pairs.push([A.length - k, B.length - k])
  return pairs
}

function myers(a: number[], b: number[]): Array<[number, number]> {
  const n = a.length
  const m = b.length
  if (n === 0 || m === 0) return []
  const max = n + m
  const off = max + 1
  const v = new Int32Array(2 * max + 3)
  const trace: Int32Array[] = []
  let found = false
  for (let d = 0; d <= max && !found; d++) {
    // snapshot of v before step d, for k in [-d-1, d+1]
    trace.push(v.slice(off - d - 1, off + d + 2))
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) {
        x++
        y++
      }
      v[off + k] = x
      if (x >= n && y >= m) {
        found = true
        break
      }
    }
  }
  const out: Array<[number, number]> = []
  let x = n
  let y = m
  for (let d = trace.length - 1; d >= 0; d--) {
    const snap = trace[d]
    const get = (k: number): number => snap[k + d + 1]
    const k = x - y
    const prevK = k === -d || (k !== d && get(k - 1) < get(k + 1)) ? k + 1 : k - 1
    const prevX = d === 0 ? 0 : get(prevK)
    const prevY = d === 0 ? 0 : prevX - prevK
    while (x > prevX && y > prevY) {
      out.push([x - 1, y - 1])
      x--
      y--
    }
    if (d > 0) {
      x = prevX
      y = prevY
    }
  }
  return out.reverse()
}

export type DiffOp = { op: 'equal' | 'delete' | 'insert'; lines: string[] }

/** Line diff as runs of equal / delete / insert (deletes before inserts within a change). */
export function diffLines(a: string[], b: string[]): DiffOp[] {
  const ops: DiffOp[] = []
  const push = (op: DiffOp['op'], line: string): void => {
    const last = ops[ops.length - 1]
    if (last && last.op === op) last.lines.push(line)
    else ops.push({ op, lines: [line] })
  }
  let i = 0
  let j = 0
  for (const [pi, pj] of [...lcsPairs(a, b), [a.length, b.length] as [number, number]]) {
    while (i < pi) push('delete', a[i++])
    while (j < pj) push('insert', b[j++])
    if (pi < a.length && pj < b.length) push('equal', a[pi])
    i = pi + 1
    j = pj + 1
  }
  return ops
}

export type MergeRegion =
  | { stable: true; lines: string[] }
  | { stable: false; conflict: boolean; base: string[]; ours: string[]; theirs: string[]; merged: string[] }

export interface MergeResult {
  clean: boolean
  /** Merged text; on conflict it carries git-style markers (for "keep both" fallbacks). */
  text: string
  regions: MergeRegion[]
  conflicts: number
}

function same(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i])
}

/**
 * Three-way line merge. A chunk changed on one side takes that side; identical changes on both sides
 * merge; different changes on both sides are a conflict.
 */
export function merge3(base: string, ours: string, theirs: string, labels = { ours: 'ours', theirs: 'theirs' }): MergeResult {
  const O = splitKeepEol(base)
  const A = splitKeepEol(ours)
  const B = splitKeepEol(theirs)
  const ma = new Map<number, number>(lcsPairs(O, A))
  const mb = new Map<number, number>(lcsPairs(O, B))
  const regions: MergeRegion[] = []
  const stable = (line: string): void => {
    const last = regions[regions.length - 1]
    if (last && last.stable) last.lines.push(line)
    else regions.push({ stable: true, lines: [line] })
  }
  let o = 0
  let a = 0
  let b = 0
  while (o < O.length || a < A.length || b < B.length) {
    if (o < O.length && ma.get(o) === a && mb.get(o) === b) {
      stable(O[o])
      o++
      a++
      b++
      continue
    }
    // next base line matched in both, beyond the current positions
    let no = o
    while (no < O.length && !(ma.has(no) && mb.has(no) && ma.get(no)! >= a && mb.get(no)! >= b)) no++
    const na = no < O.length ? ma.get(no)! : A.length
    const nb = no < O.length ? mb.get(no)! : B.length
    const cb = O.slice(o, no)
    const ca = A.slice(a, na)
    const cB = B.slice(b, nb)
    if (same(ca, cb)) regions.push({ stable: false, conflict: false, base: cb, ours: ca, theirs: cB, merged: cB })
    else if (same(cB, cb)) regions.push({ stable: false, conflict: false, base: cb, ours: ca, theirs: cB, merged: ca })
    else if (same(ca, cB)) regions.push({ stable: false, conflict: false, base: cb, ours: ca, theirs: cB, merged: ca })
    else regions.push({ stable: false, conflict: true, base: cb, ours: ca, theirs: cB, merged: [] })
    o = no
    a = na
    b = nb
  }
  let text = ''
  let conflicts = 0
  const eol = /\r\n/.test(ours) ? '\r\n' : '\n'
  const block = (lines: string[]): string => {
    const s = lines.join('')
    return s === '' || s.endsWith('\n') ? s : s + eol
  }
  for (const r of regions) {
    if (r.stable) text += r.lines.join('')
    else if (!r.conflict) text += r.merged.join('')
    else {
      conflicts++
      text += `<<<<<<< ${labels.ours}${eol}${block(r.ours)}=======${eol}${block(r.theirs)}>>>>>>> ${labels.theirs}${eol}`
    }
  }
  return { clean: conflicts === 0, text, regions, conflicts }
}
