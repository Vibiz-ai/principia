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

/** A compressed, read-only dmg holding the app and an Applications link to drag it to. */
export function makeDmg({ app, dmg, volname, exec = defaultExec }) {
  const stage = `${dmg}.root`
  fs.rmSync(stage, { recursive: true, force: true })
  fs.mkdirSync(stage, { recursive: true })
  try {
    must(exec('ditto', [app, path.join(stage, path.basename(app))], { quiet: true }), 'ditto (dmg contents)')
    fs.symlinkSync('/Applications', path.join(stage, 'Applications'))
    fs.rmSync(dmg, { force: true })
    must(exec('hdiutil', ['create', '-volname', volname, '-srcfolder', stage, '-ov', '-format', 'UDZO', '-imagekey', 'zlib-level=9', dmg]), `hdiutil create ${path.basename(dmg)}`)
  } finally {
    fs.rmSync(stage, { recursive: true, force: true })
  }
}

/**
 * The whole packaging of a release from an unsigned app, in place:
 *   sign the app → notarize + staple it → updater zip (of the stapled app) → dmg → sign the dmg → notarize + staple it.
 * notaryArgs null = no notarization (dry run, ad-hoc identity).
 */
export function packageRelease({ app, zip, dmg, volname, identity, keychain = null, entitlements, entitlementsInherit, notaryArgs = null, exec = defaultExec }) {
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
  makeDmg({ app, dmg, volname, exec })
  // a dmg is signed without the runtime option or entitlements (they are for executables)
  must(exec('codesign', codesignArgs({ target: dmg, identity, keychain, runtime: false })), `codesign ${path.basename(dmg)}`)
  if (notaryArgs) {
    notarize({ file: dmg, notaryArgs, exec })
    staple({ target: dmg, exec })
  }
}
