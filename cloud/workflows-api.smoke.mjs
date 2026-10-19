/** Actual shared-engine/API smoke. Build first; use Electron's Node runtime with the local Electron-ABI SQLite build. */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCloudWorkflows } from '../out-cloud/workflows.mjs'
import { createApi } from './server.mjs'
import { Runner } from './runner.mjs'
const dir = mkdtempSync(join(tmpdir(), 'principia-api-engine-'))
const token = 'api-smoke-'.repeat(8)
const redact = s => s.replaceAll('smoke-secret', '[REDACTED]')
// Minimal containers commonly omit SHELL; engine must provide a usable POSIX fallback.
const originalShell = process.env.SHELL
delete process.env.SHELL
assert.equal(process.env.SHELL, undefined)
const workflows = await createCloudWorkflows({ dataDir: join(dir, 'data'), workspace: dir, redact })
const runner = new Runner({ dataDir: join(dir, 'jobs'), workspace: dir, secrets: ['smoke-secret', token] })
const server = createApi(runner, token, workflows)
try {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const base = `http://127.0.0.1:${server.address().port}`
  const api = async (path, method = 'GET', value) => {
    const response = await fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(value === undefined ? {} : { body: JSON.stringify(value) }) })
    return { status: response.status, value: await response.json() }
  }
  assert.equal((await fetch(base + '/workflows')).status, 401)
  const unknownProfile = await api('/workflows', 'POST', { hive: 'workflow', version: 1, workflow: { name: 'Invalid harness', nodes: [{ id: 'agent', type: 'agent', label: 'Agent', profileId: 'prof_unknown', prompt: 'Do nothing', cwd: null, after: [], timeoutMin: 1 }] } })
  assert.equal(unknownProfile.status, 400)
  assert.match(unknownProfile.value.error, /Unknown profile/)
  const imported = await api('/workflows', 'POST', { hive: 'workflow', version: 1, workflow: { name: 'API integration', inputs: [], nodes: [
    { id: 'first', type: 'shell', label: 'First', after: [], cwd: null, timeoutMin: 1, command: 'printf "smoke-secret first-step\\n"' },
    { id: 'second', type: 'shell', label: 'Second', after: ['first'], cwd: null, timeoutMin: 1, command: 'printf "second-step\\n"' }
  ] } })
  assert.equal(imported.status, 202, JSON.stringify(imported))
  const started = await api(`/workflows/${imported.value.id}/run`, 'POST', { inputs: {} })
  assert.equal(started.status, 202, JSON.stringify(started))
  let detail
  for (let i = 0; i < 200; i++) {
    detail = await api(`/runs/${started.value.id}`)
    if (['passed', 'failed', 'canceled'].includes(detail.value.run.status)) break
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  assert.equal(detail.value.run.status, 'passed', JSON.stringify(detail))
  assert.equal(detail.value.steps.length, 2)
  assert.ok(detail.value.steps[0].output.includes('[REDACTED]'))
  assert.ok(detail.value.steps[1].output.includes('second-step'))
  assert.ok(!JSON.stringify(detail.value).includes('smoke-secret'))
  const persisted = await api('/runs')
  assert.ok(persisted.value.some(run => run.id === started.value.id))
  const logs = join(dir, 'data', 'logs', 'runs', started.value.id)
  for (const file of readdirSync(logs)) if (statSync(join(logs, file)).isFile()) assert.ok(!readFileSync(join(logs, file), 'utf8').includes('smoke-secret'))
  console.log('Shared engine → authenticated API → two dependent real shell steps → persisted results/log redaction: PASS')
} finally {
  if (originalShell === undefined) delete process.env.SHELL; else process.env.SHELL = originalShell
  runner.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await workflows.close(); rmSync(dir, { recursive: true, force: true })
}
