import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { codesignArgs, isMachO, packageRelease, parseNotaryResult, signingOrder } from './mac-sign.mjs'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mac-sign-'))
const MACHO = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 0]) // 64-bit little-endian Mach-O
const FAT = Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 2])
const put = (root, rel, bytes = MACHO) => {
  const f = path.join(root, rel)
  fs.mkdirSync(path.dirname(f), { recursive: true })
  fs.writeFileSync(f, bytes)
  return f
}

/** A tiny Principia.app shaped like the real one: framework with helpers, helper app, native modules, a symlink. */
function fakeApp() {
  const app = path.join(tmp(), 'Principia.app')
  put(app, 'Contents/MacOS/Principia')
  put(app, 'Contents/Info.plist', 'not a binary')
  put(app, 'Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework', FAT)
  put(app, 'Contents/Frameworks/Electron Framework.framework/Versions/A/Libraries/libffmpeg.dylib')
  put(app, 'Contents/Frameworks/Electron Framework.framework/Versions/A/Resources/en.lproj/locale.pak', 'resource')
  fs.symlinkSync('Versions/A/Electron Framework', path.join(app, 'Contents/Frameworks/Electron Framework.framework/Electron Framework'))
  fs.symlinkSync('A', path.join(app, 'Contents/Frameworks/Electron Framework.framework/Versions/Current'))
  put(app, 'Contents/Frameworks/Principia Helper (Renderer).app/Contents/MacOS/Principia Helper (Renderer)')
  put(app, 'Contents/Resources/app.asar.unpacked/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper')
  put(app, 'Contents/Resources/app.asar.unpacked/node_modules/better-sqlite3/build/Release/better_sqlite3.node')
  put(app, 'Contents/Resources/app.asar', 'asar bytes')
  return app
}

test('isMachO: thin and universal binaries, not text or short files', () => {
  const d = tmp()
  assert.equal(isMachO(put(d, 'a', MACHO)), true)
  assert.equal(isMachO(put(d, 'b', FAT)), true)
  assert.equal(isMachO(put(d, 'c', '#!/bin/sh\necho hi\n')), false)
  assert.equal(isMachO(put(d, 'd', Buffer.from([0xcf]))), false)
  assert.equal(isMachO(path.join(d, 'missing')), false)
})

test('signingOrder: every binary and nested bundle, inside-out, symlinks skipped, the app itself last (not listed)', () => {
  const app = fakeApp()
  const order = signingOrder(app).map((e) => `${e.kind} ${path.relative(app, e.path)}`)
  const idx = (s) => order.findIndex((o) => o.endsWith(s))
  // all of them, nothing else
  assert.deepEqual(order.slice().sort(), [
    'bundle Contents/Frameworks/Electron Framework.framework',
    'bundle Contents/Frameworks/Principia Helper (Renderer).app',
    'file Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework',
    'file Contents/Frameworks/Electron Framework.framework/Versions/A/Libraries/libffmpeg.dylib',
    'file Contents/Frameworks/Principia Helper (Renderer).app/Contents/MacOS/Principia Helper (Renderer)',
    'file Contents/MacOS/Principia',
    'file Contents/Resources/app.asar.unpacked/node_modules/better-sqlite3/build/Release/better_sqlite3.node',
    'file Contents/Resources/app.asar.unpacked/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper'
  ])
  // a bundle after everything inside it
  assert.ok(idx('libffmpeg.dylib') < idx('Electron Framework.framework'))
  assert.ok(idx('Versions/A/Electron Framework') < idx('Electron Framework.framework'))
  assert.ok(idx('MacOS/Principia Helper (Renderer)') < idx('Principia Helper (Renderer).app'))
  // no symlinked duplicate
  assert.equal(order.filter((o) => o.endsWith('Electron Framework')).length, 1)
})

test('codesignArgs: hardened runtime, timestamp, entitlements and keychain; ad-hoc has no timestamp server or keychain', () => {
  assert.deepEqual(codesignArgs({ target: 'X.app', identity: 'ABCDEF', keychain: '/k.keychain-db', entitlements: 'e.plist' }), [
    '--force', '--options', 'runtime', '--timestamp', '--entitlements', 'e.plist', '--keychain', '/k.keychain-db', '--sign', 'ABCDEF', 'X.app'
  ])
  assert.deepEqual(codesignArgs({ target: 'X.app', identity: '-', keychain: '/k.keychain-db', entitlements: 'e.plist' }), [
    '--force', '--options', 'runtime', '--timestamp=none', '--entitlements', 'e.plist', '--sign', '-', 'X.app'
  ])
  // a dmg: no runtime option, no entitlements
  assert.deepEqual(codesignArgs({ target: 'P.dmg', identity: 'ABCDEF', runtime: false }), ['--force', '--timestamp', '--sign', 'ABCDEF', 'P.dmg'])
})

test('parseNotaryResult reads notarytool --output-format json, ignoring progress lines', () => {
  assert.deepEqual(parseNotaryResult('Conducting pre-submission checks...\n{"id":"abc-123","status":"Accepted","message":"Processing complete"}\n'), { id: 'abc-123', status: 'Accepted', message: 'Processing complete' })
  assert.deepEqual(parseNotaryResult('{"id":"x","status":"Invalid","message":"Processing complete"}'), { id: 'x', status: 'Invalid', message: 'Processing complete' })
  assert.equal(parseNotaryResult('Error: HTTP status code: 401'), null)
})

/** A fake exec that records commands and creates the files the real tools would. */
function recorder({ notaryStatus = 'Accepted' } = {}) {
  const calls = []
  const exec = (cmd, argv) => {
    calls.push([cmd, ...argv])
    if (cmd === 'ditto' && argv[0] === '-c') fs.writeFileSync(argv.at(-1), 'zip')
    if (cmd === 'ditto' && argv[0] !== '-c') fs.cpSync(argv[0], argv[1], { recursive: true, verbatimSymlinks: true })
    if (cmd === 'hdiutil') fs.writeFileSync(argv.at(-1), 'dmg')
    if (cmd === 'xcrun' && argv[0] === 'notarytool' && argv[1] === 'submit') return { ok: true, status: 0, out: JSON.stringify({ id: 'sub-1', status: notaryStatus, message: '' }) }
    return { ok: true, status: 0, out: '' }
  }
  return { calls, exec }
}

test('packageRelease: sign inside-out, notarize + staple the app, then zip it, then the dmg: sign, notarize, staple', () => {
  const app = fakeApp()
  const out = path.dirname(app)
  const { calls, exec } = recorder()
  const notaryArgs = ['--key', '/k.p8', '--key-id', 'KID', '--issuer', 'ISS']
  packageRelease({ app, zip: path.join(out, 'P.zip'), dmg: path.join(out, 'P.dmg'), volname: 'Principia', identity: 'ABCDEF', keychain: '/k', entitlements: 'app.plist', entitlementsInherit: 'inherit.plist', notaryArgs, exec })
  const short = calls.map((c) => {
    if (c[0] === 'codesign' && c[1] === '--verify') return 'verify'
    if (c[0] === 'codesign') return `sign ${path.basename(c.at(-1))} ${c.includes('--entitlements') ? c[c.indexOf('--entitlements') + 1] : '-'}`
    if (c[0] === 'xcrun') return `${c[1]} ${c[2]} ${path.basename(c[3] ?? '')}`
    if (c[0] === 'ditto') return `ditto ${path.basename(c.at(-1))}`
    return `${c[0]} ${c[1]}`
  })
  const signs = short.filter((s) => s.startsWith('sign '))
  // nested code with the inherit entitlements, the app with its own, the dmg with none
  assert.equal(signs.length, signingOrder(app).length + 2)
  assert.ok(signs.slice(0, -2).every((s) => s.endsWith(' inherit.plist')))
  assert.equal(signs.at(-2), 'sign Principia.app app.plist')
  assert.equal(signs.at(-1), 'sign P.dmg -')
  const after = short.slice(short.indexOf('sign Principia.app app.plist'))
  assert.deepEqual(after, [
    'sign Principia.app app.plist',
    'verify',
    'ditto P.zip.notarize.zip',
    'notarytool submit P.zip.notarize.zip',
    'stapler staple Principia.app',
    'ditto P.zip',
    'ditto Principia.app',
    'hdiutil create',
    'sign P.dmg -',
    'notarytool submit P.dmg',
    'stapler staple P.dmg'
  ])
  // every signature names the keychain; the notary upload is removed; the dmg staging folder is removed
  assert.ok(calls.filter((c) => c[0] === 'codesign' && c[1] !== '--verify').every((c) => c.includes('--keychain')))
  assert.equal(fs.existsSync(path.join(out, 'P.zip.notarize.zip')), false)
  assert.equal(fs.existsSync(path.join(out, 'P.dmg.root')), false)
})

test('packageRelease: a rejected notarization stops before the zip and dmg, after fetching Apple\'s log', () => {
  const app = fakeApp()
  const out = path.dirname(app)
  const { calls, exec } = recorder({ notaryStatus: 'Invalid' })
  assert.throws(
    () => packageRelease({ app, zip: path.join(out, 'P.zip'), dmg: path.join(out, 'P.dmg'), volname: 'Principia', identity: 'ABCDEF', entitlements: 'a', entitlementsInherit: 'i', notaryArgs: ['--keychain-profile', 'p'], exec }),
    /notarization of P\.zip\.notarize\.zip ended Invalid \(submission sub-1\)/
  )
  assert.ok(calls.some((c) => c[0] === 'xcrun' && c[2] === 'log' && c[3] === 'sub-1'))
  assert.equal(calls.some((c) => c[0] === 'hdiutil'), false)
  assert.equal(calls.some((c) => c[0] === 'xcrun' && c[1] === 'stapler'), false)
})

test('packageRelease without notary credentials (dry run): ad-hoc, nothing sent to Apple', () => {
  const app = fakeApp()
  const out = path.dirname(app)
  const { calls, exec } = recorder()
  packageRelease({ app, zip: path.join(out, 'P.zip'), dmg: path.join(out, 'P.dmg'), volname: 'Principia', identity: '-', entitlements: 'a', entitlementsInherit: 'a', notaryArgs: null, exec })
  assert.equal(calls.some((c) => c[0] === 'xcrun'), false)
  assert.ok(calls.filter((c) => c[0] === 'codesign' && c[1] !== '--verify').every((c) => c.includes('--timestamp=none') && !c.includes('--keychain')))
})
