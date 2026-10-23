import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SlackRunContext } from '../../../../shared/slack'
import type { Repo } from '../../../../shared/types'
import { buildAuthorHandlers, parseToolsets } from '../../../author/server/tools'
import { SlackTools } from '../tools'
import { SlackWork, cleanRemote, claudeLastAssistant, fsRepoMeta, sendWorkReport, type SlackWorkDeps } from '../work'
import { entriesFrom } from '../../../history/transcript'
import { connect, makeHarness, nativeOk, settle, type Harness } from './harness'

const SECRET = 'sk-live-SECRET123'
const redact = (s: string) => s.split(SECRET).join('••••STRIPE_KEY')

let tmp: string
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-work-'))
})
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

function repoDir(name: string, remote: string, readme: string): string {
  const dir = path.join(tmp, name)
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true })
  fs.writeFileSync(path.join(dir, '.git', 'config'), `[core]\n\tbare = false\n[remote "origin"]\n\turl = ${remote}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`)
  fs.writeFileSync(path.join(dir, 'README.md'), readme)
  return dir
}

describe('work toolset registration (SLACK.md §11.4)', () => {
  it('HIVE_TOOLSETS work lists principia_repos and principia_start_session; slack alone does not', () => {
    expect([...parseToolsets('slack,work')]).toEqual(['slack', 'work'])
    const dir = process.cwd()
    expect(buildAuthorHandlers({ HIVE_LIVE_DIR: dir, HIVE_TOOLSETS: 'slack' }).listTools().map((t) => t.name)).not.toContain('principia_start_session')
    const h = buildAuthorHandlers({ HIVE_LIVE_DIR: dir, HIVE_TOOLSETS: 'slack,work' })
    const names = h.listTools().map((t) => t.name)
    expect(names).toEqual(expect.arrayContaining(['slack_post', 'principia_repos', 'principia_start_session']))
    expect(names).toHaveLength(7)
    expect(h.instructions()).toMatch(/principia_start_session/)
  })

  it('repo meta: remote without credentials, README first line', () => {
    expect(cleanRemote('https://x-access-token:ghp_abc@github.com/acme/web.git')).toBe('https://github.com/acme/web.git')
    const d = repoDir('web', 'https://bob:tok@github.com/acme/web.git', '<p align="center">\n\n# Acme Web\n\nThe storefront')
    expect(fsRepoMeta(d)).toEqual({ remote: 'https://github.com/acme/web.git', readme: 'Acme Web' })
    expect(fsRepoMeta(path.join(tmp, 'missing'))).toEqual({ remote: null, readme: null })
  })

  it('claude transcript: the last assistant text after the last typed prompt', () => {
    const root = path.join(tmp, 'projects')
    fs.mkdirSync(path.join(root, '-x-web'), { recursive: true })
    const id = '11111111-2222-3333-4444-555555555555'
    const lines = [
      { type: 'user', message: { role: 'user', content: 'fix the bug' } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Looking.' }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Fixed the null check in cart.ts.' }] } }
    ]
    fs.writeFileSync(path.join(root, '-x-web', `${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n'))
    expect(claudeLastAssistant([root], id, entriesFrom)).toBe('Fixed the null check in cart.ts.')
    expect(claudeLastAssistant([root], '99999999-2222-3333-4444-555555555555', entriesFrom)).toBeNull()
  })
})

const d = nativeOk ? describe : describe.skip
let h: Harness
let tools: SlackTools
let work: SlackWork
let steps: Record<string, { ctx: SlackRunContext | null; slackTools: boolean }>
let trig: { mode: 'draft' | 'auto' | 'none'; enabled: boolean }
let enforced: boolean
let repos: Repo[]
let created: { repoId: string; adapter: string; title: string; companyId: string | null; prompt: string; artifactsDir: string }[]
let continued: { sessionId: string; text: string }[]
let reports: { sessionId: string; text: string }[]
let lastSaid: string | null
let imagesDir: string

const ctx = (threadTs: string, o: Partial<SlackRunContext> = {}): SlackRunContext => ({
  triggerId: 'stg_1', teamId: 'T1', channelId: 'C1', channelName: 'support', channelKind: 'channel', threadTs, messageTs: [threadTs],
  userId: 'U1', userName: 'Dana Lee', text: 'go ahead and fix it', permalink: `https://acme.slack.com/archives/C1/p${threadTs.replace('.', '')}`, isMention: true, isDm: false, catchup: false, ...o
})
const repo = (id: string, name: string, dir: string, companyId: string): Repo => ({ id, name, path: dir, addedAt: '2026-10-01T00:00:00Z', exists: true, isGit: true, liveSessions: 0, companyId })
const COMPANY: Record<string, string> = { co_acme: 'Acme', co_globex: 'Globex' }

async function setup(): Promise<void> {
  vi.useFakeTimers({ now: new Date('2026-10-16T09:00:00Z') })
  h = makeHarness()
  await connect(h)
  await settle(5000)
  steps = {}
  trig = { mode: 'draft', enabled: true }
  enforced = false
  created = []
  continued = []
  reports = []
  lastSaid = null
  imagesDir = path.join(tmp, 'run', 'slack-images')
  fs.mkdirSync(imagesDir, { recursive: true })
  fs.writeFileSync(path.join(imagesDir, 'shot.png'), 'png')
  fs.writeFileSync(path.join(imagesDir, 'notes.txt'), 'not an image')
  repos = [
    repo('repo_web000001', 'acme-web', repoDir('acme-web', 'git@github.com:acme/web.git', '# Acme storefront'), 'co_acme'),
    repo('repo_api000001', 'acme-api', repoDir('acme-api', 'git@github.com:acme/api.git', '# Acme API'), 'co_acme'),
    repo('repo_glx000001', 'globex-app', repoDir('globex-app', 'git@github.com:globex/app.git', '# Globex'), 'co_globex')
  ]
  const deps: SlackWorkDeps = {
    sql: h.sql,
    redact,
    repos: () => repos,
    repoCompany: (id) => {
      const c = repos.find((r) => r.id === id)?.companyId ?? 'co_acme'
      return { id: c, name: COMPANY[c] }
    },
    teamCompany: () => ({ id: 'co_acme', name: 'Acme' }),
    enforced: () => enforced,
    multiCompany: () => true,
    lastActivity: (id) => (id === 'repo_api000001' ? '2026-10-15T00:00:00Z' : null),
    transcript: () => `[09:00] Dana Lee: checkout crashes with TypeError in cart.ts, key ${SECRET}\n[09:01] Sam Roe: <@hive> go ahead and fix it`,
    runImagesDir: () => imagesDir,
    createSession: (req) => {
      const id = `session_${String(created.length + 1).padStart(10, '0')}`
      const artifactsDir = path.join(tmp, 'artifacts', id)
      fs.mkdirSync(artifactsDir, { recursive: true })
      const prompt = req.prepare({ id, artifactsDir })
      created.push({ repoId: req.repoId, adapter: req.adapter, title: req.title, companyId: req.companyId, prompt, artifactsDir })
      return { id, title: req.title }
    },
    continueSession: (sessionId, text) => {
      continued.push({ sessionId, text })
    },
    lastAssistantMessage: () => lastSaid,
    postReport: async (w, text) => {
      reports.push({ sessionId: w.sessionId, text })
      await sendWorkReport(h.conn, { ctx: ctx(w.threadTs!), trigger: view() }, w, text, null)
    }
  }
  work = new SlackWork(deps)
  tools = new SlackTools({
    connector: h.conn,
    sql: h.sql,
    redact,
    now: () => Date.now(),
    session: (sid) => (sid === 's_live' ? { label: 'vibiz · Claude', agentId: null } : null),
    step: (o) => (steps[o.stepId] ? { ...steps[o.stepId], label: 'Reply in Slack', agentId: null } : null),
    trigger: (id) => (id === 'stg_1' ? view() : null),
    work
  })
}
const view = () => ({ id: 'stg_1', enabled: trig.enabled, reply: { mode: trig.mode, autoChannels: ['C1'], replyNode: null }, limits: { debounceSec: 3, maxRunsPerThreadPerHour: 4 } })

afterEach(async () => {
  await h?.conn.stop()
  h?.db.close()
  vi.useRealTimers()
})

async function thread(): Promise<{ parent: string; owner: { stepId: string; runId: string } }> {
  const parent = h.fake.post('C1', { user: 'U1', text: '<@UBOT> checkout is broken' })
  await settle(20)
  steps.st_a = { ctx: ctx(parent), slackTools: false }
  return { parent, owner: { stepId: 'st_a', runId: 'r_a' } }
}

d('principia_* tools: gating', () => {
  it('sessions, slackTools-only steps and runs without the work port cannot use them; disabled or replies-off triggers refuse', async () => {
    await setup()
    const { owner } = await thread()
    await expect(tools.call({ sessionId: 's_live' }, 'principia_repos', {})).rejects.toThrow(/Unknown tool/)
    steps.st_plain = { ctx: null, slackTools: true }
    await expect(tools.call({ stepId: 'st_plain', runId: 'r_p' }, 'principia_start_session', { repo_id: 'repo_web000001', task: 'x' })).rejects.toThrow(/Unknown tool/)
    trig.enabled = false
    await expect(tools.call(owner, 'principia_start_session', { repo_id: 'repo_web000001', task: 'fix' })).rejects.toThrow(/disabled/)
    trig.enabled = true
    trig.mode = 'none'
    await expect(tools.call(owner, 'principia_repos', {})).rejects.toThrow(/replies turned off/)
    expect(created).toHaveLength(0)
    const bare = new SlackTools({ connector: h.conn, sql: h.sql, redact, now: () => Date.now(), session: () => null, step: () => ({ ctx: ctx('1.1'), slackTools: false, label: 'x', agentId: null }), trigger: () => view() })
    await expect(bare.call(owner, 'principia_repos', {})).rejects.toThrow(/Unknown tool/)
  })

  it('caps new sessions per run', async () => {
    await setup()
    const { owner } = await thread()
    await tools.call(owner, 'principia_start_session', { repo_id: 'repo_web000001', task: 'a' })
    await tools.call(owner, 'principia_start_session', { repo_id: 'repo_api000001', task: 'b' })
    await expect(tools.call(owner, 'principia_start_session', { repo_id: 'repo_api000001', task: 'c' })).rejects.toThrow(/already started 2/)
  })
})

d('principia_repos + channel hint', () => {
  it('lists repos with company, remote, readme; the repo chosen from a channel becomes its hint (persisted)', async () => {
    await setup()
    const { owner } = await thread()
    const r1 = await tools.call(owner, 'principia_repos', {})
    const list = r1.repos as { id: string; company?: string; remote: string; readme: string; hint: boolean; last_activity: string | null }[]
    expect(list.map((x) => x.id)).toEqual(['repo_api000001', 'repo_web000001', 'repo_glx000001'])
    expect(list[0]).toMatchObject({ company: 'Acme', remote: 'git@github.com:acme/api.git', readme: 'Acme API', hint: false, last_activity: '2026-10-15T00:00:00Z' })
    expect(r1.channel_hint).toBeNull()
    const s = await tools.call(owner, 'principia_start_session', { repo_id: 'repo_web000001', title: 'Fix checkout crash', task: 'Fix the TypeError in cart.ts' })
    expect(s).toMatchObject({ status: 'started', title: 'Fix checkout crash', repo_name: 'acme-web', adapter: 'claude', session_id: 'session_0000000001' })
    expect(h.sql.channelRepo('T1', 'C1')).toBe('repo_web000001')
    const r2 = await tools.call(owner, 'principia_repos', {})
    expect((r2.repos as { id: string; hint: boolean }[])[0]).toMatchObject({ id: 'repo_web000001', hint: true })
    expect(r2.channel_hint).toBe('repo_web000001')
    // without repo_id the channel hint is used
    await tools.call(owner, 'principia_start_session', { task: 'and the other one', adapter: 'codex' })
    expect(created[1]).toMatchObject({ repoId: 'repo_web000001', adapter: 'codex' })
    // the thread ref is kept for the session (sidebar row = a normal repo session)
    expect(h.sql.workSession('session_0000000001')).toMatchObject({ channelId: 'C1', repoId: 'repo_web000001', userName: 'Dana Lee', reportArmed: true })
  })
})

d('company isolation', () => {
  it('enforced: another company\'s repo is refused and hidden; off: it starts (warned)', async () => {
    await setup()
    const { owner } = await thread()
    enforced = true
    const r = await tools.call(owner, 'principia_repos', {})
    expect((r.repos as { id: string }[]).map((x) => x.id)).not.toContain('repo_glx000001')
    await expect(tools.call(owner, 'principia_start_session', { repo_id: 'repo_glx000001', task: 'fix' })).rejects.toThrow(/globex-app belongs to Globex, but this Slack workspace belongs to Acme/)
    expect(created).toHaveLength(0)
    await tools.call(owner, 'principia_start_session', { repo_id: 'repo_web000001', task: 'fix' })
    expect(created[0].companyId).toBe('co_acme')
    enforced = false
    await tools.call(owner, 'principia_start_session', { repo_id: 'repo_glx000001', task: 'fix' })
    expect(created[1]).toMatchObject({ repoId: 'repo_glx000001', companyId: null })
  })
})

d('initialPrompt + context file', () => {
  it('says it came from Slack, points at a redacted context file with the thread and copied image paths', async () => {
    await setup()
    const { owner, parent } = await thread()
    await tools.call(owner, 'principia_start_session', { repo_id: 'repo_web000001', title: 'Fix checkout', task: `Fix the TypeError (the key ${SECRET} leaked)` })
    const c = created[0]
    const file = path.join(c.artifactsDir, 'slack', 'slack-context.md')
    const img = path.join(c.artifactsDir, 'slack', 'images', 'shot.png')
    expect(fs.existsSync(img)).toBe(true)
    expect(fs.existsSync(path.join(c.artifactsDir, 'slack', 'images', 'notes.txt'))).toBe(false)
    expect(c.prompt).toContain('started from Slack: Dana Lee asked in #support')
    expect(c.prompt).toContain(`thread: https://acme.slack.com/archives/C1/p${parent.replace('.', '')}`)
    expect(c.prompt).toContain(JSON.stringify(file))
    expect(c.prompt).not.toContain(SECRET)
    const body = fs.readFileSync(file, 'utf8')
    expect(body).toContain('Asked by: Dana Lee')
    expect(body).toContain('checkout crashes with TypeError in cart.ts')
    expect(body).toContain(`- ${img}`)
    expect(body).toContain('••••STRIPE_KEY')
    expect(body).not.toContain(SECRET)
    // include_thread false: no transcript, no images
    await tools.call(owner, 'principia_start_session', { repo_id: 'repo_web000001', task: 'small thing', include_thread: false })
    const body2 = fs.readFileSync(path.join(created[1].artifactsDir, 'slack', 'slack-context.md'), 'utf8')
    expect(body2).not.toContain('cart.ts')
    expect(fs.existsSync(path.join(created[1].artifactsDir, 'slack', 'images'))).toBe(false)
  })
})

d('report back', () => {
  const root = (sid: string, status: 'working' | 'needs_you' | 'idle' | 'done', needs: 'idle' | 'permission' | null = null, report: string | null = null) => ({ id: 'agent_1', sessionId: sid, parentId: null, status, needs, report })

  it('posts once when the first turn ends (auto mode), never for later app turns; a Slack follow-up re-arms it', async () => {
    await setup()
    trig.mode = 'auto'
    const { owner, parent } = await thread()
    const s = await tools.call(owner, 'principia_start_session', { repo_id: 'repo_web000001', title: 'Fix checkout', task: 'fix' })
    const sid = s.session_id as string
    lastSaid = `Fixed cart.ts. Key ${SECRET} removed. ${'x'.repeat(3000)}`
    expect(work.onAgent(root(sid, 'needs_you', 'idle'))).toBeNull() // no work yet: not a finished turn
    work.onAgent(root(sid, 'working'))
    expect(work.onAgent(root(sid, 'needs_you', 'permission'))).toBeNull() // a permission prompt is not the end
    const p1 = work.onAgent(root(sid, 'needs_you', 'idle'))
    await settle(2000)
    await p1
    expect(reports).toHaveLength(1)
    expect(reports[0].text).toMatch(/^Claude session "Fix checkout" in acme-web finished its turn:/)
    expect(reports[0].text).not.toContain(SECRET)
    expect(reports[0].text.length).toBeLessThan(1700)
    expect(h.fake.posted).toHaveLength(1)
    expect(h.fake.posted[0]).toMatchObject({ channel: 'C1', thread_ts: parent })
    // the user keeps working in the app: no more reports
    work.onAgent(root(sid, 'working'))
    expect(work.onAgent(root(sid, 'needs_you', 'idle'))).toBeNull()
    expect(reports).toHaveLength(1)
    // a follow-up from the same thread re-arms exactly one report
    steps.st_b = { ctx: ctx(parent), slackTools: false }
    const f = await tools.call({ stepId: 'st_b', runId: 'r_b' }, 'principia_start_session', { continue_session_id: sid, task: 'also add a test' })
    expect(f).toMatchObject({ status: 'continued', session_id: sid })
    expect(continued[0].text).toContain('also add a test')
    lastSaid = null
    work.onAgent(root(sid, 'working'))
    const p2 = work.onAgent(root(sid, 'needs_you', 'idle', null))
    await settle(2000)
    await p2
    expect(reports[1].text).toBe('Claude session "Fix checkout" in acme-web finished its turn. Open it in Principia to review.')
    expect(work.onAgent(root(sid, 'needs_you', 'idle'))).toBeNull()
    // another thread cannot continue it
    steps.st_c = { ctx: ctx('1729070000.000001'), slackTools: false }
    await expect(tools.call({ stepId: 'st_c', runId: 'r_c' }, 'principia_start_session', { continue_session_id: sid, task: 'x' })).rejects.toThrow(/this Slack thread started/)
  })

  it('becomes a draft owned by the session when the trigger needs approval', async () => {
    await setup()
    trig.mode = 'draft'
    const { owner } = await thread()
    const s = await tools.call(owner, 'principia_start_session', { repo_id: 'repo_web000001', title: 'Fix checkout', task: 'fix' })
    const sid = s.session_id as string
    lastSaid = 'Done: fixed cart.ts'
    work.onAgent(root(sid, 'working'))
    const p = work.onAgent(root(sid, 'needs_you', 'idle'))
    await settle(2000)
    await p
    expect(h.fake.posted).toHaveLength(0)
    const drafts = h.sql.draftList({ status: ['pending'] })
    expect(drafts).toHaveLength(1)
    expect(drafts[0]).toMatchObject({ reason: 'draft_mode', owner: { kind: 'session', sessionId: sid } })
    expect(drafts[0].text).toContain('Done: fixed cart.ts')
  })

  it('ignores sessions not started from Slack', async () => {
    await setup()
    expect(work.onAgent(root('session_other00001', 'working'))).toBeNull()
    expect(work.onAgent(root('session_other00001', 'needs_you', 'idle'))).toBeNull()
    expect(reports).toHaveLength(0)
  })
})
