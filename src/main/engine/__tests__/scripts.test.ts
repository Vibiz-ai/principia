import { describe, expect, it } from 'vitest'
import type { WorkflowNode } from '../../../shared/types'
import { addWorkflow, fakeCtx, makeEngine, waitRun } from './fakes'

const script = (id: string, lang: 'sh' | 'python' | 'node', command: string): WorkflowNode => ({
  id,
  type: 'shell',
  label: id,
  after: [],
  cwd: null,
  timeoutMin: 1,
  command,
  lang
})

describe('scripts (shell nodes with a lang)', () => {
  it('runs python and node scripts with inputs and vault keys in the env', async () => {
    const ctx = fakeCtx()
    ctx.secretValues = { APIFY_API_KEY: 'apify-secret-123' }
    const engine = await makeEngine(ctx, { available: ['shell'] })
    const wf = addWorkflow(ctx, {
      name: 'scripts',
      description: '',
      inputs: [{ name: 'who', label: 'Who' }],
      nodes: [
        script('py', 'python', 'import os\nprint("hi", os.environ["HIVE_INPUT_WHO"], len(os.environ["APIFY_API_KEY"]))'),
        script('js', 'node', 'const n = await Promise.resolve(2)\nconsole.log(`node ${process.env.HIVE_INPUT_WHO} ${n}`)'),
        script('sh', 'sh', 'echo "sh $HIVE_INPUT_WHO"')
      ]
    })
    const run = engine.runs.start({ kind: 'workflow', workflowId: wf.id, inputs: { who: "o'neil" } }, { trigger: 'manual' })
    expect((await waitRun(ctx, run.id)).status).toBe('passed')
    const out = (id: string) => ctx.store.stepsOf(run.id).find((s) => s.nodeId === id)?.output
    expect(out('py')).toBe("hi o'neil 16")
    expect(out('js')).toBe("node o'neil 2")
    expect(out('sh')).toBe("sh o'neil")
  })
})

describe('built-in resize-images script', () => {
  it.skipIf(process.platform !== 'darwin')('resizes a real image with sips into ARTIFACTS_DIR', async () => {
    const { copyFileSync, mkdtempSync, readFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const file = JSON.parse(readFileSync(join(__dirname, '../../../../resources/marketplace/scripts/resize-images.hive.json'), 'utf8'))
    const src = mkdtempSync(join(tmpdir(), 'hive-resize-'))
    copyFileSync(join(__dirname, '../../../../resources/trayTemplate@2x.png'), join(src, 'a b.png'))
    const ctx = fakeCtx()
    const engine = await makeEngine(ctx, { available: ['shell'] })
    const wf = addWorkflow(ctx, file.workflow)
    const run = engine.runs.start({ kind: 'workflow', workflowId: wf.id, inputs: { folder: src, max: '16' } }, { trigger: 'manual' })
    expect((await waitRun(ctx, run.id)).status).toBe('passed')
    expect(ctx.store.stepsOf(run.id)[0].output).toMatch(/^1 images resized to max 16px/)
  })
})
