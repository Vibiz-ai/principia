/**
 * Spawn tagging + reaper (LANDSCAPE.md "Elon's cut" #5). Every process Hive spawns carries `HIVE_SPAWN_ID=<owner id>`
 * (s_… session, st_… step) and `HIVE_USER_DATA=<userData>` in its env, and leads its own process group. When an owner
 * ends (exit, kill, cancel) the reaper kills its whole tree:
 *   1. the owner's process group (pgid = the leader's pid; node-pty and detached spawns both start one),
 *   2. descendants by parent pid, collected BEFORE the leader dies (children are re-parented to launchd after),
 *   3. every process whose env carries the owner's HIVE_SPAWN_ID and this Hive's HIVE_USER_DATA (`ps -E`), which
 *      catches dev servers that left the group (setsid / detached) and were re-parented,
 *   4. descendants seen by the periodic sampler while the owner ran (escapees whose env macOS hides: platform
 *      binaries such as /bin/sleep never show their env to `ps -E`).
 * Leftovers = tagged processes of this userData whose owner is no longer live (an earlier Hive run). They are listed,
 * never killed on launch. Strictly local: only /bin/ps, /usr/sbin/lsof and kill(2).
 */
import { execFile, execFileSync } from 'node:child_process'
import type { ProcessReaper, ReaperRow } from '../../shared/engine'

export const SPAWN_ENV = 'HIVE_SPAWN_ID'
export const USER_DATA_ENV = 'HIVE_USER_DATA'

/** A process table row; `env` = raw env text after the command (`ps -E`), null when not captured or hidden by macOS. */
export type ProcRow = ReaperRow

// ---------- pure parsing ----------

/** ps etime "[[dd-]hh:]mm:ss" -> ms. */
export function parseEtime(s: string): number {
  const m = s.trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/)
  if (!m) return 0
  const [, d, h, mi, se] = m
  return (((Number(d ?? 0) * 24 + Number(h ?? 0)) * 60 + Number(mi)) * 60 + Number(se)) * 1000
}

/** `ps -axww -o pid=,ppid=,pgid=,etime=,command=` output. */
export function parsePs(out: string): ProcRow[] {
  const rows: ProcRow[] = []
  for (const line of out.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/)
    if (!m) continue
    rows.push({ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), etimeMs: parseEtime(m[4]!), command: m[5]!.trimEnd(), env: null })
  }
  return rows
}

/**
 * Joins `ps -axww -E -o pid=,command=` output onto rows: with -E the env follows the command in the same column, so
 * the env text is what comes after the known command. Processes whose env macOS hides keep env = null.
 */
export function attachEnv(rows: ProcRow[], envOut: string): ProcRow[] {
  const byPid = new Map(rows.map((r) => [r.pid, r]))
  for (const line of envOut.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(.*)$/)
    if (!m) continue
    const r = byPid.get(Number(m[1]))
    if (!r) continue
    const full = m[2]!
    const rest = full.startsWith(r.command) ? full.slice(r.command.length) : full
    r.env = rest.includes('=') ? ` ${rest.trim()} ` : null
  }
  return rows
}

/** The HIVE_SPAWN_ID a process carries, or null. */
export function spawnIdOf(env: string | null): string | null {
  if (!env) return null
  const m = env.match(/(?:^|\s)HIVE_SPAWN_ID=(\S+)/)
  return m ? m[1]! : null
}

/** True when the env names this Hive's data folder (values may contain spaces: match the exact assignment). */
export function ownedByUserData(env: string | null, userData: string): boolean {
  if (!env || !userData) return false
  return env.includes(` ${USER_DATA_ENV}=${userData} `)
}

/** pid -> its ancestors' pids (nearest first), from one snapshot. */
function ancestors(rows: ProcRow[], pid: number): number[] {
  const byPid = new Map(rows.map((r) => [r.pid, r]))
  const out: number[] = []
  let cur = byPid.get(pid)
  const seen = new Set<number>()
  while (cur && cur.ppid > 1 && !seen.has(cur.ppid)) {
    seen.add(cur.ppid)
    out.push(cur.ppid)
    cur = byPid.get(cur.ppid)
  }
  return out
}

export interface TreeQuery {
  /** Owner ids whose tagged processes belong to the tree; 'any' = every tagged process of this userData. */
  spawnIds: string[] | 'any'
  userData: string
  /** Leaders (PTY / step pids): their groups and descendants belong to the tree. */
  rootPids?: number[]
  /** Pids known to belong (pre-kill snapshot, sampler). Only taken while their command still matches. */
  known?: { pid: number; command: string }[]
  /** Hive itself: its pid (and therefore its ancestors and its own group) are never touched. */
  selfPid: number
}

/** Pure: which processes of a snapshot belong to the query's tree. Never includes Hive, its ancestors or pid <= 1. */
export function collectTree(rows: ProcRow[], q: TreeQuery): ProcRow[] {
  const byPid = new Map(rows.map((r) => [r.pid, r]))
  const self = byPid.get(q.selfPid)
  const protect = new Set<number>([0, 1, q.selfPid, ...ancestors(rows, q.selfPid)])
  const protectPgids = new Set<number>([0, 1, ...(self ? [self.pgid] : [])])
  for (const a of protect) {
    const r = byPid.get(a)
    if (r) protectPgids.add(r.pgid)
  }
  const tagged = (r: ProcRow): boolean => {
    const id = spawnIdOf(r.env)
    if (!id || !ownedByUserData(r.env, q.userData)) return false
    return q.spawnIds === 'any' || q.spawnIds.includes(id)
  }
  const picked = new Set<number>()
  const groups = new Set<number>()
  for (const pid of q.rootPids ?? []) {
    if (protect.has(pid)) continue
    const r = byPid.get(pid)
    if (r) picked.add(pid)
    // the leader may already be gone: its group id is its pid
    if (!protectPgids.has(pid)) groups.add(pid)
  }
  for (const k of q.known ?? []) {
    const r = byPid.get(k.pid)
    if (r && r.command === k.command && !protect.has(r.pid)) picked.add(r.pid)
  }
  for (const r of rows) {
    if (protect.has(r.pid)) continue
    if (tagged(r)) {
      picked.add(r.pid)
      if (!protectPgids.has(r.pgid)) groups.add(r.pgid)
    }
  }
  for (const r of rows) if (groups.has(r.pgid) && !protect.has(r.pid)) picked.add(r.pid)
  // descendants by parent pid (closure)
  const children = new Map<number, number[]>()
  for (const r of rows) {
    const l = children.get(r.ppid)
    if (l) l.push(r.pid)
    else children.set(r.ppid, [r.pid])
  }
  const stack = [...picked]
  while (stack.length) {
    const pid = stack.pop()!
    for (const c of children.get(pid) ?? []) {
      if (picked.has(c) || protect.has(c)) continue
      picked.add(c)
      stack.push(c)
    }
  }
  return rows.filter((r) => picked.has(r.pid))
}

/**
 * Pure: tagged processes of this userData whose owner is not live and that do not descend from Hive itself.
 * Children of a leftover (same tree) are folded into it: only the topmost tagged process is listed.
 */
export function findLeftovers(rows: ProcRow[], o: { userData: string; live: ReadonlySet<string>; selfPid: number }): ProcRow[] {
  const byPid = new Map(rows.map((r) => [r.pid, r]))
  const descendsFromSelf = (r: ProcRow): boolean => {
    let cur: ProcRow | undefined = r
    const seen = new Set<number>()
    while (cur && cur.ppid > 1 && !seen.has(cur.pid)) {
      seen.add(cur.pid)
      if (cur.ppid === o.selfPid) return true
      cur = byPid.get(cur.ppid)
    }
    return false
  }
  const isLeft = (r: ProcRow): boolean => {
    if (r.pid === o.selfPid) return false
    const id = spawnIdOf(r.env)
    if (!id || !ownedByUserData(r.env, o.userData) || o.live.has(id)) return false
    return !descendsFromSelf(r)
  }
  const left = rows.filter(isLeft)
  const leftPids = new Set(left.map((r) => r.pid))
  // keep only the topmost of each tree (a parent already listed covers its children)
  return left.filter((r) => {
    let cur = byPid.get(r.ppid)
    const seen = new Set<number>()
    while (cur && !seen.has(cur.pid)) {
      if (leftPids.has(cur.pid)) return false
      seen.add(cur.pid)
      cur = byPid.get(cur.ppid)
    }
    return true
  })
}

// ---------- system access (injectable for tests) ----------

export interface ProcessTable {
  snapshot(withEnv: boolean): Promise<ProcRow[]>
  snapshotSync(withEnv: boolean): ProcRow[]
  /** kill(2); false when the process is gone or not ours. */
  signal(pid: number, sig: NodeJS.Signals): boolean
  /** Working directories by pid (lsof); missing entries = unknown. */
  cwds(pids: number[]): Promise<Map<number, string>>
}

const PS = '/bin/ps'
const LSOF = '/usr/sbin/lsof'
const PS_ARGS = ['-axww', '-o', 'pid=,ppid=,pgid=,etime=,command=']
const PS_ENV_ARGS = ['-axww', '-E', '-o', 'pid=,command=']
const MAX_BUFFER = 256 * 1024 * 1024

const run = (file: string, args: string[], timeout = 10_000): Promise<string> =>
  new Promise((resolve) => {
    execFile(file, args, { maxBuffer: MAX_BUFFER, timeout, encoding: 'utf8' }, (_e, stdout) => resolve(typeof stdout === 'string' ? stdout : ''))
  })
const runSync = (file: string, args: string[], timeout = 10_000): string => {
  try {
    return execFileSync(file, args, { maxBuffer: MAX_BUFFER, timeout, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  } catch (e) {
    const out = (e as { stdout?: unknown }).stdout
    return typeof out === 'string' ? out : ''
  }
}

export const systemProcessTable: ProcessTable = {
  async snapshot(withEnv) {
    const [plain, env] = await Promise.all([run(PS, PS_ARGS), withEnv ? run(PS, PS_ENV_ARGS) : Promise.resolve('')])
    const rows = parsePs(plain)
    return withEnv ? attachEnv(rows, env) : rows
  },
  snapshotSync(withEnv) {
    const rows = parsePs(runSync(PS, PS_ARGS))
    return withEnv ? attachEnv(rows, runSync(PS, PS_ENV_ARGS)) : rows
  },
  signal(pid, sig) {
    try {
      process.kill(pid, sig)
      return true
    } catch {
      return false
    }
  },
  async cwds(pids) {
    const out = new Map<number, string>()
    if (!pids.length) return out
    const text = await run(LSOF, ['-a', '-d', 'cwd', '-Fn', '-p', pids.join(',')], 5000)
    let cur: number | null = null
    for (const line of text.split('\n')) {
      if (line.startsWith('p')) cur = Number(line.slice(1))
      else if (line.startsWith('n') && cur !== null) out.set(cur, line.slice(1))
    }
    return out
  }
}

// ---------- the reaper ----------

export interface ReaperOptions {
  userData: string
  table?: ProcessTable
  selfPid?: number
  /** SIGTERM -> SIGKILL grace. Default 1500 ms. */
  graceMs?: number
  /** Descendant sampling period while owners run. Default 20 s; 0 = off. */
  sampleMs?: number
  log?: { warn(m: string, meta?: Record<string, unknown>): void; info?(m: string, meta?: Record<string, unknown>): void }
}

export interface LeftoverRow {
  pid: number
  spawnId: string
  command: string
  cwd: string | null
  etimeMs: number
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export class Reaper implements ProcessReaper {
  readonly userData: string
  private table: ProcessTable
  private selfPid: number
  private graceMs: number
  /** Running owners: leader pid + descendants seen by the sampler. */
  private owners = new Map<string, { rootPid: number; known: Map<number, string> }>()
  private sampler: NodeJS.Timeout | null = null
  private sampling = false

  constructor(private o: ReaperOptions) {
    this.userData = o.userData
    this.table = o.table ?? systemProcessTable
    this.selfPid = o.selfPid ?? process.pid
    this.graceMs = o.graceMs ?? 1500
  }

  /** Env every spawn of `spawnId` carries (merged last into the child env). */
  tag(spawnId: string): Record<string, string> {
    return { [SPAWN_ENV]: spawnId, [USER_DATA_ENV]: this.userData }
  }

  /** An owner started: remember its leader and sample its descendants while it runs. */
  register(spawnId: string, rootPid: number | null | undefined): void {
    if (!rootPid) return
    this.owners.set(spawnId, { rootPid, known: new Map() })
    const every = this.o.sampleMs ?? 20_000
    if (every > 0 && !this.sampler) {
      this.sampler = setInterval(() => void this.sample(), every)
      this.sampler.unref?.()
    }
  }

  liveOwners(): string[] {
    return [...this.owners.keys()]
  }

  /** One sampling pass (cheap ps without env): descendants of each running owner's leader and group. */
  async sample(): Promise<void> {
    if (this.sampling || !this.owners.size) return
    this.sampling = true
    try {
      const rows = await this.table.snapshot(false)
      for (const [id, o] of this.owners) {
        for (const r of collectTree(rows, { spawnIds: [], userData: this.userData, rootPids: [o.rootPid], selfPid: this.selfPid })) {
          if (r.pid !== o.rootPid) o.known.set(r.pid, r.command)
        }
        if (o.known.size > 2000) o.known = new Map([...o.known].slice(-2000))
        void id
      }
    } catch (e) {
      this.o.log?.warn('reaper: sample failed', { e: String(e) })
    } finally {
      this.sampling = false
    }
  }

  /** The tree of an owner right now (call before killing its leader: its children are still attached). */
  async collect(spawnId: string, rootPids: number[] = []): Promise<ProcRow[]> {
    const rows = await this.table.snapshot(true)
    return collectTree(rows, { spawnIds: [spawnId], userData: this.userData, rootPids, known: this.knownOf(spawnId), selfPid: this.selfPid })
  }

  private knownOf(spawnId: string): { pid: number; command: string }[] {
    const o = this.owners.get(spawnId)
    return o ? [...o.known].map(([pid, command]) => ({ pid, command })) : []
  }

  /**
   * Kills an owner's whole tree: SIGTERM, then SIGKILL whatever survives `graceMs`. `pre` = rows collected before
   * the leader was killed. Forgets the owner. Returns how many processes were signalled. Never throws.
   */
  async reap(spawnId: string, opts: { rootPids?: number[]; pre?: ProcRow[] } = {}): Promise<number> {
    try {
      const rootPids = [...new Set([...(opts.rootPids ?? []), ...(this.owners.get(spawnId)?.rootPid ? [this.owners.get(spawnId)!.rootPid] : [])])]
      const known = [...this.knownOf(spawnId), ...(opts.pre ?? []).map((r) => ({ pid: r.pid, command: r.command }))]
      this.owners.delete(spawnId)
      this.stopSamplerIfIdle()
      const q: TreeQuery = { spawnIds: [spawnId], userData: this.userData, rootPids, known, selfPid: this.selfPid }
      const first = collectTree(await this.table.snapshot(true), q)
      if (!first.length) return 0
      return await this.terminate(first, q)
    } catch (e) {
      this.o.log?.warn('reaper: reap failed', { spawnId, e: String(e) })
      return 0
    }
  }

  private async terminate(targets: ProcRow[], q: TreeQuery): Promise<number> {
    const groups = new Set<number>()
    for (const pid of q.rootPids ?? []) groups.add(pid)
    for (const r of targets) if (spawnIdOf(r.env) && r.pid === r.pgid) groups.add(r.pgid)
    for (const g of groups) if (g > 1 && g !== this.selfPid) this.table.signal(-g, 'SIGTERM')
    for (const r of targets) this.table.signal(r.pid, 'SIGTERM')
    const deadline = Date.now() + this.graceMs
    let left = targets
    while (Date.now() < deadline) {
      await sleep(Math.min(200, Math.max(10, deadline - Date.now())))
      const rows = await this.table.snapshot(false)
      const alive = new Map(rows.map((r) => [r.pid, r.command]))
      left = left.filter((r) => alive.get(r.pid) === r.command)
      if (!left.length) break
    }
    for (const g of groups) if (g > 1 && g !== this.selfPid) this.table.signal(-g, 'SIGKILL')
    for (const r of left) this.table.signal(r.pid, 'SIGKILL')
    if (left.length) this.o.log?.info?.('reaper: SIGKILL after grace', { pids: left.map((r) => r.pid) })
    return targets.length
  }

  private stopSamplerIfIdle(): void {
    if (this.owners.size || !this.sampler) return
    clearInterval(this.sampler)
    this.sampler = null
  }

  /** Quit: SIGKILL every tagged process of this userData now (sync; the app is going away). Returns the count. */
  reapAllSync(): number {
    try {
      const rows = this.table.snapshotSync(true)
      const rootPids = [...this.owners.values()].map((o) => o.rootPid)
      const known = [...this.owners.keys()].flatMap((id) => this.knownOf(id))
      const targets = collectTree(rows, { spawnIds: 'any', userData: this.userData, rootPids, known, selfPid: this.selfPid })
      const groups = new Set<number>([...rootPids, ...targets.filter((r) => spawnIdOf(r.env) && r.pid === r.pgid).map((r) => r.pgid)])
      for (const g of groups) if (g > 1 && g !== this.selfPid) this.table.signal(-g, 'SIGKILL')
      for (const r of targets) this.table.signal(r.pid, 'SIGKILL')
      this.owners.clear()
      this.stopSamplerIfIdle()
      return targets.length
    } catch (e) {
      this.o.log?.warn('reaper: quit reap failed', { e: String(e) })
      return 0
    }
  }

  /** Tagged processes of this userData whose owner is not live (earlier Hive runs). */
  async leftovers(live: ReadonlySet<string>): Promise<LeftoverRow[]> {
    const rows = await this.table.snapshot(true)
    const allLive = new Set([...live, ...this.owners.keys()])
    const left = findLeftovers(rows, { userData: this.userData, live: allLive, selfPid: this.selfPid })
    const cwds = await this.table.cwds(left.map((r) => r.pid)).catch(() => new Map<number, string>())
    return left.map((r) => ({ pid: r.pid, spawnId: spawnIdOf(r.env)!, command: r.command, cwd: cwds.get(r.pid) ?? null, etimeMs: r.etimeMs }))
  }

  /** Stops leftovers (and their trees). Pids that are no longer leftovers are skipped. Returns how many were signalled. */
  async stopLeftovers(pids: number[], live: ReadonlySet<string>): Promise<number> {
    const rows = await this.table.snapshot(true)
    const allLive = new Set([...live, ...this.owners.keys()])
    const left = findLeftovers(rows, { userData: this.userData, live: allLive, selfPid: this.selfPid })
    const want = new Set(pids)
    const chosen = left.filter((r) => want.has(r.pid))
    if (!chosen.length) return 0
    // each leftover's own tree: its group when it leads one, plus descendants
    const q: TreeQuery = { spawnIds: [], userData: this.userData, rootPids: chosen.filter((r) => r.pid === r.pgid).map((r) => r.pid), known: chosen.map((r) => ({ pid: r.pid, command: r.command })), selfPid: this.selfPid }
    const targets = collectTree(rows, q)
    return this.terminate(targets, q)
  }

  dispose(): void {
    if (this.sampler) clearInterval(this.sampler)
    this.sampler = null
  }
}
