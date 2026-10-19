#!/usr/bin/env node
/** Export a fresh, screened source snapshot. Never exports git history or runtime data. */
import { promises as fs } from 'node:fs'
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
const roots = ['src', 'resources', 'scripts', '.github', 'cloud']
const files = ['.dockerignore', 'README.md', 'CONTRIBUTING.md', 'LICENSE', 'SECURITY.md', 'CODE_OF_CONDUCT.md', '.gitignore', 'package.json', 'package-lock.json', 'electron-builder.yml', 'electron.vite.config.ts', 'tsconfig.json', 'tsconfig.node.json', 'tsconfig.web.json', 'vitest.config.ts', 'vite.cloud.config.ts', 'build/icon.icns', 'build/icon.png', 'docs/AUTHORING.md', 'docs/CONTRACT.md', 'docs/LIVE.md', 'docs/MEMORY.md', 'docs/SLACK.md', 'docs/MCP.md', 'docs/MCP-GATEWAY.md', 'docs/CLOUD.md']
const banned = /(?:^|\/)(?:node_modules|\.git|\.claude|\.codex|\.aws|\.hive-dev-data|out|dist|release)(?:\/|$)|(?:^|\/)\.env(?:\.|$)|\.(?:sqlite|sqlite3|db|log|pem|p12|pfx)$/i
const secretPatterns = [
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]{10,}?-----END/],
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/],
  ['provider key', /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{30,}\b/],
  ['Slack token', /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g],
  ['AWS access key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/]
]
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
    const hits = matches.filter(m => m[0] !== 'AKIAIOSFODNN7EXAMPLE' && !/^xoxb-(?:fake-0000000000-0000000000000-fakefakefakefakefake|test-0000000000-1111111111111-abcdefghijklmnop|1234567890-1234567890-abcdef(?:ABCDEF)?)$/.test(m[0]))
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
  else await fs.writeFile(path.join(target, relative), bytes.toString('utf8')
    .replaceAll(`/Users/${privateUser}/`, '/Users/example/')
    .replaceAll(privateAccount, 'example-user')
    .replaceAll(privateOrg, 'example-org')
    .replace(/https:\/\/github\.com\/example-org\/principia(?:\.git)?(?=[/#?\s)'"<>]|$)/g, url => url.replace('example-org', privateOrg))
    .replaceAll(privateProject, 'example-project'))
}
console.log(`Exported ${candidates.length} screened files. Git history, screenshots, internal research, and runtime data excluded.`)
console.log('Review the snapshot and license, then initialize a NEW Git repository. Pattern screening is not a guarantee that no sensitive content remains.')
