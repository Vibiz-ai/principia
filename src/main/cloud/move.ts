/**
 * Principia Cloud: "Run in the cloud…" (docs/CLOUD.md §3 step 5, §7.1, §7.4, §7.5, §8).
 *
 * `buildMovePlan` says what a company can send and why the rest stays on this Mac. `moveCompany` sends exactly what
 * the user ticked, after re-checking every choice against a fresh plan (the renderer never names what gets sent):
 * the passport bundle (created on the workspace's host, then PassportSync takes over with the desktop grant), the
 * workflows (rewritten by exportForCloud, `baseRev` from the link; a 409 is reported as "changed in the cloud" unless
 * the user chose to overwrite), the schedules (placement cloud: the desktop stops firing them), the repos (https GitHub,
 * with the token typed in the checklist), and only the ticked keys and connections the selected workflows use, read
 * from the vault and the gateway in main. Unticked or unused secrets are never read, let alone sent.
 */
import { HiveError } from '../../shared/errors'
import type {
  CloudCompany,
  CloudWorkflow,
  CloudSchedule,
  PatchCompanyRequest,
  PutCompanyResponse,
  PutConnectionRequest,
  PutRepoRequest,
  PutScheduleRequest,
  PutWorkflowRequest,
  StartRunRequest,
  CloudRunSummary
} from '../../shared/cloud'
import type { GatewayConnection } from '../../shared/gateway'
import type { AgentProfile, CloudMoveChoices, CloudMoveItem, CloudMovePlan, CloudMoveResult, Id, Schedule, Workflow } from '../../shared/types'
import { CLOUD_BUNDLE_TIMEOUT_MS, CloudRequestError } from './client'
import type { CloudLink, PassportSyncPort } from './link'
import { companyConnections, exportForCloud, githubRemote, referencedKeys, repoFolder, usesAgents, workflowFileOf, type CloudRepoRef } from './exportForCloud'

export const GITHUB_TOKEN_URL = 'https://github.com/settings/personal-access-tokens/new'
export const PASSPORT_OFF = 'Your cloud agents read this company\'s Passport, and the Passport vault is off on this Mac. Turn it on first.'

export interface MoveDeps {
  link: CloudLink
  company(id: Id): { id: Id; name: string; slug: string; color: string | null }
  repos(companyId: Id): CloudRepoRef[]
  workflows(companyId: Id): Workflow[]
  schedules(companyId: Id): Schedule[]
  profiles(): Pick<AgentProfile, 'id' | 'adapter' | 'secretNames'>[]
  /** key names this company's runs can use (shared plus its own); never values */
  keyNames(companyId: Id): string[]
  /** values for exactly these names (main only) */
  keyValues(companyId: Id, names: string[]): Record<string, string>
  connections(): GatewayConnection[]
  /** a connection's stored env or headers (main only; GatewayService.exportCredentials) */
  connectionCredentials(id: string): Record<string, string>
  /** the company's `.passport.zip` (exportOpenPassport) */
  passportBundle(companyId: Id): Uint8Array
  passport: PassportSyncPort | null
  /** the Passport vault is on (a first move exports the company's passport from it); absent = assume on (tests) */
  passportReady?(): boolean
  /** `git remote get-url origin`, or null */
  gitRemote(repoPath: string): Promise<string | null>
  log?: { info(m: string, meta?: Record<string, unknown>): void; warn(m: string, meta?: Record<string, unknown>): void }
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))
const CONNECTION_ID = /^[a-zA-Z0-9_-]{1,64}$/

/** A workflow schedule (task-mode and prompt schedules are not in the cloud in v1). */
const workflowSchedule = (s: Schedule): s is Schedule & { target: { kind: 'workflow'; workflowId: Id; inputs: Record<string, string> } } =>
  s.target.kind === 'workflow' && s.target.mode !== 'task'

export async function buildMovePlan(d: MoveDeps, companyId: Id): Promise<CloudMovePlan> {
  const company = d.company(companyId)
  const repos = d.repos(companyId)
  const profiles = d.profiles()
  const known = d.keyNames(companyId)
  const workflows = d.workflows(companyId).map((wf) => {
    const x = exportForCloud(workflowFileOf(wf), repos, profiles)
    return { wf, x }
  })
  const okIds = new Set(workflows.filter((w) => w.x.ok).map((w) => w.wf.id))

  const keyUse = new Map<string, Id[]>()
  for (const { wf } of workflows.filter((w) => w.x.ok)) for (const k of referencedKeys(wf, known, profiles)) keyUse.set(k, [...(keyUse.get(k) ?? []), wf.id])

  const agentWorkflows = workflows.filter((w) => w.x.ok && usesAgents(w.wf)).map((w) => w.wf.id)
  const conns = agentWorkflows.length ? companyConnections(d.connections(), companyId, repos.map((r) => r.path)).filter((c) => CONNECTION_ID.test(c.id)) : []

  const repoRows = await Promise.all(
    repos.map(async (r) => {
      let remote: string | null = null
      try {
        remote = await d.gitRemote(r.path)
      } catch {
        remote = null
      }
      const gh = githubRemote(remote)
      return {
        id: r.id,
        name: r.name,
        url: gh?.url ?? null,
        ownerRepo: gh?.ownerRepo ?? null,
        ok: !!gh,
        reason: gh ? null : remote ? `${r.name} is not on GitHub. The cloud clones GitHub repos only for now.` : `${r.name} has no origin remote, so the cloud cannot clone it.`,
        tokenUrl: GITHUB_TOKEN_URL
      }
    })
  )

  const inCloud = d.link.isCloudCompany(companyId)
  // a first move sends the passport bundle, which needs the vault; a company already in the cloud keeps its passport
  const vaultOn = d.passportReady ? d.passportReady() : true
  return {
    companyId,
    companyName: company.name,
    inCloud,
    passport: inCloud || vaultOn ? { ready: true, reason: null } : { ready: false, reason: PASSPORT_OFF },
    workflows: workflows.map(({ wf, x }) => ({ id: wf.id, name: wf.name, ok: x.ok, reason: x.ok ? null : x.reasons[0], adapters: x.adapters })),
    schedules: d.schedules(companyId).map((s) => {
      const placement: 'local' | 'cloud' = d.link.ownsSchedule(s.id) ? 'cloud' : 'local'
      if (!workflowSchedule(s)) return { id: s.id, name: s.name, sentence: s.sentence, workflowId: null, ok: false, reason: 'Only workflow schedules run in the cloud for now.', placement }
      const wf = workflows.find((w) => w.wf.id === s.target.workflowId)
      const ok = okIds.has(s.target.workflowId)
      return { id: s.id, name: s.name, sentence: s.sentence, workflowId: s.target.workflowId, ok, reason: ok ? null : `It runs ${wf?.wf.name ?? 'a workflow'}, which stays on this Mac.`, placement }
    }),
    repos: repoRows,
    needs: {
      keys: [...keyUse].map(([name, usedBy]) => ({ name, usedBy })).sort((a, b) => a.name.localeCompare(b.name)),
      connections: conns.filter((c) => c.authentication !== 'oauth').map((c) => ({ id: c.id, name: c.name, hasCredentials: c.hasCredentials, usedBy: agentWorkflows }))
    },
    oauth: conns.filter((c) => c.authentication === 'oauth').map((c) => ({ id: c.id, name: c.name, usedBy: agentWorkflows }))
  }
}

/** Base64 without Buffer pooling surprises. */
const b64 = (u: Uint8Array): string => Buffer.from(u.buffer, u.byteOffset, u.byteLength).toString('base64')

export async function moveCompany(d: MoveDeps, choices: CloudMoveChoices): Promise<CloudMoveResult> {
  const { companyId } = choices
  const plan = await buildMovePlan(d, companyId)
  const items: CloudMoveItem[] = []
  const push = (i: CloudMoveItem): void => void items.push(i)
  const company = d.company(companyId)
  const cid = { cid: companyId }

  // what may be sent: the intersection of the ticks with a fresh plan, never the renderer's word alone
  const wfOk = new Set(plan.workflows.filter((w) => w.ok).map((w) => w.id))
  const selectedWf = choices.workflows.filter((id) => wfOk.has(id))
  const selected = new Set(selectedWf)
  const keyNeeded = new Set(plan.needs.keys.filter((k) => k.usedBy.some((w) => selected.has(w))).map((k) => k.name))
  const keys = [...new Set(choices.keys)].filter((k) => keyNeeded.has(k))
  const connNeeded = new Map(plan.needs.connections.filter((c) => c.usedBy.some((w) => selected.has(w))).map((c) => [c.id, c]))
  const connections = [...new Set(choices.connections)].filter((c) => connNeeded.has(c))
  const oauth = plan.oauth.filter((c) => c.usedBy.some((w) => selected.has(w)))
  const repoOk = new Map(plan.repos.filter((r) => r.ok).map((r) => [r.id, r]))
  const repos = choices.repos.filter((r) => repoOk.has(r.id))
  const schedOk = new Map(plan.schedules.filter((s) => s.ok && s.workflowId && (selected.has(s.workflowId) || plan.inCloud)).map((s) => [s.id, s]))
  const schedules = [...new Set(choices.schedules)].filter((s) => schedOk.has(s))

  // 0. the passport comes from the vault: refuse before anything is sent, never at the last step (CLOUD.md §7.1)
  if (plan.passport && !plan.passport.ready) {
    push({ kind: 'passport', id: companyId, name: 'Passport', status: 'failed', message: plan.passport.reason })
    return { items, company: null }
  }

  // 1. the company and its passport (Open Passport connected by default, CLOUD.md §7.1)
  let cloudCompany: CloudCompany | null = null
  try {
    const first = !d.link.isCloudCompany(companyId)
    const res = await d.link.call((c) =>
      c.call<PutCompanyResponse>('companyPut', {
        params: cid,
        body: { name: company.name, slug: company.slug, color: company.color, ...(first ? { passportBundle: b64(d.passportBundle(companyId)) } : {}) },
        timeoutMs: CLOUD_BUNDLE_TIMEOUT_MS
      })
    )
    cloudCompany = res.company
    d.link.markCompany(companyId, { passportId: res.company.passport?.passportId ?? null, hostUrl: res.company.passport?.hostUrl ?? null })
    push({ kind: 'company', id: companyId, name: company.name, status: 'done', message: null })
    const grant = res.desktopPassportGrant
    if (grant && d.passport) {
      try {
        await d.passport.configure(companyId, grant)
        await d.passport.sync(companyId)
        push({ kind: 'passport', id: grant.passportId, name: 'Passport', status: 'done', message: 'Created on your host and synced with this Mac.' })
      } catch (e) {
        push({ kind: 'passport', id: grant.passportId, name: 'Passport', status: 'failed', message: `Created in the cloud, but this Mac could not sync it yet: ${errText(e)}` })
      }
    } else {
      push({ kind: 'passport', id: res.company.passport?.passportId ?? '', name: 'Passport', status: res.company.passport ? 'done' : 'failed', message: res.company.passport ? null : 'The cloud has no passport host for this company yet.' })
    }
  } catch (e) {
    push({ kind: 'company', id: companyId, name: company.name, status: 'failed', message: errText(e) })
    return { items, company: null }
  }

  // 2. repos (the token was typed in the checklist; it goes to the cloud and nowhere else)
  for (const r of repos) {
    const row = repoOk.get(r.id)!
    const body: PutRepoRequest = { name: repoFolder(row.name), url: row.url!, branch: null, credential: r.token ? { kind: 'github_pat', value: r.token } : { kind: 'public' } }
    try {
      await d.link.call((c) => c.call('repoPut', { params: { ...cid, rid: r.id }, body }))
      await d.link.call((c) => c.call('repoSync', { params: { ...cid, rid: r.id } })).catch(() => undefined)
      push({ kind: 'repo', id: r.id, name: row.ownerRepo ?? row.name, status: 'done', message: null })
    } catch (e) {
      push({ kind: 'repo', id: r.id, name: row.ownerRepo ?? row.name, status: 'failed', message: errText(e) })
    }
  }

  // 3. keys: only the ticked names the selected workflows use; values read here, in main
  const values = keys.length ? d.keyValues(companyId, keys) : {}
  for (const name of keys) {
    const value = values[name]
    if (!value) {
      push({ kind: 'key', id: name, name, status: 'failed', message: `${name} has no value on this Mac.` })
      continue
    }
    try {
      await d.link.call((c) => c.call('secretPut', { params: { ...cid, name }, body: { value } }))
      push({ kind: 'key', id: name, name, status: 'done', message: null })
    } catch (e) {
      push({ kind: 'key', id: name, name, status: 'failed', message: errText(e) })
    }
  }

  // 4. connections: ticked header ones with their stored credentials; OAuth ones without (they authorize in the cloud)
  const all = d.connections()
  const putConnection = async (conn: GatewayConnection, withCredentials: boolean): Promise<void> => {
    const body: PutConnectionRequest = {
      name: conn.name,
      transport: conn.transport,
      ...(conn.command ? { command: conn.command } : {}),
      ...(conn.args ? { args: conn.args } : {}),
      ...(conn.url ? { url: conn.url } : {}),
      enabled: true,
      authentication: conn.authentication === 'oauth' ? 'oauth' : conn.hasCredentials ? 'headers' : 'none',
      ...(withCredentials && conn.hasCredentials ? { credentials: d.connectionCredentials(conn.id) } : {})
    }
    await d.link.call((c) => c.call('connectionPut', { params: { ...cid, id: conn.id }, body }))
  }
  for (const id of connections) {
    const conn = all.find((c) => c.id === id)
    if (!conn) continue
    try {
      await putConnection(conn, true)
      push({ kind: 'connection', id, name: conn.name, status: 'done', message: null })
    } catch (e) {
      push({ kind: 'connection', id, name: conn.name, status: 'failed', message: errText(e) })
    }
  }
  for (const o of oauth) {
    const conn = all.find((c) => c.id === o.id)
    if (!conn) continue
    try {
      await putConnection(conn, false)
      push({ kind: 'connection', id: o.id, name: conn.name, status: 'done', message: 'Authorize it in the cloud to finish.' })
    } catch (e) {
      push({ kind: 'connection', id: o.id, name: conn.name, status: 'failed', message: errText(e) })
    }
  }

  // 5. workflows, with baseRev; 409 = changed in the cloud since this Mac sent it
  const profiles = d.profiles()
  const repoRefs = d.repos(companyId)
  const workflows = d.workflows(companyId)
  for (const id of selectedWf) {
    const wf = workflows.find((w) => w.id === id)
    if (!wf) continue
    const x = exportForCloud(workflowFileOf(wf), repoRefs, profiles)
    if (!x.ok) {
      push({ kind: 'workflow', id, name: wf.name, status: 'skipped', message: x.reasons[0] })
      continue
    }
    // every key this workflow uses, ticked or not: readiness flags the ones that were not sent (CLOUD.md §7.9)
    const declared = plan.needs.keys.filter((k) => k.usedBy.includes(id)).map((k) => k.name)
    const put = (baseRev: number | null) => d.link.call((c) => c.call<CloudWorkflow>('workflowPut', { params: { ...cid, wid: id }, body: { file: x.file, baseRev, ...(declared.length ? { keys: declared } : {}) } satisfies PutWorkflowRequest }))
    try {
      let out: CloudWorkflow
      try {
        out = await put(d.link.workflowRev(id))
      } catch (e) {
        if (!(e instanceof CloudRequestError && e.cloudCode === 'conflict')) throw e
        if (!choices.overwrite?.includes(id)) {
          push({ kind: 'workflow', id, name: wf.name, status: 'conflict', message: 'Changed in the cloud since this Mac sent it.' })
          continue
        }
        out = await put(e.rev ?? (await currentWorkflowRev(d, companyId, id)))
      }
      d.link.setWorkflowRev(id, out.rev)
      push({ kind: 'workflow', id, name: wf.name, status: 'done', message: out.problems?.length ? out.problems[0] : null })
    } catch (e) {
      push({ kind: 'workflow', id, name: wf.name, status: 'failed', message: errText(e) })
    }
  }

  // 6. schedules: ticked ones fire in the cloud from now on; ones the user unticked come back to this Mac
  const local = d.schedules(companyId)
  const sendSchedule = async (s: Schedule & { target: { kind: 'workflow'; workflowId: Id; inputs: Record<string, string> } }, placement: 'local' | 'cloud'): Promise<CloudSchedule> => {
    const body = (baseRev: number | null): PutScheduleRequest => ({
      schedule: { name: s.name, when: s.when, target: { kind: 'workflow', workflowId: s.target.workflowId, inputs: s.target.inputs ?? {} }, enabled: s.enabled },
      placement,
      baseRev
    })
    try {
      return await d.link.call((c) => c.call<CloudSchedule>('schedulePut', { params: { ...cid, sid: s.id }, body: body(d.link.scheduleRev(s.id)) }))
    } catch (e) {
      // the desktop is the source of truth for schedules (CLOUD.md §8): a stale rev retries once on the server's
      if (!(e instanceof CloudRequestError && e.cloudCode === 'conflict' && e.rev !== undefined)) throw e
      return await d.link.call((c) => c.call<CloudSchedule>('schedulePut', { params: { ...cid, sid: s.id }, body: body(e.rev!) }))
    }
  }
  for (const id of schedules) {
    const s = local.find((x) => x.id === id)
    if (!s || !workflowSchedule(s)) continue
    try {
      const out = await sendSchedule(s, 'cloud')
      d.link.setSchedulePlacement(id, 'cloud', out.rev)
      push({ kind: 'schedule', id, name: s.name, status: 'done', message: null })
    } catch (e) {
      push({ kind: 'schedule', id, name: s.name, status: 'failed', message: errText(e) })
    }
  }
  for (const row of plan.schedules.filter((r) => r.placement === 'cloud' && !schedules.includes(r.id))) {
    const s = local.find((x) => x.id === row.id)
    if (!s || !workflowSchedule(s)) continue
    try {
      const out = await sendSchedule(s, 'local')
      d.link.setSchedulePlacement(row.id, 'local', out.rev)
      push({ kind: 'schedule', id: row.id, name: s.name, status: 'done', message: 'Back on this Mac.' })
    } catch (e) {
      push({ kind: 'schedule', id: row.id, name: s.name, status: 'failed', message: errText(e) })
    }
  }

  // 7. what the cloud thinks now (readiness included)
  try {
    const list = await d.link.call((c) => c.call<CloudCompany[] | { companies: CloudCompany[] }>('companies'))
    const arr = Array.isArray(list) ? list : (list?.companies ?? [])
    cloudCompany = arr.find((c) => c.id === companyId) ?? cloudCompany
  } catch {
    /* keep the PUT's answer */
  }
  d.log?.info('cloud: company moved', { companyId, sent: items.filter((i) => i.status === 'done').length, failed: items.filter((i) => i.status === 'failed').length })
  return { items, company: cloudCompany }
}

async function currentWorkflowRev(d: MoveDeps, companyId: Id, wid: Id): Promise<number | null> {
  const list = await d.link.call((c) => c.call<CloudWorkflow[] | { workflows: CloudWorkflow[] }>('workflows', { params: { cid: companyId } }))
  const arr = Array.isArray(list) ? list : (list?.workflows ?? [])
  return arr.find((w) => w.id === wid)?.rev ?? null
}

/** "Run once now": the company's first runnable cloud workflow (or the one named), trigger desktop. */
export async function runOnce(d: Pick<MoveDeps, 'link'>, companyId: Id, workflowId?: Id | null): Promise<CloudRunSummary> {
  let wid = workflowId ?? null
  if (!wid) {
    const list = await d.link.call((c) => c.call<CloudWorkflow[] | { workflows: CloudWorkflow[] }>('workflows', { params: { cid: companyId } }))
    const arr = Array.isArray(list) ? list : (list?.workflows ?? [])
    wid = arr.find((w) => !w.problems?.length)?.id ?? null
  }
  if (!wid) throw new HiveError('conflict', 'This company has no workflow ready to run in the cloud.')
  const body: StartRunRequest = { kind: 'workflow', workflowId: wid }
  return d.link.call((c) => c.call<CloudRunSummary>('runStart', { params: { cid: companyId }, body }))
}

/**
 * "Run now" on a schedule placed in the cloud (CLOUD.md §8: each schedule fires in exactly one place): the run starts
 * in the cloud through the control plane, with the schedule's own workflow and inputs. Never a local run.
 */
export async function runScheduleInCloud(d: Pick<MoveDeps, 'link'>, s: Pick<Schedule, 'id' | 'name' | 'target' | 'companyId'>): Promise<CloudRunSummary> {
  if (s.target.kind !== 'workflow') throw new HiveError('conflict', `"${s.name}" runs in the cloud, which runs workflow schedules only.`)
  if (!s.companyId) throw new HiveError('conflict', `"${s.name}" has no company, so the cloud cannot run it.`)
  const body: StartRunRequest = { kind: 'workflow', workflowId: s.target.workflowId, ...(s.target.inputs && Object.keys(s.target.inputs).length ? { inputs: s.target.inputs } : {}) }
  const run = await d.link.call((c) => c.call<CloudRunSummary>('runStart', { params: { cid: s.companyId! }, body }))
  void d.link.pollNow().catch(() => undefined)
  return run
}

/**
 * "Bring back to this Mac": the company is paused in the cloud first (its runs are canceled and its triggers parked,
 * so nothing writes the passport any more), its schedules fire here again (placement local), PassportSync pulls the
 * final passport revision while the desktop grant still works, and only then is the company deleted from the cloud
 * (the host revokes the grants) and the desktop's PassportSync config for the cloud's passport removed. When that last
 * sync fails nothing is deleted: the company stays paused in the cloud and bringing it back again retries.
 */
export async function bringBack(d: Pick<MoveDeps, 'link' | 'schedules' | 'passport'>, companyId: Id): Promise<void> {
  await d.link.call((c) => c.call('companyPatch', { params: { cid: companyId }, body: { paused: true } satisfies PatchCompanyRequest }))
  const owned = d.schedules(companyId).filter((s) => d.link.ownsSchedule(s.id))
  for (const s of owned) {
    if (!workflowSchedule(s)) continue
    try {
      await d.link.call((c) =>
        c.call('schedulePut', {
          params: { cid: companyId, sid: s.id },
          body: { schedule: { name: s.name, when: s.when, target: { kind: 'workflow', workflowId: s.target.workflowId, inputs: s.target.inputs ?? {} }, enabled: s.enabled }, placement: 'local', baseRev: d.link.scheduleRev(s.id) } satisfies PutScheduleRequest
        })
      )
    } catch {
      /* the delete below removes it anyway */
    }
  }
  const passport = d.link.cloudCompany(companyId)
  if (passport?.passportId && d.passport?.configured(companyId)) {
    try {
      await d.passport.sync(companyId)
    } catch (e) {
      throw new HiveError('conflict', `Could not bring the latest Passport back from the cloud (${errText(e)}). The company is paused in the cloud and nothing was deleted; try again.`)
    }
  }
  await d.link.call((c) => c.call('companyDelete', { params: { cid: companyId } }))
  d.link.unmarkCompany(companyId, owned.map((s) => s.id))
  if (passport?.passportId && d.passport?.clear) await Promise.resolve(d.passport.clear(companyId, passport.passportId)).catch(() => undefined)
}
