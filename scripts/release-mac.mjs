#!/usr/bin/env node
/**
 * docs/RELEASING.md §5: one command from a clean checkout to a published macOS release.
 *
 *   npm run release:mac -- 0.2.0                 build, sign, notarize, staple, verify, publish v0.2.0
 *   npm run release:mac -- 0.3.0-beta.1          a beta: GitHub pre-release, beta-mac.yml only (RELEASING.md §4.1)
 *   npm run release:mac -- 0.2.0 --notes notes.md   ... with these release notes (default: the release-please draft's
 *                                                notes when there is one, else generated from commits)
 *   npm run release:mac -- --dry-run             everything except Developer ID signing, notarizing and publishing
 *                                                (ad-hoc signed, hardened runtime): tests the build on any Mac
 *
 * The stages, which GitHub Actions runs in two jobs (.github/workflows/release.yml, RELEASING.md §5.2):
 *   ... --build-only                             1. build the UNSIGNED Principia.app (electron-builder --dir) and stop.
 *                                                The job that runs `npm ci` stops here and never sees a secret.
 *   ... --prepackaged <Principia.app>            2. skip the build: sign that app inside-out (hardened runtime,
 *                                                entitlements), notarize + staple it, make the updater zip and the dmg,
 *                                                sign + notarize + staple the dmg, write latest-mac.yml / beta-mac.yml
 *                                                and SHA256SUMS.txt, verify. Needs no node_modules (scripts/mac-sign.mjs,
 *                                                scripts/update-info.mjs: Apple's tools and Node built-ins only).
 *   ... --draft-only                             3. stop once the draft release holds every file (CI attests them)
 *   ... --publish-draft                          4. publish that draft: checks it holds exactly the files of
 *                                                release/<version>/SHA256SUMS.txt, then publishes (no build)
 *   ... --ci                                     GitHub Actions only: the version must be the run's tag, and the identity
 *                                                comes from the job's temporary keychain (CSC_KEYCHAIN)
 *
 * A release is always created as a draft first: every file (dmg, versioned dmg, zip, the update manifests and
 * SHA256SUMS.txt) is uploaded to the draft, checked there, and only then published. With immutable releases on, a
 * published release can never gain or replace a file.
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
import { assetProblems, checksumsText, describeFiles, parseChecksums, SUMS_FILE } from './release-assets.mjs'
import { channelFiles, parseUpdateInfo, releaseChannel, sha512Base64File, writeUpdateInfo } from './update-info.mjs'
import { packageRelease } from './mac-sign.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const ci = args.includes('--ci')
const draftOnly = args.includes('--draft-only')
const publishDraft = args.includes('--publish-draft')
const buildOnly = args.includes('--build-only')
const prepIdx = args.indexOf('--prepackaged')
const prepackaged = prepIdx >= 0 ? args[prepIdx + 1] && path.resolve(args[prepIdx + 1]) : null
if (prepIdx >= 0 && !prepackaged) fail('--prepackaged needs the path of the unsigned Principia.app')
// --ci: the workflow imported the certificate into a temporary keychain that lives for the whole job, and passes
// its path as CSC_KEYCHAIN; every identity lookup and signature uses that keychain only
const ciKeychain = ci ? process.env.CSC_KEYCHAIN?.trim() || null : null
const notesIdx = args.indexOf('--notes')
const notesFile = notesIdx >= 0 ? args[notesIdx + 1] : null
const positional = args.filter((a, i) => !a.startsWith('--') && !(notesIdx >= 0 && i === notesIdx + 1) && !(prepIdx >= 0 && i === prepIdx + 1))
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
// electron-updater's beta channel offers only -beta prereleases: an -rc or -alpha would publish and never reach anyone
if (!releaseChannel(version)) fail(`"${version}": the only prerelease the updater offers is -beta (1.2.3-beta.1), not -rc/-alpha`)
const tag = `v${version}`
// RELEASING.md §4.1: 1.2.3-beta.1 is a GitHub pre-release on the beta channel (beta-mac.yml only); releases/latest never
// points at it, so the website's download link and the stable updater feed stay on the newest stable release
const prerelease = releaseChannel(version) === 'beta'
if (ci && dryRun) fail('--ci and --dry-run do not go together')
if (dryRun && (draftOnly || publishDraft)) fail('--dry-run never uploads: leave out --draft-only / --publish-draft')
if (draftOnly && publishDraft) fail('--draft-only and --publish-draft do not go together')
if (buildOnly && (prepackaged || draftOnly || publishDraft || dryRun)) fail('--build-only only builds: leave out --prepackaged / --draft-only / --publish-draft / --dry-run')
if (prepackaged && publishDraft) fail('--publish-draft builds nothing: leave out --prepackaged')
// stages that sign: everything but --build-only and --publish-draft
const signs = !buildOnly && !publishDraft
if (ci) {
  if (process.env.GITHUB_ACTIONS !== 'true') fail('--ci runs only in GitHub Actions (locally: npm run release:mac -- <version>)')
  if (process.env.GITHUB_REF_TYPE !== 'tag' || process.env.GITHUB_REF_NAME !== tag) fail(`--ci releases only the pushed tag: this run is for ${process.env.GITHUB_REF_NAME ?? 'no ref'}, not ${tag}`)
  if (signs && (!ciKeychain || !fs.existsSync(ciKeychain))) fail('--ci needs CSC_KEYCHAIN: the path of the temporary keychain holding the Developer ID certificate')
  // CI never builds and signs in one job: the job that ran `npm ci` holds no secrets (release.yml)
  if (signs && !prepackaged) fail('--ci signs only a --prepackaged app (built by the --build-only job)')
}
const outDir = path.join(root, 'release', version)
const appPath = path.join(outDir, 'mac-arm64', 'Principia.app')
const dmg = path.join(outDir, 'Principia-arm64.dmg')
const dmgVersioned = path.join(outDir, `Principia-${version}-arm64.dmg`)
const zip = path.join(outDir, 'Principia-arm64.zip')
const updateYmls = channelFiles(version).map((n) => path.join(outDir, n))
const sumsFile = path.join(outDir, SUMS_FILE)

const ENTITLEMENTS = { app: 'build/entitlements.mac.plist', inherit: 'build/entitlements.mac.inherit.plist', adhoc: 'build/entitlements.mac.adhoc.plist' }

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

const stage = buildOnly ? ' · BUILD ONLY: unsigned app' : prepackaged ? ' · SIGN the prepackaged app' : ''
console.log(`Principia ${version} for macOS (Apple Silicon)${prerelease ? ' · BETA (pre-release, beta channel)' : ''}${dryRun ? ' · DRY RUN: ad-hoc signed, not notarized, not published' : ''}${stage}${ci ? ' · GitHub Actions' : ''}`)
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

// --build-only never talks to GitHub (the CI build job has no token): it only builds
const gh = buildOnly ? { ok: false } : run('gh', ['auth', 'status'])
if (!buildOnly) check(gh.ok, 'gh is signed in', 'gh is not signed in (run: gh auth login)', { blocking: !dryRun })
let latestTag = null
let existingDraft = false
if (gh.ok) {
  const v = run('gh', ['release', 'view', '--repo', repo, '--json', 'tagName', '--jq', '.tagName'])
  latestTag = v.ok ? v.out.replace(/^v/, '') : null
  console.log(`  · latest published release: ${latestTag ? `v${latestTag}` : 'none yet'}`)
  if (!dryRun) {
    const r = run('gh', ['release', 'view', tag, '--repo', repo, '--json', 'isDraft', '--jq', '.isDraft'])
    existingDraft = r.ok && r.out === 'true'
    if (publishDraft) {
      check(existingDraft, `${tag} is a draft, ready to publish`, r.ok ? `${tag} is already published` : `${tag} has no draft release to publish`)
    } else {
      check(!r.ok || existingDraft, `${tag} is not published yet`, `${tag} already exists on ${repo}`)
      if (existingDraft) console.log(`  · a draft of ${tag} from an earlier attempt exists: it is replaced (it was never published)`)
    }
    checkTagTarget()
  }
}
if (!dryRun) {
  check(positional[0] != null, 'version given', 'give the new version explicitly')
  if (latestTag && SEMVER.test(latestTag)) check(cmp(version, latestTag) > 0, `${version} is newer than v${latestTag}`, `${version} must be newer than the published v${latestTag} (the updater only moves forward)`)
}
check(pkg.dependencies?.['electron-updater'] != null, 'electron-updater is a dependency', 'electron-updater is missing from dependencies')

// --publish-draft: nothing is built; the draft made by an earlier --draft-only run is checked and published
if (publishDraft) {
  if (!gh.ok) problems.push('gh is not signed in')
  if (problems.length) fail(`Preflight failed (${problems.length}). Nothing was published.`)
  publishDraftRelease()
  process.exit(0)
}

// signing identity: Developer ID Application, from CSC_NAME or the login keychain (--ci: CSC_KEYCHAIN). The dry run
// signs ad-hoc ("-") and --build-only does not sign at all.
let identity = null
let notaryArgs = null
if (signs) {
  const ids = run('security', ['find-identity', '-v', '-p', 'codesigning', ...(ciKeychain ? [ciKeychain] : [])]).out.split('\n').filter((l) => l.includes('"Developer ID Application:'))
  const cscName = process.env.CSC_NAME?.trim()
  let signHash = null
  if (process.env.CSC_LINK) {
    check(false, '', `CSC_LINK is not used by release:mac: ${ci ? 'the workflow imports the certificate and sets CSC_KEYCHAIN' : 'import the certificate into the login keychain (RELEASING.md §3.1)'}`, { blocking: !dryRun })
  } else if (cscName) {
    const hit = ids.find((l) => l.includes(`"Developer ID Application: ${cscName}"`))
    signHash = hit ? /\b([0-9A-F]{40})\b/.exec(hit)?.[1] ?? null : null
    check(!!hit, 'CSC_NAME matches a Developer ID Application certificate in the keychain', 'CSC_NAME matches no valid Developer ID Application certificate in the keychain', { blocking: !dryRun })
  } else {
    if (ids.length === 1) signHash = /\b([0-9A-F]{40})\b/.exec(ids[0])?.[1] ?? null
    check(ids.length === 1, 'one Developer ID Application certificate in the keychain', ids.length ? `${ids.length} Developer ID Application certificates: set CSC_NAME to the one to use` : 'no Developer ID Application certificate in the keychain (RELEASING.md §3.1)', { blocking: !dryRun })
  }
  // the certificate's SHA-1: names the exact identity, whatever else the keychains hold
  identity = dryRun ? '-' : signHash

  // notary credentials: an App Store Connect API key, or a notarytool keychain profile
  const apiVars = ['APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER']
  const apiSet = apiVars.filter((k) => process.env[k])
  const profile = process.env.APPLE_KEYCHAIN_PROFILE
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
  if (dryRun) notaryArgs = null
  check(run('xcrun', ['--find', 'notarytool']).ok && run('xcrun', ['--find', 'stapler']).ok, 'notarytool and stapler are installed', 'Xcode command line tools missing (xcode-select --install)', { blocking: !dryRun })
}
if (prepackaged) {
  // release/<version>/ is emptied before packaging: the app to sign must live elsewhere (CI: the runner's temp folder)
  check(!(prepackaged + path.sep).startsWith(outDir + path.sep), 'the prepackaged app is outside release/<version>/', `move ${prepackaged} out of ${path.relative(root, outDir)}/ first (that folder is emptied)`)
  const ok = fs.existsSync(path.join(prepackaged, 'Contents', 'Info.plist'))
  check(ok, `prepackaged app: ${prepackaged}`, `--prepackaged ${prepackaged} is not an app bundle`)
  if (ok) {
    const v = run('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', path.join(prepackaged, 'Contents', 'Info.plist')]).out
    check(v === version, `the prepackaged app is version ${version}`, `the prepackaged app is version ${v}, not ${version}`)
  }
}

if (problems.length) fail(`Preflight failed (${problems.length}). Nothing was built or published.`)

// ---------- 2. the unsigned app ----------
fs.rmSync(outDir, { recursive: true, force: true })
if (prepackaged) {
  // a copy: the downloaded artifact stays as it was; ditto keeps symlinks, modes and extended attributes
  fs.mkdirSync(path.dirname(appPath), { recursive: true })
  step('ditto', [prepackaged, appPath])
} else {
  step('npx', ['electron-vite', 'build'])
  step('npm', ['run', '-s', 'phone:build'])
  step('node', ['scripts/verify-no-fake-slack.cjs'])
  // the app, unsigned: signing, notarizing, the zip, the dmg and the update manifests are this script's job
  // (scripts/mac-sign.mjs, scripts/update-info.mjs), so the same steps run whether the app was built here or in another
  // job. The `zip` target rather than `dir`: electron-builder writes the app's app-update.yml (the updater's feed) only
  // for a zip or dmg build. Its unsigned zip and manifest are deleted right after.
  step('npx', [
    'electron-builder', '--mac', 'zip', '--arm64', '--config', 'electron-builder.yml', '--publish', 'never',
    `-c.directories.output=release/${version}`,
    `-c.extraMetadata.version=${version}`,
    '-c.mac.identity=null', '-c.mac.notarize=false'
  ], { env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' } })
  for (const f of fs.readdirSync(outDir)) if (/\.(zip|blockmap|yml|yaml)$/.test(f)) fs.rmSync(path.join(outDir, f), { force: true })
}
if (!fs.existsSync(appPath)) fail(`missing build output ${path.relative(root, appPath)}`)
const appVersion = run('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', path.join(appPath, 'Contents', 'Info.plist')]).out
check(appVersion === version, `app version is ${version}`, `app version is ${appVersion}, not ${version}`)
const updateYml = path.join(appPath, 'Contents', 'Resources', 'app-update.yml')
check(fs.existsSync(updateYml) && fs.readFileSync(updateYml, 'utf8').includes(latestUrl), 'app-update.yml points at the release feed', 'app-update.yml is missing or points elsewhere')
if (problems.length) fail(`The build is not right (${problems.length}). Nothing was signed or published.`)
if (buildOnly) {
  console.log(`\n✓ Unsigned ${path.relative(root, appPath)} (${version}). Sign and publish it with: node scripts/release-mac.mjs ${version} --prepackaged <that app>`)
  process.exit(0)
}

// ---------- 3. sign, notarize, staple; the updater zip and the dmg (scripts/mac-sign.mjs) ----------
try {
  packageRelease({
    app: appPath,
    zip,
    dmg,
    volname: 'Principia',
    identity,
    keychain: ciKeychain,
    // an ad-hoc signature has no Team ID for library validation to compare: the dry run alone uses the adhoc plist,
    // which adds disable-library-validation (RELEASING.md §2)
    entitlements: path.join(root, dryRun ? ENTITLEMENTS.adhoc : ENTITLEMENTS.app),
    entitlementsInherit: path.join(root, dryRun ? ENTITLEMENTS.adhoc : ENTITLEMENTS.inherit),
    notaryArgs
  })
} catch (e) {
  fail(`${e instanceof Error ? e.message : String(e)}. Nothing was published.`)
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
check(/flags=0x[0-9a-f]+\([^)]*runtime[^)]*\)/.test(info), 'hardened runtime is on', 'hardened runtime is off (scripts/mac-sign.mjs)')
if (!dryRun) check(/TeamIdentifier=[A-Z0-9]{10}/.test(info), 'signed with a Developer ID (Team ID present)', 'the app has no Team ID: not signed with a Developer ID')
const ents = run('codesign', ['-d', '--entitlements', '-', '--xml', appPath]).out
check(ents.includes('com.apple.security.cs.allow-jit'), 'entitlements include allow-jit', 'entitlements are missing allow-jit')
verify('hdiutil verify (dmg)', 'hdiutil', ['verify', dmg])
verify('codesign --verify (dmg)', 'codesign', ['--verify', '--verbose=2', dmg])
if (dryRun) {
  verify('spctl (app)', 'spctl', ['-a', '-vvv', '-t', 'exec', appPath], { expectFail: true })
} else {
  // spctl accepts anything on a Mac with assessments off ("override=security disabled"): require the notarized source
  const notarized = (label, r) => check(/source=Notarized Developer ID/.test(r.out), `${label}: source=Notarized Developer ID`, `${label}: Gatekeeper does not see a notarized Developer ID signature`)
  notarized('spctl (app)', verify('spctl Gatekeeper (app)', 'spctl', ['-a', '-vvv', '-t', 'exec', appPath]))
  // a disk image is assessed as a document to open; `-t install` is for installer packages
  notarized('spctl (dmg)', verify('spctl Gatekeeper (dmg)', 'spctl', ['-a', '-vvv', '-t', 'open', '--context', 'context:primary-signature', dmg]))
  verify('stapler validate (app)', 'xcrun', ['stapler', 'validate', appPath])
  verify('stapler validate (dmg)', 'xcrun', ['stapler', 'validate', dmg])
}
// the updater installs the app from the zip: check the app as it comes out of it
const unzipped = fs.mkdtempSync(path.join(outDir, 'zip-check-'))
if (run('ditto', ['-x', '-k', zip, unzipped]).ok) {
  const z = path.join(unzipped, 'Principia.app')
  verify('codesign --verify --deep --strict (app from the zip)', 'codesign', ['--verify', '--deep', '--strict', z])
  if (!dryRun) verify('stapler validate (app from the zip)', 'xcrun', ['stapler', 'validate', z])
} else check(false, '', 'the zip does not extract')
fs.rmSync(unzipped, { recursive: true, force: true })
// the update manifests (scripts/update-info.mjs): one per channel this version is offered on
writeUpdateInfo({ version, zip })
const zipSha512 = sha512Base64File(zip)
for (const f of updateYmls) {
  const info = parseUpdateInfo(fs.readFileSync(f, 'utf8'))
  check(info.version === version && info.path === 'Principia-arm64.zip' && info.sha512 === zipSha512 && info.files[0]?.size === fs.statSync(zip).size, `${path.basename(f)} offers ${version} (Principia-arm64.zip, sha512 and size match)`, `${path.basename(f)} does not describe this build`)
}
check(run('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', path.join(appPath, 'Contents', 'Info.plist')]).out === version, `signed app version is ${version}`, 'the signed app changed version')
if (problems.length) fail(`Verification failed (${problems.length}). Nothing was published.`)

// ---------- 5. checksums ----------
const assets = [dmg, dmgVersioned, zip, ...updateYmls]
for (const f of assets) if (!fs.existsSync(f)) fail(`missing ${path.relative(root, f)}`)
fs.writeFileSync(sumsFile, checksumsText(describeFiles(assets)))
const sumsCheck = run('shasum', ['-a', '256', '-c', SUMS_FILE], { cwd: outDir })
check(sumsCheck.ok, `shasum -a 256 -c ${SUMS_FILE} (${assets.length} files)`, `shasum -a 256 -c ${SUMS_FILE} failed: ${sumsCheck.out}`)
if (problems.length) fail(`Verification failed (${problems.length}). Nothing was published.`)

// ---------- 6. draft release, then publish ----------
const uploads = [...assets, sumsFile]
// release notes: --notes, else the notes of the draft release-please made for this tag (its CHANGELOG.md section), else
// GitHub's generated notes
const draftNotes = existingDraft && !notesFile ? run('gh', ['release', 'view', tag, '--repo', repo, '--json', 'body', '--jq', '.body']) : null
let notes = notesFile ? ['--notes-file', path.resolve(notesFile)] : ['--generate-notes']
if (draftNotes?.ok && draftNotes.out.trim()) {
  const kept = path.join(outDir, 'RELEASE_NOTES.md')
  fs.writeFileSync(kept, draftNotes.out.trim() + '\n')
  notes = ['--notes-file', kept]
  console.log(`  · release notes: kept from the existing ${tag} draft (release-please)`)
}
// --target is used only when the tag is new; an existing tag was checked (and is checked again below) to be the build
const channelArgs = prerelease ? ['--prerelease', '--latest=false'] : ['--latest']
const ghArgs = ['release', 'create', tag, '--repo', repo, '--draft', '--target', sha, ...(ci ? ['--verify-tag'] : []), ...channelArgs, '--title', `Principia ${version}`, ...notes, ...uploads.map((f) => path.relative(root, f))]
console.log('\nArtifacts')
for (const f of uploads) console.log(`  ${path.relative(root, f)}  ${(fs.statSync(f).size / 1048576).toFixed(1)} MB`)
if (dryRun) {
  console.log(`\nDry run: would create the draft with\n  gh ${ghArgs.join(' ')}\nthen check it and publish it with\n  gh release edit ${tag} --repo ${repo} --draft=false ${channelArgs.join(' ')}`)
  console.log(`\nTry it: open "${path.relative(root, appPath)}" (use HIVE_USER_DATA=<scratch dir> so it never touches your data).`)
  process.exit(0)
}
// the tag may have been pushed or moved while this built and notarized
if (gh.ok && !checkTagTarget()) fail(`Nothing was published: ${tag} must point at the built commit ${head}.`)
// a draft left by an earlier failed attempt was never public; it is replaced (the tag itself is never deleted)
if (existingDraft) step('gh', ['release', 'delete', tag, '--repo', repo, '--yes'])
step('gh', ghArgs)
verifyDraft()
if (draftOnly) {
  console.log(`\n✓ Draft ${tag} holds every file. Publish it with: node scripts/release-mac.mjs ${version}${ci ? ' --ci' : ''} --publish-draft`)
  process.exit(0)
}
publishDraftRelease()

/** The draft release holds exactly the files listed in SHA256SUMS.txt (plus that file), with matching sizes and digests. */
function verifyDraft() {
  console.log(`\nDraft ${tag}`)
  const found = []
  const sums = fs.existsSync(sumsFile) ? parseChecksums(fs.readFileSync(sumsFile, 'utf8')) : null
  if (!sums || sums.size === 0) found.push(`${path.relative(root, sumsFile)} is missing or malformed (build this version first)`)
  else {
    const files = [...sums.keys()].map((n) => path.join(outDir, n))
    const missing = files.filter((f) => !fs.existsSync(f))
    if (missing.length) found.push(...missing.map((f) => `${path.relative(root, f)} is missing locally`))
    else {
      const expected = describeFiles([...files, sumsFile])
      for (const e of expected) if (e.name !== SUMS_FILE && sums.get(e.name) !== e.sha256) found.push(`${e.name} changed since ${SUMS_FILE} was written`)
      const v = run('gh', ['release', 'view', tag, '--repo', repo, '--json', 'isDraft,assets'], { stdio: ['ignore', 'pipe', 'ignore'] })
      let release = null
      try { release = v.ok ? JSON.parse(v.out) : null } catch { release = null }
      if (!release) found.push(`could not read the ${tag} release`)
      else if (!release.isDraft) found.push(`${tag} is already published`)
      else found.push(...assetProblems(expected, release.assets))
      if (!found.length) check(true, `the draft holds exactly the ${expected.length} built files (sizes and SHA-256 match)`, '')
    }
  }
  for (const p of found) check(false, '', p)
  if (found.length) fail(`The draft ${tag} does not hold exactly this build (${found.length}). Nothing was published. Delete the draft (gh release delete ${tag} --repo ${repo}) and release again.`)
}

/** Publish the checked draft, then check that the site's download link answers. */
function publishDraftRelease() {
  verifyDraft()
  // the tag may have been pushed or moved since the draft was made
  if (!checkTagTarget()) fail(`Nothing was published: ${tag} must point at the built commit ${head}.`)
  // a beta stays a pre-release and never becomes "latest"; a stable release becomes latest
  step('gh', ['release', 'edit', tag, '--repo', repo, '--draft=false', ...(prerelease ? ['--prerelease', '--latest=false'] : ['--latest'])])
  if (prerelease) {
    console.log(`\n✓ Published beta ${tag} (pre-release): https://github.com/${repo}/releases/tag/${tag}`)
    console.log('Only people with Settings › About › Get beta updates on receive it. The website keeps the latest stable release.')
    return
  }
  // the download link on the site resolves to this release
  const head200 = run('curl', ['-sIL', '-o', '/dev/null', '-w', '%{http_code}', `${latestUrl}/Principia-arm64.dmg`]).out
  check(head200 === '200', `${latestUrl}/Principia-arm64.dmg answers 200`, `the latest download link answers ${head200} (GitHub may need a minute; check the release page)`, { blocking: false })
  console.log(`\n✓ Published ${tag}: https://github.com/${repo}/releases/tag/${tag}`)
  console.log(`Verify a download: shasum -a 256 -c ${SUMS_FILE} · gh attestation verify Principia-arm64.dmg -R ${repo} (RELEASING.md §5.3)`)
  console.log('First release only: set RELEASE_PUBLISHED = true on the website so the Download button appears (RELEASING.md §7).')
}
