#!/usr/bin/env node
/**
 * docs/IOS.md "TestFlight": archive the iPhone app, export it for App Store Connect and upload it, in one command.
 *
 *   node scripts/ios-testflight.mjs --dry-run                 print every step (credentials redacted), run nothing
 *   node scripts/ios-testflight.mjs --unsigned                archive only, with code signing off (no Apple account):
 *                                                             proves the Release archive builds
 *   node scripts/ios-testflight.mjs                           archive, export and upload (needs the four variables)
 *   node scripts/ios-testflight.mjs --build-number 42 --version 0.2.0 --skip-upload
 *
 * Signing is automatic (-allowProvisioningUpdates) with the App Store Connect API key, so no certificate or profile
 * has to be made by hand. It reads from the environment only, and never prints a value:
 *   APPLE_TEAM_ID       the Apple Developer team id (never committed: project.yml keeps DEVELOPMENT_TEAM empty)
 *   APPLE_API_KEY       path to AuthKey_<KEY ID>.p8 (the same variable the Mac release uses, docs/RELEASING.md §3.3)
 *   APPLE_API_KEY_ID    the key's Key ID
 *   APPLE_API_ISSUER    the Issuer ID
 * The build number is --build-number, else BUILD_NUMBER, else GITHUB_RUN_NUMBER (.github/workflows/testflight.yml):
 * App Store Connect needs a new, higher one for every upload of a version. A dry run or an unsigned archive without
 * one uses the UTC time (YYYYMMDDHHmm). Everything is written to ios/build/testflight
 * (git-ignored), never to out/.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ios = path.join(root, 'ios')
const args = process.argv.slice(2)
const flag = name => args.includes(name)
const option = name => {
  const i = args.indexOf(name)
  if (i < 0) return null
  const v = args[i + 1]
  if (!v || v.startsWith('--')) fail(`${name} needs a value`)
  return v
}
const known = new Set(['--dry-run', '--unsigned', '--skip-upload', '--build-number', '--version', '--help'])
for (const [i, a] of args.entries()) {
  if (a.startsWith('--') && !known.has(a)) fail(`Unknown option ${a} (see the top of scripts/ios-testflight.mjs)`)
  if (!a.startsWith('--') && !['--build-number', '--version'].includes(args[i - 1])) fail(`Unexpected argument ${a}`)
}
if (flag('--help')) {
  console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0])
  process.exit(0)
}
const dryRun = flag('--dry-run')
const unsigned = flag('--unsigned')
const skipUpload = flag('--skip-upload') || unsigned

const buildNumber = option('--build-number') ?? process.env.BUILD_NUMBER?.trim() ?? process.env.GITHUB_RUN_NUMBER?.trim()
  ?? new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12)
if (!dryRun && !unsigned && !option('--build-number') && !process.env.BUILD_NUMBER?.trim() && !process.env.GITHUB_RUN_NUMBER?.trim()) {
  // CI numbers its uploads with the run number: a time-based number from a laptop would be higher and block CI's next
  fail('Give --build-number (higher than the last upload; TestFlight lists it). CI uses its run number.')
}
if (!/^\d{1,18}(?:\.\d{1,9}){0,2}$/.test(buildNumber)) fail(`"${buildNumber}" is not a build number like 42 or 202610271200`)
const version = option('--version') ?? /^\s+MARKETING_VERSION:\s*"?([^"\s]+)"?/m.exec(fs.readFileSync(path.join(ios, 'project.yml'), 'utf8'))?.[1]
if (!version || !/^\d+\.\d+(?:\.\d+)?$/.test(version)) fail(`"${version}" is not a version like 0.2.0 (App Store Connect takes one to three numbers)`)

const out = path.join(ios, 'build', 'testflight')
const archive = path.join(out, 'Principia.xcarchive')
const exportDir = path.join(out, 'export')
const ipa = path.join(exportDir, 'Principia.ipa')
const exportPlist = path.join(out, 'ExportOptions.plist')

// the four credentials, checked before anything runs (a dry run shows placeholders)
const env = name => process.env[name]?.trim() || ''
const creds = { team: env('APPLE_TEAM_ID'), key: env('APPLE_API_KEY'), keyId: env('APPLE_API_KEY_ID'), issuer: env('APPLE_API_ISSUER') }
if (!dryRun && !unsigned) {
  const missing = Object.entries({ APPLE_TEAM_ID: creds.team, APPLE_API_KEY: creds.key, APPLE_API_KEY_ID: creds.keyId, APPLE_API_ISSUER: creds.issuer })
    .filter(([, v]) => !v).map(([k]) => k)
  if (missing.length) fail(`Set ${missing.join(', ')} (docs/IOS.md, TestFlight). Or try --dry-run / --unsigned.`)
  if (!/^[A-Z0-9]{10}$/.test(creds.team)) fail('APPLE_TEAM_ID is not a 10-character team id')
  if (!fs.existsSync(creds.key)) fail('APPLE_API_KEY does not point at a file (the AuthKey_<KEY ID>.p8 path)')
  if (!/^[A-Z0-9]{8,12}$/.test(creds.keyId)) fail('APPLE_API_KEY_ID does not look like a Key ID')
  if (!/^[0-9a-f-]{36}$/i.test(creds.issuer)) fail('APPLE_API_ISSUER does not look like an Issuer ID')
}
// what is printed: the shape of every command, never a credential
const shown = { team: '<APPLE_TEAM_ID>', key: '<APPLE_API_KEY>', keyId: '<APPLE_API_KEY_ID>', issuer: '<APPLE_API_ISSUER>' }
const auth = c => ['-allowProvisioningUpdates', '-authenticationKeyPath', c.key, '-authenticationKeyID', c.keyId, '-authenticationKeyIssuerID', c.issuer]

const archiveCmd = c => ['xcodebuild', '-project', 'ios/Principia.xcodeproj', '-scheme', 'Principia', '-configuration', 'Release',
  '-destination', 'generic/platform=iOS', '-archivePath', rel(archive), 'archive',
  `MARKETING_VERSION=${version}`, `CURRENT_PROJECT_VERSION=${buildNumber}`,
  ...(unsigned ? ['CODE_SIGNING_ALLOWED=NO'] : [`DEVELOPMENT_TEAM=${c.team}`, 'CODE_SIGN_STYLE=Automatic', ...auth(c)])]
const exportCmd = c => ['xcodebuild', '-exportArchive', '-archivePath', rel(archive), '-exportPath', rel(exportDir),
  '-exportOptionsPlist', rel(exportPlist), ...auth(c)]
const uploadCmd = c => ['xcrun', 'altool', '--upload-app', '-f', rel(ipa), '-t', 'ios',
  '--api-key', c.keyId, '--api-issuer', c.issuer, '--p8-file-path', c.key]

const exportOptions = team => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>method</key>
\t<string>app-store-connect</string>
\t<key>destination</key>
\t<string>export</string>
\t<key>teamID</key>
\t<string>${team}</string>
\t<key>signingStyle</key>
\t<string>automatic</string>
\t<key>uploadSymbols</key>
\t<true/>
\t<key>manageAppVersionAndBuildNumber</key>
\t<false/>
</dict>
</plist>
`

console.log(`Principia for iPhone ${version} (${buildNumber})${dryRun ? ': dry run, nothing runs' : unsigned ? ': unsigned archive only' : ''}`)
step('Generate the Xcode project', ['xcodegen', 'generate', '--spec', 'ios/project.yml'])
if (!dryRun) fs.rmSync(archive, { recursive: true, force: true })
step('Archive (Release, generic iOS device)', archiveCmd(creds), archiveCmd(shown))
if (unsigned) {
  if (!dryRun) {
    const app = path.join(archive, 'Products', 'Applications', 'Principia.app')
    for (const f of ['Info.plist', 'PrivacyInfo.xcprivacy', 'Assets.car']) {
      if (!fs.existsSync(path.join(app, f))) fail(`The archive has no ${f} in Principia.app`)
    }
  }
  console.log(`\nUnsigned archive: ${rel(archive)} (not uploadable; it proves the Release build).`)
  process.exit(0)
}
console.log(`\n▸ Write ${rel(exportPlist)} (method app-store-connect, automatic signing, team ${shown.team})`)
if (dryRun) console.log(exportOptions(shown.team).split('\n').map(l => `    ${l}`).join('\n'))
else {
  fs.mkdirSync(out, { recursive: true })
  fs.writeFileSync(exportPlist, exportOptions(creds.team), { mode: 0o600 })
  fs.rmSync(exportDir, { recursive: true, force: true })
}
step('Export the .ipa for App Store Connect', exportCmd(creds), exportCmd(shown))
if (!dryRun && !fs.existsSync(ipa)) fail(`The export made no ${rel(ipa)}`)
if (skipUpload) {
  console.log(`\nSkipped the upload. The build is ${rel(ipa)}.`)
} else {
  step('Upload to App Store Connect (TestFlight)', uploadCmd(creds), uploadCmd(shown))
  console.log(dryRun ? '\nDry run: nothing was built or uploaded.' : `\nUploaded ${version} (${buildNumber}). App Store Connect processes it (5–30 minutes), then it shows in TestFlight.`)
}
if (!dryRun) fs.rmSync(exportPlist, { force: true })

function step(title, cmd, display = cmd) {
  console.log(`\n▸ ${title}\n  ${display.map(quote).join(' ')}`)
  if (dryRun) return
  const r = spawnSync(cmd[0], cmd.slice(1), { cwd: root, stdio: 'inherit' })
  if (r.error) fail(`${cmd[0]} did not start: ${r.error.message}`)
  if (r.status !== 0) fail(`${title} failed (exit ${r.status})`)
}

function rel(p) { return path.relative(root, p) }
function quote(s) { return /^[\w@%+=:,./<>-]+$/.test(s) ? s : `'${s.replaceAll("'", "'\\''")}'` }
function fail(message) {
  console.error(`ios-testflight: ${message}`)
  process.exit(1)
}
