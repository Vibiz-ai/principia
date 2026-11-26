/**
 * Principia Cloud, the desktop side wired to this Mac's Hive (docs/CLOUD.md §4.1 "Desktop link"): the CloudLink with
 * safeStorage, the PassportSync port (the existing Open Passport sync config and code), the move dependencies (store,
 * vault, gateway, git) and Mac-side account linking through node-pty. Built lazily by `Hive.cloud`.
 */
import { execFile } from 'node:child_process'
import dns from 'node:dns/promises'
import os from 'node:os'
import { app, safeStorage } from 'electron'
import type { CloudAdapter, ProviderTestResponse, PutProviderCredentialRequest } from '../../shared/cloud'
import type { Id } from '../../shared/types'
import type { Hive } from '../hive'
import { emit } from '../ipc'
import { log } from '../log'
import { baseChildEnv } from '../loginEnv'
import { which } from '../engine/util'
import { PassportSync } from '../memory/openPassportSync'
import { openPassportActions } from '../handlers/openPassport'
import { CloudLink, type PassportSyncPort } from './link'
import { AccountLogins, type LoginProc } from './logins'
import { CloudAccountsSync } from './accounts'
import { CloudLoginVault } from './loginVault'
import { ghToken } from '../onboarding/github'
import type { MoveDeps } from './move'
import { CloudMachines } from './machines'
import { runSsh, sshPublicKey } from './machines/local'
import { digitalocean, hetzner } from './machines/providers'
import { fleetClient } from './machines/fleet'
import { FLEET_URL } from '../../shared/machines'

export interface CloudWiring {
  link: CloudLink
  logins: AccountLogins
  move: MoveDeps
  /** docs/ACCOUNTS.md: GitHub and the Shared keys marked "In the cloud" */
  accounts: CloudAccountsSync
  /** docs/MACHINES.md: the cloud machine made from this Mac */
  machines: CloudMachines
  /** docs/FLEET.md §9: every cloud sign-in, kept encrypted on this Mac so a new machine is signed in by itself */
  loginVault: CloudLoginVault
}

/** node-pty loads its native binding on import: load it at the first sign-in only (tests build a Hive without it). */
const loadPty = (): typeof import('node-pty') => require('node-pty') as typeof import('node-pty')

const cipher = {
  available: () => safeStorage.isEncryptionAvailable(),
  encrypt: (s: string) => safeStorage.encryptString(s),
  decrypt: (b: Buffer) => safeStorage.decryptString(b)
}

/** `git -C <path> remote get-url origin`, 5 s, or null. */
export function gitRemote(repoPath: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('git', ['-C', repoPath, 'remote', 'get-url', 'origin'], { timeout: 5000, env: baseChildEnv() }, (err, stdout) => resolve(err ? null : stdout.trim() || null))
  })
}

export function createCloud(h: Hive): CloudWiring {
  const userData = h.paths.userData
  const op = () => openPassportActions(h)
  const passport: PassportSyncPort = {
    async configure(companyId, cfg) {
      await op().sync({ op: 'set', companyId, url: cfg.url, passportId: cfg.passportId, token: cfg.token }, userData)
    },
    async sync(companyId) {
      const r = await op().sync({ op: 'sync', companyId }, userData)
      emit('data:changed', { domain: 'company' })
      return r
    },
    configured: (companyId) => {
      const fail = (): never => {
        throw new Error('read only')
      }
      return !!new PassportSync({ userData, exportZip: fail, merge: fail, remember: fail }).config(companyId)
    },
    async clear(companyId, passportId) {
      const fail = (): never => {
        throw new Error('read only')
      }
      const c = new PassportSync({ userData, exportZip: fail, merge: fail, remember: fail }).config(companyId)
      if (c?.passportId === passportId) await op().sync({ op: 'clear', companyId }, userData)
    }
  }

  const link = new CloudLink({
    userData,
    cipher,
    passport,
    emit: (e) => emit('cloud', e),
    // a schedule back on this Mac starts from its next slot: the ones the cloud owned are neither missed nor caught up
    released: (ids) => {
      for (const id of ids) h.safe(() => h.engine.scheduler.upsert(id), undefined)
    },
    log,
    // a sleeping managed cloud wakes when a change can't get through (docs/FLEET.md)
    wake: (): Promise<boolean> => machines.wakeForUse(),
    asleep: (): boolean => machines.view()?.power === 'asleep'
  })

  const loginVault = new CloudLoginVault({ userData, cipher })
  const logins = new AccountLogins({
    spawn: (file, args, opts): LoginProc => {
      // wide columns: the token is printed on one line and never wrapped
      const p = loadPty().spawn(file, args, { name: 'xterm-256color', cols: 400, rows: 40, cwd: opts.cwd, env: opts.env })
      return {
        onData: (cb) => void p.onData(cb),
        onExit: (cb) => void p.onExit(({ exitCode }) => cb(exitCode)),
        kill: () => p.kill()
      }
    },
    env: () => baseChildEnv(),
    // dev builds only: PRINCIPIA_FAKE_CLI_DIR puts fake claude / codex first (visual QA, e2e); never in a packaged app
    resolveBin: (name, env) => {
      const fake = !app.isPackaged ? process.env.PRINCIPIA_FAKE_CLI_DIR : undefined
      return (fake && which(name, fake)) || which(name, env.PATH)
    },
    upload: async (adapter, kind, value) => {
      const body: PutProviderCredentialRequest = { kind, value }
      await link.call((c) => c.call('providerPut', { params: { adapter }, body }))
      loginVault.save(adapter, kind, value)
    },
    test: (adapter: CloudAdapter) => link.call((c) => c.call<ProviderTestResponse>('providerTest', { params: { adapter }, body: {} })),
    report: (s) => link.setLogin(s)
  })

  const move: MoveDeps = {
    link,
    company: (id: Id) => {
      const c = h.company.passport(id)
      return { id: c.id, name: c.name, slug: c.slug, color: c.color ?? null }
    },
    repos: (companyId) => h.store.listRepos(() => 0, companyId).map((r) => ({ id: r.id, name: r.name, path: r.path })),
    workflows: (companyId) => h.store.listWorkflows(companyId),
    schedules: (companyId) => h.store.listSchedules(companyId),
    profiles: () => h.store.listProfiles(),
    keyNames: (companyId) => h.vault.names(['*'], companyId),
    keyValues: (companyId, names) => h.vault.resolve(names, companyId),
    connections: () => h.gateway?.list() ?? [],
    connectionCredentials: (id) => {
      if (!h.gateway) throw new Error('Connections are not available')
      return h.gateway.exportCredentials(id)
    },
    passportBundle: (companyId) => op().export(companyId).zip,
    passport,
    passportReady: () => h.safe(() => !!h.memory?.vaultMode(), false),
    gitRemote,
    log
  }
  const accounts = new CloudAccountsSync({
    call: (f) => link.call(f),
    linked: () => link.linked,
    ghToken: () => ghToken(),
    sharedKeyNames: () => h.vault.list().map((k) => k.name),
    revealShared: (name) => h.vault.reveal(name),
    cloudKeys: () => h.store.getSettings().cloudKeys ?? [],
    setCloudKeys: (names) => {
      const after = h.store.updateSettings({ cloudKeys: names })
      emit('settings:changed', after)
    },
    log
  })
  const machines: CloudMachines = new CloudMachines({
    userData,
    cipher,
    emit: (machine) => emit('cloud', { kind: 'machine', machine }),
    api: (provider, token) => (provider === 'hetzner' ? hetzner(token) : digitalocean(token)),
    fleet: fleetUrl() ? fleetClient(fleetUrl()!) : null,
    ghToken: async () => (await ghToken())?.token ?? null,
    sshPublicKey,
    runSsh: (t, script, line) => runSsh(t, script, line, baseChildEnv()),
    resolve: async (host) => (await dns.lookup(host, { family: 4 })).address,
    pair: async (url, code) => {
      await link.pair({ url, code })
    },
    linkedUrl: () => (link.linked ? link.state().url : null),
    unlink: async () => {
      logins.cancel()
      await link.unlink()
    },
    bring: {
      keys: async () => void (await accounts.sync()),
      github: async () => void (await accounts.connectGithub({})),
      saved: (adapter) => loginVault.has(adapter),
      login: async (adapter) => {
        // signed in before: the saved sign-in goes up and is tested; the browser opens only if it no longer works
        const saved = loginVault.get(adapter)
        if (saved) {
          try {
            await link.call((c) => c.call('providerPut', { params: { adapter }, body: { kind: saved.kind, value: saved.value } }))
            const t = await link.call((c) => c.call<ProviderTestResponse>('providerTest', { params: { adapter }, body: {} }))
            if (t.ok) return { ok: true, detail: null }
            log.warn('cloud: a saved sign-in no longer works', { adapter })
            loginVault.forget(adapter)
          } catch (e) {
            log.warn('cloud: saved sign-in not restored', { adapter, error: e instanceof Error ? e.message : String(e) })
          }
        }
        const s = await logins.start(adapter)
        return { ok: s.phase === 'done', detail: s.message }
      }
    },
    version: app.getVersion(),
    // dev and self-builders: another image, or another ref of the public source to build from
    image: process.env.PRINCIPIA_CLOUD_IMAGE || undefined,
    sourceRef: process.env.PRINCIPIA_CLOUD_REF || undefined,
    hostName: os.hostname().replace(/\.local$/, '').slice(0, 40),
    log
  })
  machines.watch()
  return { link, logins, move, accounts, machines, loginVault }
}

/** The managed fleet's address: PRINCIPIA_FLEET_URL (development, self-hosted fleets) or the build's own. */
function fleetUrl(): string | null {
  const v = process.env.PRINCIPIA_FLEET_URL?.trim()
  return v && /^https:\/\//.test(v) ? v : FLEET_URL
}

