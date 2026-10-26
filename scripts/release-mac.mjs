#!/usr/bin/env node
/**
 * docs/RELEASING.md §5: one command from a clean checkout to a published macOS release.
 *
 *   npm run release:mac -- 0.2.0                 build, sign, notarize, staple, verify, publish v0.2.0
 *   npm run release:mac -- 0.2.0 --notes notes.md   ... with these release notes (default: generated from commits)
 *   npm run release:mac -- --dry-run             everything except Developer ID signing, notarizing and publishing
 *                                                (ad-hoc signed, hardened runtime): tests the build on any Mac
 *   node scripts/release-mac.mjs 0.2.0 --ci      GitHub Actions only (.github/workflows/release.yml): the version
 *                                                must be the pushed tag, and the identity comes from the job's
 *                                                temporary keychain (CSC_KEYCHAIN) instead of the login keychain
 *
 * It builds into THIS checkout (out/, release/<version>/). Never run it in the checkout a Principia is running
 * from: the build replaces out/, which that Principia loads its MCP servers and pages from. It refuses when it sees
 * one. Signing identity and notary credentials come from the environment only (RELEASING.md §3); nothing secret is
 * read from, or written to, the repository, and no credential value is printed.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { tagTargetProblem } from './release-target.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const ci = args.includes('--ci')
// --ci: the workflow imported the certificate into a temporary keychain that lives for the whole job, and passes
// its path as CSC_KEYCHAIN; every identity lookup and signature uses that keychain only
const ciKeychain = ci ? process.env.CSC_KEYCHAIN?.trim() || null : null
const notesIdx = args.indexOf('--notes')
const notesFile = notesIdx >= 0 ? args[notesIdx + 1] : null
const positional = args.filter((a, i) => !a.startsWith('--') && !(notesIdx >= 0 && i === notesIdx + 1))
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))

// the update feed and the release repository are one address: electron-builder.yml `publish.url`
const builderYml = fs.readFileSync(path.join(root, 'electron-builder.yml'), 'utf8')
const feed = /^\s+url:\s*(https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/releases\/latest\/download)\s*$/m.exec(builderYml)
if (!feed) fail('electron-builder.yml publish.url is not a https://github.com/<owner>/<repo>/releases/latest/download address')
const repo = `${feed[2]}/${feed[3]}`
const latestUrl = feed[1]

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/
const version = positional[0] ?? (dryRun ? pkg.version : null)
if (!version) fail('Give the version to release, for example: npm run release:mac -- 0.2.0 (or --dry-run)')
if (!SEMVER.test(version)) fail(`"${version}" is not a version like 1.2.3`)
const tag = `v${version}`
if (ci && dryRun) fail('--ci and --dry-run do not go together')
if (ci) {
  if (process.env.GITHUB_ACTIONS !== 'true') fail('--ci runs only in GitHub Actions (locally: npm run release:mac -- <version>)')
  if (process.env.GITHUB_REF_TYPE !== 'tag' || process.env.GITHUB_REF_NAME !== tag) fail(`--ci releases only the pushed tag: this run is for ${process.env.GITHUB_REF_NAME ?? 'no ref'}, not ${tag}`)
  if (!ciKeychain || !fs.existsSync(ciKeychain)) fail('--ci needs CSC_KEYCHAIN: the path of the temporary keychain holding the Developer ID certificate')
}
const outDir = path.join(root, 'release', version)
const appPath = path.join(outDir, 'mac-arm64', 'Principia.app')
const dmg = path.join(outDir, 'Principia-arm64.dmg')
const dmgVersioned = path.join(outDir, `Principia-${version}-arm64.dmg`)
const zip = path.join(outDir, 'Principia-arm64.zip')
const latestYml = path.join(outDir, 'latest-mac.yml')

// ---------- small helpers (never echo the environment) ----------
function fail(msg) {
  console.error(`\n✗ ${msg}`)
  process.exit(1)
}
function run(cmd, argv, o = {}) {
  const r = spawnSync(cmd, argv, { cwd: root, encoding: 'utf8', ...o })
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim(), status: r.status }
}
// notary key ID, issuer and profile name are credentials: shown as *** in the printed command
const SECRET_FLAGS = new Set(['--key-id', '--issuer', '--keychain-profile'])
function step(cmd, argv, o = {}) {
  console.log(`\n$ ${[cmd, ...argv.map((a, i) => (SECRET_FLAGS.has(argv[i - 1]) ? '***' : a))].join(' ')}`)
  const r = spawnSync(cmd, argv, { cwd: root, stdio: 'inherit', ...o })
  if (r.status !== 0) fail(`${cmd} ${argv[0] ?? ''} failed (exit ${r.status})`)
}
const cmp = (a, b) => {
  const pa = SEMVER.exec(a).slice(1, 4).map(Number)
  const pb = SEMVER.exec(b).slice(1, 4).map(Number)
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i]
  return 0
}
const problems = []
const check = (ok, good, bad, { blocking = true } = {}) => {
  console.log(`  ${ok ? '✓' : blocking ? '✗' : '!'} ${ok ? good : bad}`)
  if (!ok && blocking) problems.push(bad)
  return ok
}

console.log(`Principia ${version} for macOS (Apple Silicon)${dryRun ? ' · DRY RUN: ad-hoc signed, not notarized, not published' : ''}${ci ? ' · GitHub Actions' : ''}`)
console.log(`Release repository: ${repo}`)

// ---------- 0. never in a checkout a Principia runs from ----------
const ps = run('ps', ['-axo', 'command']).out.split('\n')
const mine = [`${root}/out/`, `${root}/node_modules/electron/`, `${root}/node_modules/.bin/electron-vite`, `${root}/release/`]
const live = ps.filter((l) => mine.some((m) => l.includes(m)))
if (live.length) fail(`A Principia is running from this checkout (${live.length} process${live.length === 1 ? '' : 'es'}). Releases build in a separate clone or worktree (RELEASING.md §5).`)

// ---------- 1. preflight ----------
console.log('\nPreflight')
const dirty = run('git', ['status', '--porcelain']).out
check(!dirty, 'working tree is clean', 'working tree has uncommitted changes (commit or stash them)', { blocking: !dryRun })
// the release tag must name the commit these binaries come from (release-target.mjs)
const sha = run('git', ['rev-parse', 'HEAD']).out
const head = sha.slice(0, 12)
console.log(`  · building commit ${head}`)
if (ci) {
  const p = tagTargetProblem({ tag, sha, tagCommit: sha, ci, githubSha: process.env.GITHUB_SHA ?? null })
  check(!p, `the checkout is the tagged commit ${head}`, p)
}
/** Publishing `tag` would describe the built commit (asks the release repository where the tag points). */
function checkTagTarget() {
  const t = run('gh', ['api', `repos/${repo}/commits/${tag}`, '--jq', '.sha'])
  const tagCommit = t.ok && /^[0-9a-f]{40}$/.test(t.out) ? t.out : null
  const shaOnRemote = !tagCommit && run('gh', ['api', `repos/${repo}/commits/${sha}`, '--jq', '.sha']).ok
  const p = tagTargetProblem({ tag, sha, tagCommit, shaOnRemote, ci, githubSha: process.env.GITHUB_SHA ?? null })
  return check(!p, `${tag} ${tagCommit ? 'points' : 'will point'} at the built commit ${head}`, p)
}

const gh = run('gh', ['auth', 'status'])
check(gh.ok, 'gh is signed in', 'gh is not signed in (run: gh auth login)', { blocking: !dryRun })
let latestTag = null
if (gh.ok) {
  const v = run('gh', ['release', 'view', '--repo', repo, '--json', 'tagName', '--jq', '.tagName'])
  latestTag = v.ok ? v.out.replace(/^v/, '') : null
  console.log(`  · latest published release: ${latestTag ? `v${latestTag}` : 'none yet'}`)
  if (!dryRun) {
    const exists = run('gh', ['release', 'view', tag, '--repo', repo]).ok
    check(!exists, `${tag} is not published yet`, `${tag} already exists on ${repo}`)
    checkTagTarget()
  }
}
if (!dryRun) {
  check(positional[0] != null, 'version given', 'give the new version explicitly')
  if (latestTag && SEMVER.test(latestTag)) check(cmp(version, latestTag) > 0, `${version} is newer than v${latestTag}`, `${version} must be newer than the published v${latestTag} (the updater only moves forward)`)
}
check(pkg.dependencies?.['electron-updater'] != null, 'electron-updater is a dependency', 'electron-updater is missing from dependencies')

// signing identity: Developer ID Application, from CSC_NAME / CSC_LINK or the login keychain (--ci: CSC_KEYCHAIN)
const ids = run('security', ['find-identity', '-v', '-p', 'codesigning', ...(ciKeychain ? [ciKeychain] : [])]).out.split('\n').filter((l) => l.includes('"Developer ID Application:'))
const cscName = process.env.CSC_NAME?.trim()
let signHash = null
if (process.env.CSC_LINK) {
  // electron-builder would import the .p12 into a temporary keychain that is gone before the dmg is signed
  // (CI imports it itself, into a keychain that outlives this script: CSC_KEYCHAIN)
  check(false, '', `CSC_LINK is not used by release:mac: ${ci ? 'the workflow imports the certificate and sets CSC_KEYCHAIN' : 'import the certificate into the login keychain (RELEASING.md §3.1)'}`, { blocking: !dryRun })
} else if (cscName) {
  const hit = ids.find((l) => l.includes(`"Developer ID Application: ${cscName}"`))
  signHash = hit ? /\b([0-9A-F]{40})\b/.exec(hit)?.[1] ?? null : null
  check(!!hit, 'CSC_NAME matches a Developer ID Application certificate in the keychain', 'CSC_NAME matches no valid Developer ID Application certificate in the keychain', { blocking: !dryRun })
} else {
  if (ids.length === 1) signHash = /\b([0-9A-F]{40})\b/.exec(ids[0])?.[1] ?? null
  check(ids.length === 1, 'one Developer ID Application certificate in the keychain', ids.length ? `${ids.length} Developer ID Application certificates: set CSC_NAME to the one to use` : 'no Developer ID Application certificate in the keychain (RELEASING.md §3.1)', { blocking: !dryRun })
}
const keychainArgs = ciKeychain ? ['--keychain', ciKeychain] : []

// notary credentials: an App Store Connect API key, or a notarytool keychain profile
const apiVars = ['APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER']
const apiSet = apiVars.filter((k) => process.env[k])
const profile = process.env.APPLE_KEYCHAIN_PROFILE
let notaryArgs = null
if (apiSet.length === 3) {
  const p8 = process.env.APPLE_API_KEY
  const exists = fs.existsSync(p8)
  check(exists, 'notary API key file exists (APPLE_API_KEY)', 'APPLE_API_KEY does not point to a readable .p8 file', { blocking: !dryRun })
  check(!p8.startsWith(root + path.sep), 'notary API key is outside the repository', 'the .p8 key is inside the repository: move it out (RELEASING.md §3.2)')
  if (exists) {
    const mode = fs.statSync(p8).mode & 0o777
    check((mode & 0o077) === 0, 'notary API key is private (chmod 600)', 'the .p8 key is readable by others: chmod 600 it', { blocking: false })
  }
  notaryArgs = ['--key', p8, '--key-id', process.env.APPLE_API_KEY_ID, '--issuer', process.env.APPLE_API_ISSUER]
} else if (profile) {
  check(true, 'notary credentials from keychain profile (APPLE_KEYCHAIN_PROFILE)', '')
  notaryArgs = ['--keychain-profile', profile, ...(process.env.APPLE_KEYCHAIN ? ['--keychain', process.env.APPLE_KEYCHAIN] : [])]
} else {
  check(false, '', apiSet.length ? `notary API key incomplete: set all of ${apiVars.join(', ')}` : 'no notary credentials: set APPLE_API_KEY, APPLE_API_KEY_ID, APPLE_API_ISSUER (or APPLE_KEYCHAIN_PROFILE)', { blocking: !dryRun })
}
check(run('xcrun', ['--find', 'notarytool']).ok && run('xcrun', ['--find', 'stapler']).ok, 'notarytool and stapler are installed', 'Xcode command line tools missing (xcode-select --install)', { blocking: !dryRun })

if (problems.length) fail(`Preflight failed (${problems.length}). Nothing was built or published.`)

// ---------- 2. build ----------
fs.rmSync(outDir, { recursive: true, force: true })
step('npx', ['electron-vite', 'build'])
step('npm', ['run', '-s', 'phone:build'])
step('node', ['scripts/verify-no-fake-slack.cjs'])
const builderArgs = [
  'electron-builder', '--mac', '--arm64', '--config', 'electron-builder.yml', '--publish', 'never',
  `-c.directories.output=release/${version}`,
  `-c.extraMetadata.version=${version}`
]
const env = { ...process.env }
if (dryRun) {
  // ad-hoc identity "-": same hardened runtime and entitlements as a release, no certificate. An ad-hoc signature has
  // no Team ID for library validation to compare, so this build alone adds disable-library-validation.
  builderArgs.push('-c.mac.identity=-', '-c.mac.notarize=false', '-c.mac.entitlements=build/entitlements.mac.adhoc.plist', '-c.mac.entitlementsInherit=build/entitlements.mac.adhoc.plist')
  delete env.CSC_LINK
  delete env.CSC_NAME
} else {
  // a release is never unsigned: fail instead of skipping when the identity is not found
  builderArgs.push('-c.forceCodeSigning=true')
  // CI: electron-builder looks only in CSC_KEYCHAIN (inherited) and signs with the exact identity checked above
  if (ci && signHash) env.CSC_NAME = signHash
}
step('npx', builderArgs, { env })

// ---------- 3. dmg: sign, notarize, staple (the app inside was notarized and stapled by electron-builder) ----------
for (const f of [appPath, dmg, zip, latestYml]) if (!fs.existsSync(f)) fail(`missing build output ${path.relative(root, f)}`)
if (dryRun) {
  step('codesign', ['--force', '--sign', '-', dmg])
} else {
  step('codesign', ['--force', '--timestamp', ...keychainArgs, '--sign', signHash ?? `Developer ID Application: ${cscName}`, dmg])
  step('xcrun', ['notarytool', 'submit', dmg, '--wait', ...notaryArgs])
  step('xcrun', ['stapler', 'staple', dmg])
}
fs.copyFileSync(dmg, dmgVersioned)

// ---------- 4. verify ----------
console.log('\nVerify')
const verify = (label, cmd, argv, { expectFail = false } = {}) => {
  const r = run(cmd, argv)
  const shown = r.out.replaceAll(root + path.sep, '').split('\n').filter(Boolean).slice(-2).join(' | ')
  if (expectFail) console.log(`  · ${label}: ${r.ok ? 'accepted' : 'rejected'} (expected for an ad-hoc build) ${shown ? `- ${shown}` : ''}`)
  else check(r.ok, `${label}${shown ? ` - ${shown}` : ''}`, `${label} failed${shown ? `: ${shown}` : ''}`)
  return r
}
verify('codesign --verify --deep --strict (app)', 'codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath])
const info = run('codesign', ['-dvv', appPath]).out
check(/flags=0x[0-9a-f]+\([^)]*runtime[^)]*\)/.test(info), 'hardened runtime is on', 'hardened runtime is off (electron-builder.yml mac.hardenedRuntime)')
const ents = run('codesign', ['-d', '--entitlements', '-', '--xml', appPath]).out
check(ents.includes('com.apple.security.cs.allow-jit'), 'entitlements include allow-jit', 'entitlements are missing allow-jit')
verify('hdiutil verify (dmg)', 'hdiutil', ['verify', dmg])
verify('codesign --verify (dmg)', 'codesign', ['--verify', '--verbose=2', dmg])
if (dryRun) {
  verify('spctl (app)', 'spctl', ['-a', '-vvv', '-t', 'exec', appPath], { expectFail: true })
} else {
  verify('spctl Gatekeeper (app)', 'spctl', ['-a', '-vvv', '-t', 'exec', appPath])
  // a disk image is assessed as a document to open; `-t install` is for installer packages
  verify('spctl Gatekeeper (dmg)', 'spctl', ['-a', '-vvv', '-t', 'open', '--context', 'context:primary-signature', dmg])
  verify('stapler validate (app)', 'xcrun', ['stapler', 'validate', appPath])
  verify('stapler validate (dmg)', 'xcrun', ['stapler', 'validate', dmg])
}
const yml = fs.readFileSync(latestYml, 'utf8')
check(yml.includes(`version: ${version}`) && yml.includes('Principia-arm64.zip'), `latest-mac.yml offers ${version} (Principia-arm64.zip)`, 'latest-mac.yml does not describe this build')
const appVersion = run('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', path.join(appPath, 'Contents', 'Info.plist')]).out
check(appVersion === version, `app version is ${version}`, `app version is ${appVersion}, not ${version}`)
const updateYml = path.join(appPath, 'Contents', 'Resources', 'app-update.yml')
check(fs.existsSync(updateYml) && fs.readFileSync(updateYml, 'utf8').includes(latestUrl), 'app-update.yml points at the release feed', 'app-update.yml is missing or points elsewhere')
if (problems.length) fail(`Verification failed (${problems.length}). Nothing was published.`)

// ---------- 5. publish ----------
const assets = [dmg, dmgVersioned, zip, `${zip}.blockmap`, latestYml].filter((f) => fs.existsSync(f))
const notes = notesFile ? ['--notes-file', path.resolve(notesFile)] : ['--generate-notes']
// --target is used only when the tag is new; an existing tag was checked (and is checked again below) to be the build
const ghArgs = ['release', 'create', tag, '--repo', repo, '--target', sha, ...(ci ? ['--verify-tag'] : []), '--title', `Principia ${version}`, ...notes, ...assets.map((f) => path.relative(root, f))]
console.log('\nArtifacts')
for (const f of assets) console.log(`  ${path.relative(root, f)}  ${(fs.statSync(f).size / 1048576).toFixed(1)} MB`)
if (dryRun) {
  console.log(`\nDry run: would publish with\n  gh ${ghArgs.join(' ')}`)
  console.log(`\nTry it: open "${path.relative(root, appPath)}" (use HIVE_USER_DATA=<scratch dir> so it never touches your data).`)
  process.exit(0)
}
// the tag may have been pushed or moved while this built and notarized
if (gh.ok && !checkTagTarget()) fail(`Nothing was published: ${tag} must point at the built commit ${head}.`)
step('gh', ghArgs)

// the download link on the site resolves to this release
const head200 = run('curl', ['-sIL', '-o', '/dev/null', '-w', '%{http_code}', `${latestUrl}/Principia-arm64.dmg`]).out
check(head200 === '200', `${latestUrl}/Principia-arm64.dmg answers 200`, `the latest download link answers ${head200} (GitHub may need a minute; check the release page)`, { blocking: false })
console.log(`\n✓ Published ${tag}: https://github.com/${repo}/releases/tag/${tag}`)
console.log('First release only: set RELEASE_PUBLISHED = true on the website so the Download button appears (RELEASING.md §7).')
