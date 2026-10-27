#!/usr/bin/env node
/** Export a fresh, screened source snapshot. Never exports git history or runtime data. */
import { promises as fs } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Split migration-only identifiers so the exported script remains self-consistent.
const privateUser = ['lauta', 'ritos'].join('')
const privateAccount = ['lausu', 'arez02'].join('')
const privateOrg = ['Vibiz', 'ai'].join('-')
const privateProject = ['vibiz', '04'].join('-')
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const target = process.argv[2] && path.resolve(process.argv[2])
if (!target || target === root || target.startsWith(root + path.sep)) {
  throw new Error('Usage: node scripts/prepare-public-release.mjs /absolute/new-empty-directory (outside source tree)')
}
const roots = ['src', 'e2e', 'resources', 'scripts', '.github', 'cloud', 'website', 'ios', 'phone-site']
const files = ['.dockerignore', 'release-please-config.json', '.release-please-manifest.json', 'CHANGELOG.md', 'README.md', 'CONTRIBUTING.md', 'LICENSE', 'SECURITY.md', 'CODE_OF_CONDUCT.md', '.gitignore', 'package.json', 'package-lock.json', 'electron-builder.yml', 'electron.vite.config.ts', 'tsconfig.json', 'tsconfig.node.json', 'tsconfig.web.json', 'eslint.config.mjs', 'vitest.config.ts', 'playwright.config.ts', 'vite.cloud.config.ts', 'vite.console.config.ts', 'vite.phone.config.ts', 'vite.phone-site.config.ts', 'render.yaml', 'build/icon.icns', 'build/icon.png', 'build/entitlements.mac.plist', 'build/entitlements.mac.inherit.plist', 'build/entitlements.mac.adhoc.plist', 'docs/RELEASING.md', 'docs/AUTHORING.md', 'docs/CONTRACT.md', 'docs/LIVE.md', 'docs/MEMORY.md', 'docs/SLACK.md', 'docs/slack-app-manifest.json', 'docs/MCP.md', 'docs/MCP-GATEWAY.md', 'docs/CLOUD.md', 'docs/GTM.md', 'docs/CHAT-UI.md', 'docs/REMOTE.md', 'docs/ORCHESTRATOR.md', 'docs/IOS.md', 'docs/WORKTREE.md', 'docs/PLANS.md', 'docs/BROWSER.md', 'docs/CONNECTIONS.md']
const banned = /(?:^|\/)(?:node_modules|\.git|\.claude|\.codex|\.aws|\.hive-dev-data|out|dist|release)(?:\/|$)|(?:^|\/)\.env(?:\.|$)|\.(?:sqlite|sqlite3|db|log|pem|p12|pfx)$/i
const secretPatterns = [
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]{10,}?-----END/],
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/],
  ['provider key', /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{30,}\b/],
  ['Slack token', /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g],
  ['AWS access key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/]
]
// Reviewed synthetic test fixtures that look like credentials, by SHA-256 of the exact value (values never stored).
const fixtureHashes = new Set((await fs.readFile(path.join(root, 'scripts/public-release-fixtures.sha256'), 'utf8').catch(() => ''))
  .split('\n').map(line => line.replace(/#.*/, '').trim()).filter(Boolean))
const reviewedFixture = value => fixtureHashes.has(createHash('sha256').update(value).digest('hex'))
// .github/CODEOWNERS names the code owner by GitHub handle (the public repository's owner, already public): only the
// `@handle` owner entries in that one file survive the export; every other occurrence is still replaced.
const OWNER_SLOT = '\u0000code-owner\u0000'
const keepCodeOwners = (relative, text, sanitize) => relative === '.github/CODEOWNERS'
  ? sanitize(text.replace(new RegExp(`(^|\\s)@${privateAccount}(?=\\s|$)`, 'gm'), (_, pre) => pre + OWNER_SLOT)).replaceAll(OWNER_SLOT, `@${privateAccount}`)
  : sanitize(text)
const candidates = []
async function walk(relative) {
  let stat
  try { stat = await fs.lstat(path.join(root, relative)) } catch (error) { if (error.code === 'ENOENT') return; throw error }
  if (stat.isSymbolicLink()) throw new Error(`Symlinks must be reviewed: ${relative}`)
  if (banned.test(relative) && relative !== 'cloud/.env.example') return
  if (stat.isDirectory()) {
    for (const entry of (await fs.readdir(path.join(root, relative))).sort()) await walk(`${relative}/${entry}`)
  } else if (stat.isFile()) candidates.push(relative)
}
for (const entry of [...roots, ...files]) await walk(entry)
if (!candidates.includes('LICENSE')) throw new Error('Public export requires a LICENSE selected by the project owner')
const violations = []
for (const relative of candidates.sort()) {
  const bytes = await fs.readFile(path.join(root, relative))
  if (bytes.includes(0)) continue
  const text = bytes.toString('utf8')
  for (const [kind, pattern] of secretPatterns) {
    const matches = [...text.matchAll(new RegExp(pattern.source, 'g'))]
    // Exact deliberately synthetic Slack fixtures; never broadly exempt test files.
    const hits = matches.filter(m => m[0] !== 'AKIAIOSFODNN7EXAMPLE' && !reviewedFixture(m[0]) && !/^xoxb-(?:fake-0000000000-0000000000000-fakefakefakefakefake|test-0000000000-1111111111111-abcdefghijklmnop|1234567890-1234567890-abcdef(?:ABCDEF)?)$/.test(m[0]))
    if (hits.length) violations.push(`${relative}: ${kind} (${hits.length})`)
  }
}
if (violations.length) throw new Error(`Credential screening failed; values withheld:\n${violations.join('\n')}`)
try { if ((await fs.readdir(target)).length) throw new Error('Destination must be empty') } catch (error) { if (error.code !== 'ENOENT') throw error }
await fs.mkdir(target, { recursive: true })
for (const relative of candidates) {
  await fs.mkdir(path.dirname(path.join(target, relative)), { recursive: true })
  const bytes = await fs.readFile(path.join(root, relative))
  if (bytes.includes(0)) await fs.writeFile(path.join(target, relative), bytes)
  else await fs.writeFile(path.join(target, relative), keepCodeOwners(relative, bytes.toString('utf8'), text => text
    .replaceAll(`/Users/${privateUser}/`, '/Users/example/')
    .replaceAll(privateAccount, 'example-user')
    .replaceAll(privateOrg, 'example-org')
    // the public repositories keep their real address (the README, compose and the Render button point at them)
    .replace(/https:\/\/(?:github\.com|raw\.githubusercontent\.com)\/example-org\/(?:principia|open-passport)(?:\.git)?(?=[/#?\s)'"<>\\]|$)/g, url => url.replace('example-org', privateOrg))
    // so does the public repo's own name anywhere (badges, `gh -R`, `--repo`): it is public, masking it only breaks links
    .replace(/(?<![\w.-])example-org\/principia(?![\w-])/g, `${privateOrg}/principia`)
    .replaceAll(privateProject, 'example-project')))
  // keep the permission bits: the fake CLIs the tests spawn (src/cloud/agent/__tests__/bin) must stay executable
  await fs.chmod(path.join(target, relative), (await fs.stat(path.join(root, relative))).mode & 0o777)
}
console.log(`Exported ${candidates.length} screened files. Git history, screenshots, internal research, and runtime data excluded.`)
console.log('Review the snapshot and license, then initialize a NEW Git repository. Pattern screening is not a guarantee that no sensitive content remains.')
