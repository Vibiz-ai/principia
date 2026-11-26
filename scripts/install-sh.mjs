#!/usr/bin/env node
/**
 * docs/MACHINES.md §7: writes cloud/install.sh (the one-line install on your own server) from the same source as every
 * other machine's script, src/main/cloud/machines/bootstrap.ts, at the app version in package.json.
 *   node scripts/install-sh.mjs            write cloud/install.sh
 *   node scripts/install-sh.mjs --check    exit 1 when cloud/install.sh is not what bootstrap.ts makes
 *   node scripts/install-sh.mjs --version 1.2.3 --out dist/install.sh
 * Node 24 runs bootstrap.ts directly (it has only erasable TypeScript and no imports).
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { installScript } from '../src/main/cloud/machines/bootstrap.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const arg = (name) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const version = arg('--version') ?? JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version
const out = path.resolve(root, arg('--out') ?? 'cloud/install.sh')
const text = installScript(version)

if (args.includes('--check')) {
  const have = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : ''
  if (have !== text) {
    console.error(`${path.relative(root, out)} is out of date: run npm run cloud:install-sh`)
    process.exit(1)
  }
  console.log(`${path.relative(root, out)} is up to date (${version})`)
} else {
  fs.writeFileSync(out, text, { mode: 0o755 })
  console.log(`wrote ${path.relative(root, out)} (${version})`)
}
