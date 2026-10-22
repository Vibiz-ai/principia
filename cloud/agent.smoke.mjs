/**
 * Principia Cloud agent runtime smoke (CLOUD.md §15, package AI). The real engine (better-sqlite3) with fake Claude and
 * Codex CLIs, a fake Open Passport host and a ControlPorts recorder. No model is ever called.
 *   npm run cloud:build && ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron cloud/agent.smoke.mjs
 * (out-cloud/agent.mjs comes from CLOUD_AGENT_ENTRIES in src/cloud/agent/entries.ts.) Env FAKE_BIN_DIR overrides the
 * fake CLI folder (the Docker check mounts it).
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const bundle = resolve(here, '../out-cloud/agent.mjs')
if (!existsSync(bundle)) {
  console.error('out-cloud/agent.mjs is missing: vite.cloud.config.ts must spread CLOUD_AGENT_ENTRIES (src/cloud/agent/entries.ts), then npm run cloud:build')
  process.exit(1)
}
const { createCloudRuntime } = await import(bundle)
const binDir = process.env.FAKE_BIN_DIR || resolve(here, '../src/cloud/agent/__tests__/bin')
const bins = { claude: join(binDir, 'claude'), codex: join(binDir, 'codex'), gemini: join(binDir, 'gemini'), git: 'git' }

// ---------- a fake Open Passport host ----------
const GRANT = 'opk_smoke_runtime_grant_0123456789abcdef'
const passportHost = { requests: [], notes: [] }
const server = http.createServer(async (req, res) => {
  let body = ''
  for await (const c of req) body += c
  const url = new URL(req.url, 'http://x')
  passportHost.requests.push({ path: url.pathname + url.search, auth: req.headers.authorization })
  if (req.headers.authorization !== `Bearer ${GRANT}`) return void res.writeHead(401).end('{"error":"unauthorized"}')
  if (url.pathname === '/v1/passports/pp_acme' && url.searchParams.get('format') === 'json') return void res.writeHead(200, { 'content-type': 'application/json' }).end('{"revision":7}')
  if (url.pathname === '/v1/passports/pp_acme') return void res.writeHead(200, { 'content-type': 'text/markdown' }).end('<company-passport>\nAcme sells invoicing to bakeries.\n</company-passport>\n')
  if (url.pathname === '/v1/passports/pp_acme/notes') {
    passportHost.notes.push(JSON.parse(body))
    return void res.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"proposed"}')
  }
  res.writeHead(404).end()
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const passportUrl = `http://127.0.0.1:${server.address().port}`

// ---------- a ControlPorts recorder ----------
const rec = { status: [], steps: [], logs: [], usage: [], asks: [], requests: [], fired: [], saved: [], forum: [] }
let schedules = []
let seq = 0
const ports = {
  runStatus: (runId, status, summary) => rec.status.push({ runId, status, summary }),
  runStep: (runId, step) => rec.steps.push({ runId, step }),
  runLog: (runId, stepId, lines) => rec.logs.push({ runId, stepId, lines }),
  usage: (e) => rec.usage.push(e),
  openAsk: (a) => {
    const id = `cask_${++seq}`
    rec.asks.push({ ...a, id })
    return id
  },
  requestRun: (r) => {
    rec.requests.push(r)
    return { runId: `crun_req${++seq}`, refused: null }
  },
  cloudSchedules: () => schedules,
  markScheduleFired: (scheduleId, slot, runId) => rec.fired.push({ scheduleId, slot, runId }),
  saveProviderCredential: (c) => rec.saved.push(c),
  forumEvent: (companyId, channelId, messageId) => rec.forum.push({ companyId, channelId, messageId }),
  audit: () => {},
  knownSecrets: () => ['known-secret-from-the-vault'],
  log: { info: () => {}, warn: (m, meta) => process.env.SMOKE_DEBUG && console.warn('warn', m, meta), error: (m, meta) => console.error('error', m, meta) }
}
const finalOf = (runId) => [...rec.status].reverse().find((s) => s.runId === runId)
const until = async (cond, ms = 30_000) => {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 25))
  }
}
const settled = (runId) => until(() => ['passed', 'failed', 'canceled', 'needs_input'].includes(finalOf(runId)?.status))

// ---------- the runtime ----------
process.env.PRINCIPIA_SECRET = 'planted-control-plane-secret'
const root = realpathSync(mkdtempSync(join(tmpdir(), 'principia-agent-smoke-')))
const rt = createCloudRuntime({ dataDir: join(root, 'data'), workspaceDir: join(root, 'workspace'), ports, bins })
const CLAUDE_TOKEN = 'sk-ant-oat01-smoke-token-0123456789abcdef'
const OPENAI_KEY = 'sk-proj-smoke-openai-key-0123456789'
const materials = (providers) => ({
  providers,
  repos: [],
  connections: [],
  passport: { internalUrl: passportUrl, publicUrl: 'https://passport.example.com', passportId: 'pp_acme', token: GRANT },
  secrets: { ACME_KEY: 'acme-company-key-value' }
})
const claude = [{ credentialId: 'cred_claude', adapter: 'claude', kind: 'claude_oauth_token', value: CLAUDE_TOKEN }]
const codex = [{ credentialId: 'cred_codex', adapter: 'codex', kind: 'openai_api_key', value: OPENAI_KEY }]
let n = 0
const request = (target, extra = {}) => ({ runId: `crun_smoke${++n}`, workspaceId: 'ws_1', companyId: 'co_acme', companyName: 'Acme', trigger: 'manual', target, workflowFile: null, timeoutMs: 120_000, untrustedInputs: [], materials: materials(claude), ...extra })

try {
  await rt.start()
  await rt.ensureCompany({ workspaceId: 'ws_1', companyId: 'co_acme', name: 'Acme', slug: 'acme' })
  assert.equal(rt.health().status, 'ok')

  // 1. a two-node workflow: shell, then fake Claude
  const file = {
    hive: 'workflow',
    version: 1,
    workflow: {
      name: 'Launch email',
      description: '',
      inputs: [],
      nodes: [
        { id: 'prep', type: 'shell', label: 'Prepare', command: 'echo "key=$ACME_KEY"; echo prep-ok', cwd: null, after: [], timeoutMin: 1 },
        { id: 'draft', type: 'agent', label: 'Draft', profileId: 'prof_claude', prompt: 'PRINT_SECRET FAKE_FORUM_POST WRITE_NOTES draft it', cwd: null, after: ['prep'], timeoutMin: 2, memory: 'read-write' }
      ]
    }
  }
  assert.deepEqual(rt.validateWorkflow('co_acme', file), [])
  const wf = request({ kind: 'workflow', workflowId: 'wf_launch', inputs: {} }, { workflowFile: file })
  rt.startRun(wf)
  await settled(wf.runId)
  assert.deepEqual(rec.status.filter((s) => s.runId === wf.runId).map((s) => s.status), ['running', 'passed'], JSON.stringify(rec.status))
  const wfSummary = finalOf(wf.runId).summary
  assert.match(wfSummary, /fake-claude-ok PASSPORT_SEEN/, 'the passport L0 card reaches the prompt')
  const wfDetail = rt.runDetail(wf.runId)
  assert.deepEqual(wfDetail.steps.map((s) => [s.nodeId, s.adapter, s.status]), [['prep', 'shell', 'passed'], ['draft', 'claude', 'passed']])
  assert.ok(rec.steps.some((s) => s.runId === wf.runId && s.step.nodeId === 'draft' && s.step.status === 'running'))
  await until(() => rec.usage.some((u) => u.runId === wf.runId))
  assert.deepEqual(rec.usage.filter((u) => u.runId === wf.runId), [{ runId: wf.runId, companyId: 'co_acme', adapter: 'claude', inputTokens: 120, outputTokens: 30, usd: null }])
  const everything = JSON.stringify({ summary: wfSummary, detail: rt.runDetail(wf.runId), log: rt.runLog(wf.runId, null, 500), streamed: rec.logs })
  for (const secret of [CLAUDE_TOKEN, 'acme-company-key-value', GRANT]) assert.ok(!everything.includes(secret), `redacted: ${secret.slice(0, 12)}`)
  assert.ok(everything.includes('••••ACME_KEY'))
  const env = JSON.parse(readFileSync(rt.artifactPath(wf.runId, 'claude-env.json'), 'utf8'))
  assert.ok(!env.names.includes('PRINCIPIA_SECRET'), 'no host variable reaches the agent')
  assert.ok(env.args.includes('dontAsk') && !env.args.includes('--bare'))
  assert.ok(!existsSync(env.home), 'the run home is deleted')
  assert.deepEqual(rt.runDetail(wf.runId).forumPosts.map((p) => p.text), ['Drafted the launch email.'])
  await until(() => passportHost.notes.length === 1)
  assert.equal(passportHost.notes[0].note, 'Launch')
  console.log('workflow run (shell + claude), steps, usage, redaction, passport card and notes, forum posts: PASS')

  // 2. a prompt run with fake Codex on an OpenAI API key (codex login --with-api-key), posting through the forum CLI
  const pr = request({ kind: 'prompt', adapter: 'codex', prompt: 'FORUM_CLI_POST weekly numbers' }, { materials: materials(codex) })
  rt.startRun(pr)
  await settled(pr.runId)
  assert.equal(finalOf(pr.runId).status, 'passed', JSON.stringify(finalOf(pr.runId)))
  assert.match(finalOf(pr.runId).summary, /fake-codex-ok auth=apikey store=file sandbox=workspace-write PASSPORT_SEEN forum-cli=0/)
  await until(() => rec.usage.some((u) => u.runId === pr.runId))
  assert.deepEqual(rec.usage.find((u) => u.runId === pr.runId), { runId: pr.runId, companyId: 'co_acme', adapter: 'codex', inputTokens: 200, outputTokens: 40, usd: null })
  assert.deepEqual(rt.runDetail(pr.runId).forumPosts.map((p) => p.text), ['Weekly numbers are in.'])
  assert.ok(!JSON.stringify(rt.runLog(pr.runId, null, 500)).includes(OPENAI_KEY))
  console.log('prompt run (codex, API-key login, forum CLI), usage: PASS')

  // 3. a cloud schedule fires once
  const slotBase = new Date()
  schedules = [{ id: 'sch_brief', companyId: 'co_acme', name: 'Brief', when: { kind: 'cron', cron: '*/5 * * * *', tz: 'UTC' }, target: { kind: 'workflow', workflowId: 'wf_launch', inputs: {} }, enabled: true, lastFireAt: new Date(slotBase.getTime() - 11 * 60_000).toISOString() }]
  rt.triggers.reloadSchedules()
  rt.triggers.reloadSchedules()
  assert.equal(rec.requests.filter((r) => r.trigger === 'schedule').length, 1)
  const fire = rec.requests.find((r) => r.trigger === 'schedule')
  assert.equal(fire.scheduleId, 'sch_brief')
  assert.ok(Date.parse(fire.slot) <= Date.now() && Date.parse(fire.slot) % (5 * 60_000) === 0)
  assert.deepEqual(rec.fired, [{ scheduleId: 'sch_brief', slot: fire.slot, runId: rec.fired[0].runId }])
  schedules = []
  console.log('schedule fire (slot, no double fire): PASS')

  // 4. an ask: Needs you, needs_input, the answer resumes the work
  const ask = request({ kind: 'prompt', adapter: 'claude', prompt: 'FAKE_FORUM_ASK plan the launch' })
  rt.startRun(ask)
  await settled(ask.runId)
  assert.equal(finalOf(ask.runId).status, 'needs_input')
  const opened = rec.asks.find((a) => a.runId === ask.runId)
  assert.equal(opened.question, 'Which plan should the launch email push?')
  await rt.answerAsk(opened.id, 'Yearly')
  const resume = rec.requests.at(-1)
  assert.equal(resume.trigger, 'answer')
  const answered = request(resume.target, { runId: resume.runId ?? 'crun_resume', trigger: 'answer' })
  rt.startRun(answered)
  await settled(answered.runId)
  assert.equal(finalOf(answered.runId).status, 'passed')
  assert.match(finalOf(answered.runId).summary, /ANSWER_SEEN/)
  // a retried answer never posts twice or asks for a second resume run
  const requestsBefore = rec.requests.length
  await rt.answerAsk(opened.id, 'Yearly')
  assert.equal(rec.requests.length, requestsBefore)
  console.log('ask opened, answered, resumed (answer idempotent): PASS')

  // 5. an expired Claude token: the run says what to fix, and never falls back to a signed-out Codex
  const expired = request({ kind: 'prompt', adapter: 'claude', prompt: 'draft it' }, { materials: materials([{ credentialId: 'cred_old', adapter: 'claude', kind: 'claude_oauth_token', value: 'sk-ant-oat01-smoke-expired-token-0123456789' }]) })
  rt.startRun(expired)
  await settled(expired.runId)
  assert.deepEqual(finalOf(expired.runId), { runId: expired.runId, status: 'failed', summary: 'Claude token expired. Connect Claude again.' })
  assert.deepEqual(rt.runDetail(expired.runId).steps.map((s) => s.adapter), ['claude'])
  console.log('expired account reads as its fix, no fallback to a signed-out CLI: PASS')

  assert.equal((await rt.triggers.webhook({ id: 'h', companyId: 'co_acme', workflowId: 'wf', verify: 'github', secret: 's', inputs: {} }, { headers: {}, rawBody: Buffer.from('{}') })).status, 501)
  assert.deepEqual(await rt.providers.cliVersions(), { claude: '2.1.290', codex: '0.120.0', gemini: '0.9.0' })
  console.log('Principia Cloud agent runtime smoke: PASS')
} finally {
  await rt.close()
  server.closeAllConnections()
  server.close()
}
