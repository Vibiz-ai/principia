import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { createCloudWorkflows } from '../out-cloud/workflows.mjs'
const dir = mkdtempSync(join(tmpdir(), 'principia-engine-'))
const workflows = await createCloudWorkflows({ dataDir: join(dir, 'data'), workspace: dir, redact: s => s.replaceAll('secret-value', '[REDACTED]') })
try {
  assert.throws(() => workflows.import({ hive: 'workflow', version: 1, workflow: { name: 'Escape', nodes: [{ id: 'test', type: 'shell', label: 'Test', command: 'true', cwd: '/', after: [], timeoutMin: 1 }] } }), /workspace/)
  const workflow = workflows.import({ hive: 'workflow', version: 1, workflow: { name: 'Cloud smoke', description: '', inputs: [], nodes: [{ id: 'test', type: 'shell', label: 'Test', command: 'echo secret-value; echo cloud-engine-ok', cwd: null, after: [], timeoutMin: 1 }] } })
  const run = workflows.start(workflow.id)
  let detail
  for (let i = 0; i < 200; i++) { detail = workflows.get(run.id); if (['passed', 'failed', 'canceled'].includes(detail.run.status)) break; await new Promise(r => setTimeout(r, 25)) }
  assert.equal(detail.run.status, 'passed', JSON.stringify(detail))
  assert.ok(detail.steps[0].output.includes('cloud-engine-ok'))
  assert.ok(!detail.steps[0].output.includes('secret-value'))
  console.log('Cloud existing-engine workflow import, confinement, execution, persistence and redaction: PASS')
} finally { await workflows.close() }
