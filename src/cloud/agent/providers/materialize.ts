/**
 * ProviderMaterial -> what a run needs (CLOUD.md §7.2, §7.8): env variables, 0600 files inside the run home, a setup
 * step before the first step (codex API-key login) and a readback after the run (codex auth.json refresh). Only the
 * adapters the run uses are materialized, so a shell step of a Claude workflow never sees a Codex sign-in.
 */
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { CloudAdapter, ProviderCredentialKind } from '../../../shared/cloud'
import type { ProviderMaterial } from '../../contract'
import { isInside, type RunSandbox } from '../sandbox'
import { materializeClaude } from './claude'
import { materializeCodex } from './codex'
import { materializeGemini } from './gemini'

export interface ProviderFile { path: string; content: string }
export interface ProviderSetup {
  env: Record<string, string>
  files: ProviderFile[]
  /** runs once before the run's first step, with the run's full env */
  before?: (env: Record<string, string>) => Promise<void>
  /** after the run: the file credential's new content when the CLI changed it, else null */
  readback?: () => string | null
}

export interface CredentialWriteBack { credentialId: string; adapter: CloudAdapter; kind: ProviderCredentialKind; value: string }

export interface Materialized {
  env: Record<string, string>
  /** the materials used, per adapter */
  used: Partial<Record<CloudAdapter, ProviderMaterial>>
  /** adapters the run needs but has no credential for */
  missing: CloudAdapter[]
  before(env: Record<string, string>): Promise<void>
  readback(): CredentialWriteBack[]
}

export function materializeOne(box: RunSandbox, m: ProviderMaterial, bins: { codex: string }): ProviderSetup {
  if (m.adapter === 'claude') return materializeClaude(box, m)
  if (m.adapter === 'codex') return materializeCodex(box, m, bins.codex)
  if (m.adapter === 'gemini') return materializeGemini(box, m)
  throw new Error('Unknown provider')
}

/** Writes a credential file at 0600 (folders 0700), only inside the run home. */
export function writePrivateFile(box: RunSandbox, f: ProviderFile): void {
  if (!isInside(box.home, f.path)) throw new Error('Credential files stay in the run home')
  mkdirSync(dirname(f.path), { recursive: true, mode: 0o700 })
  writeFileSync(f.path, f.content, { mode: 0o600 })
  chmodSync(f.path, 0o600)
}

export function materializeProviders(box: RunSandbox, materials: ProviderMaterial[], adapters: readonly CloudAdapter[], bins: { codex: string }): Materialized {
  const env: Record<string, string> = {}
  const used: Partial<Record<CloudAdapter, ProviderMaterial>> = {}
  const missing: CloudAdapter[] = []
  const befores: NonNullable<ProviderSetup['before']>[] = []
  const readbacks: { m: ProviderMaterial; read: NonNullable<ProviderSetup['readback']> }[] = []
  for (const adapter of [...new Set(adapters)]) {
    const m = materials.find((x) => x.adapter === adapter)
    if (!m) {
      missing.push(adapter)
      continue
    }
    const setup = materializeOne(box, m, bins)
    for (const f of setup.files) writePrivateFile(box, f)
    Object.assign(env, setup.env)
    if (setup.before) befores.push(setup.before)
    if (setup.readback) readbacks.push({ m, read: setup.readback })
    used[adapter] = m
  }
  return {
    env,
    used,
    missing,
    async before(runEnv) {
      for (const b of befores) await b(runEnv)
    },
    readback() {
      const out: CredentialWriteBack[] = []
      for (const { m, read } of readbacks) {
        const value = read()
        if (value) out.push({ credentialId: m.credentialId, adapter: m.adapter, kind: m.kind, value })
      }
      return out
    }
  }
}
