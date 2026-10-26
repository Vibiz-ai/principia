import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, copyFile, access, rm, chmod, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const privateUser = ['lauta', 'ritos'].join('')
const privateAccount = ['lausu', 'arez02'].join('')
const privateOrg = ['Vibiz', 'ai'].join('-')
const privateProject = ['vibiz', '04'].join('-')
const script = fileURLToPath(new URL('./prepare-public-release.mjs', import.meta.url))
async function fixture(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'principia-export-test-'))
  const root = path.join(dir, 'source'), dest = path.join(dir, 'snapshot')
  await mkdir(path.join(root, 'scripts'), { recursive: true })
  await copyFile(script, path.join(root, 'scripts/prepare-public-release.mjs'))
  const put = async (p, value) => { await mkdir(path.dirname(path.join(root, p)), { recursive: true }); await writeFile(path.join(root, p), value) }
  const run = () => spawnSync(process.execPath, [path.join(root, 'scripts/prepare-public-release.mjs'), dest], { encoding: 'utf8' })
  try { await fn({ root, dest, put, run }) } finally { await rm(dir, { recursive: true, force: true }) }
}
test('exports source and cloud example, excludes private data and sanitizes local identities', async () => fixture(async ({ dest, put, run }) => {
  await put('LICENSE', 'MIT')
  await put('SECURITY.md', `https://github.com/${privateOrg}/principia/security/advisories/new https://github.com/${privateOrg}/principia-private`)
  await put('cloud/README.md', `curl -fsSL https://raw.githubusercontent.com/${privateOrg}/principia/main/cloud/compose.yml https://github.com/${privateOrg}/open-passport.git#main https://github.com/${privateOrg}/secret-repo`)
  await put('render.yaml', 'services: []')
  await put('src/example.ts', `// /Users/${privateUser}/projects ${privateProject} ${privateOrg} ${privateAccount}`)
  await put('cloud/.env', 'PRIVATE_LOCAL_DATA=secret')
  await put('cloud/.env.example', 'PRINCIPIA_TOKEN=replace-me')
  await put('vite.cloud.config.ts', 'export default {}')
  await put('docs/qa/keys.png', 'private screenshot')
  await put('.git/config', 'private history')
  assert.equal(run().status, 0)
  assert.match(await readFile(path.join(dest, 'src/example.ts'), 'utf8'), /Users\/example/)
  assert.doesNotMatch(await readFile(path.join(dest, 'src/example.ts'), 'utf8'), new RegExp([privateUser, privateProject, privateOrg, privateAccount].join('|')))
  assert.equal(await readFile(path.join(dest, 'SECURITY.md'), 'utf8'), `https://github.com/${privateOrg}/principia/security/advisories/new https://github.com/example-org/principia-private`)
  assert.equal(await readFile(path.join(dest, 'cloud/README.md'), 'utf8'), `curl -fsSL https://raw.githubusercontent.com/${privateOrg}/principia/main/cloud/compose.yml https://github.com/${privateOrg}/open-passport.git#main https://github.com/example-org/secret-repo`)
  await access(path.join(dest, 'render.yaml'))
  await access(path.join(dest, 'cloud/.env.example'))
  await access(path.join(dest, 'vite.cloud.config.ts'))
  for (const p of ['cloud/.env', '.git/config', 'docs/qa/keys.png']) await assert.rejects(access(path.join(dest, p)))
}))
test('CODEOWNERS keeps its @owner entries; the handle is replaced everywhere else', async () => fixture(async ({ dest, put, run }) => {
  await put('LICENSE', 'MIT')
  await put('.github/CODEOWNERS', `/.github/ @${privateAccount}\n/docs/${privateAccount}/ @${privateAccount}\n# ask ${privateAccount}\n`)
  await put('src/a.ts', `// @${privateAccount}`)
  assert.equal(run().status, 0)
  assert.equal(await readFile(path.join(dest, '.github/CODEOWNERS'), 'utf8'), `/.github/ @${privateAccount}\n/docs/example-user/ @${privateAccount}\n# ask example-user\n`)
  assert.equal(await readFile(path.join(dest, 'src/a.ts'), 'utf8'), '// @example-user')
}))
test('fails before writing when source contains a credential and withholds its value', async () => fixture(async ({ dest, put, run }) => {
  await put('LICENSE', 'MIT')
  const token = 'ghp_' + 'A'.repeat(36)
  await put('src/key.ts', token)
  const result = run()
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /Credential screening failed/)
  assert.ok(!result.stderr.includes(token))
  await assert.rejects(access(dest))
}))
test('requires a license', async () => fixture(async ({ run }) => {
  const result = run()
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /requires a LICENSE/)
}))
test('refuses to overwrite an existing destination', async () => fixture(async ({ dest, put, run }) => {
  await put('LICENSE', 'MIT')
  await mkdir(dest)
  await writeFile(path.join(dest, 'keep.txt'), 'keep')
  assert.notEqual(run().status, 0)
  assert.equal(await readFile(path.join(dest, 'keep.txt'), 'utf8'), 'keep')
}))

test('preserves the public clone URL before an escaped newline in website source', async () => fixture(async ({ dest, put, run }) => {
  await put('LICENSE', 'MIT')
  const source = JSON.stringify(`git clone https://github.com/${privateOrg}/principia.git\ncd principia`)
  await put('website/src/install.ts', source)
  assert.equal(run().status, 0)
  assert.equal(await readFile(path.join(dest, 'website/src/install.ts'), 'utf8'), source)
}))

test('exempts only reviewed fixture values listed by hash', async () => fixture(async ({ dest, put, run }) => {
  const { createHash } = await import('node:crypto')
  await put('LICENSE', 'MIT')
  const reviewed = 'sk-ant-' + 'q'.repeat(30), other = 'sk-ant-' + 'r'.repeat(30)
  await put('scripts/public-release-fixtures.sha256', `# reviewed\n${createHash('sha256').update(reviewed).digest('hex')}  # src/a.test.ts\n`)
  await put('src/a.test.ts', reviewed)
  assert.equal(run().status, 0)
  await rm(dest, { recursive: true, force: true })
  await put('src/b.test.ts', other)
  const result = run()
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /src\/b\.test\.ts: provider key/)
  assert.doesNotMatch(result.stderr, /src\/a\.test\.ts/)
}))

test('keeps the executable bit, so the fake CLIs the tests spawn still run from the snapshot', async () => fixture(async ({ root, dest, put, run }) => {
  await put('LICENSE', 'MIT')
  await put('src/cloud/agent/__tests__/bin/codex', '#!/usr/bin/env node\n')
  await chmod(path.join(root, 'src/cloud/agent/__tests__/bin/codex'), 0o755)
  await put('src/plain.ts', 'export {}')
  await chmod(path.join(root, 'src/plain.ts'), 0o644)
  assert.equal(run().status, 0)
  assert.equal((await stat(path.join(dest, 'src/cloud/agent/__tests__/bin/codex'))).mode & 0o777, 0o755)
  assert.equal((await stat(path.join(dest, 'src/plain.ts'))).mode & 0o777, 0o644)
}))
