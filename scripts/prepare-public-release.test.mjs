import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, copyFile, access, rm } from 'node:fs/promises'
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
  await access(path.join(dest, 'cloud/.env.example'))
  await access(path.join(dest, 'vite.cloud.config.ts'))
  for (const p of ['cloud/.env', '.git/config', 'docs/qa/keys.png']) await assert.rejects(access(path.join(dest, p)))
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
