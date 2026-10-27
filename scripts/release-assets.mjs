/**
 * docs/RELEASING.md §1: the files of a release, their SHA256SUMS.txt, and the check that a draft release holds
 * exactly those files before it is published. With immutable releases (Settings › General › Releases) a published
 * release can never gain, lose or replace a file, so everything is uploaded to a draft first and checked there.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export const SUMS_FILE = 'SHA256SUMS.txt'

/** SHA-256 of a file, hex. */
export function sha256File(file) {
  const hash = crypto.createHash('sha256')
  const fd = fs.openSync(file, 'r')
  try {
    const buf = Buffer.allocUnsafe(1 << 20)
    let n
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) hash.update(buf.subarray(0, n))
  } finally {
    fs.closeSync(fd)
  }
  return hash.digest('hex')
}

/** `shasum -a 256` format ("<hex>  <name>"), sorted by name, so `shasum -a 256 -c SHA256SUMS.txt` checks downloads. */
export function checksumsText(entries) {
  return [...entries]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((e) => `${e.sha256}  ${e.name}\n`)
    .join('')
}

/** name → hex from a SHA256SUMS.txt; null when a line is not "<64 hex>  <name>". */
export function parseChecksums(text) {
  const out = new Map()
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    const m = /^([0-9a-f]{64}) [ *](.+)$/.exec(line)
    if (!m || m[2].includes('/')) return null
    out.set(m[2], m[1])
  }
  return out
}

/** Name, size and SHA-256 of local files. */
export function describeFiles(files) {
  return files.map((f) => ({ name: path.basename(f), size: fs.statSync(f).size, sha256: sha256File(f) }))
}

/**
 * Why the release's uploaded assets (gh release view --json assets) are not exactly the expected files: missing,
 * extra, not fully uploaded, wrong size, or (when GitHub reports a digest) wrong SHA-256. Empty when they match.
 */
export function assetProblems(expected, assets) {
  const problems = []
  const byName = new Map((assets ?? []).map((a) => [a.name, a]))
  for (const e of expected) {
    const a = byName.get(e.name)
    if (!a) { problems.push(`${e.name} is missing`); continue }
    if (a.state && a.state !== 'uploaded') problems.push(`${e.name} is not fully uploaded (${a.state})`)
    if (typeof a.size === 'number' && a.size !== e.size) problems.push(`${e.name} is ${a.size} bytes, not ${e.size}`)
    if (a.digest && a.digest !== `sha256:${e.sha256}`) problems.push(`${e.name} has digest ${a.digest}, not sha256:${e.sha256}`)
  }
  const names = new Set(expected.map((e) => e.name))
  for (const a of assets ?? []) if (!names.has(a.name)) problems.push(`${a.name} is not part of this build`)
  return problems
}
