import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { assetProblems, checksumsText, describeFiles, parseChecksums, sha256File, SUMS_FILE } from './release-assets.mjs'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'release-assets-'))

test('sha256File matches the known digest of a file', () => {
  const dir = tmp()
  const f = path.join(dir, 'a.txt')
  fs.writeFileSync(f, 'abc')
  assert.equal(sha256File(f), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
})

test('SHA256SUMS.txt is sorted, round-trips, and shasum -c accepts it', () => {
  const dir = tmp()
  fs.writeFileSync(path.join(dir, 'b.zip'), 'zip bytes')
  fs.writeFileSync(path.join(dir, 'a.dmg'), 'dmg bytes')
  const entries = describeFiles([path.join(dir, 'b.zip'), path.join(dir, 'a.dmg')])
  const text = checksumsText(entries)
  assert.deepEqual(text.trim().split('\n').map((l) => l.split('  ')[1]), ['a.dmg', 'b.zip'])
  const parsed = parseChecksums(text)
  for (const e of entries) assert.equal(parsed.get(e.name), e.sha256)
  fs.writeFileSync(path.join(dir, SUMS_FILE), text)
  const r = spawnSync('shasum', ['-a', '256', '-c', SUMS_FILE], { cwd: dir, encoding: 'utf8' })
  if (r.error?.code !== 'ENOENT') assert.equal(r.status, 0, r.stdout + r.stderr)
})

test('parseChecksums refuses malformed lines and paths', () => {
  assert.equal(parseChecksums('nothex  a.dmg\n'), null)
  assert.equal(parseChecksums(`${'a'.repeat(64)}  dir/a.dmg\n`), null)
  assert.equal(parseChecksums(`${'a'.repeat(64)} *a.dmg\n`).get('a.dmg'), 'a'.repeat(64))
})

test('a draft matches only when it holds exactly the built files', () => {
  const h = 'c'.repeat(64)
  const expected = [{ name: 'Principia-arm64.dmg', size: 10, sha256: h }, { name: SUMS_FILE, size: 2, sha256: 'd'.repeat(64) }]
  const good = [
    { name: 'Principia-arm64.dmg', size: 10, state: 'uploaded', digest: `sha256:${h}` },
    { name: SUMS_FILE, size: 2, state: 'uploaded' }
  ]
  assert.deepEqual(assetProblems(expected, good), [])
  assert.match(assetProblems(expected, good.slice(0, 1)).join(), /SHA256SUMS.txt is missing/)
  assert.match(assetProblems(expected, [...good, { name: 'extra.bin', size: 1 }]).join(), /extra.bin is not part of this build/)
  assert.match(assetProblems(expected, [{ ...good[0], size: 9 }, good[1]]).join(), /is 9 bytes, not 10/)
  assert.match(assetProblems(expected, [{ ...good[0], digest: `sha256:${'e'.repeat(64)}` }, good[1]]).join(), /has digest/)
  assert.match(assetProblems(expected, [{ ...good[0], state: 'starter' }, good[1]]).join(), /not fully uploaded/)
})
