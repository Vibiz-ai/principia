/**
 * Principia Cloud, the desktop side wired to this Mac's Hive (docs/CLOUD.md §4.1 "Desktop link"): the CloudLink with
 * safeStorage, the PassportSync port (the existing Open Passport sync config and code), the move dependencies (store,
 * vault, gateway, git) and Mac-side account linking through node-pty. Built lazily by `Hive.cloud`.
 */
import { execFile } from 'node:child_process'
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
import type { MoveDeps } from './move'

export interface CloudWiring {
  link: CloudLink
  logins: AccountLogins
  move: MoveDeps
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
    log
  })

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
  return { link, logins, move }
}
