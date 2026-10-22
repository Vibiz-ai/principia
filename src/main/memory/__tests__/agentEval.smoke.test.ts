// Opt-in real-CLI smoke eval (PASSPORT.md §14 P8.4): a real `claude -p` writes to the Northwind fixture vault through the
// real hivemem server (bundled from source, run on node) and the real main-side bridge, over 10 scripted tasks. It
// measures how agents use the Passport: the share of written lines with a resolved [[link]], the ghost rate of the links
// they write, and the duplicate-note rate (new notes that are near-misses of an existing title or alias).
//
// Skipped unless PRINCIPIA_AGENT_EVAL=1, HIVE_REAL_CLAUDE=1 (keeps the real $HOME, so the CLI is signed in; see
// src/test/isolateHome.ts) and `claude` is on PATH. It spends real model calls on the user's account.
//   HIVE_REAL_CLAUDE=1 PRINCIPIA_AGENT_EVAL=1 npx vitest run src/main/memory/__tests__/agentEval.smoke.test.ts
// Optional: PRINCIPIA_AGENT_EVAL_TASKS=3 (run the first N), PRINCIPIA_AGENT_EVAL_MODEL=<model>,
// PRINCIPIA_AGENT_EVAL_MIN_LINK_RATE (0.5), _MAX_GHOST_RATE (0.5), _MAX_DUP_RATE (0.2), PRINCIPIA_AGENT_EVAL_REPORT=<file>.
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { singularName, stripTypeSuffix } from '../../../shared/fuzzy'
import { normName } from '../../../shared/vault/resolve'
import { agentBrief } from '../../engine/memory'
import { retargetScore } from '../vault/suggest/ghosts'
import { nativeOk } from '../vault/__tests__/vaultTestKit'
import { makeHarness, NW, type Harness } from './fixtures/vault/harness'

const REPO_ROOT = path.resolve(__dirname, '../../../..')
const optedIn = process.env.PRINCIPIA_AGENT_EVAL === '1' && !!process.env.HIVE_REAL_CLAUDE
// probe the CLI only when opted in, so CI never spawns `claude` just to skip
const claudeOk = () => spawnSync('claude', ['--version'], { encoding: 'utf8', timeout: 15_000 }).status === 0
const enabled = optedIn && nativeOk && claudeOk()
const d = enabled ? describe : describe.skip
const num = (k: string, dflt: number) => (process.env[k] ? Number(process.env[k]) : dflt)

/** Ten tasks that hand the agent new, lasting facts about things the vault already knows (and a few it does not). */
export const EVAL_TASKS = [
  'The user tells you: Helios Clinics renewed for two more years and now wants Ledger Sync to run every hour instead of every 15 minutes.',
  'Diego Alvarez says the Tax engine must round VAT per invoice line, not per invoice, because Portuguese auditors require it.',
  "Chloe Martin reports that Mercury Bank's finance lead, Sofia Reyes, is now the contact for the November renewal.",
  'Bruno Costa decided that northwind-web moves to Node 22 in December, after the Postgres 16 upgrade.',
  'Ana Ruiz found that monthly churn on the Starter Plan is 4%, double the Growth Plan.',
  'Orbit Freight agreed to pilot usage-based billing at 0.10 EUR per shipment starting in November.',
  'Postmark will be replaced by Amazon SES for receipts in Q1 because of cost; Bruno Costa approved it.',
  'New gotcha from Diego: Dunning retries skip workspaces on the Enterprise Plan because those customers pay by wire.',
  'Priya Nair says the Brand voice now allows one exclamation mark in onboarding emails, and nowhere else.',
  'A new customer, Lumen Labs, signed for the Growth Plan; Chloe Martin will run their Customer onboarding.'
]

/** hivemem bundled from the current source for plain node (out/main/mcp-memory.js may be stale or Electron-only). */
async function bundleServer(outDir: string): Promise<string> {
  const { rolldown } = await import('rolldown')
  const file = path.join(outDir, 'mcp-memory.cjs')
  const b = await rolldown({
    input: path.join(REPO_ROOT, 'src/main/memory/server/main.ts'),
    platform: 'node',
    external: ['better-sqlite3', /^node:/],
    resolve: { alias: { '@shared': path.join(REPO_ROOT, 'src/shared') } },
    logLevel: 'warn'
  })
  await b.write({ file, format: 'cjs' })
  await b.close()
  return file
}

function runClaude(prompt: string, cwd: string, mcpConfig: string, tools: string[], timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const args = ['-p', '--output-format', 'json', '--max-turns', '12', '--strict-mcp-config', '--mcp-config', mcpConfig, '--allowedTools', tools.join(',')]
  if (process.env.PRINCIPIA_AGENT_EVAL_MODEL) args.push('--model', process.env.PRINCIPIA_AGENT_EVAL_MODEL)
  return new Promise((resolve) => {
    const child = spawn('claude', args, { cwd, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (b) => (stdout += b.toString()))
    child.stderr.on('data', (b) => (stderr += b.toString()))
    const t = setTimeout(() => child.kill('SIGTERM'), timeoutMs)
    child.on('exit', (code) => {
      clearTimeout(t)
      resolve({ code, stdout, stderr })
    })
    child.stdin.end(prompt)
  })
}

export interface AgentEvalMetrics {
  tasks: number
  tasksWithWrites: number
  lines: number
  linesWithResolvedLink: number
  links: number
  ghostLinks: number
  notesCreated: number
  duplicateNotes: string[]
  linkRate: number
  ghostRate: number
  duplicateRate: number
}

/** The §14 P8.4 metrics over what the given runs wrote (read back from the index, which mirrors the files). */
export function agentMetrics(h: Harness, runIds: string[], before: { titles: string[] }): AgentEvalMetrics {
  const db = h.rt.db
  let lines = 0
  let linked = 0
  let links = 0
  let ghosts = 0
  let tasksWithWrites = 0
  const created: string[] = []
  for (const run of runIds) {
    const facts = db.prepare(`SELECT id FROM mem_fact WHERE company_id = ? AND run_id = ? AND section = 'obs'`).all(NW, run) as { id: string }[]
    const rels = db.prepare(`SELECT to_note FROM mem_link WHERE company_id = ? AND run_id = ? AND origin = 'relation'`).all(NW, run) as { to_note: string | null }[]
    const factLinks = db.prepare(`SELECT from_fact, to_note FROM mem_link WHERE company_id = ? AND from_fact IN (SELECT id FROM mem_fact WHERE company_id = ? AND run_id = ?)`).all(NW, NW, run) as {
      from_fact: string
      to_note: string | null
    }[]
    if (facts.length + rels.length) tasksWithWrites++
    lines += facts.length + rels.length
    linked += facts.filter((f) => factLinks.some((l) => l.from_fact === f.id && l.to_note)).length + rels.filter((r) => r.to_note).length
    links += factLinks.length + rels.length
    ghosts += factLinks.filter((l) => !l.to_note).length + rels.filter((r) => !r.to_note).length
    for (const e of db.prepare(`SELECT after_json FROM mem_event WHERE company_id = ? AND run_id = ? AND op = 'create' AND target_kind = 'note'`).all(NW, run) as { after_json: string | null }[]) {
      const title = (JSON.parse(e.after_json ?? '{}') as { title?: string }).title
      if (title) created.push(title)
    }
  }
  const key = (s: string) => singularName(stripTypeSuffix(normName(s)))
  const dup = created.filter((t) => before.titles.some((x) => key(x) === key(t) || retargetScore(t, x) > 0))
  return {
    tasks: runIds.length,
    tasksWithWrites,
    lines,
    linesWithResolvedLink: linked,
    links,
    ghostLinks: ghosts,
    notesCreated: created.length,
    duplicateNotes: dup,
    linkRate: lines ? linked / lines : 0,
    ghostRate: links ? ghosts / links : 0,
    duplicateRate: created.length ? dup.length / created.length : 0
  }
}

d('real CLI agents on the Passport (opt-in)', () => {
  it(
    'link rate, ghost rate and duplicate-note rate over the scripted tasks',
    async () => {
      const h = makeHarness()
      const work = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-p8-eval-'))
      try {
        const bundle = await bundleServer(work)
        const titles = (h.rt.db.prepare(`SELECT title FROM mem_note WHERE company_id = ? UNION SELECT alias FROM mem_alias WHERE company_id = ?`).all(NW, NW) as { title: string }[]).map((r) => r.title)
        const tasks = EVAL_TASKS.slice(0, num('PRINCIPIA_AGENT_EVAL_TASKS', EVAL_TASKS.length))
        const runIds: string[] = []
        const transcripts: { task: string; code: number | null; result: string }[] = []
        for (const [i, task] of tasks.entries()) {
          const runId = `run_eval${String(i).padStart(6, '0')}`
          runIds.push(runId)
          const g = h.grant(NW, { runId, briefQuery: task, cwd: '/tmp/scratch' })
          const config = path.join(work, `${g.grantId}.mcp.json`)
          const env = { ...g.server.env, NODE_PATH: path.join(REPO_ROOT, 'node_modules') }
          delete (env as Record<string, string>).ELECTRON_RUN_AS_NODE
          fs.writeFileSync(config, JSON.stringify({ mcpServers: { hivemem: { type: 'stdio', command: process.execPath, args: [bundle], env } } }))
          const cwd = fs.mkdtempSync(path.join(work, 'cwd-'))
          const prompt = `${agentBrief(g, true)}\n\n${task}\nThere is no code to change. Keep the company Passport up to date if this is worth remembering, then answer in one sentence.`
          const r = await runClaude(prompt, cwd, config, g.toolNames.map((t) => `mcp__hivemem__${t}`), 240_000)
          let result = r.stdout
          try {
            result = (JSON.parse(r.stdout) as { result?: string }).result ?? r.stdout
          } catch {
            result = `${r.stdout}\n${r.stderr}`.slice(0, 2000)
          }
          transcripts.push({ task, code: r.code, result })
          h.svc.release(g.grantId)
        }
        const m = agentMetrics(h, runIds, { titles })
        const report = { metrics: m, transcripts }
        console.info(`[agent eval] ${JSON.stringify(m)}`)
        if (process.env.PRINCIPIA_AGENT_EVAL_REPORT) fs.writeFileSync(process.env.PRINCIPIA_AGENT_EVAL_REPORT, `${JSON.stringify(report, null, 2)}\n`)
        expect(transcripts.filter((t) => t.code === 0).length, JSON.stringify(transcripts, null, 2)).toBe(tasks.length)
        expect(m.tasksWithWrites).toBeGreaterThanOrEqual(Math.ceil(tasks.length / 2))
        expect(m.linkRate).toBeGreaterThanOrEqual(num('PRINCIPIA_AGENT_EVAL_MIN_LINK_RATE', 0.5))
        expect(m.ghostRate).toBeLessThanOrEqual(num('PRINCIPIA_AGENT_EVAL_MAX_GHOST_RATE', 0.5))
        expect(m.duplicateRate, m.duplicateNotes.join(', ')).toBeLessThanOrEqual(num('PRINCIPIA_AGENT_EVAL_MAX_DUP_RATE', 0.2))
      } finally {
        h.close()
        fs.rmSync(work, { recursive: true, force: true })
      }
    },
    EVAL_TASKS.length * 260_000
  )
})

// The metric code itself runs in CI on a scripted "agent" (no CLI): one linked line, one ghost relation, one duplicate note.
const dm = nativeOk ? describe : describe.skip
dm('agent eval metrics (CI)', () => {
  it('counts resolved links, ghosts and near-duplicate notes per run', async () => {
    const h = makeHarness()
    try {
      const titles = (h.rt.db.prepare(`SELECT title FROM mem_note WHERE company_id = ?`).all(NW) as { title: string }[]).map((r) => r.title)
      const b = h.server(h.grant(NW, { runId: 'run_metric0001' }))
      await h.call(b, 'memory_write', { note: 'Helios Clinics', facts: [{ text: 'Renewed for two years; wants [[Ledger Sync]] hourly' }, { text: 'Pays by card' }] })
      await h.call(b, 'memory_write', { note: 'Helios Clinic', type: 'customer', relations: [{ type: 'uses', to: 'Hourly Sync Job' }] })
      const m = agentMetrics(h, ['run_metric0001'], { titles })
      expect(m).toMatchObject({ tasks: 1, tasksWithWrites: 1, lines: 3, linesWithResolvedLink: 1, links: 2, ghostLinks: 1, notesCreated: 1, duplicateNotes: ['Helios Clinic'] })
      expect(m.linkRate).toBeCloseTo(1 / 3)
      expect(m.ghostRate).toBe(0.5)
      expect(m.duplicateRate).toBe(1)
    } finally {
      h.close()
    }
  })
})
