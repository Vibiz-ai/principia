import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { codesignArgs, DMG_BACKGROUND, DMG_LAYOUT_DIR, dmgTemplate, isMachO, makeDmg, packageRelease, parseNotaryResult, signingOrder } from './mac-sign.mjs'
import { dmgWindowLayout, readDsStore, withBookmarkVolumeUuid } from './ds-store.mjs'

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

const NEW_UUID = '0A1B2C3D-4E5F-4061-8273-94A5B6C7D8E9'

/** A fake exec that records commands and creates the files the real tools would. */
function recorder({ notaryStatus = 'Accepted' } = {}) {
  const calls = []
  let srcfolder = null
  const exec = (cmd, argv) => {
    calls.push([cmd, ...argv])
    // a mounted read-write dmg shows what it was made from
    if (cmd === 'hdiutil' && argv[0] === 'create') srcfolder = argv[argv.indexOf('-srcfolder') + 1]
    if (cmd === 'hdiutil' && argv[0] === 'attach') fs.cpSync(srcfolder, argv[argv.indexOf('-mountpoint') + 1], { recursive: true, verbatimSymlinks: true })
    if (cmd === 'diskutil') return { ok: true, status: 0, out: `<plist><dict><key>VolumeName</key><string>Principia</string><key>VolumeUUID</key>\n\t<string>${NEW_UUID}</string></dict></plist>` }
    if (cmd === 'ditto' && argv[0] === '-c') fs.writeFileSync(argv.at(-1), 'zip')
    if (cmd === 'ditto' && argv[0] !== '-c') fs.cpSync(argv[0], argv[1], { recursive: true, verbatimSymlinks: true })
    if (cmd === 'hdiutil' && (argv[0] === 'create' || argv[0] === 'convert')) fs.writeFileSync(argv.at(-1), 'dmg')
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
    'hdiutil attach',
    'diskutil info',
    'xattr -wx',
    'chflags hidden',
    'hdiutil detach',
    'hdiutil convert',
    'sign P.dmg -',
    'notarytool submit P.dmg',
    'stapler staple P.dmg'
  ])
  // every signature names the keychain; the notary upload is removed; the dmg staging folder is removed
  assert.ok(calls.filter((c) => c[0] === 'codesign' && c[1] !== '--verify').every((c) => c.includes('--keychain')))
  assert.equal(fs.existsSync(path.join(out, 'P.zip.notarize.zip')), false)
  assert.equal(fs.existsSync(path.join(out, 'P.dmg.root')), false)
  assert.equal(fs.existsSync(path.join(out, 'P.dmg.rw.dmg')), false)
  assert.equal(fs.existsSync(path.join(out, 'P.dmg.mnt')), false)
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

// ---------- the dmg window (build/dmg, RELEASING.md §5.5) ----------

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const layoutJson = JSON.parse(fs.readFileSync(path.join(DMG_LAYOUT_DIR, 'layout.json'), 'utf8'))
const ICON = path.join(root, 'build', 'icon.icns')

test('the committed dmg window template is the layout in build/dmg/layout.json', () => {
  assert.equal(DMG_LAYOUT_DIR, path.join(root, 'build', 'dmg'))
  const l = dmgWindowLayout(fs.readFileSync(path.join(DMG_LAYOUT_DIR, 'DS_Store')))
  const w = layoutJson.window
  // Finder's bounds include the title bar: the content area is the background picture's size
  assert.deepEqual(l.window, { x: w.x, y: w.y, width: w.width, height: w.height + w.titleBar })
  assert.deepEqual([l.toolbar, l.sidebar, l.statusBar, l.pathBar], [false, false, false, false])
  assert.equal(l.view, 'icnv')
  assert.equal(l.iconSize, layoutJson.iconSize)
  assert.equal(l.textSize, layoutJson.textSize)
  assert.deepEqual(l.icons, layoutJson.icons)
  // Principia on the left, Applications on the right, side by side
  assert.ok(l.icons['Principia.app'].x < l.icons.Applications.x)
  assert.equal(l.icons['Principia.app'].y, l.icons.Applications.y)
  // a picture background, found by volume name + path, plus the bookmark newer Finders read
  assert.equal(l.backgroundType, 2)
  assert.deepEqual(l.background, { volume: layoutJson.volumeName, file: DMG_BACKGROUND, posixPath: `/${DMG_BACKGROUND}` })
  assert.match(l.bookmarkVolume, /^[0-9A-F]{8}(-[0-9A-F]{4}){3}-[0-9A-F]{12}$/)
  // the volume name the template was made for is the one release-mac.mjs gives the dmg
  assert.equal(layoutJson.volumeName, 'Principia')
  assert.match(fs.readFileSync(path.join(root, 'scripts', 'release-mac.mjs'), 'utf8'), /volname: 'Principia'/)
})

/** Width × height of every image in a TIFF (one per IFD). */
function tiffSizes(buf) {
  const le = buf.toString('latin1', 0, 2) === 'II'
  const u16 = (o) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o))
  const u32 = (o) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o))
  const sizes = []
  for (let ifd = u32(4); ifd; ) {
    const n = u16(ifd)
    const tag = {}
    for (let i = 0; i < n; i++) {
      const e = ifd + 2 + i * 12
      tag[u16(e)] = u16(e + 2) === 3 ? u16(e + 8) : u32(e + 8)
    }
    sizes.push(`${tag[256]}x${tag[257]}`)
    ifd = u32(ifd + 2 + n * 12)
  }
  return sizes
}

test('the dmg background is one TIFF holding the 1x and 2x art at the window size', () => {
  const { width, height } = layoutJson.window
  assert.deepEqual(tiffSizes(fs.readFileSync(path.join(DMG_LAYOUT_DIR, 'background.tiff'))), [`${width}x${height}`, `${width * 2}x${height * 2}`])
})

test('the app icon (and volume icon) has every macOS size, 16 to 512 at 1x and 2x', () => {
  const buf = fs.readFileSync(ICON)
  assert.equal(buf.toString('latin1', 0, 4), 'icns')
  const types = new Set()
  for (let o = 8; o + 8 <= buf.length; o += buf.readUInt32BE(o + 4)) types.add(buf.toString('latin1', o, o + 4))
  // 16, 32, 128, 256, 512, 1024 (512@2x), 16@2x, 32@2x, 128@2x, 256@2x
  for (const t of ['ic04', 'ic05', 'ic07', 'ic08', 'ic09', 'ic10', 'ic11', 'ic12', 'ic13', 'ic14']) assert.ok(types.has(t), `icon.icns has ${t}`)
})

test('dmgTemplate refuses a template made for another volume name or app, or missing files', () => {
  assert.ok(dmgTemplate({ volname: 'Principia', appName: 'Principia.app', icon: ICON }).layout.icons['Principia.app'])
  assert.throws(() => dmgTemplate({ volname: 'Principia Beta', appName: 'Principia.app', icon: ICON }), /background is on volume "Principia", the dmg is "Principia Beta"/)
  assert.throws(() => dmgTemplate({ volname: 'Principia', appName: 'Other.app', icon: ICON }), /no position for Other\.app/)
  assert.throws(() => dmgTemplate({ dir: tmp(), volname: 'Principia', appName: 'Principia.app', icon: ICON }), /DS_Store is missing/)
  assert.throws(() => dmgTemplate({ volname: 'Principia', appName: 'Principia.app', icon: path.join(tmp(), 'none.icns') }), /none\.icns is missing/)
})

test('readDsStore refuses what is not a .DS_Store', () => {
  assert.throws(() => readDsStore(Buffer.alloc(64)), /not a \.DS_Store/)
})

test('withBookmarkVolumeUuid points the background bookmark at another volume, changing nothing else', () => {
  const before = fs.readFileSync(path.join(DMG_LAYOUT_DIR, 'DS_Store'))
  const after = withBookmarkVolumeUuid(before, NEW_UUID.toLowerCase())
  assert.equal(after.length, before.length)
  const a = dmgWindowLayout(after)
  const b = dmgWindowLayout(before)
  assert.equal(a.bookmarkVolume, NEW_UUID)
  assert.deepEqual({ ...a, bookmarkVolume: null }, { ...b, bookmarkVolume: null })
  // exactly 36 bytes differ at most, all inside the old UUID's place
  const diff = [...after.keys()].filter((i) => after[i] !== before[i])
  assert.ok(diff.length > 0 && diff.length <= 36 && diff.at(-1) - diff[0] < 36)
  // the template itself is untouched
  assert.notEqual(dmgWindowLayout(fs.readFileSync(path.join(DMG_LAYOUT_DIR, 'DS_Store'))).bookmarkVolume, NEW_UUID)
  assert.throws(() => withBookmarkVolumeUuid(before, 'not-a-uuid'), /not a volume UUID/)
})

test('makeDmg: the layout goes in, the volume gets its custom icon, then the dmg is compressed; nothing left behind', () => {
  const app = fakeApp()
  const out = path.dirname(app)
  const dmg = path.join(out, 'P.dmg')
  const seen = {}
  const { calls, exec } = recorder()
  const spy = (cmd, argv, o) => {
    if (cmd === 'hdiutil' && argv[0] === 'detach') seen.mounted = dmgWindowLayout(fs.readFileSync(path.join(argv[1], '.DS_Store'))).bookmarkVolume
    if (cmd === 'hdiutil' && argv[0] === 'create') {
      const stage = argv[argv.indexOf('-srcfolder') + 1]
      seen.stage = fs.readdirSync(stage).sort()
      seen.link = fs.readlinkSync(path.join(stage, 'Applications'))
      seen.dsStore = fs.readFileSync(path.join(stage, '.DS_Store')).equals(fs.readFileSync(path.join(DMG_LAYOUT_DIR, 'DS_Store')))
      seen.icon = fs.readFileSync(path.join(stage, '.VolumeIcon.icns')).equals(fs.readFileSync(ICON))
    }
    return exec(cmd, argv, o)
  }
  makeDmg({ app, dmg, volname: 'Principia', exec: spy })
  assert.deepEqual(seen.stage, ['.DS_Store', '.VolumeIcon.icns', DMG_BACKGROUND, 'Applications', 'Principia.app'].sort())
  assert.equal(seen.link, '/Applications')
  assert.ok(seen.dsStore && seen.icon)
  // the copy on the volume names that volume
  assert.equal(seen.mounted, NEW_UUID)
  const mnt = `${dmg}.mnt`
  assert.deepEqual(calls.filter((c) => c[0] !== 'ditto'), [
    ['hdiutil', 'create', '-volname', 'Principia', '-srcfolder', `${dmg}.root`, '-fs', 'HFS+', '-format', 'UDRW', '-ov', `${dmg}.rw.dmg`],
    ['hdiutil', 'attach', `${dmg}.rw.dmg`, '-nobrowse', '-noautoopen', '-noverify', '-mountpoint', mnt],
    ['diskutil', 'info', '-plist', mnt],
    ['xattr', '-wx', 'com.apple.FinderInfo', '0000000000000000040000000000000000000000000000000000000000000000', mnt],
    ['chflags', 'hidden', path.join(mnt, DMG_BACKGROUND), path.join(mnt, '.VolumeIcon.icns')],
    ['hdiutil', 'detach', mnt],
    ['hdiutil', 'convert', `${dmg}.rw.dmg`, '-format', 'UDZO', '-imagekey', 'zlib-level=9', '-ov', '-o', dmg]
  ])
  // kHasCustomIcon is bit 0x0400 of the Finder flags, bytes 8-9 of the 32-byte FinderInfo
  assert.equal(Buffer.from(calls.find((c) => c[0] === 'xattr')[3], 'hex').readUInt16BE(8), 0x0400)
  assert.equal(fs.readFileSync(dmg, 'utf8'), 'dmg')
  for (const left of ['.root', '.rw.dmg', '.mnt']) assert.equal(fs.existsSync(`${dmg}${left}`), false)
})

test('makeDmg: a busy volume is detached on a later try; layout null makes the plain dmg', () => {
  const app = fakeApp()
  const dmg = path.join(path.dirname(app), 'P.dmg')
  const { calls, exec } = recorder()
  let busy = 2
  makeDmg({ app, dmg, volname: 'Principia', sleep: () => {}, exec: (cmd, argv, o) => (cmd === 'hdiutil' && argv[0] === 'detach' && busy-- > 0 ? { ok: false, status: 16, out: 'resource busy' } : exec(cmd, argv, o)) })
  assert.equal(calls.filter((c) => c[1] === 'detach').length, 1)
  assert.ok(calls.some((c) => c[1] === 'convert'))

  const plain = recorder()
  makeDmg({ app, dmg, volname: 'Principia', layout: null, exec: plain.exec })
  assert.deepEqual(plain.calls.filter((c) => c[0] !== 'ditto').map((c) => c[1]), ['create', 'convert'])
})

test('makeDmg: a volume that never lets go fails the build, after a forced detach', () => {
  const app = fakeApp()
  const dmg = path.join(path.dirname(app), 'P.dmg')
  const { calls, exec } = recorder()
  const tries = []
  assert.throws(
    () => makeDmg({ app, dmg, volname: 'Principia', sleep: () => {}, exec: (cmd, argv, o) => (cmd === 'hdiutil' && argv[0] === 'detach' ? (tries.push(argv), { ok: false, status: 16, out: 'resource busy' }) : exec(cmd, argv, o)) }),
    /hdiutil detach \(dmg layout\) failed/
  )
  assert.ok(tries.some((a) => a.includes('-force')))
  assert.equal(calls.some((c) => c[1] === 'convert'), false)
  assert.equal(fs.existsSync(`${dmg}.rw.dmg`), false)
})
