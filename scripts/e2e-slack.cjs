// End-to-end Slack check (SLACK.md §14.1 items 3-6 + §9.5) against the dev-only fake Slack build, throwaway data only.
// usage: npm run build:fakeslack && PW=<dir containing node_modules/playwright-core> node scripts/e2e-slack.cjs "$PWD"
// Never touches /Applications/Hive.app or ~/Library/Application Support/Hive (HIVE_USER_DATA is a temp dir).
// Spends real Claude usage: three headless haiku runs + one interactive pane (authoring).
// Any ~/.claude.json trust entry Hive adds for the temp dirs is removed at the end (file mode kept at 600).
const path = require('path')
const fs = require('fs')
const os = require('os')
const pwDir = process.env.PW ? path.join(process.env.PW, 'node_modules', 'playwright-core') : 'playwright-core'
const { _electron: electron } = require(pwDir)

const APP = process.argv[2] || path.resolve(__dirname, '..')
const OUT = path.join(APP, 'out-fakeslack')
const FIXTURE = path.join(APP, 'scripts', 'fixtures', 'fake-slack.json')
const SCRATCH = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hive-e2e-slack-')))
const SHOTS = process.env.SHOTS || path.join(SCRATCH, 'shots')
fs.mkdirSync(SHOTS, { recursive: true })
const SKIP_AUTHORING = process.env.SKIP_AUTHORING === '1'
const fx = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'))
const BOT = fx.bot.userId

const results = []
const ok = (name, pass, detail = '') => {
  results.push({ name, pass })
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitFor(fn, timeoutMs, everyMs = 1000) {
  const end = Date.now() + timeoutMs
  let last
  while (Date.now() < end) {
    last = await fn()
    if (last) return last
    await sleep(everyMs)
  }
  return last
}

// ~/.claude.json: remember which project keys exist so we can drop the ones this run adds
const claudeJson = path.join(os.homedir(), '.claude.json')
const projectKeys = () => {
  try {
    return Object.keys(JSON.parse(fs.readFileSync(claudeJson, 'utf8')).projects || {})
  } catch {
    return null
  }
}
const keysBefore = new Set(projectKeys() || [])
function cleanTrust() {
  try {
    const raw = fs.readFileSync(claudeJson, 'utf8')
    const cfg = JSON.parse(raw)
    const added = Object.keys(cfg.projects || {}).filter((k) => !keysBefore.has(k) && (k.startsWith(SCRATCH) || k.startsWith(fs.realpathSync(os.tmpdir()))))
    if (!added.length) return 0
    for (const k of added) delete cfg.projects[k]
    const tmp = `${claudeJson}.hive-e2e-${process.pid}`
    fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 })
    fs.renameSync(tmp, claudeJson)
    fs.chmodSync(claudeJson, 0o600)
    return added.length
  } catch (e) {
    console.log(`warn: could not clean ~/.claude.json trust entries: ${e}`)
    return -1
  }
}

;(async () => {
  if (!fs.existsSync(path.join(OUT, 'main', 'index.js'))) throw new Error('out-fakeslack missing: run npm run build:fakeslack')
  const userData = path.join(SCRATCH, 'userdata')
  const claudeDirs = path.join(SCRATCH, 'claude-history')
  fs.mkdirSync(claudeDirs)
  const env = { ...process.env, HIVE_USER_DATA: userData, HIVE_FAKE_SLACK: FIXTURE, HIVE_CLAUDE_DIRS: claudeDirs }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.HIVE_NO_SCHEDULER
  const app = await electron.launch({ executablePath: path.join(APP, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'), args: [OUT], env, cwd: APP })
  // run on the main event loop (setImmediate), like a real socket frame: Playwright's evaluate arrives as an inspector
  // interrupt and could otherwise land in the middle of a synchronous SQLite call
  const fake = (fn, arg) =>
    app.evaluate(
      (_electron, [src, a]) => new Promise((res, rej) => setImmediate(() => { try { res(new Function('f', 'a', `return (${src})(f, a)`)(globalThis.__hiveFakeSlack, a)) } catch (e) { rej(e) } })),
      [fn.toString(), arg]
    )
  const posts = () => fake((f) => f.callsOf('chat.postMessage').map((c) => c.body))
  let page
  const nav = async (label) => {
    await page.evaluate((l) => document.querySelectorAll('.side-row--nav').forEach((el) => el.textContent.includes(l) && el.click()), label)
    await sleep(700)
  }
  try {
    page = await app.firstWindow()
    await page.waitForFunction(() => !!window.hive, null, { timeout: 30000 })
    await page.setViewportSize({ width: 1440, height: 900 }).catch(() => undefined)
    ok('fake Slack is wired in the dev fake build', await fake((f) => !!f))

    // ---- S1: connect through Settings › Connections with the fixture tokens
    await page.evaluate(() => document.querySelector('.sidebar__settings')?.click())
    await sleep(500)
    await page.locator('text=Connections').first().click()
    await sleep(500)
    const manifest = await page.evaluate(() => window.hive.slack.manifest())
    const m = JSON.parse(manifest.json)
    const scopes = m.oauth_config.scopes.bot
    const need = ['app_mentions:read', 'channels:history', 'channels:read', 'groups:history', 'groups:read', 'im:history', 'im:read', 'im:write', 'mpim:history', 'chat:write', 'users:read', 'reactions:read']
    const events = m.settings.event_subscriptions.bot_events
    ok('manifest: scopes, events, socket mode', need.every((s) => scopes.includes(s)) && ['message.channels', 'message.groups', 'message.im', 'app_mention'].every((e) => events.includes(e)) && m.settings.socket_mode_enabled === true, `${scopes.length} scopes · ${events.join(',')}`)
    ok('Create the Slack app button (pre-filled manifest link)', /manifest_json=/.test(manifest.createUrl) && (await page.locator('button', { hasText: 'Create the Slack app' }).count()) > 0)
    await page.locator('text=Paste it yourself').first().click()
    await sleep(300)
    ok('Copy manifest button + YAML/JSON', (await page.locator('button', { hasText: 'Copy manifest' }).count()) > 0 && /oauth_config:/.test(manifest.yaml))
    await page.screenshot({ path: path.join(SHOTS, '00-settings-setup-guide.png') })
    await page.locator('input[placeholder="xapp-…"]').fill(fx.tokens.app)
    await page.locator('input[placeholder="xoxb-…"]').fill(fx.tokens.bot)
    await page.locator('button', { hasText: /^Connect$/ }).first().click()
    const st = await waitFor(async () => {
      const s = await page.evaluate(() => window.hive.slack.status())
      return s.state === 'connected' ? s : null
    }, 30000)
    ok('status connected', !!st, st ? `${st.workspace?.name} · @${st.workspace?.botName}` : 'not connected')
    const masked = await page.evaluate(() => window.hive.slack.status().then((s) => s.tokens))
    const body = await page.evaluate(() => document.body.innerText)
    ok('tokens never shown in full', !body.includes(fx.tokens.bot) && !body.includes(fx.tokens.app) && !JSON.stringify(masked).includes(fx.tokens.bot), JSON.stringify(masked))
    await page.screenshot({ path: path.join(SHOTS, '01-settings-connected.png') })
    const test = await page.evaluate(() => window.hive.slack.test())
    ok('Test connection (auth.test)', test.ok, JSON.stringify({ bot: test.botToken, app: test.appToken, socket: test.socket }))

    // ---- S2: backfill shows channels and the seeded thread
    const synced = await waitFor(async () => {
      const s = await page.evaluate(() => window.hive.slack.status())
      const chans = await page.evaluate(() => window.hive.slack.channels())
      const msgs = chans.some((c) => c.id === 'CSUPPORT') ? await page.evaluate(() => window.hive.slack.messages({ channelId: 'CSUPPORT' })) : { messages: [] }
      return s.sync.state === 'idle' && msgs.messages.length >= 2 ? { chans, msgs } : null
    }, 30000)
    ok('backfill: channels + messages', !!synced, synced ? `${synced.chans.map((c) => c.name).join(', ')} · ${synced.msgs.messages.length} msgs in #support` : '')
    const users = await page.evaluate(() => window.hive.slack.users())
    ok('users resolved', users.some((u) => u.id === 'UDANA' && /Dana/.test(u.realName || u.displayName || u.name || '')), users.map((u) => u.id).join(','))
    await nav('Slack')
    await page.locator('text=support').first().click().catch(() => undefined)
    await sleep(800)
    await page.screenshot({ path: path.join(SHOTS, '02-slack-page.png') })
    const pageText = await page.evaluate(() => document.querySelector('.main')?.innerText || document.body.innerText)
    ok('Slack page shows the timeline', /Is the deploy done\?/.test(pageText))
    const hits = await page.evaluate(() => window.hive.slack.search({ query: 'deploy' }))
    ok('search (local mirror)', hits.length >= 1, `${hits.length} hit(s)`)

    // ---- S4/S3: @mention -> workflow (claude haiku) drafts a reply -> Needs-you card -> Send -> in-thread post
    const prof = await page.evaluate(() =>
      window.hive.profiles.create({ name: 'Claude haiku (slack e2e)', adapter: 'claude', model: 'haiku', extraArgs: ['--max-turns', '6'], permissionMode: 'bypass' })
    )
    const wf = await page.evaluate(
      ({ pid }) =>
        window.hive.workflows.create({
          name: 'Support bot',
          description: 'answers @hive mentions',
          inputs: [],
          nodes: [
            {
              id: 'answer',
              type: 'agent',
              label: 'Answer',
              after: [],
              cwd: null,
              timeoutMin: 5,
              profileId: pid,
              prompt:
                'Someone asked in Slack ({{trigger.channel}}, from {{trigger.user}}):\n{{trigger.text}}\n\nCall the mcp__hive__slack_draft_reply tool exactly once with a one-sentence friendly reply as `text` (use channel {{trigger.channel_id}} and thread_ts {{trigger.thread_ts}}). Then answer with the single word DONE.'
            }
          ]
        }),
      { pid: prof.id }
    )
    const trig = await page.evaluate(
      (wid) =>
        window.hive.slackTriggers.create({
          name: 'Support mentions',
          workflowId: wid,
          match: { on: ['mention'], channels: ['CSUPPORT'], keywords: [], regex: null, fromUsers: [] },
          reply: { mode: 'draft', autoChannels: [], replyNode: null },
          limits: { debounceSec: 1 }
        }),
      wf.id
    )
    ok('Slack trigger created (draft mode)', !!trig.id, trig.sentence)
    const runsBefore = (await page.evaluate(() => window.hive.runs.list())).length
    const parentTs = await fake((f, bot) => f.post('CSUPPORT', { user: 'UDANA', text: `<@${bot}> what does HTTP 418 mean?` }), BOT)
    const draft = await waitFor(async () => {
      const d = await page.evaluate(() => window.hive.slack.drafts({ status: ['pending'] }))
      return d.find((x) => x.channelId === 'CSUPPORT') || null
    }, 4 * 60_000, 2000)
    ok('mention -> run -> draft (via slack_draft_reply tool)', !!draft, draft ? `“${draft.text.slice(0, 80)}” · thread ${draft.threadTs}` : 'no draft in 4 min')
    const runs1 = await page.evaluate(() => window.hive.runs.list())
    const slackRun = runs1.find((r) => r.trigger === 'slack')
    ok('run was started by the Slack trigger', !!slackRun, slackRun ? `${slackRun.title} · ${slackRun.status}` : `${runs1.length - runsBefore} new runs`)
    const asks = await page.evaluate(() => window.hive.asks.list())
    ok('draft is a Needs-you ask', asks.some((a) => a.kind === 'slack_reply' && draft && a.slackDraftId === draft.id))
    if (draft) {
      ok('draft is in the triggering thread', draft.threadTs === parentTs, `${draft.threadTs} vs ${parentTs}`)
      await nav('Agents')
      await sleep(800)
      await page.screenshot({ path: path.join(SHOTS, '03-hub-draft-card.png') })
      const card = page.locator('.ask, [class*="draft"]', { hasText: /Send/ }).filter({ has: page.locator('textarea') }).first()
      const ta = card.locator('textarea').first()
      const edited = `${draft.text} (edited in Hive)`
      if (await ta.count()) await ta.fill(edited)
      await card.locator('button', { hasText: /^Send/ }).first().click()
      const sent = await waitFor(async () => {
        const p = await posts()
        return p.find((b) => b.channel === 'CSUPPORT' && b.thread_ts === parentTs) || null
      }, 30000)
      ok('Send -> fake Slack got chat.postMessage in-thread', !!sent, sent ? `“${String(sent.text).slice(0, 80)}”` : 'no post')
      ok('edit carried to Slack', !!sent && String(sent.text).includes('(edited in Hive)'))
      await sleep(1500)
      await page.screenshot({ path: path.join(SHOTS, '04-hub-after-send.png') })
    }
    // loop guard: the echoed bot message (and a direct bot post) never fires the trigger
    await waitFor(async () => {
      const r = await page.evaluate((id) => window.hive.runs.get({ id }), slackRun ? slackRun.id : '')
      return ['passed', 'failed', 'canceled'].includes(r.run.status)
    }, 60000).catch(() => undefined)
    await fake((f, bot) => f.post('CSUPPORT', { user: bot, text: `<@${bot}> echo test from the bot`, bot_id: f.bot.botId, thread_ts: undefined }), BOT)
    await sleep(6000)
    const evs = await page.evaluate((id) => window.hive.slackTriggers.events({ triggerId: id }), trig.id)
    const fired = evs.filter((e) => e.kind === 'fired').length
    const slackRuns = (await page.evaluate(() => window.hive.runs.list())).filter((r) => r.trigger === 'slack').length
    ok("bot's own messages do not retrigger", fired === 1 && slackRuns === 1, `fired=${fired} slackRuns=${slackRuns} events=${evs.map((e) => e.kind).join(',')}`)
    await page.evaluate((id) => window.hive.slackTriggers.setEnabled({ id, enabled: false }), trig.id)

    // ---- auto mode: posts only in the allow-listed channel; elsewhere it becomes a draft
    await page.evaluate(() => window.hive.slack.join({ channelId: 'CRANDOM' }))
    const wf2 = await page.evaluate(
      ({ pid }) =>
        window.hive.workflows.create({
          name: 'Auto answer',
          description: '',
          inputs: [],
          nodes: [{ id: 'reply', type: 'agent', label: 'Reply', after: [], cwd: null, timeoutMin: 5, profileId: pid, prompt: 'Reply to this Slack message in one short sentence. Output only the reply text, do not use any tools.\n\n{{trigger.text}}' }]
        }),
      { pid: prof.id }
    )
    const trig2 = await page.evaluate(
      (wid) =>
        window.hive.slackTriggers.create({
          name: 'Auto mentions',
          workflowId: wid,
          match: { on: ['mention'], channels: [], keywords: [], regex: null, fromUsers: [] },
          reply: { mode: 'auto', autoChannels: ['CSUPPORT'] },
          limits: { debounceSec: 1 }
        }),
      wf2.id
    )
    ok('auto trigger saved with replyNode defaulted (PO-S10)', trig2.reply.replyNode === 'reply', trig2.sentence)
    const postsBefore = (await posts()).length
    const autoTs = await fake((f, bot) => f.post('CSUPPORT', { user: 'USAM', text: `<@${bot}> is it Friday yet?` }), BOT)
    const randTs = await fake((f, bot) => f.post('CRANDOM', { user: 'UDANA', text: `<@${bot}> say hi to the team` }), BOT)
    const autoPost = await waitFor(async () => (await posts()).slice(postsBefore).find((b) => b.channel === 'CSUPPORT' && b.thread_ts === autoTs) || null, 4 * 60_000, 2000)
    ok('auto mode posts in the allow-listed channel without a card', !!autoPost, autoPost ? `“${String(autoPost.text).slice(0, 80)}”` : 'no auto post')
    const randDraft = await waitFor(async () => {
      const d = await page.evaluate(() => window.hive.slack.drafts({ status: ['pending'] }))
      return d.find((x) => x.channelId === 'CRANDOM') || null
    }, 4 * 60_000, 2000)
    const randPosted = (await posts()).some((b) => b.channel === 'CRANDOM')
    ok('auto mode outside the allow-list -> draft, nothing posted', !!randDraft && !randPosted, randDraft ? `reason=${randDraft.reason} · ${randDraft.channelName}` : 'no draft')
    await nav('Agents')
    await sleep(800)
    const hubText = await page.evaluate(() => document.querySelector('.main')?.innerText || '')
    ok('draft card titled "Reply in #random"', /Reply in #random/.test(hubText) && !/random \(DM\)/.test(hubText))
    // (the no-listener check runs outside Playwright, whose --inspect/--remote-debugging ports would show up here)
    void randTs
    await page.evaluate((id) => window.hive.slackTriggers.setEnabled({ id, enabled: false }), trig2.id)

    // ---- S5: notify node -> Slack DM to the configured alert user; iMessage gone from the UI
    await page.evaluate(() => window.hive.settings.update({ slackAlertUserId: 'UDANA' }))
    const wf3 = await page.evaluate(() =>
      window.hive.workflows.create({
        name: 'Alert me',
        description: '',
        inputs: [],
        nodes: [{ id: 'ping', type: 'notify', label: 'Ping', after: [], cwd: null, timeoutMin: 1, title: 'Hive e2e', message: 'Nightly checks are green', slack: { kind: 'me' } }]
      })
    )
    const nBefore = (await posts()).length
    const r3 = await page.evaluate((id) => window.hive.runs.start({ target: { kind: 'workflow', workflowId: id, inputs: {} } }), wf3.id)
    const dm = await waitFor(async () => (await posts()).slice(nBefore).find((b) => /Nightly checks are green/.test(JSON.stringify(b))) || null, 30000)
    const dmChan = dm ? await fake((f, c) => { const ch = f.channels.get(c); return ch ? ch.kind : (String(c).startsWith('D') ? 'dm' : 'channel') }, dm.channel) : null
    ok('notify node sends a Slack DM', !!dm && (dmChan === 'dm' || String(dm.channel).startsWith('D')), dm ? `channel ${dm.channel} (${dmChan})` : `run ${r3.id}: no DM`)
    await page.evaluate(() => document.querySelector('.sidebar__settings')?.click())
    await sleep(400)
    let anyIMessage = false
    for (const s of ['General', 'Agents', 'Connections', 'Notifications', 'Data', 'About']) {
      await page.locator('.settings__nav >> text=' + s).first().click().catch(() => page.locator(`text=${s}`).first().click().catch(() => undefined))
      await sleep(300)
      if (/imessage/i.test(await page.evaluate(() => document.body.innerText))) anyIMessage = true
      if (s === 'Notifications') await page.screenshot({ path: path.join(SHOTS, '05-settings-notifications.png') })
    }
    ok('iMessage gone from Settings', !anyIMessage)
    const apiKeys = await page.evaluate(() => Object.keys(window.hive.notify || {}))
    ok('notify:testIMessage gone from the API', !apiKeys.includes('testIMessage'), apiKeys.join(','))

    // ---- §9.5: Claude in Hive authors a Slack-triggered workflow; one approval click creates workflow + trigger
    if (!SKIP_AUTHORING) {
      const repo = path.join(SCRATCH, 'author-repo')
      fs.mkdirSync(repo)
      fs.writeFileSync(path.join(repo, 'README.md'), '# scratch\n')
      const [r] = await page.evaluate((p) => window.hive.repos.add({ paths: [p] }), repo)
      const s = await page.evaluate(({ repoId, pid }) => window.hive.sessions.create({ repoId, profileId: pid, cols: 140, rows: 40 }), { repoId: r.id, pid: prof.id })
      await page.evaluate(() => {
        window.__pty = ''
        window.hive.on('pty:data', (p) => (window.__pty += p.data))
      })
      await waitFor(() => page.evaluate(() => window.__pty.length > 200), 60000, 1000)
      await sleep(4000)
      const paragraph =
        'Make me a Hive workflow with a Slack trigger: whenever someone @mentions the bot in #support, a Claude agent reads the thread and drafts a short helpful reply for me to approve (reply mode draft). Use the hive tools to create it.'
      await page.evaluate(({ id, text }) => window.hive.send('sessions:write', { id, data: text, typed: true }), { id: s.id, text: paragraph })
      await sleep(800)
      await page.evaluate((id) => window.hive.send('sessions:write', { id, data: '\r', typed: true }), s.id)
      const pending = await waitFor(async () => {
        const l = await page.evaluate(() => window.hive.author.list())
        return l.length ? l : null
      }, 6 * 60_000, 3000)
      ok('Claude in Hive drafted a workflow', !!pending, pending ? pending[0].workflowName : 'no draft in 6 min')
      if (pending) {
        await sleep(3000)
        const all = await page.evaluate(() => window.hive.author.list())
        const detail = await page.evaluate((id) => window.hive.author.get({ id }), all[all.length - 1].id)
        ok('the card carries the Slack trigger and its reply mode', !!detail.flags.slackTrigger, detail.flags.slackTrigger ? `${detail.flags.slackTrigger.sentence} · ${detail.flags.slackTrigger.replyMode}` : 'no slackTrigger flag')
        await nav('Agents')
        await sleep(1000)
        // Match the trigger row itself (data attributes on ApprovalCard), never free text: a card summary that merely
        // says "reply" must not pass this check when the card carries no Slack trigger.
        const trigRow = await page.evaluate((name) => {
          const card = [...document.querySelectorAll('.approval')].find((e) => e.innerText.includes(name))
          const row = card && card.querySelector('[data-slack-trigger]')
          const mode = row && row.querySelector('[data-slack-reply-row]')
          return row ? { replyMode: row.getAttribute('data-reply-mode'), text: mode ? mode.innerText : '' } : null
        }, detail.workflowName)
        ok(
          'approval card shows the Slack trigger row with its reply mode',
          !!trigRow && !!trigRow.replyMode && /^Replies:/.test(trigRow.text) && (!detail.flags.slackTrigger || trigRow.replyMode === detail.flags.slackTrigger.replyMode),
          trigRow ? `${trigRow.replyMode} · ${trigRow.text}` : 'no [data-slack-trigger] row on the card'
        )
        await page.screenshot({ path: path.join(SHOTS, '06-hub-approval-slack-trigger.png') })
        const approval = page.locator('.approval', { hasText: detail.workflowName }).first()
        await approval.locator('.approval__actions button').first().click()
        const created = await waitFor(async () => {
          const wfs = await page.evaluate(() => window.hive.workflows.list())
          const w = wfs.find((x) => x.origin && x.origin.draftId === detail.draft?.id) || wfs.find((x) => x.origin && x.name === detail.workflowName)
          if (!w) return null
          const ts = await page.evaluate((wid) => window.hive.slackTriggers.list({ workflowId: wid }), w.id)
          return ts.length ? { w, ts } : null
        }, 20000)
        ok('one click saved the workflow and its Slack trigger', !!created, created ? `${created.w.name} · ${created.ts[0].sentence}` : '')
      }
      await page.evaluate((id) => window.hive.sessions.kill({ id }), s.id).catch(() => undefined)
    }

    // the dev fake must be impossible in a packaged / normal build: the marker is absent from out/main
    const outMain = path.join(APP, 'out', 'main')
    let leak = false
    if (fs.existsSync(outMain)) for (const f of fs.readdirSync(outMain, { recursive: true })) if (/\.js$/.test(f) && fs.readFileSync(path.join(outMain, f), 'utf8').includes('HIVE_FAKE_SLACK_MARKER')) leak = true
    ok('normal build has no fake Slack', fs.existsSync(outMain) && !leak)
  } catch (e) {
    ok('e2e', false, String(e && e.stack ? e.stack : e))
    if (page) await page.screenshot({ path: path.join(SHOTS, 'zz-error.png') }).catch(() => undefined)
  } finally {
    await app.close().catch(() => undefined)
    const n = cleanTrust()
    console.log(`cleaned ${n} ~/.claude.json trust entr${n === 1 ? 'y' : 'ies'}`)
  }
  const failed = results.filter((x) => !x.pass).length
  console.log(`\n${results.length - failed}/${results.length} passed · scratch ${SCRATCH} · shots ${SHOTS}`)
  process.exit(failed ? 1 : 0)
})()
