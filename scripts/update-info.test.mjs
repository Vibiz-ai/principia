import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { channelFiles, parseUpdateInfo, releaseChannel, sha512Base64File, updateInfoYaml, writeUpdateInfo } from './update-info.mjs'

const require = createRequire(import.meta.url)
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'update-info-'))

test('stable versions go to latest (and beta); any prerelease goes to beta only', () => {
  assert.equal(releaseChannel('0.3.0'), 'latest')
  assert.equal(releaseChannel('0.3.0-beta.1'), 'beta')
  assert.equal(releaseChannel('1.0.0-rc.2'), 'beta')
  assert.equal(releaseChannel('v0.3.0'), null)
  assert.equal(releaseChannel('0.3'), null)
  assert.deepEqual(channelFiles('0.3.0'), ['latest-mac.yml', 'beta-mac.yml'])
  assert.deepEqual(channelFiles('0.3.0-beta.1'), ['beta-mac.yml'])
  assert.throws(() => channelFiles('nope'))
})

test('sha512 is the base64 SHA-512 electron-updater checks', () => {
  const dir = tmp()
  const f = path.join(dir, 'a.zip')
  fs.writeFileSync(f, 'abc')
  assert.equal(sha512Base64File(f), crypto.createHash('sha512').update('abc').digest('base64'))
})

test('the manifest is what electron-updater reads: version, files, path, sha512, releaseDate', () => {
  const sha512 = crypto.createHash('sha512').update('zip').digest('base64')
  const text = updateInfoYaml({ version: '0.3.0-beta.1', files: [{ url: 'Principia-arm64.zip', sha512, size: 1234 }], releaseDate: '2026-10-26T12:00:00Z' })
  const back = parseUpdateInfo(text)
  assert.equal(back.version, '0.3.0-beta.1')
  assert.equal(back.path, 'Principia-arm64.zip')
  assert.equal(back.sha512, sha512)
  assert.equal(back.releaseDate, '2026-10-26T12:00:00.000Z')
  assert.deepEqual(back.files, [{ url: 'Principia-arm64.zip', sha512, size: 1234 }])
  // the updater's own parser (js-yaml through electron-updater) reads the same values, when installed
  let parseUpdateInfo2 = null
  try { parseUpdateInfo2 = require('electron-updater/out/providers/Provider.js').parseUpdateInfo } catch { /* not installed */ }
  if (parseUpdateInfo2) {
    const info = parseUpdateInfo2(text, 'beta-mac.yml', new URL('https://example.invalid/beta-mac.yml'))
    assert.equal(info.version, '0.3.0-beta.1')
    assert.equal(info.files[0].url, 'Principia-arm64.zip')
    assert.equal(info.files[0].sha512, sha512)
    assert.equal(info.files[0].size, 1234)
    assert.equal(info.releaseDate, '2026-10-26T12:00:00.000Z')
  }
})

test('bad input is refused rather than written', () => {
  const sha512 = crypto.createHash('sha512').update('zip').digest('base64')
  const ok = { url: 'Principia-arm64.zip', sha512, size: 1 }
  assert.throws(() => updateInfoYaml({ version: '0.3', files: [ok], releaseDate: new Date() }))
  assert.throws(() => updateInfoYaml({ version: '0.3.0', files: [], releaseDate: new Date() }))
  assert.throws(() => updateInfoYaml({ version: '0.3.0', files: [{ ...ok, url: '../x.zip' }], releaseDate: new Date() }))
  assert.throws(() => updateInfoYaml({ version: '0.3.0', files: [{ ...ok, sha512: 'abc' }], releaseDate: new Date() }))
  assert.throws(() => updateInfoYaml({ version: '0.3.0', files: [{ ...ok, size: 0 }], releaseDate: new Date() }))
  assert.throws(() => updateInfoYaml({ version: '0.3.0', files: [ok], releaseDate: 'not a date' }))
})

test('writeUpdateInfo: stable writes both manifests; a prerelease writes beta only and removes a stale latest', () => {
  const dir = tmp()
  const zip = path.join(dir, 'Principia-arm64.zip')
  fs.writeFileSync(zip, 'zip bytes')
  const stable = writeUpdateInfo({ version: '0.3.0', zip, releaseDate: '2026-10-26T00:00:00Z' })
  assert.deepEqual(stable.map((f) => path.basename(f)), ['latest-mac.yml', 'beta-mac.yml'])
  assert.equal(fs.readFileSync(stable[0], 'utf8'), fs.readFileSync(stable[1], 'utf8'))
  const info = parseUpdateInfo(fs.readFileSync(stable[0], 'utf8'))
  assert.equal(info.sha512, sha512Base64File(zip))
  assert.equal(info.files[0].size, fs.statSync(zip).size)
  const beta = writeUpdateInfo({ version: '0.4.0-beta.1', zip, releaseDate: '2026-10-27T00:00:00Z' })
  assert.deepEqual(beta.map((f) => path.basename(f)), ['beta-mac.yml'])
  assert.equal(fs.existsSync(path.join(dir, 'latest-mac.yml')), false)
})
