// Principia Cloud agent isolation smoke (CLOUD.md §7.8, §11). Drives a running cloud (the real runtime, in Docker):
//   docker compose -f cloud/compose.yml up -d        (or with -f cloud/compose.build.yml for local images)
//   node cloud/isolation.smoke.mjs --url http://127.0.0.1:8787 --link '<connect link>'
// It pairs, moves a company, runs a one-step shell workflow and reads the run's log. The step is an agent process: it
// must run as uid 1001, get "Permission denied" on /secrets/master.key, /data/control.db and the runtime's databases,
// and still work in its own company folder. No model is called.
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zipFolder } from './control.smoke.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const arg = name => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined }

/** the same rules as parseConnectLink in src/shared/cloud.ts */
function parseLink(text) {
  const t = text.replace(/\s+/g, ''); const hash = t.indexOf('#'); if (hash < 0) return null
  const code = t.slice(hash + 1).replace(/-/g, '').toUpperCase(); if (!/^[2-9A-HJ-NP-Z]{8}$/.test(code)) return null
  const u = new URL(t.slice(0, hash)); return { url: `${u.origin}${u.pathname.replace(/\/+$/, '').replace(/\/pair$/, '')}`, code: `${code.slice(0, 4)}-${code.slice(4)}` }
}

export const PROBE = [
  'echo "uid=$(id -u)"',
  'for f in /secrets/master.key /secrets/passport-admin /data/control.db /data/runtime/engine.db /data/runtime/forum.db; do if cat "$f" >/dev/null 2>&1; then echo "READABLE $f"; else echo "denied $f"; fi; done',
  'ls /secrets >/dev/null 2>&1 && echo "LISTABLE /secrets" || echo "denied ls /secrets"',
  'ls /data/runtime >/dev/null 2>&1 && echo "LISTABLE /data/runtime" || echo "denied ls /data/runtime"',
  'cat /secrets/master.key /data/control.db 2>&1 | head -2',
  'echo ok > proof.txt && echo "wrote $(cat proof.txt) in $(pwd)"'
].join('; ')

export async function isolation(base, link) {
  const call = async (method, path, { token, body } = {}) => {
    const res = await fetch(base + path, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })
    const text = await res.text(); let json = null; try { json = JSON.parse(text) } catch { /* html */ }
    return { status: res.status, json, text }
  }
  const parsed = parseLink(link)
  assert.ok(parsed, `could not parse the connect link: ${link}`)
  const pair = await call('POST', '/v1/pair/complete', { body: { code: parsed.code, deviceName: 'Isolation smoke', platform: 'smoke' } })
  assert.equal(pair.status, 201, `pair/complete: ${pair.text}`)
  const dev = pair.json.deviceToken
  const summary = (await call('GET', '/v1/summary', { token: dev })).json
  const body = { name: 'Isolation', slug: 'isolation' }
  const acme = process.env.SMOKE_PASSPORT_DIR || resolve(here, '../../open-passport/examples/acme')
  if (summary.passportHost?.status === 'ok' && existsSync(acme)) body.passportBundle = zipFolder(acme).toString('base64')
  const co = await call('PUT', '/v1/companies/co_iso', { token: dev, body })
  assert.equal(co.status, 200, `company PUT: ${co.text}`)
  const file = { hive: 'workflow', version: 1, workflow: { name: 'Isolation probe', description: '', inputs: [], nodes: [{ id: 'probe', type: 'shell', label: 'Probe', command: PROBE, cwd: null, after: [], timeoutMin: 1 }] } }
  const wid = `wf_probe_${Date.now().toString(36)}`
  const wf = await call('PUT', `/v1/companies/co_iso/workflows/${wid}`, { token: dev, body: { file, baseRev: null } })
  assert.equal(wf.status, 200, `workflow PUT: ${wf.text}`)
  assert.deepEqual(wf.json.problems, [], 'the probe is runnable in the cloud')
  const run = await call('POST', '/v1/companies/co_iso/runs', { token: dev, body: { kind: 'workflow', workflowId: wid } })
  assert.equal(run.status, 202, `run: ${run.text}`)
  const id = run.json.id
  const end = Date.now() + 90_000
  let status = 'queued'
  while (!['passed', 'failed', 'canceled', 'needs_input'].includes(status)) {
    if (Date.now() > end) throw new Error('the probe run did not finish in 90 s')
    await new Promise(r => setTimeout(r, 500))
    status = (await call('GET', `/v1/runs/${id}`, { token: dev })).json.status
  }
  const detail = (await call('GET', `/v1/runs/${id}`, { token: dev })).json
  const log = (await call('GET', `/v1/runs/${id}/log?tail=200`, { token: dev })).json.lines.join('\n')
  assert.equal(status, 'passed', `the probe run ${status}: ${detail.summary}\n${log}`)
  assert.match(log, /^uid=1001$/m, `agents run as uid 1001:\n${log}`)
  for (const f of ['/secrets/master.key', '/secrets/passport-admin', '/data/control.db', '/data/runtime/engine.db', '/data/runtime/forum.db']) assert.match(log, new RegExp(`^denied ${f}$`, 'm'), `${f} must not be readable by an agent:\n${log}`)
  assert.doesNotMatch(log, /^(READABLE|LISTABLE) /m, log)
  assert.match(log, /cat: \/secrets\/master\.key: Permission denied/, log)
  assert.match(log, /cat: \/data\/control\.db: Permission denied/, log)
  assert.match(log, /^wrote ok in \/workspace\/co_iso$/m, `the agent still works in its company folder:\n${log}`)
  return { runId: id, log }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const url = arg('--url'); const link = arg('--link')
  if (!url || !link) { console.error('Usage: node cloud/isolation.smoke.mjs --url http://127.0.0.1:8787 --link "<connect link>"'); process.exit(2) }
  isolation(url.replace(/\/+$/, ''), link).then(
    r => console.log(`isolation smoke ok (run ${r.runId}): the agent ran as uid 1001 and could not read /secrets, control.db or the runtime databases`),
    e => { console.error(e.stack ?? e.message); process.exitCode = 1 }
  )
}
