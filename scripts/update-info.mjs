/**
 * docs/RELEASING.md §4.1: the update manifests electron-updater reads (latest-mac.yml, beta-mac.yml), written here
 * without electron-builder so the signing job never needs node_modules. Dependency-free (node built-ins only).
 *
 * Channels:
 *   - a stable version (1.2.3) is offered to everyone: latest-mac.yml, and beta-mac.yml too, so people on the beta
 *     channel also move on to the stable release;
 *   - a prerelease (1.2.3-beta.1) is offered only to people who turned on "Get beta updates": beta-mac.yml alone,
 *     on a GitHub pre-release, so releases/latest/download (the stable feed and the website's download link) never
 *     moves to it.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/

/**
 * 'latest' for a stable version, 'beta' for a beta (1.2.3-beta or 1.2.3-beta.N); null for anything else, including
 * other prereleases (rc, alpha, ...): on the `beta` channel electron-updater's GitHub provider skips every prerelease
 * whose first identifier is not alpha/beta and moves beta users down to no alpha, so an rc would never reach anyone.
 */
export function releaseChannel(version) {
  const m = SEMVER.exec(String(version ?? ''))
  if (!m) return null
  if (!m[4]) return 'latest'
  return m[4].split('.')[0] === 'beta' ? 'beta' : null
}

/** The update manifests a release of `version` publishes (macOS). */
export function channelFiles(version) {
  const channel = releaseChannel(version)
  if (!channel) throw new Error(`"${version}" is not a version like 1.2.3 or 1.2.3-beta.1 (the only prerelease the updater offers is -beta)`)
  return channel === 'beta' ? ['beta-mac.yml'] : ['latest-mac.yml', 'beta-mac.yml']
}

/** SHA-512 of a file, base64: the digest electron-updater checks a download against. */
export function sha512Base64File(file) {
  const hash = crypto.createHash('sha512')
  const fd = fs.openSync(file, 'r')
  try {
    const buf = Buffer.allocUnsafe(1 << 20)
    let n
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) hash.update(buf.subarray(0, n))
  } finally {
    fs.closeSync(fd)
  }
  return hash.digest('base64')
}

// every value written is a version, a file name, a base64 digest, a size or an ISO date: quote what YAML could misread
const q = (s) => `'${String(s).replaceAll("'", "''")}'`

/**
 * The text of an update manifest in electron-builder's format:
 *   version, files[{url, sha512, size}], path, sha512, releaseDate
 * `files` are update payloads by file name (the zip); the first one is the primary (path/sha512).
 */
export function updateInfoYaml({ version, files, releaseDate }) {
  if (!releaseChannel(version)) throw new Error(`"${version}" is not a version like 1.2.3 or 1.2.3-beta.1`)
  if (!files?.length) throw new Error('an update manifest needs at least one file')
  for (const f of files) {
    if (!f.url || f.url.includes('/') || /\s/.test(f.url)) throw new Error(`"${f.url}" is not a plain file name`)
    if (!/^[A-Za-z0-9+/]{86}==$/.test(f.sha512)) throw new Error(`${f.url}: sha512 is not a base64 SHA-512`)
    if (!Number.isSafeInteger(f.size) || f.size <= 0) throw new Error(`${f.url}: size must be a positive integer`)
  }
  const date = new Date(releaseDate)
  if (Number.isNaN(date.getTime())) throw new Error(`"${releaseDate}" is not a date`)
  const lines = [`version: ${version}`, 'files:']
  for (const f of files) lines.push(`  - url: ${f.url}`, `    sha512: ${f.sha512}`, `    size: ${f.size}`)
  lines.push(`path: ${files[0].url}`, `sha512: ${files[0].sha512}`, `releaseDate: ${q(date.toISOString())}`)
  return lines.join('\n') + '\n'
}

/**
 * Minimal reader for the manifests written above (and electron-builder's own): version, path, sha512 and the files
 * list. Used to check a manifest against its zip; not a general YAML parser.
 */
export function parseUpdateInfo(text) {
  const out = { version: null, path: null, sha512: null, releaseDate: null, files: [] }
  let cur = null
  const unq = (v) => {
    const s = v.trim()
    if (s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1).replaceAll("''", "'")
    if (s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1)
    return s
  }
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue
    let m
    if ((m = /^ {2}- (\w+):\s*(.*)$/.exec(line))) {
      cur = {}
      out.files.push(cur)
      cur[m[1]] = unq(m[2])
    } else if ((m = /^ {4}(\w+):\s*(.*)$/.exec(line)) && cur) {
      cur[m[1]] = unq(m[2])
    } else if ((m = /^(\w+):\s*(.*)$/.exec(line))) {
      cur = null
      if (m[1] in out && m[1] !== 'files') out[m[1]] = unq(m[2])
    }
  }
  for (const f of out.files) if (f.size != null) f.size = Number(f.size)
  return out
}

/**
 * Write the manifests for `version` next to `zip` (its directory), and remove a manifest of the other channel left
 * there (a prerelease must never carry latest-mac.yml). Returns the paths written.
 */
export function writeUpdateInfo({ version, zip, releaseDate = new Date() }) {
  const dir = path.dirname(zip)
  const text = updateInfoYaml({ version, files: [{ url: path.basename(zip), sha512: sha512Base64File(zip), size: fs.statSync(zip).size }], releaseDate })
  const names = channelFiles(version)
  for (const stale of ['latest-mac.yml', 'beta-mac.yml']) if (!names.includes(stale)) fs.rmSync(path.join(dir, stale), { force: true })
  return names.map((n) => {
    const file = path.join(dir, n)
    fs.writeFileSync(file, text)
    return file
  })
}

// CLI: node scripts/update-info.mjs <version> <path/to/Principia-arm64.zip>
if (import.meta.url === `file://${process.argv[1]}`) {
  const [version, zip] = process.argv.slice(2)
  if (!version || !zip) {
    console.error('Usage: node scripts/update-info.mjs <version> <path/to/Principia-arm64.zip>')
    process.exit(2)
  }
  for (const f of writeUpdateInfo({ version, zip })) console.log(f)
}
