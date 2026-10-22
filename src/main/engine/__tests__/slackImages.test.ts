/** SLACK.md §9.6: thread images in Slack-triggered runs ({{trigger.images}}, prompt note, claude --add-dir, codex -i). */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { SlackRunContext } from '../../../shared/slack'
import type { AgentNode } from '../../../shared/types'
import { claudeAdapter, codexAdapter } from '../adapters'
import { addWorkflow, fakeAdapter, fakeCtx, makeEngine, profile, waitRun, type FakeCall } from './fakes'
import { attachFakeSlackTools } from './slackToolsFake'

const agent = (id: string, prompt: string): AgentNode => ({ id, type: 'agent', label: id, after: [], cwd: null, timeoutMin: 1, profileId: 'p_claude', prompt })
const sctx: SlackRunContext = {
  triggerId: 'stg_1',
  teamId: 'T1',
  channelId: 'C1',
  channelName: 'support',
  channelKind: 'channel',
  threadTs: '1792141200.000100',
  messageTs: ['1792141200.000100'],
  userId: 'U1',
  userName: 'Dana Lee',
  text: 'what is wrong here?',
  permalink: '',
  isMention: true,
  isDm: false,
  catchup: false
}

async function setup(prompt: string, download: (q: { channelId: string; threadTs: string; destDir: string }) => Promise<string[]>) {
  const ctx = fakeCtx()
  attachFakeSlackTools(ctx)
  const asked: { channelId: string; threadTs: string; destDir: string }[] = []
  ctx.slack!.downloadThreadImages = async (q) => {
    asked.push(q)
    return download(q)
  }
  ctx.profiles.set('p_claude', profile('p_claude', 'claude'))
  const calls: FakeCall[] = []
  const claude = fakeAdapter('claude', calls, () => ({ output: 'ok' }))
  const wf = addWorkflow(ctx, { name: 'Support', description: '', inputs: [], nodes: [agent('reply', prompt)] })
  const engine = await makeEngine(ctx, { adapters: { claude }, available: ['claude', 'shell'] })
  return { ctx, calls, wf, engine, asked }
}

const writeImages = (q: { destDir: string }): string[] => {
  mkdirSync(q.destDir, { recursive: true })
  return ['1-shot.png', '2-before.jpg'].map((n) => {
    const p = join(q.destDir, n)
    writeFileSync(p, 'x')
    return p
  })
}

describe('Slack thread images in a triggered run', () => {
  it('downloads into <artifacts>/slack-images, renders {{trigger.images}} and passes the images to the adapter', async () => {
    const s = await setup('Look:\n{{trigger.images}}\nEnd', async (q) => writeImages(q))
    const run = await waitRun(s.ctx, s.engine.runs.start({ kind: 'workflow', workflowId: s.wf.id, inputs: {} }, { trigger: 'slack', slack: sctx }).id)
    expect(run.status).toBe('passed')
    expect(s.asked).toEqual([{ channelId: 'C1', threadTs: sctx.threadTs, destDir: join(run.artifactsDir, 'slack-images') }])
    const paths = [join(run.artifactsDir, 'slack-images', '1-shot.png'), join(run.artifactsDir, 'slack-images', '2-before.jpg')]
    const call = s.calls[0]!
    expect(call.prompt).toContain(`Look:\n${paths.join('\n')}\nEnd`)
    // already listed by the template: no second copy of the note
    expect(call.prompt).not.toContain('Images shared in this Slack thread')
    expect(call.images).toEqual(paths)
  })

  it('appends the note when the prompt does not mention the images', async () => {
    const s = await setup('answer the question', async (q) => writeImages(q))
    const run = await waitRun(s.ctx, s.engine.runs.start({ kind: 'workflow', workflowId: s.wf.id, inputs: {} }, { trigger: 'slack', slack: sctx }).id)
    expect(run.status).toBe('passed')
    expect(s.calls[0]!.prompt).toContain(`Images shared in this Slack thread (open them with your Read tool before answering):\n${join(run.artifactsDir, 'slack-images', '1-shot.png')}`)
  })

  it('no images / a failing download: {{trigger.images}} is empty and the run still passes', async () => {
    for (const dl of [async () => [], async () => Promise.reject(new Error('slack down'))]) {
      const s = await setup('imgs=[{{trigger.images}}]', dl)
      const run = await waitRun(s.ctx, s.engine.runs.start({ kind: 'workflow', workflowId: s.wf.id, inputs: {} }, { trigger: 'slack', slack: sctx }).id)
      expect(run.status).toBe('passed')
      expect(s.calls[0]!.prompt).toContain('imgs=[]')
      expect(s.calls[0]!.prompt).not.toContain('Images shared in this Slack thread')
      expect(s.calls[0]!.images).toBeUndefined()
    }
  })

  it('a manual run never asks for images', async () => {
    const s = await setup('x {{trigger.images}}', async (q) => writeImages(q))
    const run = await waitRun(s.ctx, s.engine.runs.start({ kind: 'workflow', workflowId: s.wf.id, inputs: {} }, { trigger: 'manual' }).id)
    expect(run.status).toBe('passed')
    expect(s.asked).toEqual([])
  })
})

describe('adapter args for thread images', () => {
  const imgs = ['/runs/r1/artifacts/slack-images/1-a.png', '/runs/r1/artifacts/slack-images/2-b.jpg']
  const base = { profile: null, prompt: 'look at it', artifactsDir: '/runs/r1/artifacts', resumeId: null, shell: '/bin/zsh' }

  it('claude: one --add-dir of the images folder, before --session-id, also when restricted', () => {
    for (const restricted of [false, true]) {
      const args = claudeAdapter.headless({ ...base, images: imgs, restricted, mcpArgs: ['--mcp-config', '/x.json'] }).args
      const i = args.indexOf('--add-dir')
      expect(i).toBeGreaterThan(-1)
      expect(args[i + 1]).toBe('/runs/r1/artifacts/slack-images')
      expect(args[i + 2]).toBe('--session-id')
      expect(args.filter((a) => a === '--add-dir')).toHaveLength(1)
    }
    expect(claudeAdapter.headless(base).args).not.toContain('--add-dir')
  })

  it('codex: -i per image right after exec; the prompt stays the last positional', () => {
    const args = codexAdapter.headless({ ...base, images: imgs }).args
    expect(args.slice(0, 6)).toEqual(['exec', '-i', imgs[0], '-i', imgs[1], '--json'])
    expect(args[args.length - 1]).toContain('look at it')
    expect(args[args.length - 2]?.startsWith('-')).toBe(true)
    expect(codexAdapter.headless(base).args).not.toContain('-i')
  })
})
