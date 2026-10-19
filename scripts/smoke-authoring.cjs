// Integrator smoke for AUTHORING.md (A1-A3) against the built app, throwaway data only.
// usage: npm run build && PW=<dir containing node_modules/playwright-core> node scripts/smoke-authoring.cjs "$PWD"
// Never touches /Applications/Hive.app or ~/Library/Application Support/Hive (HIVE_USER_DATA is a temp dir).
// Spends real Claude usage: one interactive haiku pane + one headless summarize step.
// Phase 1 uses a fixture Claude history (HIVE_CLAUDE_DIRS). Phase 2 lists the real ~/.claude/projects read-only and
// checks via mtimes that nothing Hive read was written. Trust entries Hive adds to ~/.claude.json for the scratch dirs
// are removed at the end (file mode kept 600).
const path = require('path')
const fs = require('fs')
const os = require('os')
const { execSync } = require('child_process')
const pwDir = process.env.PW ? path.join(process.env.PW, 'node_modules', 'playwright-core') : 'playwright-core'
const { _electron: electron } = require(pwDir)

const APP = process.argv[2] || path.resolve(__dirname, '..')
const SCRATCH = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hive-smoke-author-')))
const SHOTS = path.join(SCRATCH, 'shots')
fs.mkdirSync(SHOTS)
const results = []
const ok = (name, pass, detail = '') => {
  results.push({ name, pass })
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
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
const g = (cwd, cmd) => execSync(`git -c user.email=smoke@hive.local -c user.name=smoke ${cmd}`, { cwd, stdio: 'pipe' }).toString().trim()

function launch(env) {
  const e = { ...process.env, HIVE_NO_SCHEDULER: '1', ...env }
  delete e.ELECTRON_RUN_AS_NODE
  return electron.launch({ executablePath: path.join(APP, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'), args: [APP], env: e, cwd: APP })
}
async function runToEnd(page, runId, ms) {
  return waitFor(async () => {
    const d = await page.evaluate((id) => window.hive.runs.get({ id }), runId)
    return ['passed', 'failed', 'canceled'].includes(d.run.status) ? d : null
  }, ms, 1000)
}
async function startWf(page, draft, inputs = {}) {
  const wf = await page.evaluate((d) => window.hive.workflows.create(d), draft)
  const run = await page.evaluate(({ id, inputs }) => window.hive.runs.start({ target: { kind: 'workflow', workflowId: id, inputs } }), { id: wf.id, inputs })
  return { wf, run }
}
const node = (o) => ({ after: [], cwd: null, timeoutMin: 5, memory: 'off', ...o })

// ---------- ~/.claude.json trust cleanup ----------
const claudeJson = path.join(process.env.CLAUDE_CONFIG_DIR || os.homedir(), '.claude.json')
function cleanTrust() {
  try {
    const raw = fs.readFileSync(claudeJson, 'utf8')
    const cfg = JSON.parse(raw)
    const roots = [SCRATCH, SCRATCH.replace(/^\/private/, '')]
    const removed = Object.keys(cfg.projects || {}).filter((k) => roots.some((r) => k === r || k.startsWith(r + '/')))
    if (removed.length) {
      for (const k of removed) delete cfg.projects[k]
      const tmp = `${claudeJson}.hive-smoke-${process.pid}`
      fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 })
      fs.renameSync(tmp, claudeJson)
    }
    fs.chmodSync(claudeJson, 0o600)
    const mode = (fs.statSync(claudeJson).mode & 0o777).toString(8)
    ok('~/.claude.json temp trust entries removed, mode 600', mode === '600', `removed ${removed.length} · mode ${mode}`)
  } catch (e) {
    ok('~/.claude.json cleanup', false, String(e))
  }
}

;(async () => {
  // ---------- scratch repo with a local bare remote ----------
  const remote = path.join(SCRATCH, 'remote.git')
  const repo = path.join(SCRATCH, 'scratch-repo')
  g(SCRATCH, `init -q --bare -b main ${remote}`)
  fs.mkdirSync(repo)
  g(repo, 'init -q -b main')
  fs.writeFileSync(path.join(repo, 'app.js'), 'console.log("hi")\n')
  fs.writeFileSync(path.join(repo, 'README.md'), '# scratch\nA tiny repo for the Hive authoring smoke.\n')
  g(repo, 'add -A')
  g(repo, 'commit -qm init')
  g(repo, `remote add origin ${remote}`)
  g(repo, 'push -q -u origin main')
  g(repo, 'remote set-head origin main')
  const headBefore = g(repo, 'rev-parse HEAD')

  // ---------- fixture Claude history ----------
  const fixtures = path.join(SCRATCH, 'claude-history')
  const proj = path.join(fixtures, '-tmp-fixture-proj')
  fs.mkdirSync(proj, { recursive: true })
  const line = (o) => JSON.stringify(o) + '\n'
  const now = new Date().toISOString()
  const fx = []
  for (let i = 0; i < 3; i++) {
    const id = `0000000${i}-aaaa-4bbb-8ccc-dddddddddddd`
    let s = line({ type: 'user', cwd: repo, gitBranch: 'main', version: '2.1.289', entrypoint: 'cli', timestamp: now, promptSource: 'typed', message: { role: 'user', content: `Fixture prompt number ${i}: refactor the parser` } })
    s += line({ type: 'assistant', timestamp: now, message: { model: 'claude-haiku-4-5', content: [{ type: 'text', text: 'Done.' }] } })
    s += line({ type: 'user', timestamp: now, promptSource: 'typed', message: { content: 'thanks' } })
    const f = path.join(proj, `${id}.jsonl`)
    fs.writeFileSync(f, s)
    if (i === 0) {
      const sd = path.join(proj, id, 'subagents')
      fs.mkdirSync(sd, { recursive: true })
      fs.writeFileSync(path.join(sd, 'agent-1.jsonl'), line({ type: 'user', message: { content: 'x' } }))
      fs.writeFileSync(path.join(sd, 'agent-1.meta.json'), JSON.stringify({ agentType: 'Explore', description: 'look around' }))
    }
    fx.push(f)
  }
  const fxStat = () => fx.map((f) => `${fs.statSync(f).mtimeMs}:${fs.readFileSync(f, 'utf8').length}`).join('|')
  const fxBefore = fxStat()

  const userData = path.join(SCRATCH, 'userdata')
  let app = await launch({ HIVE_USER_DATA: userData, HIVE_CLAUDE_DIRS: fixtures })
  try {
    const page = await app.firstWindow()
    await page.waitForFunction(() => !!window.hive, null, { timeout: 30000 })
    await page.waitForSelector('.sidebar', { timeout: 30000 })
    const info = await page.evaluate(() => window.hive.app.info())
    ok('throwaway userData', String(info.userDataDir || '').startsWith(SCRATCH), info.userDataDir)
    const [r] = await page.evaluate((p) => window.hive.repos.add({ paths: [p] }), repo)
    const providers = await page.evaluate(() => window.hive.providers.list())
    if (!providers.find((p) => p.id === 'claude')?.available) throw new Error('claude is not installed')
    const haiku = await page.evaluate(() => window.hive.profiles.create({ name: 'Claude Haiku', adapter: 'claude', model: 'haiku' }))

    // ---------- A1: describe a workflow to Claude in a Hive pane -> card -> approve -> saved with provenance -> run ----------
    const s = await page.evaluate(({ repoId, profileId }) => window.hive.sessions.create({ profileId, repoId, cols: 140, rows: 40 }), { repoId: r.id, profileId: haiku.id })
    await page.evaluate(() => {
      window.__pty = ''
      window.hive.on('pty:data', (p) => (window.__pty += p.data))
    })
    await waitFor(() => page.evaluate(() => window.__pty.length > 200), 60000, 1000)
    await sleep(4000)
    const ask = 'create a 2-step workflow that lists files then summarizes them'
    await page.evaluate(({ id, text }) => window.hive.send('sessions:write', { id, data: text, typed: true }), { id: s.id, text: ask })
    await sleep(800)
    await page.evaluate((id) => window.hive.send('sessions:write', { id, data: '\r', typed: true }), s.id)
    const pending = await waitFor(async () => {
      const l = await page.evaluate(() => window.hive.author.list())
      return l.length ? l : null
    }, 8 * 60_000, 3000)
    ok('Claude in a Hive pane proposes the workflow (approval card)', !!pending, pending ? `${pending[0].workflowName} · ${pending[0].ownerLabel}` : 'no draft in 8 min')
    if (!pending) {
      const tail = await page.evaluate(() => window.__pty.slice(-3000))
      console.log('--- pty tail ---\n' + tail.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, ''))
    }
    let savedWf = null
    if (pending) {
      const draft = pending[0]
      const detail = await page.evaluate((id) => window.hive.author.get({ id }), draft.id)
      ok('draft has 2 nodes', !!detail.draft && detail.draft.nodes.length === 2, detail.draft ? detail.draft.nodes.map((n) => `${n.id}:${n.type}`).join(', ') : '')
      const asks = await page.evaluate(() => window.hive.asks.list())
      ok('card is a Needs-you approval ask', asks.some((a) => a.kind === 'approval' && a.draftId === draft.id))
      // the card in the Agents hub: click its primary button like the user would
      await page.click('.sidebar >> text=Agents').catch(() => undefined)
      const card = await page.waitForSelector('.approval', { timeout: 15000 }).catch(() => null)
      ok('approval card renders in the Agents hub', !!card)
      await page.screenshot({ path: path.join(SHOTS, '01-approval-card.png') })
      if (card) {
        const btn = await page.waitForSelector('.approval .approval__actions button:not([disabled])', { timeout: 15000 }).catch(() => null)
        if (btn) await btn.click()
      }
      const decided = await waitFor(async () => {
        const l = await page.evaluate(() => window.hive.author.list({ status: ['approved', 'rejected', 'pending'] }))
        const d = l.find((x) => x.id === draft.id)
        return d && d.status !== 'pending' ? d : null
      }, 15000, 500)
      if (!decided) await page.evaluate((id) => window.hive.author.decide({ id, decision: 'approve' }), draft.id)
      ok('approve clicked on the card', !!decided && decided.status === 'approved', decided ? decided.status : 'fell back to IPC')
      const wfs = await page.evaluate(() => window.hive.workflows.list())
      savedWf = wfs.find((w) => w.origin && w.origin.draftId === draft.id) || null
      ok('workflow saved with provenance', !!savedWf, savedWf ? `${savedWf.name} · created by ${savedWf.origin.adapter} in ${savedWf.origin.ownerLabel}` : '')
      await page.click('.sidebar >> text=Workflows').catch(() => undefined)
      await sleep(1200)
      const originText = await page.$eval('.wf-origin', (e) => e.textContent).catch(() => '')
      ok('Workflows list shows "Created by Claude in …"', /Created by Claude/i.test(originText || ''), originText || '')
      await page.screenshot({ path: path.join(SHOTS, '02-workflows-provenance.png') })
      // Claude should get the approval back in its pane
      const heard = await waitFor(() => page.evaluate(() => /approved/i.test(window.__pty.slice(-20000))), 90_000, 2000)
      ok('Claude received the approval result', !!heard)
      if (!heard) console.log('--- pty tail ---\n' + (await page.evaluate(() => window.__pty.slice(-4000))).replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, ''))
    }
    await page.evaluate((id) => window.hive.sessions.kill({ id }), s.id).catch(() => undefined)
    if (savedWf) {
      const run = await page.evaluate(({ id, inputs }) => window.hive.runs.start({ target: { kind: 'workflow', workflowId: id, inputs } }), { id: savedWf.id, inputs: Object.fromEntries((savedWf.inputs || []).map((i) => [i.name, i.type === 'repo' ? r.id : i.default || ''])) })
      const d = await runToEnd(page, run.id, 8 * 60_000)
      ok('the authored workflow runs and passes', !!d && d.run.status === 'passed', d ? `${d.run.status} · ${d.steps.map((x) => `${x.nodeId}=${x.status}`).join(', ')}` : 'timeout')
    }

    // ---------- A2: stop-if ----------
    {
      const { run } = await startWf(page, {
        name: 'Stop if smoke', description: '', inputs: [],
        nodes: [
          node({ id: 'scan', type: 'shell', label: 'scan', command: 'echo "nothing changed"; echo "HIVE_STOP: no work today"' }),
          node({ id: 'after_scan', type: 'shell', label: 'should not run', after: ['scan'], command: 'echo ran' })
        ]
      })
      const d = await runToEnd(page, run.id, 60_000)
      ok('stop-if: run passed · nothing to do, downstream skipped', !!d && d.run.status === 'passed' && d.run.outcome === 'nothing_to_do' && !d.steps.some((x) => x.nodeId === 'after_scan' && x.status === 'passed'),
        d ? `${d.run.status}/${d.run.outcome} · ${d.run.reason} · steps ${d.steps.map((x) => `${x.nodeId}=${x.status}`).join(',')}` : 'timeout')
    }

    // ---------- A2: wait node (match after 3 tries) + timeout continue ----------
    {
      const counter = path.join(SCRATCH, 'wait-counter')
      const { run } = await startWf(page, {
        name: 'Wait smoke', description: '', inputs: [],
        nodes: [
          node({ id: 'poll', type: 'wait', label: 'poll', command: `n=$(cat '${counter}' 2>/dev/null || echo 0); n=$((n+1)); echo $n > '${counter}'; echo $n`, until: 'match', pattern: '^3$', intervalSec: 5, onTimeout: 'fail', timeoutMin: 2 }),
          node({ id: 'never', type: 'wait', label: 'gives up', after: ['poll'], command: 'exit 1', until: 'exit0', pattern: null, intervalSec: 20, onTimeout: 'continue', timeoutMin: 1 })
        ]
      })
      const d = await runToEnd(page, run.id, 4 * 60_000)
      const poll = d && d.steps.find((x) => x.nodeId === 'poll')
      ok('wait: re-runs until output matches, then timeout→continue passes', !!d && d.run.status === 'passed' && poll && /3/.test(poll.output || ''),
        d ? `${d.run.status} · tries=${fs.existsSync(counter) ? fs.readFileSync(counter, 'utf8').trim() : '?'} · ${d.steps.map((x) => `${x.nodeId}=${x.status}`).join(',')}` : 'timeout')
    }

    // ---------- A2: notify with no iMessage handle ----------
    {
      const st = await page.evaluate(() => window.hive.settings.get())
      ok('no iMessage handle configured', !st.imessageHandle)
      const { run } = await startWf(page, {
        name: 'Notify smoke', description: '', inputs: [],
        nodes: [
          node({ id: 'make', type: 'shell', label: 'make', command: 'echo 3 files' }),
          node({ id: 'tell', type: 'notify', label: 'tell me', title: 'Smoke', message: 'Result: {{make.output}}', imessage: true, timeoutMin: 1 })
        ]
      })
      const d = await runToEnd(page, run.id, 60_000)
      const t = d && d.steps.find((x) => x.nodeId === 'tell')
      ok('notify: passes, iMessage skipped with a clear note', !!d && d.run.status === 'passed' && !!t && /Result: 3 files/.test(t.output || '') && /No iMessage handle/i.test(t.output || ''), t ? JSON.stringify(t.output) : d ? d.run.status : 'timeout')
    }

    // ---------- A2: worktree per run (removed when clean, kept when dirty, cleanup button path) ----------
    {
      const wt = { repo: r.id, base: null }
      const { run } = await startWf(page, {
        name: 'Worktree clean', description: '', inputs: [], worktree: wt,
        nodes: [
          node({ id: 'where', type: 'shell', label: 'where', isolate: 'worktree', command: 'pwd; git rev-parse --abbrev-ref HEAD; ls' }),
          node({ id: 'again', type: 'shell', label: 'same tree', isolate: 'worktree', after: ['where'], command: 'echo "$HIVE_WORKTREE $HIVE_WORKTREE_BRANCH"' })
        ]
      })
      const d = await runToEnd(page, run.id, 120_000)
      const out = d ? d.steps.map((x) => x.output || '').join('\n') : ''
      const w = d && d.run.worktree
      ok('worktree: created off default branch under userData, shared by nodes', !!d && d.run.status === 'passed' && !!w && w.path.startsWith(userData) && out.includes(w.path) && /hive\/worktree-clean-/.test(out),
        w ? `${w.branch} · ${w.base} · ${w.status}` : d ? `${d.run.status} ${d.steps.map((x) => x.error).join(' ')}` : 'timeout')
      const after = w ? await waitFor(async () => {
        const l = await page.evaluate(() => window.hive.worktrees.list())
        const x = l.find((y) => y.id === w.id)
        return x && x.status !== 'active' && x.status !== 'creating' ? x : null
      }, 20000, 500) : null
      ok('worktree: clean run → removed + branch deleted', !!after && after.status === 'removed' && !fs.existsSync(w.path) && !g(repo, 'branch --list "hive/*"'), after ? after.status : 'no row')

      const { run: run2 } = await startWf(page, {
        name: 'Worktree dirty', description: '', inputs: [], worktree: wt,
        nodes: [node({ id: 'edit', type: 'shell', label: 'edit', isolate: 'worktree', command: 'echo change >> app.js && echo edited' })]
      })
      const d2 = await runToEnd(page, run2.id, 120_000)
      const w2 = d2 && d2.run.worktree
      const kept = w2 ? await waitFor(async () => {
        const l = await page.evaluate(() => window.hive.worktrees.list())
        const x = l.find((y) => y.id === w2.id)
        return x && x.status === 'kept' ? x : null
      }, 20000, 500) : null
      ok('worktree: uncommitted work → kept (dirty)', !!kept && kept.keptReason === 'dirty' && fs.existsSync(kept.path), kept ? `${kept.status}/${kept.keptReason}` : 'not kept')
      if (kept) {
        const removed = await page.evaluate((id) => window.hive.worktrees.remove({ id }), kept.id)
        ok('worktree: cleanup removes it', removed.status === 'removed' && !fs.existsSync(kept.path), removed.status)
      }
      ok("worktree: user's checkout untouched", g(repo, 'rev-parse HEAD') === headBefore && g(repo, 'status --porcelain') === '' && g(repo, 'rev-parse --abbrev-ref HEAD') === 'main')
      ok('worktree: remote unchanged', g(remote, 'rev-parse main') === headBefore)
    }

    // ---------- A3: Claude history (fixtures) ----------
    {
      const list = await waitFor(async () => {
        const res = await page.evaluate(() => window.hive.history.list({}))
        return res.items.length >= 3 && !res.indexing ? res : null
      }, 20000, 500)
      ok('history: lists fixture sessions', !!list, list ? list.items.map((x) => `${x.title} (${x.turns}t, ${x.subagents}sa)`).join('; ') : 'empty')
      if (list) {
        const t = await page.evaluate((id) => window.hive.history.get({ id }), list.items[0].id)
        ok('history: transcript preview', t.entries.length > 0, `${t.entries.length} entries`)
      }
      await page.click('.sidebar >> text=Home').catch(() => undefined)
      const rows = await page.waitForSelector('.hist-row', { timeout: 15000 }).catch(() => null)
      ok('history: Home "Recent Claude sessions outside Hive" renders', !!rows)
      await page.screenshot({ path: path.join(SHOTS, '03-home-history.png') })
      ok('history: fixture files unchanged (mtime + content)', fxStat() === fxBefore)
    }
  } catch (e) {
    ok('smoke phase 1', false, String(e && e.stack ? e.stack : e))
  } finally {
    await app.close().catch(() => undefined)
  }

  // ---------- Phase 2: real ~/.claude/projects, read-only ----------
  const realRoot = path.join(os.homedir(), '.claude', 'projects')
  if (fs.existsSync(realRoot)) {
    const cutoff = Date.now() - 10 * 60_000 // ignore files being written by live Claude sessions right now
    const snap = new Map()
    for (const d of fs.readdirSync(realRoot)) {
      const dir = path.join(realRoot, d)
      let names = []
      try { names = fs.readdirSync(dir) } catch { continue }
      for (const n of names) {
        if (!n.endsWith('.jsonl')) continue
        const f = path.join(dir, n)
        const st = fs.statSync(f)
        if (st.mtimeMs < cutoff) snap.set(f, `${st.mtimeMs}:${st.size}`)
      }
    }
    app = await launch({ HIVE_USER_DATA: path.join(SCRATCH, 'userdata-real-history') })
    try {
      const page = await app.firstWindow()
      await page.waitForFunction(() => !!window.hive, null, { timeout: 30000 })
      const t0 = Date.now()
      const res = await waitFor(async () => {
        const x = await page.evaluate(() => window.hive.history.list({ limit: 500 }))
        return !x.indexing ? x : null
      }, 120_000, 500)
      ok('history (real ~/.claude/projects): indexes', !!res, res ? `${res.total} sessions in ${Date.now() - t0} ms` : 'still indexing')
      const t1 = Date.now()
      const res2 = await page.evaluate(() => window.hive.history.list({ limit: 500 }))
      ok('history: warm list is fast', Date.now() - t1 < 1500, `${Date.now() - t1} ms · ${res2.total}`)
      if (res && res.items[0]) await page.evaluate((id) => window.hive.history.get({ id }), res.items[0].id)
      await page.click('.sidebar >> text=Home').catch(() => undefined)
      await sleep(1500)
      await page.screenshot({ path: path.join(SHOTS, '04-home-real-history.png') })
    } catch (e) {
      ok('smoke phase 2', false, String(e))
    } finally {
      await app.close().catch(() => undefined)
    }
    let changed = 0
    for (const [f, v] of snap) {
      try {
        const st = fs.statSync(f)
        if (`${st.mtimeMs}:${st.size}` !== v) {
          changed++
          console.log(`changed: ${f} ${v} -> ${st.mtimeMs}:${st.size}`)
        }
      } catch {
        changed++
        console.log(`vanished: ${f}`)
      }
    }
    ok('history: no writes to ~/.claude/projects (mtimes)', changed === 0, `${snap.size} files checked, ${changed} changed`)
  }

  cleanTrust()
  const failed = results.filter((x) => !x.pass).length
  console.log(`\n${results.length - failed}/${results.length} passed · scratch ${SCRATCH} · shots ${SHOTS}`)
  process.exit(failed ? 1 : 0)
})()
