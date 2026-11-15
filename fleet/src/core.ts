/**
 * The fleet's rules (docs/FLEET.md), pure over the ports in types.ts:
 *
 *   api(ports)        the HTTP API the Mac and the machines call (enroll, machine, wake, delete, heartbeat)
 *   reconcile(ports)  every minute: brings each machine to where it should be, stops idle ones, wakes them for their
 *                     schedules, counts awake hours, and cleans up anything AWS has that the fleet doesn't know about
 *
 * Money rules, all enforced here: one machine per person, a fleet-wide cap, a monthly cap of awake hours per person,
 * stop after `idleMinutes` with nothing running and nothing changed, stop a machine whose heartbeat went quiet or
 * that never came up, and never leave a failed machine running.
 *
 * Every write is conditional on the record's `rev`: the API and the reconciler can run at the same time, and the one
 * that loses re-reads (API) or leaves the machine to the next tick (reconciler).
 */
import { createHash } from 'node:crypto'
import { CapacityError, type Activity, type FleetConfig, type InstanceInfo, type MachineRec, type MachineView, type Ports, type Req, type Res, type UserRec } from './types'

export class FleetError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message)
  }
}
class Conflict extends Error {}

export const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex')
export const sslipHost = (ip: string): string => `${ip.replace(/\./g, '-')}.sslip.io`
export const monthOf = (d: Date): string => d.toISOString().slice(0, 7)
const minutes = (n: number): number => n * 60_000
const ms = (iso: string | null): number => (iso ? Date.parse(iso) : 0)

/** Seconds counted per tick at most: a reconciler that missed ticks never bills a gap it didn't see. */
const MAX_TICK_S = 5 * 60
/** A running machine with no heartbeat for this long is stopped (it is broken or can't reach the fleet). */
const HEARTBEAT_STALE_MIN = 15
/** Wake this long before the next schedule, so the box is up when the slot comes. */
const WAKE_EARLY_MIN = 3
/** An instance the fleet has no record of is terminated once it is this old (a create that crashed half way). */
const ORPHAN_MIN = 15
const CREATING_STUCK_MIN = 10
const STOPPING_STUCK_MIN = 10

const AWAKE: InstanceInfo['state'][] = ['pending', 'running', 'stopping']

export function view(m: MachineRec, cfg: FleetConfig, now: Date): MachineView {
  const month = monthOf(now)
  const seconds = m.month === month ? m.awakeSeconds : 0
  return {
    id: m.id,
    state: m.state,
    host: m.host,
    url: m.host ? `https://${m.host}` : null,
    instanceType: m.instanceType,
    createdAt: m.createdAt,
    error: m.error,
    wakeAt: m.wakeAt,
    sleepReason: m.sleepReason,
    usage: { month, hours: Math.round((seconds / 3600) * 10) / 10, limitHours: cfg.maxHoursPerMonth },
    idleMinutes: cfg.idleMinutes
  }
}

function hoursLeft(m: MachineRec, cfg: FleetConfig, now: Date): boolean {
  const seconds = m.month === monthOf(now) ? m.awakeSeconds : 0
  return seconds < cfg.maxHoursPerMonth * 3600
}

/** Writes `patch` over `m` if nobody wrote since; throws Conflict otherwise. */
async function save(p: Ports, m: MachineRec, patch: Partial<MachineRec>): Promise<MachineRec> {
  const next: MachineRec = { ...m, ...patch, rev: m.rev + 1, updatedAt: p.now().toISOString() }
  if (!(await p.store.putMachine(next, m.rev))) throw new Conflict('machine changed')
  return next
}

/** Starts a stopped instance, moving it to the next instance type when its zone has no room for this one. */
async function startWithFallback(p: Ports, m: MachineRec): Promise<string> {
  const types = [m.instanceType, ...p.config.instanceTypes.filter((t) => t !== m.instanceType)]
  let last: unknown = null
  for (const [i, t] of types.entries()) {
    try {
      if (i > 0) await p.compute.setInstanceType(m.instanceId!, t)
      await p.compute.start(m.instanceId!)
      return t
    } catch (e) {
      if (!(e instanceof CapacityError)) throw e
      last = e
      p.log.warn('fleet: no capacity to start', { machineId: m.id, instanceType: t })
    }
  }
  throw last instanceof Error ? last : new CapacityError('No capacity')
}

async function wakeNow(p: Ports, m: MachineRec, why: string): Promise<MachineRec> {
  const type = await startWithFallback(p, m)
  const now = p.now().toISOString()
  p.log.info('fleet: wake', { machineId: m.id, why })
  return save(p, m, {
    state: 'starting',
    instanceType: type,
    awakeSince: now,
    lastWakeAt: now,
    lastTickAt: now,
    firstBoot: false,
    wakeAt: null,
    wakeRequested: false,
    sleepReason: null,
    error: null,
    up: false
  })
}

async function stopNow(p: Ports, m: MachineRec, reason: string): Promise<MachineRec> {
  await p.compute.stop(m.instanceId!)
  const next = m.activity?.nextScheduleAt
  const wakeAt = reason === 'idle' && next ? new Date(ms(next) - minutes(WAKE_EARLY_MIN)).toISOString() : null
  p.log.info('fleet: sleep', { machineId: m.id, reason, wakeAt })
  return save(p, m, { state: 'stopping', sleepReason: reason, wakeAt, wakeRequested: false, up: false })
}

// ---------------------------------------------------------------- API

const json = (status: number, body: unknown): Res => ({ status, body })
const fail = (e: FleetError): Res => json(e.status, { error: e.code, message: e.message })

function bearer(r: Req): string {
  const h = r.headers.authorization ?? r.headers.Authorization ?? ''
  const m = /^Bearer\s+(\S{20,512})$/.exec(h)
  if (!m) throw new FleetError(401, 'unauthorized', 'Sign in again.')
  return m[1]!
}

function body(r: Req): Record<string, unknown> {
  if (!r.body) return {}
  if (r.body.length > 64_000) throw new FleetError(413, 'payload_too_large', 'Too large.')
  try {
    const v = JSON.parse(r.body) as unknown
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
  } catch {
    throw new FleetError(400, 'bad_request', 'Not JSON.')
  }
}

function cleanActivity(v: unknown): Activity | null {
  if (!v || typeof v !== 'object') return null
  const a = v as Record<string, unknown>
  const iso = (x: unknown): string | null => (typeof x === 'string' && x.length <= 40 && !Number.isNaN(Date.parse(x)) ? new Date(x).toISOString() : null)
  const n = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? Math.min(Math.floor(x), 1e6) : 0)
  const at = iso(a.at)
  if (!at) return null
  return { busy: a.busy === true, running: n(a.running), queued: n(a.queued), lastActivityAt: iso(a.lastActivityAt), nextScheduleAt: iso(a.nextScheduleAt), at }
}

async function allowed(p: Ports, token: string, login: string): Promise<boolean> {
  const c = p.config
  if (c.open) return true
  if (c.allowUsers.some((u) => u.toLowerCase() === login.toLowerCase())) return true
  if (!c.allowOrgs.length) return false
  try {
    const orgs = (await p.github.orgs(token)).map((o) => o.toLowerCase())
    return c.allowOrgs.some((o) => orgs.includes(o.toLowerCase()))
  } catch {
    return false
  }
}

export function api(p: Ports): (r: Req) => Promise<Res> {
  async function me(r: Req): Promise<UserRec> {
    const uid = await p.store.userIdByKeyHash(sha256(bearer(r)))
    const u = uid ? await p.store.getUser(uid) : null
    // the index can lag a rotation: the user's own record decides
    if (!u || u.keyHash !== sha256(bearer(r))) throw new FleetError(401, 'unauthorized', 'This Mac is not signed in to Principia Cloud. Sign in again.')
    return u
  }

  async function enroll(r: Req): Promise<Res> {
    const token = body(r).githubToken
    if (typeof token !== 'string' || token.length < 20 || token.length > 512) throw new FleetError(400, 'bad_request', 'Sign in to GitHub on this Mac first.')
    let gh: { id: string; login: string }
    try {
      gh = await p.github.user(token)
    } catch {
      throw new FleetError(401, 'unauthorized', 'GitHub did not accept this Mac’s sign-in. Run `gh auth login` and try again.')
    }
    const ok = await allowed(p, token, gh.login)
    const key = `pfk_${p.random(32)}`
    const now = p.now().toISOString()
    const prev = await p.store.getUser(gh.id)
    const u: UserRec = { id: gh.id, login: gh.login, allowed: ok, keyHash: sha256(key), createdAt: prev?.createdAt ?? now, lastSeenAt: now, ...(prev?.usage ? { usage: prev.usage } : {}) }
    await p.store.putUser(u, prev?.keyHash ?? null)
    p.log.info('fleet: enroll', { userId: u.id, login: u.login, allowed: ok })
    // the GitHub token is used for these two calls and never stored
    return json(200, { key, login: u.login, allowed: ok })
  }

  async function createMachine(r: Req, u: UserRec): Promise<Res> {
    if (!u.allowed) throw new FleetError(403, 'not_allowed', 'Principia Cloud isn’t open for your account yet.')
    const b = body(r)
    const adminTokenSha256 = typeof b.adminTokenSha256 === 'string' && /^[0-9a-f]{64}$/.test(b.adminTokenSha256) ? b.adminTokenSha256 : null
    if (!adminTokenSha256) throw new FleetError(400, 'bad_request', 'adminTokenSha256 is required.')
    const workspaceName = (typeof b.workspaceName === 'string' ? b.workspaceName : 'My cloud').replace(/[^\w .-]/g, '').slice(0, 80) || 'My cloud'
    const existing = await p.store.getMachine(u.id)
    if (existing && existing.state !== 'failed') throw new FleetError(409, 'exists', 'You already have a cloud machine.')
    const now = p.now()
    // the monthly cap follows the person, not the machine: deleting and making one again doesn't reset it
    const carried = u.usage && u.usage.month === monthOf(now) ? u.usage.awakeSeconds : 0
    const used = existing ? (existing.month === monthOf(now) ? existing.awakeSeconds : 0) : carried
    if (used >= p.config.maxHoursPerMonth * 3600) throw new FleetError(429, 'limit', `Your cloud used its ${p.config.maxHoursPerMonth} hours this month. It can start again on the 1st.`)
    const machineToken = `pmt_${p.random(32)}`
    let m: MachineRec
    if (existing) {
      // a failed machine is rebuilt in place: same address, a new instance
      if (existing.instanceId) await p.compute.terminate(existing.instanceId).catch((e) => p.log.warn('fleet: terminate failed', { error: String(e) }))
      m = await save(p, existing, { state: 'creating', instanceId: null, machineTokenHash: sha256(machineToken), error: null, up: false, activity: null, lastHeartbeatAt: null, firstBoot: true, sleepReason: null, wakeAt: null })
    } else {
      m = {
        id: `m_${sha256(p.random(16)).slice(0, 12)}`,
        userId: u.id,
        login: u.login,
        state: 'creating',
        instanceId: null,
        instanceType: p.config.instanceTypes[0]!,
        allocationId: null,
        ip: null,
        host: null,
        machineTokenHash: sha256(machineToken),
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        awakeSince: null,
        firstBoot: true,
        lastWakeAt: null,
        wakeRequested: false,
        wakeAt: null,
        lastHeartbeatAt: null,
        up: false,
        activity: null,
        month: monthOf(now),
        awakeSeconds: carried,
        lastTickAt: null,
        error: null,
        sleepReason: null,
        rev: 0
      }
      const r = await p.store.insertMachine(m, p.config.maxMachines)
      if (r === 'exists') throw new FleetError(409, 'exists', 'You already have a cloud machine.')
      if (r === 'full') throw new FleetError(503, 'full', 'Principia Cloud is full right now. Try again later.')
    }
    try {
      if (!m.allocationId) {
        const a = await p.compute.allocateAddress(m.id)
        m = await save(p, m, { allocationId: a.allocationId, ip: a.ip, host: sslipHost(a.ip) })
      }
      const userData = p.userData({ host: m.host!, adminTokenSha256, workspaceName, machineToken })
      const types = [m.instanceType, ...p.config.instanceTypes.filter((t) => t !== m.instanceType)]
      let launched: { instanceId: string; type: string } | null = null
      for (const t of types) {
        try {
          launched = { ...(await p.compute.launch({ machineId: m.id, name: `principia-${u.login}`.slice(0, 60), instanceType: t, userData })), type: t }
          break
        } catch (e) {
          if (!(e instanceof CapacityError)) throw e
          p.log.warn('fleet: no capacity to launch', { machineId: m.id, instanceType: t })
        }
      }
      if (!launched) throw new FleetError(503, 'no_capacity', 'AWS has no room for a machine right now. Try again in a few minutes.')
      const at = p.now().toISOString()
      m = await save(p, m, { state: 'starting', instanceId: launched.instanceId, instanceType: launched.type, awakeSince: at, lastWakeAt: at, lastTickAt: at })
      p.log.info('fleet: created', { machineId: m.id, userId: u.id, instanceType: launched.type })
      return json(201, view(m, p.config, p.now()))
    } catch (e) {
      const message = e instanceof FleetError ? e.message : 'The machine could not be made. Try again.'
      p.log.warn('fleet: create failed', { machineId: m.id, error: e instanceof Error ? e.message : String(e) })
      const cur = await p.store.getMachine(u.id)
      if (cur) await save(p, cur, { state: 'failed', error: message }).catch(() => undefined)
      throw e instanceof FleetError ? e : new FleetError(502, 'create_failed', message)
    }
  }

  async function wake(u: UserRec): Promise<Res> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const m = await p.store.getMachine(u.id)
      if (!m) throw new FleetError(404, 'not_found', 'You have no cloud machine.')
      try {
        switch (m.state) {
          case 'running':
          case 'starting':
            // asked for it: counts as activity, so it isn't stopped under you
            return json(200, view(await save(p, m, { lastWakeAt: p.now().toISOString() }), p.config, p.now()))
          case 'stopping':
            return json(202, view(await save(p, m, { wakeRequested: true }), p.config, p.now()))
          case 'sleeping': {
            if (!hoursLeft(m, p.config, p.now())) throw new FleetError(429, 'limit', `Your cloud used its ${p.config.maxHoursPerMonth} hours this month. It wakes again on the 1st.`)
            try {
              return json(202, view(await wakeNow(p, m, 'asked'), p.config, p.now()))
            } catch (e) {
              if (e instanceof CapacityError) throw new FleetError(503, 'no_capacity', 'AWS has no room to start your machine right now. Try again in a few minutes.')
              throw e
            }
          }
          case 'failed':
            throw new FleetError(409, 'failed', m.error ?? 'Your cloud machine failed. Make it again.')
          default:
            return json(200, view(m, p.config, p.now()))
        }
      } catch (e) {
        if (!(e instanceof Conflict)) throw e
      }
    }
    throw new FleetError(409, 'busy', 'Your machine is changing. Try again.')
  }

  async function remove(u: UserRec): Promise<Res> {
    const m = await p.store.getMachine(u.id)
    if (!m) return json(200, { deleted: true })
    const d = m.state === 'deleting' ? m : await save(p, m, { state: 'deleting' })
    await finishDelete(p, d, undefined)
    return json(202, { deleted: true })
  }

  async function heartbeat(r: Req): Promise<Res> {
    const uid = await p.store.userIdByMachineTokenHash(sha256(bearer(r)))
    if (!uid) throw new FleetError(401, 'unauthorized', 'Unknown machine.')
    const b = body(r)
    for (let attempt = 0; attempt < 3; attempt++) {
      const m = await p.store.getMachine(uid)
      if (m && m.machineTokenHash !== sha256(bearer(r))) throw new FleetError(401, 'unauthorized', 'Unknown machine.')
      if (!m || m.state === 'deleting') return json(200, { ok: true })
      const up = b.up === true
      const patch: Partial<MachineRec> = { lastHeartbeatAt: p.now().toISOString(), up, activity: cleanActivity(b.activity) ?? m.activity }
      if (m.state === 'starting' && up) Object.assign(patch, { state: 'running', error: null })
      try {
        await save(p, m, patch)
        return json(200, { ok: true })
      } catch (e) {
        if (!(e instanceof Conflict)) throw e
      }
    }
    return json(409, { error: 'busy' })
  }

  return async (r: Req): Promise<Res> => {
    try {
      const route = `${r.method.toUpperCase()} ${r.path.replace(/\/+$/, '')}`
      switch (route) {
        case 'GET /v1/health':
          return json(200, { ok: true })
        case 'POST /v1/enroll':
          return await enroll(r)
        case 'POST /v1/heartbeat':
          return await heartbeat(r)
        case 'GET /v1/machine': {
          const u = await me(r)
          const m = await p.store.getMachine(u.id)
          return json(200, { login: u.login, allowed: u.allowed, machine: m ? view(m, p.config, p.now()) : null })
        }
        case 'POST /v1/machine':
          return await createMachine(r, await me(r))
        case 'POST /v1/machine/wake':
          return await wake(await me(r))
        case 'DELETE /v1/machine':
          return await remove(await me(r))
        default:
          return json(404, { error: 'not_found', message: 'Not here.' })
      }
    } catch (e) {
      if (e instanceof FleetError) return fail(e)
      if (e instanceof Conflict) return json(409, { error: 'busy', message: 'Your machine is changing. Try again.' })
      p.log.warn('fleet: request failed', { path: r.path, error: e instanceof Error ? e.message : String(e) })
      return json(500, { error: 'internal', message: 'Something went wrong in Principia Cloud. Try again.' })
    }
  }
}

/**
 * Terminates, releases the address once AWS lets go of it, then forgets the machine. Safe to call again: `i` is the
 * instance as the reconciler saw it (null: AWS no longer knows it), or undefined from the API (not looked at).
 */
async function finishDelete(p: Ports, m: MachineRec, i: InstanceInfo | null | undefined): Promise<void> {
  if (m.instanceId && !(i === null || i?.state === 'terminated')) {
    try {
      await p.compute.terminate(m.instanceId)
    } catch (e) {
      p.log.warn('fleet: terminate failed', { machineId: m.id, error: String(e) })
    }
    // AWS keeps the address on the instance until it is gone: the next tick releases it
    if (m.allocationId) return
  }
  if (m.allocationId) {
    try {
      await p.compute.releaseAddress(m.allocationId)
    } catch (e) {
      p.log.warn('fleet: address not released yet', { machineId: m.id, error: String(e) })
      return
    }
  }
  if (!(await p.store.deleteMachine(m))) return
  // keep this month's awake time with the person (docs/FLEET.md §5)
  const month = monthOf(p.now())
  if (m.month === month && m.awakeSeconds > 0) {
    const u = await p.store.getUser(m.userId)
    if (u) {
      const before = u.usage?.month === month ? u.usage.awakeSeconds : 0
      await p.store.putUser({ ...u, usage: { month, awakeSeconds: Math.max(before, m.awakeSeconds) } }, u.keyHash)
    }
  }
  p.log.info('fleet: deleted', { machineId: m.id })
}

// ---------------------------------------------------------------- reconcile

export interface ReconcileReport {
  machines: number
  stopped: string[]
  woken: string[]
  failed: string[]
  deleted: string[]
  orphans: string[]
  errors: string[]
}

export async function reconcile(p: Ports): Promise<ReconcileReport> {
  const out: ReconcileReport = { machines: 0, stopped: [], woken: [], failed: [], deleted: [], orphans: [], errors: [] }
  const now = p.now()
  const machines = await p.store.listMachines()
  out.machines = machines.length
  const ids = machines.map((m) => m.instanceId).filter((x): x is string => !!x)
  const instances = ids.length ? await p.compute.describe(ids) : new Map<string, InstanceInfo>()

  for (const m0 of machines) {
    try {
      await one(m0)
    } catch (e) {
      if (e instanceof Conflict) continue
      out.errors.push(`${m0.id}: ${e instanceof Error ? e.message : String(e)}`)
      p.log.warn('fleet: reconcile failed for a machine', { machineId: m0.id, error: e instanceof Error ? e.message : String(e) })
    }
  }

  async function one(m0: MachineRec): Promise<void> {
    const i = m0.instanceId ? (instances.get(m0.instanceId) ?? null) : null
    if (m0.state === 'deleting') {
      await finishDelete(p, m0, i)
      if (!(await p.store.getMachine(m0.userId))) out.deleted.push(m0.id)
      return
    }
    // a create in flight owns its record until it is 'starting'
    if (m0.state === 'creating') {
      if (now.getTime() - ms(m0.updatedAt) > minutes(CREATING_STUCK_MIN)) {
        await save(p, m0, { state: 'failed', error: 'The machine could not be made. Make it again.' })
        out.failed.push(m0.id)
      }
      return
    }
    // awake hours: only what this tick saw, never more than MAX_TICK_S; written only while AWS bills it
    let m = m0
    const month = monthOf(now)
    if ((i && AWAKE.includes(i.state)) || m0.month !== month) {
      let awakeSeconds = m0.month === month ? m0.awakeSeconds : 0
      if (i && AWAKE.includes(i.state)) awakeSeconds += Math.max(0, Math.min(MAX_TICK_S, (now.getTime() - ms(m0.lastTickAt ?? now.toISOString())) / 1000))
      m = await save(p, m0, { month, awakeSeconds: Math.round(awakeSeconds), lastTickAt: now.toISOString() })
    }

    const gone = !i || i.state === 'terminated' || i.state === 'shutting-down'
    const since = (iso: string | null) => now.getTime() - ms(iso)
    switch (m.state) {
      case 'starting': {
        if (gone) return void (await markFailed(m, 'The machine was removed at AWS. Make it again.', false))
        if (i!.state === 'stopped') {
          // a start that didn't take (capacity, or AWS stopped it): try again
          try {
            m = await wakeNow(p, m, 'retry')
            out.woken.push(m.id)
          } catch (e) {
            if (!(e instanceof CapacityError)) throw e
          }
          return
        }
        if (i!.state === 'running') await ensureAddress(m, i!)
        const limit = minutes(m.firstBoot ? p.config.firstBootMinutes : p.config.wakeMinutes)
        if (since(m.awakeSince) > limit) await markFailed(m, `The machine didn't come up in ${Math.round(limit / 60_000)} minutes.`, true)
        return
      }
      case 'running': {
        if (gone) return void (await markFailed(m, 'The machine was removed at AWS. Make it again.', false))
        if (i!.state === 'stopped' || i!.state === 'stopping') {
          await save(p, m, { state: i!.state === 'stopped' ? 'sleeping' : 'stopping', awakeSince: null, sleepReason: m.sleepReason ?? 'stopped at AWS', up: false })
          return
        }
        if (i!.state === 'running') await ensureAddress(m, i!)
        const reason = sleepReason(m)
        if (reason) {
          await stopNow(p, m, reason)
          out.stopped.push(m.id)
        }
        return
      }
      case 'stopping': {
        if (gone) return void (await markFailed(m, 'The machine was removed at AWS. Make it again.', false))
        if (i!.state === 'stopped') {
          m = await save(p, m, { state: 'sleeping', awakeSince: null })
          if (m.wakeRequested && hoursLeft(m, p.config, now)) {
            try {
              await wakeNow(p, m, 'asked while stopping')
              out.woken.push(m.id)
            } catch (e) {
              if (!(e instanceof CapacityError)) throw e
            }
          }
        } else if (i!.state === 'running' && since(m.updatedAt) > minutes(STOPPING_STUCK_MIN)) {
          await p.compute.stop(m.instanceId!)
        }
        return
      }
      case 'sleeping': {
        if (gone) return void (await markFailed(m, 'The machine was removed at AWS. Make it again.', false))
        if (i!.state === 'pending' || i!.state === 'running') {
          // started outside the fleet: account for it, and let the idle rule stop it again
          await save(p, m, { state: 'starting', awakeSince: now.toISOString(), lastWakeAt: now.toISOString() })
          return
        }
        if (m.wakeAt && ms(m.wakeAt) <= now.getTime() && i!.state === 'stopped') {
          if (!hoursLeft(m, p.config, now)) {
            await save(p, m, { wakeAt: null })
            return
          }
          try {
            await wakeNow(p, m, 'schedule')
            out.woken.push(m.id)
          } catch (e) {
            if (!(e instanceof CapacityError)) throw e
          }
        }
        return
      }
      case 'failed':
        // never pay for a broken machine
        if (i && (i.state === 'pending' || i.state === 'running')) await p.compute.stop(m.instanceId!)
        return
    }
  }

  function sleepReason(m: MachineRec): string | null {
    if (!hoursLeft(m, p.config, now)) return 'limit'
    const since = (iso: string | null) => now.getTime() - ms(iso)
    if (since(m.lastHeartbeatAt) > minutes(HEARTBEAT_STALE_MIN) && since(m.awakeSince) > minutes(HEARTBEAT_STALE_MIN)) return 'no heartbeat'
    if (m.activity?.busy) return null
    const last = Math.max(ms(m.activity?.lastActivityAt ?? null), ms(m.lastWakeAt), ms(m.awakeSince))
    return now.getTime() - last > minutes(p.config.idleMinutes) ? 'idle' : null
  }

  async function ensureAddress(m: MachineRec, i: InstanceInfo): Promise<void> {
    if (!m.allocationId || !m.ip || i.publicIp === m.ip) return
    await p.compute.associateAddress(m.allocationId, i.instanceId)
  }

  async function markFailed(m: MachineRec, error: string, withConsole: boolean): Promise<void> {
    let detail = ''
    if (withConsole && m.instanceId) {
      try {
        const tail = (await p.compute.consoleTail(m.instanceId))
          .split('\n')
          .filter((l) => l.includes('principia:'))
          .slice(-3)
          .join(' · ')
          .replace(/p[mf]t_[A-Za-z0-9_-]+/g, '[token]')
        if (tail) detail = ` Last step: ${tail.slice(0, 300)}`
      } catch {
        /* no console output yet */
      }
      await p.compute.stop(m.instanceId).catch(() => undefined)
    }
    await save(p, m, { state: 'failed', error: `${error}${detail}`, up: false })
    out.failed.push(m.id)
  }

  // ---------- orphans: what AWS has that no record knows ----------
  try {
    const tagged = await p.compute.listTagged()
    const known = new Set(machines.map((m) => m.instanceId).filter(Boolean))
    for (const i of tagged.instances) {
      if (known.has(i.instanceId) || i.state === 'terminated' || i.state === 'shutting-down') continue
      if (i.launchedAt && now.getTime() - ms(i.launchedAt) < minutes(ORPHAN_MIN)) continue
      await p.compute.terminate(i.instanceId)
      out.orphans.push(i.instanceId)
      p.log.warn('fleet: terminated an orphan instance', { instanceId: i.instanceId, machineId: i.machineId })
    }
    const knownAddr = new Set(machines.map((m) => m.allocationId).filter(Boolean))
    for (const a of tagged.addresses) {
      if (knownAddr.has(a.allocationId) || a.instanceId) continue
      // a create allocates the address a moment before it records it
      if (!a.createdAt || now.getTime() - ms(a.createdAt) < minutes(ORPHAN_MIN)) continue
      await p.compute.releaseAddress(a.allocationId)
      out.orphans.push(a.allocationId)
      p.log.warn('fleet: released an orphan address', { allocationId: a.allocationId, machineId: a.machineId })
    }
  } catch (e) {
    out.errors.push(`orphans: ${e instanceof Error ? e.message : String(e)}`)
  }
  return out
}
