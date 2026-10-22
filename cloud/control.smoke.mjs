// Principia Cloud control plane smoke (CLOUD.md §14). Two modes:
//   node cloud/control.smoke.mjs                         boots out-cloud/control.mjs (PRINCIPIA_RUNTIME=fake unless
//                                                         SMOKE_RUNTIME=real) on a free port with throwaway dirs, plus the
//                                                         Open Passport host from the sibling checkout when it exists
//   node cloud/control.smoke.mjs --url <base> --link <connect link>
//                                                         drives an already running cloud (the docker compose run)
// It pairs with the connect link, moves a company with a small passport bundle, checks the desktop passport key and
// readiness, lists providers, checks a cut route answers 501, and checks /v1/health. No network beyond 127.0.0.1.
import { spawn } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve, dirname } from 'node:path'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import { crc32 } from 'node:zlib'
import assert from 'node:assert/strict'

const here = dirname(fileURLToPath(import.meta.url))
const SIBLING = resolve(here, '../../open-passport')
const ACME = process.env.SMOKE_PASSPORT_DIR || join(SIBLING, 'examples/acme')

/** a stored (uncompressed) zip of every .md/.json file under dir */
export function zipFolder(dir) {
  const files = []
  const walk = d => { for (const n of readdirSync(d).sort()) { if (n.startsWith('.')) continue; const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else if (/\.(md|json)$/.test(n)) files.push([relative(dir, p).split('\\').join('/'), readFileSync(p)]) } }
  walk(dir)
  const locals = []; const centrals = []; let offset = 0
  for (const [name, data] of files) {
    const nb = Buffer.from(name, 'utf8'); const crc = crc32(data)
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nb.length, 26)
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8); central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(nb.length, 28); central.writeUInt32LE(offset, 42)
    locals.push(local, nb, data); centrals.push(central, nb)
    offset += 30 + nb.length + data.length
  }
  const cd = Buffer.concat(centrals)
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cd, end])
}

const freePort = () => new Promise(r => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)) }) })
const waitFor = async (fn, ms, what) => { const end = Date.now() + ms; for (;;) { try { const v = await fn(); if (v) return v } catch { /* not yet */ } if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await new Promise(r => setTimeout(r, 100)) } }
const arg = name => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined }

/** the same rules as parseConnectLink in src/shared/cloud.ts */
function parseLink(text) {
  const t = text.replace(/\s+/g, ''); const hash = t.indexOf('#'); if (hash < 0) return null
  const code = t.slice(hash + 1).replace(/-/g, '').toUpperCase(); if (!/^[2-9A-HJ-NP-Z]{8}$/.test(code)) return null
  const u = new URL(t.slice(0, hash)); return { url: `${u.origin}${u.pathname.replace(/\/+$/, '').replace(/\/pair$/, '')}`, code: `${code.slice(0, 4)}-${code.slice(4)}` }
}

export async function drive(base, link, { expectPassport }) {
  const call = async (method, path, { token, body } = {}) => {
    const res = await fetch(base + path, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })
    const text = await res.text(); let json = null; try { json = JSON.parse(text) } catch { /* html */ }
    return { status: res.status, json, text }
  }
  const parsed = parseLink(link)
  assert.ok(parsed, `could not parse the connect link: ${link}`)
  const health = await call('GET', '/v1/health')
  assert.equal(health.status, 200, 'health')
  const pair = await call('POST', '/v1/pair/complete', { body: { code: parsed.code.toLowerCase().replace('-', ''), deviceName: 'Smoke Mac', platform: 'smoke' } })
  assert.equal(pair.status, 201, `pair/complete: ${pair.text}`)
  const dev = pair.json.deviceToken
  assert.match(dev, /^pdt_/)
  const pairPage = await call('GET', '/pair')
  assert.match(pairPage.text, /paste this link/)
  assert.doesNotMatch(pairPage.text, /<script/i)
  const companyBody = { name: 'Acme', slug: 'acme' }
  if (expectPassport) {
    assert.ok(existsSync(ACME), `a passport folder is needed at ${ACME} (set SMOKE_PASSPORT_DIR)`)
    companyBody.passportBundle = zipFolder(ACME).toString('base64')
  }
  const co = await call('PUT', '/v1/companies/co_smoke', { token: dev, body: companyBody })
  assert.equal(co.status, 200, `company PUT: ${co.text}`)
  if (expectPassport) {
    const g = co.json.desktopPassportGrant
    assert.ok(g && /^opk_/.test(g.token), 'desktopPassportGrant returned once')
    assert.equal(g.passportId, 'co_smoke')
    assert.ok(co.json.company.passport && co.json.company.passport.revision >= 1, 'passport revision')
  }
  const list = await call('GET', '/v1/companies', { token: dev })
  assert.equal(list.status, 200)
  assert.ok(list.json[0].readiness && typeof list.json[0].readiness.ready === 'boolean', 'readiness on GET /v1/companies')
  const providers = await call('GET', '/v1/providers', { token: dev })
  assert.deepEqual(providers.json.map(p => p.adapter), ['claude', 'codex', 'gemini'])
  const cut = await call('GET', '/v1/companies/co_smoke/hooks', { token: dev })
  assert.deepEqual([cut.status, cut.json.error], [501, 'not_in_v1'])
  const summary = await call('GET', '/v1/summary', { token: dev })
  assert.equal(summary.status, 200)
  const unauth = await call('GET', '/v1/summary')
  assert.equal(unauth.status, 401)
  return { summary: summary.json, readiness: list.json[0].readiness, passport: co.json.company.passport }
}

async function local() {
  const out = resolve(here, '../out-cloud/control.mjs')
  assert.ok(existsSync(out), 'run npm run cloud:build first')
  const dir = mkdtempSync(join(tmpdir(), 'pcloud-smoke-'))
  const procs = []
  try {
    const port = await freePort()
    const env = { ...process.env, PRINCIPIA_SECRETS_DIR: join(dir, 'secrets'), PRINCIPIA_DATA_DIR: join(dir, 'data'), PRINCIPIA_WORKSPACE: join(dir, 'ws'), PORT: String(port), HOST: '127.0.0.1', PRINCIPIA_PUBLIC_URL: `http://127.0.0.1:${port}`, PRINCIPIA_RUNTIME: process.env.SMOKE_RUNTIME === 'real' ? 'real' : 'fake' }
    for (const k of ['PRINCIPIA_MASTER_KEY', 'PRINCIPIA_ADMIN_TOKEN', 'OPEN_PASSPORT_INTERNAL_URL', 'OPEN_PASSPORT_ADMIN_TOKEN', 'OPEN_PASSPORT_PUBLIC_URL']) delete env[k]
    const init = spawn(process.execPath, [out, 'init'], { env, stdio: 'inherit' })
    assert.equal(await new Promise(r => init.on('exit', r)), 0, 'init')
    const hostMain = join(SIBLING, 'packages/server/src/main.ts')
    const withPassport = existsSync(hostMain) && existsSync(ACME)
    if (withPassport) {
      const pport = await freePort()
      const admin = readFileSync(join(dir, 'secrets/passport-admin'), 'utf8').trim()
      const host = spawn(process.execPath, [hostMain], { env: { ...process.env, OPEN_PASSPORT_ADMIN_TOKEN: admin, DATA_DIR: join(dir, 'passport'), PORT: String(pport), HOST: '127.0.0.1', OPEN_PASSPORT_PUBLIC_URL: `http://127.0.0.1:${pport}` }, stdio: 'ignore' })
      procs.push(host)
      env.OPEN_PASSPORT_INTERNAL_URL = `http://127.0.0.1:${pport}`
      env.OPEN_PASSPORT_PUBLIC_URL = `http://127.0.0.1:${pport}`
      await waitFor(async () => (await fetch(`${env.OPEN_PASSPORT_INTERNAL_URL}/healthz`)).ok, 10_000, 'the passport host')
    } else console.log('control smoke: no sibling open-passport checkout, running without a passport host')
    const cp = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', out], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    procs.push(cp)
    let logs = ''
    cp.stdout.on('data', d => { logs += d }); cp.stderr.on('data', d => { logs += d })
    const link = await waitFor(() => /Connect link: (\S+) \(10 min\)/.exec(logs)?.[1], 15_000, 'the connect link')
    const r = await drive(`http://127.0.0.1:${port}`, link, { expectPassport: withPassport })
    // the code never appears in a request log line (it travels in the fragment, then in a POST body)
    const code = link.split('#')[1]
    assert.equal(logs.split('\n').filter(l => l.includes(code)).length, 1, 'the code is logged only in the connect link line')
    const pairCli = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', out, 'pair'], { env, stdio: ['ignore', 'pipe', 'inherit'] })
    let pairOut = ''; pairCli.stdout.on('data', d => { pairOut += d })
    assert.equal(await new Promise(res => pairCli.on('exit', res)), 0)
    assert.match(pairOut, /^Connect link: http:\/\/127\.0\.0\.1:\d+\/pair#[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4} \(10 min\)\n$/)
    console.log(`control smoke ok (runtime ${r.summary.runtime.version}, passport ${withPassport ? `revision ${r.passport.revision}` : 'off'}, ready ${r.readiness.ready})`)
    cp.kill('SIGTERM')
    assert.equal(await new Promise(res => cp.on('exit', res)), 0, 'clean SIGTERM exit')
  } finally {
    for (const p of procs) if (p.exitCode === null) p.kill('SIGTERM')
    rmSync(dir, { recursive: true, force: true })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const url = arg('--url'); const link = arg('--link')
  const run = url && link ? drive(url.replace(/\/+$/, ''), link, { expectPassport: process.argv.includes('--passport') }).then(r => console.log(`control smoke ok against ${url} (runtime ${r.summary.runtime.version}, passport host ${r.summary.passportHost.status}, ready ${r.readiness.ready})`)) : local()
  run.catch(e => { console.error(e.stack ?? e.message); process.exitCode = 1 })
}
