/**
 * Business-first onboarding IPC (docs/ONBOARDING.md §4): metadata and read-only intake until launch, then the launch
 * transaction (onboarding/launch.ts) over the same create paths the other handlers use.
 *
 * - Keys cross IPC once (`onboarding:key` check) into the main-memory stash; the value is never echoed, logged or
 *   journaled. The stash is cleared and live plan calls are killed when the window closes and on quit.
 * - `onboarding:plan` recomputes what is available (keys present in Shared or stashed by this handler, installed
 *   adapters, the departments consent); the renderer cannot claim more.
 * - On registration, a launch left `running` by a quit or crash is marked failed (§7.4).
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { app, BrowserWindow, dialog, safeStorage } from 'electron'
import { departmentsEnabled, PERSONAL_COMPANY_ID } from '../../shared/company'
import { HiveError } from '../../shared/errors'
import {
  PLAN_ADAPTERS,
  VIBIZ_WAITLIST_URL,
  WORKFLOW_KEY_NAMES,
  workflowsForKeys,
  type BundledWorkflowId,
  type OnboardingAvailable,
  type OnboardingKeyName,
  type OnboardingStatus,
  type PlanAdapter,
  type PlanInput,
  type WorkflowKeyName
} from '../../shared/onboarding'
import type { ProviderInfo } from '../../shared/types'
import type { DB } from '../db'
import { CompanySecrets, KeyNamespaces } from '../db/companySecrets'
import type { Hive } from '../hive'
import { emit, handle } from '../ipc'
import { log } from '../log'
import { screenText } from '../memory/screen'
import { claudeCliAvailable } from '../oneshot'
import { clone, ghStatus, listRepos } from '../onboarding/github'
import { JournalStore, journalMeta } from '../onboarding/journal'
import { checkAndStash, keyStash, type KeyStash } from '../onboarding/keys'
import { LaunchService, type LaunchDeps } from '../onboarding/launch'
import { PlanService } from '../onboarding/plan'
import { inspectFolders, runScan, type FolderStore } from '../onboarding/scan'
import { fetchSite } from '../onboarding/site'
import { resourcePath } from '../tray'
import { createTaskGuarded, departmentActions } from './company'
import { installFromMarketplace } from './marketplace'
import { addRepoPaths } from './repos'
import { createSchedule, removeSchedule, setScheduleEnabled } from './schedules'

/** §2 S1a: "Clone into ~/Projects". */
export function defaultCloneDir(): string {
  return path.join(os.homedir(), 'Projects')
}

/**
 * §1 first run is for a new install only: any row a person made (a repo, a session, a run, a workflow that is not a
 * first-launch seed, a schedule, a task, a key) means an existing user, who is never put through the flow. A table
 * that cannot be read counts as data (fail closed: when in doubt, do not interrupt).
 */
const USER_DATA_QUERIES = [
  'SELECT 1 FROM repos LIMIT 1',
  'SELECT 1 FROM sessions LIMIT 1',
  'SELECT 1 FROM runs LIMIT 1',
  'SELECT 1 FROM workflows WHERE seed_key IS NULL LIMIT 1',
  'SELECT 1 FROM schedules LIMIT 1',
  'SELECT 1 FROM company_tasks LIMIT 1',
  'SELECT 1 FROM secrets LIMIT 1',
  'SELECT 1 FROM company_secrets LIMIT 1'
] as const
export function hasUserData(db: Pick<DB, 'prepare'>): boolean {
  for (const sql of USER_DATA_QUERIES) {
    try {
      if (db.prepare(sql).get() !== undefined) return true
    } catch {
      return true
    }
  }
  return false
}

/** Installed non-shell adapters a profile agent can use. */
export function installedAdapters(providers: readonly ProviderInfo[]): PlanAdapter[] {
  return PLAN_ADAPTERS.filter((a) => providers.some((p) => p.id === a && p.available))
}

/** The bundled workflows whose key is present: Shared, or checked into the stash by this flow (and still alive). */
export function availableFor(input: Pick<PlanInput, 'hasCode' | 'keys' | 'departmentsOn'>, ctx: { sharedHas: (k: WorkflowKeyName) => boolean; stashed: (k: OnboardingKeyName) => boolean; adapters: PlanAdapter[]; flagsOn: boolean }): OnboardingAvailable {
  const present: Partial<Record<WorkflowKeyName, boolean>> = {}
  for (const k of WORKFLOW_KEY_NAMES) present[k] = ctx.sharedHas(k)
  // the renderer's claim counts only when main holds a live stashed key of that name
  if (input.keys.fal && ctx.stashed('FAL_KEY')) present.FAL_KEY = true
  if (input.keys.openai && ctx.stashed('OPENAI_API_KEY')) present.OPENAI_API_KEY = true
  return { workflows: workflowsForKeys(present), profileAdapters: ctx.adapters, hasCode: input.hasCode, departmentsOn: ctx.flagsOn || input.departmentsOn }
}

/** The name a bundled workflow installs under (its .hive.json `workflow.name`), or null when unreadable. */
export function bundledWorkflowName(id: BundledWorkflowId): string | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(resourcePath('marketplace'), 'workflows', `${id}.hive.json`), 'utf8')) as { workflow?: { name?: unknown } }
    return typeof raw.workflow?.name === 'string' ? raw.workflow.name.trim() : null
  } catch {
    return null
  }
}

/**
 * The launch transaction's service layer over a Hive: the same create paths the IPC handlers use (createTaskGuarded,
 * departmentActions, addRepoPaths, installFromMarketplace, createSchedule, the key namespaces, the passport runtime).
 * Exported for the integration test, which passes a Hive built from real stores.
 */
export function onboardingLaunchDeps(h: Hive, o: { journal: JournalStore; keys: KeyNamespaces; providers: () => readonly ProviderInfo[]; stash?: KeyStash }): LaunchDeps {
  const { journal, keys } = o
  const changed = (domains: Parameters<LaunchDeps['changed']>[0]) => {
    for (const domain of domains) emit('data:changed', { domain })
    h.statusChanged()
  }
  const deptActions = departmentActions(h)
  return {
    store: h.store,
    company: h.company,
    journal,
    stash: o.stash ?? keyStash,
    settings: () => h.settings(),
    updateSettings: (patch) => h.updateSettings(patch),
    memory: () => {
      const m = h.memory
      try {
        return m && m.vaultMode() ? m.passport() : null
      } catch {
        return null
      }
    },
    departments: deptActions,
    createTask: (task) => createTaskGuarded(h, task),
    addRepoPaths: (paths, companyId) => addRepoPaths(h, paths, companyId),
    clone: (src, parentDir, onProgress, opts) => clone(src, parentDir, onProgress, { redact: (t) => h.vault.redact(t), createParent: opts.createParent }),
    defaultCloneDir: defaultCloneDir(),
    keys: {
      set: (companyId, name, value) => {
        // KeyNamespaces.set with no space writes Shared: an onboarding key only ever goes to its own business
        if (!companyId || companyId === PERSONAL_COMPANY_ID) throw new HiveError('forbidden', 'A key from setup is saved only to its business')
        void keys.set(companyId, name, value)
      },
      remove: (companyId, name) => keys.remove(companyId, name),
      sharedHas: (name) => h.safe(() => h.vault.list().some((m) => m.name === name), false)
    },
    installWorkflow: async (id: BundledWorkflowId, companyId) => {
      // a crash between the install and its journal entry left it installed: adopt it instead of a second copy
      const name = bundledWorkflowName(id)?.toLowerCase()
      const adopted = name ? h.store.listWorkflows(companyId).find((wf) => wf.name.trim().toLowerCase() === name) : undefined
      if (adopted) return adopted.id
      const r = await installFromMarketplace(h, { source: 'builtin', id, companyId })
      if (!('workflowId' in r)) throw new HiveError('internal', `${id} is not a workflow`)
      return r.workflowId
    },
    removeWorkflow: (id) => {
      h.company.departments.assertNotBacking('workflow', id)
      h.store.removeWorkflow(id)
      h.author?.onWorkflowRemoved(id)
      emit('data:changed', { domain: 'workflows' })
    },
    createSchedule: (input) => createSchedule(h, input),
    removeSchedule: (id) => removeSchedule(h, id),
    setScheduleEnabled: (id, enabled) => void setScheduleEnabled(h, id, enabled),
    profileAdapters: () => installedAdapters(o.providers()),
    emitProgress: (e) => emit('onboarding:progress', e),
    emitClone: (e) => emit('onboarding:cloneProgress', e),
    changed,
    pump: (companyId) => void h.dispatcher?.pump(companyId),
    redact: (t) => h.vault.redact(t),
    screen: (t) => screenText(null, t)?.label ?? null,
    log
  }
}

export function registerOnboardingHandlers(h: Hive): void {
  const journal = new JournalStore(h.store)
  try {
    const interrupted = journal.markInterrupted()
    if (interrupted.length) log.warn('onboarding: launch interrupted by quit or crash', { journals: interrupted })
  } catch (e) {
    log.warn('onboarding: journal check failed', { e: String(e) })
  }

  // a separate CompanySecrets instance, so the Keys handlers' change listener stays theirs
  const keys = new KeyNamespaces(
    h.vault,
    new CompanySecrets(h.db, {
      available: () => safeStorage.isEncryptionAvailable(),
      encrypt: (s: string) => safeStorage.encryptString(s),
      decrypt: (b: Buffer) => safeStorage.decryptString(b)
    }),
    () => h.memory?.refreshFingerprints()
  )
  const sharedHas = (name: WorkflowKeyName) => h.safe(() => h.vault.list().some((m) => m.name === name), false)

  let providers: ProviderInfo[] = []
  const loadProviders = async (): Promise<ProviderInfo[]> => {
    try {
      providers = await h.engine.providers.list()
    } catch {
      /* keep the last list */
    }
    return providers
  }

  /** stashId → key name, for the stash entries this flow made (KeyStash only answers by id). */
  const issued = new Map<string, OnboardingKeyName>()
  const stashed = (name: OnboardingKeyName) => {
    for (const [id, n] of issued) {
      if (!keyStash.has(id)) issued.delete(id)
      else if (n === name) return true
    }
    return false
  }

  const plans = new PlanService({
    providers: () => providers,
    redact: (t) => h.vault.redact(t)
  })

  const launch = new LaunchService(onboardingLaunchDeps(h, { journal, keys, providers: () => providers }))

  const folderStore: FolderStore = {
    getRepoByPath: (p) => {
      const r = h.store.getRepoByPath(p)
      return r ? { id: r.id, companyId: h.company.companyForRepo(r.id).id } : null
    },
    companyName: (id) => h.company.listPassports({ includeArchived: true }).find((c) => c.id === id)?.name ?? null
  }
  const redact = (t: string) => h.vault.redact(t)

  handle('onboarding:status', async (): Promise<OnboardingStatus> => {
    const list = await loadProviders()
    const settings = h.settings()
    const gh = await ghStatus().catch(() => ({ gh: 'missing' as const }))
    const own = h.company.listPassports().filter((c) => c.id !== PERSONAL_COMPANY_ID && c.system !== 'personal')
    const latest = journal.latest()
    return {
      firstRun: !settings.onboardingDone && own.length === 0 && !hasUserData(h.db),
      journal: latest ? journalMeta(latest) : null,
      providers: list.filter((p) => p.id !== 'shell').map((p) => ({ adapter: p.id, installed: p.available })),
      claudeCli: !!claudeCliAvailable(list),
      flags: settings.experimental ?? {},
      sharedKeys: { FAL_KEY: sharedHas('FAL_KEY'), OPENAI_API_KEY: sharedHas('OPENAI_API_KEY'), FIRECRAWL_API_KEY: sharedHas('FIRECRAWL_API_KEY') },
      gh: gh.gh,
      ...('login' in gh && gh.login ? { ghLogin: gh.login } : {}),
      defaultCloneDir: defaultCloneDir(),
      waitlistUrl: VIBIZ_WAITLIST_URL
    }
  })

  handle('onboarding:pickFolders', async (_q, sender) => {
    const win = BrowserWindow.fromWebContents(sender)
    const opts: Electron.OpenDialogOptions = { title: 'Choose your code folders', buttonLabel: 'Choose', properties: ['openDirectory', 'multiSelections'] }
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    if (r.canceled || !r.filePaths.length) return []
    // adds nothing: repos are attached at launch
    return inspectFolders(r.filePaths, folderStore)
  })
  handle('onboarding:inspectFolders', ({ paths }) => inspectFolders(paths, folderStore))
  handle('onboarding:scan', (req) => runScan(req, { redact }))
  handle('onboarding:fetchSite', ({ url }) => fetchSite(url, { redact }))
  handle('onboarding:github', (req) => listRepos(req.query, { redact }))
  handle('onboarding:pickCloneDir', async (_q, sender) => {
    const win = BrowserWindow.fromWebContents(sender)
    const opts: Electron.OpenDialogOptions = { title: 'Clone into', buttonLabel: 'Choose', defaultPath: defaultCloneDir(), properties: ['openDirectory', 'createDirectory'] }
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    return r.canceled || !r.filePaths[0] ? null : r.filePaths[0]
  })
  handle('onboarding:key', async (req) => {
    if (req.op === 'forget') {
      keyStash.forget(req.stashIds)
      for (const id of req.stashIds) issued.delete(id)
      return undefined
    }
    const result = await checkAndStash(req.name, req.value)
    if (result.stashId) issued.set(result.stashId, req.name)
    return result
  })
  handle('onboarding:plan', async ({ requestId, input, useAgent }) => {
    await loadProviders()
    const available = availableFor(input, { sharedHas, stashed, adapters: installedAdapters(providers), flagsOn: departmentsEnabled(h.settings().experimental) })
    // the plan is made for what main knows, not what the renderer claimed
    const checked: PlanInput = { ...input, hasCode: available.hasCode, departmentsOn: available.departmentsOn, keys: { fal: available.workflows.includes('generate-image-fal'), openai: available.workflows.includes('generate-image-openai') } }
    return plans.generate({ requestId, input: checked, available, useAgent })
  })
  handle('onboarding:cancelPlan', ({ requestId }) => plans.cancel(requestId))
  handle('onboarding:launch', async (req) => {
    await loadProviders()
    return launch.launch(req)
  })
  handle('onboarding:skipStep', async (req) => {
    await loadProviders()
    return launch.skipStep(req)
  })
  handle('onboarding:discard', (req) => launch.discard(req))
  handle('onboarding:start', (req) => launch.start(req))

  // keys never outlive the window, and plan calls never outlive their screen
  const wipe = () => {
    keyStash.clear()
    issued.clear()
    for (const id of plans.live()) void plans.cancel(id)
  }
  const watch = (win: BrowserWindow) => win.on('close', wipe)
  try {
    for (const win of BrowserWindow.getAllWindows()) watch(win)
    app.on('browser-window-created', (_e, win) => watch(win))
    app.on('will-quit', () => {
      keyStash.clear()
      issued.clear()
      void plans.shutdown()
      void launch.shutdown()
    })
  } catch (e) {
    log.warn('onboarding: lifecycle hooks unavailable', { e: String(e) })
  }
}
