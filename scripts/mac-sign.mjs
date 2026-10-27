/**
 * docs/RELEASING.md §2, §5: sign, notarize and package an unsigned Principia.app with Apple's own tools only
 * (codesign, notarytool, stapler, ditto, hdiutil). Node built-ins only, no node_modules: the release workflow's signing
 * job runs this without `npm ci`, so no dependency's install script ever runs next to the Developer ID certificate.
 *
 * Signing follows Apple's inside-out rule: every Mach-O file and nested bundle (frameworks, helper apps, native
 * modules, node-pty's spawn-helper) is signed before the bundle that contains it, the app itself last. Everything gets
 * the hardened runtime and a secure timestamp; nested code gets the inherit entitlements, the app its own.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { dmgWindowLayout, withBookmarkVolumeUuid } from './ds-store.mjs'

// Mach-O and universal (fat) binaries, either byte order
const MACHO_MAGIC = new Set([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca])
const BUNDLE = /\.(app|framework|xpc|appex|bundle)$/

/** The first 4 bytes of `file` are a Mach-O or universal binary header. */
export function isMachO(file) {
  let fd
  try {
    fd = fs.openSync(file, 'r')
    const b = Buffer.alloc(4)
    if (fs.readSync(fd, b, 0, 4, 0) < 4) return false
    return MACHO_MAGIC.has(b.readUInt32BE(0))
  } catch {
    return false
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}

/**
 * Everything inside `app` that needs its own signature, inside-out: deeper paths first, so a binary is signed before
 * the bundle holding it and a nested bundle before its parent. Symlinks are skipped (frameworks' Versions/Current and
 * friends point at what is signed anyway). The app itself is not in the list: it is signed last, on its own.
 */
export function signingOrder(app) {
  const found = []
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const p = path.join(dir, name)
      const st = fs.lstatSync(p)
      if (st.isSymbolicLink()) continue
      if (st.isDirectory()) {
        walk(p)
        if (BUNDLE.test(name)) found.push({ path: p, kind: 'bundle' })
      } else if (st.isFile() && isMachO(p)) found.push({ path: p, kind: 'file' })
    }
  }
  walk(path.join(app, 'Contents'))
  const depth = (p) => p.split(path.sep).length
  // stable: same depth keeps the walk's (alphabetical, children-before-bundle) order
  return found.map((e, i) => ({ ...e, i })).sort((a, b) => depth(b.path) - depth(a.path) || a.i - b.i).map(({ path: p, kind }) => ({ path: p, kind }))
}

/**
 * codesign arguments for one item. identity '-' is ad-hoc (the dry run): no timestamp server, no keychain.
 */
export function codesignArgs({ target, identity, keychain = null, entitlements = null, runtime = true }) {
  const adhoc = identity === '-'
  return [
    '--force',
    ...(runtime ? ['--options', 'runtime'] : []),
    adhoc ? '--timestamp=none' : '--timestamp',
    ...(entitlements ? ['--entitlements', entitlements] : []),
    ...(keychain && !adhoc ? ['--keychain', keychain] : []),
    '--sign',
    identity,
    target
  ]
}

/** The notarytool JSON answer ({id, status, message}); null when it is not JSON. */
export function parseNotaryResult(text) {
  try {
    const j = JSON.parse(String(text).trim().split('\n').filter((l) => l.trim().startsWith('{')).pop() ?? '')
    return typeof j?.status === 'string' ? { id: j.id ?? null, status: j.status, message: j.message ?? '' } : null
  } catch {
    return null
  }
}

/**
 * The runner of the steps below: `exec(cmd, argv, {quiet})` → {ok, out, status}. Default spawns the command and
 * echoes it (credentials after --key-id / --issuer / --keychain-profile as ***).
 */
const SECRET_FLAGS = new Set(['--key-id', '--issuer', '--keychain-profile'])
export function defaultExec(cmd, argv, { quiet = false, cwd } = {}) {
  if (!quiet) console.log(`\n$ ${[cmd, ...argv.map((a, i) => (SECRET_FLAGS.has(argv[i - 1]) ? '***' : a))].join(' ')}`)
  const r = spawnSync(cmd, argv, { encoding: 'utf8', cwd, maxBuffer: 64 << 20 })
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim()
  return { ok: r.status === 0, out, status: r.status }
}

function must(r, what) {
  if (!r.ok) throw new Error(`${what} failed (exit ${r.status})${r.out ? `: ${r.out.split('\n').slice(-3).join(' | ')}` : ''}`)
  return r
}

/** Sign the app inside-out with the hardened runtime. Returns how many nested items were signed. */
export function signApp({ app, identity, keychain = null, entitlements, entitlementsInherit, exec = defaultExec }) {
  const items = signingOrder(app)
  console.log(`\nSigning ${items.length} nested binaries and bundles, then ${path.basename(app)} (${identity === '-' ? 'ad-hoc' : 'Developer ID'}, hardened runtime)`)
  for (const it of items) must(exec('codesign', codesignArgs({ target: it.path, identity, keychain, entitlements: entitlementsInherit }), { quiet: true }), `codesign ${path.relative(app, it.path)}`)
  must(exec('codesign', codesignArgs({ target: app, identity, keychain, entitlements })), `codesign ${path.basename(app)}`)
  return items.length
}

/** Submit to Apple's notary service and wait; throws (with Apple's log) unless Accepted. */
export function notarize({ file, notaryArgs, exec = defaultExec }) {
  const r = exec('xcrun', ['notarytool', 'submit', file, '--wait', '--output-format', 'json', ...notaryArgs])
  const res = parseNotaryResult(r.out)
  if (res?.status === 'Accepted') {
    console.log(`  notarized: ${path.basename(file)} (submission ${res.id})`)
    return res
  }
  if (res?.id) {
    const log = exec('xcrun', ['notarytool', 'log', res.id, ...notaryArgs], { quiet: true })
    console.error(log.out)
  }
  throw new Error(`notarization of ${path.basename(file)} ${res ? `ended ${res.status}${res.id ? ` (submission ${res.id})` : ''}` : `failed: ${r.out.split('\n').slice(-2).join(' | ')}`}`)
}

export function staple({ target, exec = defaultExec }) {
  must(exec('xcrun', ['stapler', 'staple', target]), `stapler staple ${path.basename(target)}`)
}

/** The updater's zip (and the notary upload of an app): ditto keeps symlinks, modes and extended attributes. */
export function makeZip({ app, zip, exec = defaultExec }) {
  fs.rmSync(zip, { force: true })
  must(exec('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, zip]), `ditto ${path.basename(zip)}`)
}

/**
 * The dmg window (docs/RELEASING.md §5.5): Principia on the left, an Applications link on the right, an arrow and
 * "Drag Principia to Applications" on a dark background, no toolbar, sidebar or status bar, the app icon as the
 * volume icon. build/dmg/ holds the layout:
 *   DS_Store         the window's Finder settings, written once by dmgbuild (scripts/dmg-layout/make-template.sh)
 *   background.tiff  the art at 1x and 2x (scripts/make-icons.swift), found through a bookmark in DS_Store
 *   layout.json      the numbers both were made from
 *
 * Why a committed .DS_Store instead of running dmgbuild here: this runs in the release job next to the Developer ID
 * certificate, which installs nothing (RELEASING.md §5.2). Running dmgbuild would put Python packages from PyPI in
 * that job, even pinned by hash; the template needs none. What the template depends on is checked before anything is
 * built (dmgTemplate): the volume name and file names it was made for. One value differs in every dmg: Finder finds
 * the background through the bookmark's volume UUID (tried on macOS 15: with the template's UUID the window shows no
 * background, with the new volume's it does), so makeDmg writes the new volume's UUID into the copy, same length, in
 * place. Finder automation (AppleScript) is not used: it needs a logged-in Finder and an Automation permission.
 */
export const DMG_LAYOUT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'build', 'dmg')
export const DMG_BACKGROUND = '.background.tiff'
// com.apple.FinderInfo of the volume's root folder with kHasCustomIcon (0x0400) set: use /.VolumeIcon.icns
const FINDER_INFO_CUSTOM_ICON = `${'00'.repeat(8)}0400${'00'.repeat(22)}`
const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

/**
 * The template in `dir`, checked against this dmg: it must place `appName` and Applications, and its background
 * alias must name volume `volname` and the file copied as DMG_BACKGROUND. Returns the files to copy into the dmg.
 */
export function dmgTemplate({ dir = DMG_LAYOUT_DIR, volname, appName, icon }) {
  const dsStore = path.join(dir, 'DS_Store')
  const background = path.join(dir, 'background.tiff')
  for (const f of [dsStore, background, icon]) if (!f || !fs.existsSync(f)) throw new Error(`dmg layout: ${f ?? 'the volume icon'} is missing (npm run make:icons / make:dmg-layout)`)
  const layout = dmgWindowLayout(fs.readFileSync(dsStore))
  const problems = []
  for (const name of [appName, 'Applications']) if (!layout.icons[name]) problems.push(`no position for ${name}`)
  if (!layout.background) problems.push('no background picture')
  else {
    if (layout.background.volume !== volname) problems.push(`its background is on volume "${layout.background.volume}", the dmg is "${volname}"`)
    if (layout.background.posixPath !== `/${DMG_BACKGROUND}`) problems.push(`its background is ${layout.background.posixPath}, not /${DMG_BACKGROUND}`)
  }
  if (problems.length) throw new Error(`dmg layout ${dsStore}: ${problems.join('; ')} (regenerate it: npm run make:dmg-layout)`)
  return { dsStore, background, icon, layout }
}

/**
 * A compressed, read-only dmg holding the app and an Applications link to drag it to, laid out by the build/dmg
 * template (layout null: a plain window). Made read-write first, so the volume's root can be marked as having a
 * custom icon (hdiutil does not copy that flag from the source folder), then converted to compressed UDZO. HFS+, as
 * the template's background alias was made on.
 */
export function makeDmg({ app, dmg, volname, layout = { dir: DMG_LAYOUT_DIR, icon: path.join(DMG_LAYOUT_DIR, '..', 'icon.icns') }, exec = defaultExec, sleep = sleepMs }) {
  const tpl = layout ? dmgTemplate({ dir: layout.dir, volname, appName: path.basename(app), icon: layout.icon }) : null
  const stage = `${dmg}.root`
  const rw = `${dmg}.rw.dmg`
  const mnt = `${dmg}.mnt`
  const clean = () => {
    fs.rmSync(stage, { recursive: true, force: true })
    fs.rmSync(rw, { force: true })
    fs.rmSync(mnt, { recursive: true, force: true })
  }
  clean()
  fs.mkdirSync(stage, { recursive: true })
  try {
    must(exec('ditto', [app, path.join(stage, path.basename(app))], { quiet: true }), 'ditto (dmg contents)')
    fs.symlinkSync('/Applications', path.join(stage, 'Applications'))
    if (tpl) {
      fs.copyFileSync(tpl.dsStore, path.join(stage, '.DS_Store'))
      fs.copyFileSync(tpl.background, path.join(stage, DMG_BACKGROUND))
      fs.copyFileSync(tpl.icon, path.join(stage, '.VolumeIcon.icns'))
    }
    fs.rmSync(dmg, { force: true })
    must(exec('hdiutil', ['create', '-volname', volname, '-srcfolder', stage, '-fs', 'HFS+', '-format', 'UDRW', '-ov', rw]), `hdiutil create ${path.basename(rw)}`)
    if (tpl) {
      fs.mkdirSync(mnt, { recursive: true })
      must(exec('hdiutil', ['attach', rw, '-nobrowse', '-noautoopen', '-noverify', '-mountpoint', mnt], { quiet: true }), 'hdiutil attach (dmg layout)')
      try {
        // the background bookmark names this volume (see above)
        const info = must(exec('diskutil', ['info', '-plist', mnt], { quiet: true }), 'diskutil info (dmg volume)')
        const uuid = /<key>VolumeUUID<\/key>\s*<string>([0-9A-Fa-f-]{36})<\/string>/.exec(info.out)?.[1]
        if (!uuid) throw new Error('diskutil info: the dmg volume has no VolumeUUID')
        const dsStore = path.join(mnt, '.DS_Store')
        fs.writeFileSync(dsStore, withBookmarkVolumeUuid(fs.readFileSync(dsStore), uuid))
        must(exec('xattr', ['-wx', 'com.apple.FinderInfo', FINDER_INFO_CUSTOM_ICON, mnt], { quiet: true }), 'xattr (volume icon)')
        // hidden even when Finder shows dot files
        must(exec('chflags', ['hidden', path.join(mnt, DMG_BACKGROUND), path.join(mnt, '.VolumeIcon.icns')], { quiet: true }), 'chflags (dmg layout)')
      } finally {
        // a busy volume (Spotlight, fseventsd) usually lets go within a second or two
        let r = exec('hdiutil', ['detach', mnt], { quiet: true })
        for (let i = 0; !r.ok && i < 5; i++) {
          sleep(1000)
          r = exec('hdiutil', ['detach', mnt, ...(i >= 3 ? ['-force'] : [])], { quiet: true })
        }
        must(r, 'hdiutil detach (dmg layout)')
      }
    }
    must(exec('hdiutil', ['convert', rw, '-format', 'UDZO', '-imagekey', 'zlib-level=9', '-ov', '-o', dmg]), `hdiutil convert ${path.basename(dmg)}`)
  } finally {
    clean()
  }
}

/**
 * The whole packaging of a release from an unsigned app, in place:
 *   sign the app → notarize + staple it → updater zip (of the stapled app) → dmg → sign the dmg → notarize + staple it.
 * notaryArgs null = no notarization (dry run, ad-hoc identity).
 */
export function packageRelease({ app, zip, dmg, volname, identity, keychain = null, entitlements, entitlementsInherit, notaryArgs = null, dmgLayout, exec = defaultExec }) {
  signApp({ app, identity, keychain, entitlements, entitlementsInherit, exec })
  must(exec('codesign', ['--verify', '--deep', '--strict', app], { quiet: true }), 'codesign --verify (app, before notarizing)')
  if (notaryArgs) {
    // notarytool takes a zip of the app; the ticket is then stapled to the app itself
    const upload = `${zip}.notarize.zip`
    makeZip({ app, zip: upload, exec })
    try {
      notarize({ file: upload, notaryArgs, exec })
    } finally {
      fs.rmSync(upload, { force: true })
    }
    staple({ target: app, exec })
  }
  makeZip({ app, zip, exec })
  makeDmg({ app, dmg, volname, ...(dmgLayout !== undefined ? { layout: dmgLayout } : {}), exec })
  // a dmg is signed without the runtime option or entitlements (they are for executables)
  must(exec('codesign', codesignArgs({ target: dmg, identity, keychain, runtime: false })), `codesign ${path.basename(dmg)}`)
  if (notaryArgs) {
    notarize({ file: dmg, notaryArgs, exec })
    staple({ target: dmg, exec })
  }
}
