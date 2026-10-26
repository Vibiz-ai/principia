// End-to-end check of "start a company from this chat" (shared/chatCompany.ts) against a built app, throwaway data only.
// usage: electron-vite build --outDir <app>/out (with <app>/package.json {"main":"out/main/index.js"} and node_modules)
//        PW=<dir containing node_modules/playwright-core> SHOTS=<dir> node scripts/e2e-chat-company.cjs <app>
// Never touches ~/Library/Application Support/Hive (HIVE_USER_DATA is a temp dir). Spends real Claude usage: one
// interactive pane (a few turns) and the onboarding's brief read + plan.
const path = require('path')
const fs = require('fs')
const os = require('os')
const pwDir = process.env.PW ? path.join(process.env.PW, 'node_modules', 'playwright-core') : 'playwright-core'
const { _electron: electron } = require(pwDir)

const APP = process.argv[2] || path.resolve(__dirname, '..')
const SHOTS = process.env.SHOTS || fs.mkdtempSync(path.join(os.tmpdir(), 'nc-shots-'))
const SCRATCH = fs.mkdtempSync(path.join(process.env.SCRATCH_ROOT || os.tmpdir(), 'hive-e2e-newco-'))
const LAUNCH = process.env.NC_LAUNCH === '1'
const results = []
const ok = (name, pass, detail = '') => {
  results.push({ name, pass })
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const strip = (s) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07]*\x07/g, '')
async function waitFor(fn, timeoutMs, everyMs = 1500) {
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
  const userData = path.join(SCRATCH, 'userdata')
  const env = { ...process.env, HIVE_USER_DATA: userData, HIVE_NO_SCHEDULER: '1', HIVE_CLAUDE_DIRS: path.join(SCRATCH, 'claude-history') }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.NO_COLOR
  fs.mkdirSync(env.HIVE_CLAUDE_DIRS)
  const app = await electron.launch({ executablePath: path.join(APP, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'), args: [APP], env, cwd: APP })
  const shot = (name) => app.windows()[0].screenshot({ path: path.join(SHOTS, `nc-${name}.png`) })
  try {
    const page = await app.firstWindow()
    await page.setViewportSize({ width: 1400, height: 900 }).catch(() => undefined)
    await page.waitForFunction(() => !!window.hive, null, { timeout: 30000 })
    const info = await page.evaluate(() => window.hive.app.info())
    ok('throwaway userData', String(info.userDataDir || '').startsWith(SCRATCH), info.userDataDir)
    await page.evaluate(() => window.hive.settings.update({ onboardingDone: true }))
    await page.reload()
    await page.waitForSelector('.sidebar', { timeout: 30000 })
    const providers = await page.evaluate(() => window.hive.providers.list())
    if (!providers.find((p) => p.id === 'claude')?.available) throw new Error('claude is not installed')

    // a repo-less chat in Personal, like "Start a Chat"
    await page.evaluate(() => {
      window.__pty = ''
      window.hive.on('pty:data', (p) => (window.__pty += p.data))
    })
    await page.keyboard.press('Alt+Meta+KeyN')
    const s = await waitFor(async () => (await page.evaluate(() => window.hive.sessions.list())).find((x) => x.adapter === 'claude' && x.status === 'running'), 30000, 1000)
    if (!s) throw new Error('no chat session opened')
    await waitFor(() => page.evaluate(() => window.__pty.length > 200), 60000, 1000)
    await sleep(5000)
    const say = async (text) => {
      await page.evaluate(({ id, text }) => window.hive.send('sessions:write', { id, data: text, typed: true }), { id: s.id, text })
      await sleep(800)
      await page.evaluate((id) => window.hive.send('sessions:write', { id, data: '\r', typed: true }), s.id)
    }
    const mark = () => page.evaluate(() => window.__pty.length)
    const since = async (at) => strip(await page.evaluate((n) => window.__pty.slice(n), at))

    // 1. the founder mentions a new side project: the agent asks first, no card yet
    let at = await mark()
    await say('I want to start a new side project: Sunday Bakery, sourdough and pastries delivered to offices in Lisbon, ordered by Thursday for Friday mornings. I want my first 20 office customers and weekly Instagram posts.')
    const asked = await waitFor(async () => /Principiacompany/i.test((await since(at)).replace(/\s+/g, "")), 4 * 60_000, 3000)
    ok('the agent asks before proposing', !!asked)
    const early = await page.evaluate(() => window.hive.chatCompany.list())
    ok('no card before the founder agrees', early.length === 0, `${early.length}`)
    await sleep(3000)
    await shot('01-chat-asks')

    // 2. yes → exactly one card
    at = await mark()
    await say('Yes, set it up as a new Principia company.')
    const cards = await waitFor(async () => {
      const l = await page.evaluate(() => window.hive.chatCompany.list())
      return l.length ? l : null
    }, 4 * 60_000, 2000)
    ok('a confirmation card appears after the yes', !!cards, cards ? `${cards[0].name} · ${cards[0].brief.slice(0, 80)}…` : strip(await since(at)).slice(-1500))
    if (!cards) throw new Error('no card')
    const card = await page.waitForSelector('.chat-co', { timeout: 15000 }).catch(() => null)
    ok('the card renders', !!card)
    await sleep(800)
    await shot('02-card')
    // pick the ring emblem, then Set up
    await page.click('.chat-co__logo[title="Ring emblem"]').catch(() => undefined)
    await sleep(300)
    await shot('03-card-ring')
    await page.click('.sheet__footer .btn--primary')

    // 3. onboarding "From a prompt", brief read, Plan
    const draftAt = (step) =>
      page.evaluate((st) => {
        const d = JSON.parse(localStorage.getItem('principia.onboarding.v1') || 'null')
        return d && (!st || d.step === st) ? d : null
      }, step)
    const opened = await waitFor(() => draftAt(null), 20000, 500)
    ok('the onboarding opens "From a prompt" with the chat brief', !!opened && opened.start === 'prompt' && /bakery/i.test(opened.brief || ''), opened ? `${opened.step} · ${(opened.brief || '').slice(0, 60)}` : '')
    await sleep(700)
    await shot('04-onboarding-brief')
    const plan = await waitFor(() => draftAt('plan'), 4 * 60_000, 2000)
    ok('the brief is read and the plan step is reached', !!plan, plan ? plan.answers.name : '')
    // wait for the tailored plan if Claude is making one
    await waitFor(async () => (await draftAt('plan'))?.plan?.source === 'agent', 4 * 60_000, 3000)
    await sleep(1500)
    await shot('05-onboarding-plan')

    // 4. the chat got its answer
    const told = await waitFor(async () => /Openedonboarding|onboarding(is)?open|(setup|onboarding)isopen|isopeninPrincipia/i.test((await since(at)).replace(/\s+/g, "")), 90_000, 2000)
    ok('the chat is told the onboarding opened', !!told)
    const decided = await page.evaluate(() => window.hive.chatCompany.list())
    ok('the card is closed', decided.length === 0)

    // 5. optionally launch it: the emblem lands on the coin
    if (LAUNCH && plan) {
      await page.click('.ob-foot .btn--primary')
      const ready = await waitFor(() => draftAt('ready'), 5 * 60_000, 3000)
      ok('launch done', !!ready)
      await sleep(1500)
      await shot('06-ready')
      const companies = await page.evaluate(() => window.hive.company.list())
      const co = companies.find((c) => /sunday/i.test(c.name))
      const logos = await page.evaluate(() => window.hive.company.logos())
      const logo = co && logos.find((l) => l.companyId === co.id)
      ok('the emblem is the company logo', !!logo && logo.origin === 'Generated emblem', logo ? `${logo.source} · ${logo.origin}` : 'none')
    }

    // 6. the pane after it all (close the flow first)
    await page.keyboard.press('Escape').catch(() => undefined)
    await sleep(1200)
    await shot('07-chat-after')
  } catch (e) {
    ok('no exception', false, String(e && e.stack ? e.stack : e))
  } finally {
    // a running pane makes Quit ask first: close, else stop the throwaway app
    await Promise.race([app.close().catch(() => undefined), sleep(8000)])
    try { app.process().kill() } catch {}
    const failed = results.filter((r) => !r.pass).length
    console.log(`\n${results.length - failed}/${results.length} passed · shots in ${SHOTS} · data in ${SCRATCH}`)
    process.exit(failed ? 1 : 0)
  }
})()
