// Real end-to-end smoke of Hive via Playwright's Electron driver.
// usage: npm i --no-save playwright && npm run build && node scripts/e2e-smoke.cjs "$PWD"   (or: node scripts/e2e-smoke.cjs x release/mac-arm64/Hive.app/Contents/MacOS/Hive)
// Spends a few cents of Claude usage (haiku). Uses a throwaway HIVE_USER_DATA.
const { _electron: electron } = require('playwright')
const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')

const SCRATCH = fs.mkdtempSync(path.join(require('os').tmpdir(), 'hive-e2e-'))
const APP = process.argv[2]
const EXE = process.argv[3]
const results = []
const ok = (name, pass, detail = '') => {
  results.push({ name, pass, detail })
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

;(async () => {
  const userData = path.join(SCRATCH, 'userdata-' + Date.now())
  const repo = path.join(SCRATCH, 'demo-repo')
  fs.rmSync(repo, { recursive: true, force: true })
  fs.mkdirSync(repo, { recursive: true })
  fs.writeFileSync(path.join(repo, 'README.md'), '# demo\n')
  execSync('git init -q && git add -A && git -c user.email=a@b -c user.name=t commit -qm init', { cwd: repo })

  const env = { ...process.env, HIVE_USER_DATA: userData }
  delete env.ELECTRON_RUN_AS_NODE; if (process.env.MINIMAL_PATH) env.PATH = '/usr/bin:/bin:/usr/sbin:/sbin'
  const app = await electron.launch(EXE ? { executablePath: EXE, args: [], env } : { executablePath: path.join(APP, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'), args: [APP], env, cwd: APP })
  const logs = []
  app.process().stdout?.on('data', (d) => logs.push(String(d)))
  app.process().stderr?.on('data', (d) => logs.push(String(d)))
  try {
    const page = await app.firstWindow()
    await page.waitForSelector('.sidebar', { timeout: 30000 })
    const info = await page.evaluate(() => window.hive.app.info())
    ok('window opens + bridge works', typeof info === 'object', `userData=${info.userData ?? ''}`)
    ok('renderer has no node', (await page.evaluate(() => typeof require)) === 'undefined')
    ok('renderer is file:// (no server)', page.url().startsWith('file://'), page.url())
    await page.screenshot({ path: path.join(SCRATCH, '01-home.png') })

    // collect events
    await page.evaluate(() => {
      window.__ev = []
      for (const n of ['run:updated', 'run:step', 'run:output', 'artifact:added', 'schedule:fired', 'pty:data'])
        window.hive.on(n, (p) => window.__ev.push({ n, p: n === 'pty:data' ? { sessionId: p.sessionId, len: p.data.length } : p }))
    })

    // 1. add repo
    const added = await page.evaluate((p) => window.hive.repos.add({ paths: [p] }), repo)
    ok('add repo', added.length === 1, added[0]?.name)
    const repoRow = page.locator('.sidebar__repos .side-row', { hasText: 'demo-repo' }).first()
    await repoRow.waitFor({ timeout: 10000 })
    ok('repo shows in sidebar', true)

    // 2. claude session pane: click repo row (starts a session)
    await repoRow.click()
    await page.waitForSelector('.xterm', { timeout: 20000 })
    const got = await waitFor(
      () => page.evaluate(() => window.__ev.filter((e) => e.n === 'pty:data').reduce((a, e) => a + e.p.len, 0)),
      20000
    )
    await sleep(3000)
    await page.screenshot({ path: path.join(SCRATCH, '02-session.png') })
    const sessions = await page.evaluate(() => window.hive.sessions.list({ status: 'running' }))
    ok('claude session pane with live terminal', sessions.length >= 1 && got > 0, `bytes=${got} adapter=${sessions[0]?.adapter}`)
    const termText = await page.evaluate(() => document.querySelector('.xterm-rows')?.textContent?.slice(0, 200) ?? '')
    console.log('terminal text:', JSON.stringify(termText))
    for (const s of sessions) await page.evaluate((id) => window.hive.sessions.kill({ id }), s.id)

    // 3. secret
    const sec = await page.evaluate(() => window.hive.secrets.set({ name: 'HIVE_SMOKE_KEY', value: 'sk-smoke-1234567890abcdef' }))
    await page.evaluate(() => document.querySelectorAll('.side-row--nav').forEach((el) => /Keys/.test(el.textContent) && el.click()))
    await page.waitForTimeout(800)
    const keysHtml = await page.evaluate(() => document.querySelector('.main')?.innerText ?? '')
    await page.screenshot({ path: path.join(SCRATCH, '03-keys.png') })
    ok('secret stored + masked in UI', keysHtml.includes('HIVE_SMOKE_KEY') && !keysHtml.includes('sk-smoke-1234567890abcdef'), JSON.stringify(sec))

    // 4. workflow: 2 claude nodes + secret-env check via shell node
    const profiles = await page.evaluate(() => window.hive.profiles.list())
    const prof = await page.evaluate(() =>
      window.hive.profiles.create({ name: 'Claude smoke', adapter: 'claude', model: 'haiku', extraArgs: ['--max-turns', '3'], permissionMode: 'bypass' })
    )
    ok('profiles seeded + custom profile', profiles.some((p) => p.adapter === 'claude'), profiles.map((p) => p.name).join(','))
    const wf = await page.evaluate(
      ({ pid }) =>
        window.hive.workflows.create({
          name: 'Smoke two-step',
          description: 'smoke',
          inputs: [],
          nodes: [
            { id: 'ping', type: 'agent', label: 'Ping', after: [], cwd: null, timeoutMin: 5, profileId: pid, prompt: 'Reply with exactly the single word PING and nothing else. Do not use tools.' },
            {
              id: 'pong', type: 'agent', label: 'Pong', after: ['ping'], cwd: null, timeoutMin: 5, profileId: pid,
              prompt: 'The previous agent said: {{ping.output}}\nUse the Write tool to create the file {{ARTIFACTS_DIR}}/pong.md containing "# PONG" and the previous agent\'s word. Then reply DONE.'
            },
            { id: 'env', type: 'shell', label: 'Env', after: ['pong'], cwd: null, timeoutMin: 1, command: 'echo "keylen=${#HIVE_SMOKE_KEY}"; echo "leak=$HIVE_SMOKE_KEY"; echo "art=$ARTIFACTS_DIR"' }
          ]
        }),
      { pid: prof.id }
    )
    ok('workflow saved', !!wf.id)
    const run = await page.evaluate((id) => window.hive.runs.start({ target: { kind: 'workflow', workflowId: id, inputs: {} } }), wf.id)
    await page.evaluate((id) => {
      document.querySelectorAll('.side-row--nav').forEach((el) => /Canvas/.test(el.textContent) && el.click())
    }, run.id)
    const final = await waitFor(async () => {
      const d = await page.evaluate((id) => window.hive.runs.get({ id }), run.id)
      return ['passed', 'failed', 'canceled'].includes(d.run.status) ? d : null
    }, 300000, 3000)
    await page.screenshot({ path: path.join(SCRATCH, '04-canvas.png') })
    const ev = await page.evaluate(() => window.__ev.filter((e) => e.n !== 'pty:data'))
    const counts = ev.reduce((a, e) => ((a[e.n] = (a[e.n] || 0) + 1), a), {})
    ok('workflow run passed', final?.run.status === 'passed', `status=${final?.run.status} reason=${final?.run.reason ?? ''}`)
    ok('run events streamed', (counts['run:step'] || 0) > 0 && (counts['run:updated'] || 0) > 0, JSON.stringify(counts))
    if (final) {
      for (const s of final.steps) {
        const lg = await page.evaluate(({ r, s }) => window.hive.runs.stepLog({ runId: r, stepId: s }), { r: run.id, s: s.id })
        console.log(`step ${s.nodeId} ${s.status} output=${JSON.stringify((s.output ?? '').slice(0, 120))} logTail=${JSON.stringify(lg.text.slice(-200))}`)
        if (s.nodeId === 'env') {
          const txt = (s.output ?? '') + lg.text
          ok('secret injected as env', /keylen=25/.test(txt), '')
          ok('secret redacted in output', !txt.includes('sk-smoke-1234567890abcdef'), '')
        }
      }
      const ping = final.steps.find((s) => s.nodeId === 'ping')
      ok('agent output captured', /PING/.test(ping?.output ?? ''), ping?.output?.slice(0, 40))
    }
    const arts = await waitFor(async () => {
      const a = await page.evaluate((id) => window.hive.artifacts.list({ runId: id }), run.id)
      return a.length ? a : null
    }, 15000)
    ok('artifact written to ARTIFACTS_DIR + indexed', !!arts?.some((a) => /pong\.md$/.test(a.path)), arts?.map((a) => a.path).join(','))
    await page.evaluate(() => document.querySelectorAll('.side-row--nav').forEach((el) => /Artifacts/.test(el.textContent) && el.click()))
    await page.waitForTimeout(1500)
    await page.screenshot({ path: path.join(SCRATCH, '05-artifacts.png') })

    // 5. schedule ~70 s out, then hide window
    const at = new Date(Date.now() + 70_000).toISOString()
    const sch = await page.evaluate(
      ({ pid, at }) =>
        window.hive.schedules.create({
          name: 'Smoke one-off',
          target: { kind: 'prompt', profileId: pid, repoId: null, prompt: 'Reply with exactly OK.' },
          when: { kind: 'at', at },
          preset: { kind: 'once', at }
        }),
      { pid: prof.id, at }
    )
    ok('schedule created', !!sch.id, sch.sentence)
    await page.evaluate(() => window.hive.app.hideWindow())
    await sleep(1000)
    const visible = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => w.isVisible()))
    ok('window hidden (app alive in tray)', visible.every((v) => !v), JSON.stringify(visible))
    const fired = await waitFor(async () => {
      const runs = await page.evaluate((id) => window.hive.runs.list({ scheduleId: id }), sch.id)
      return runs.find((r) => ['passed', 'failed'].includes(r.status)) ?? null
    }, 180000, 5000)
    const stillHidden = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every((w) => !w.isVisible()))
    ok('schedule fired while window hidden', !!fired && stillHidden, `run=${fired?.status} trigger=${fired?.trigger} at=${fired?.startedAt} slot=${at}`)
    const sEvents = await page.evaluate((id) => window.hive.schedules.events({ scheduleId: id }), sch.id)
    console.log('schedule events', JSON.stringify(sEvents.map((e) => e.kind)))
    const trayOk = await app.evaluate(({ Tray }) => typeof Tray)
    console.log('tray type', trayOk)
  } catch (e) {
    ok('unexpected error', false, String(e && e.stack))
  } finally {
    fs.writeFileSync(path.join(SCRATCH, 'app-stdout.log'), logs.join(''))
    try {
      await app.evaluate(({ app }) => app.exit(0))
    } catch {}
    await app.close().catch(() => {})
    fs.writeFileSync(path.join(SCRATCH, 'results.json'), JSON.stringify(results, null, 2))
    const failed = results.filter((r) => !r.pass)
    console.log(`\n${results.length - failed.length}/${results.length} passed`)
    console.log('userData:', userData)
    process.exit(failed.length ? 1 : 0)
  }
})()
