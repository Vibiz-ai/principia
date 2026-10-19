import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, chmodSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Runner } from './runner.mjs'
import { createApi } from './server.mjs'
import { authorized, parseCommand } from './telegram.mjs'
const token = 'a'.repeat(64)
function fixture(script = "console.log('done')") {
  const dir = mkdtempSync(join(tmpdir(), 'principia-cloud-')); const cli = join(dir, 'cli')
  writeFileSync(cli, '#!/usr/bin/env node\n' + script); chmodSync(cli, 0o700)
  return new Runner({ dataDir: join(dir, 'data'), workspace: dir, commands: { codex: cli }, secrets: ['SECRET123'], timeoutMs: 2000 })
}
async function done(runner, id) { for (let i = 0; i < 100; i++) { if (!['queued', 'running'].includes(runner.get(id).status)) return runner.get(id); await new Promise(r => setTimeout(r, 20)) } throw Error('job did not end') }
test('CLI execution persists redacted prompt and output', async () => {
  const r = fixture("console.log('SECRET123')"); const job = r.submit({ prompt: 'do SECRET123' }); await done(r, job.id)
  assert.equal(job.status, 'succeeded'); assert.equal(job.output.trim(), '[REDACTED]'); assert.ok(!readFileSync(join(r.dir, 'jobs.json'), 'utf8').includes('SECRET123')); r.close()
})
test('workspace escape and unsupported harness rejected', () => { const r = fixture(); assert.throws(() => r.submit({ prompt: 'x', cwd: '..' }), /workspace/); assert.throws(() => r.submit({ prompt: 'x', harness: 'bash' }), /harness/); r.close() })
test('concurrency queue and cancellation', async () => { const r = fixture('setTimeout(() => {}, 10000)'); const a = r.submit({ prompt: 'a' }); const b = r.submit({ prompt: 'b' }); assert.equal(b.status, 'queued'); r.cancel(b.id); assert.equal(b.status, 'cancelled'); r.cancel(a.id); await done(r, a.id); r.close() })
test('timeout and interrupted restart recovery', async () => { const r = fixture('setTimeout(() => {}, 10000)'); r.timeoutMs = 50; const j = r.submit({ prompt: 'x' }); await done(r, j.id); assert.equal(j.status, 'timed_out'); r.close(); writeFileSync(join(r.dir, 'jobs.json'), JSON.stringify([{ id: 'stale', status: 'running' }])); const recovered = new Runner({ dataDir: r.dir, workspace: r.workspace }); assert.equal(recovered.get('stale').status, 'interrupted'); recovered.close() })
test('API requires bearer auth and runs real job', async () => { const r = fixture(); const server = createApi(r, token); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const base = `http://127.0.0.1:${server.address().port}`
  try { assert.equal((await fetch(base + '/jobs')).status, 401); const response = await fetch(base + '/jobs', { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ prompt: 'hello' }) }); assert.equal(response.status, 202); const job = await response.json(); await done(r, job.id); assert.equal((await (await fetch(base + '/jobs/' + job.id, { headers: { authorization: `Bearer ${token}` } })).json()).status, 'succeeded') } finally { r.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
})
test('Telegram checks sender AND chat; parses commands', () => { const users = new Set(['12']); const chats = new Set(['34']); assert.ok(authorized({ from: { id: 12 }, chat: { id: 34 } }, users, chats)); assert.ok(!authorized({ from: { id: 99 }, chat: { id: 34 } }, users, chats)); assert.ok(!authorized({ from: { id: 12 }, chat: { id: 99 } }, users, chats)); assert.deepEqual(parseCommand('/run codex fix tests'), { action: 'run', harness: 'codex', prompt: 'fix tests' }); assert.deepEqual(parseCommand('/workflow wf_1 {"repo":"demo"}'), { action: 'workflow', id: 'wf_1', inputs: { repo: 'demo' } }) })
test('redacts secrets split across stdout chunks and strips control credentials', async () => {
  const prior = process.env.PRINCIPIA_API_TOKEN; process.env.PRINCIPIA_API_TOKEN = 'CONTROL_SECRET'
  const r = fixture("process.stdout.write('SEC'); setTimeout(() => { console.log('RET123'); console.log(String(process.env.PRINCIPIA_API_TOKEN)) }, 20)")
  try { const job = r.submit({ prompt: 'test' }); await done(r, job.id); assert.equal(job.output, '[REDACTED]\nundefined\n') } finally { r.close(); if (prior === undefined) delete process.env.PRINCIPIA_API_TOKEN; else process.env.PRINCIPIA_API_TOKEN = prior }
})
