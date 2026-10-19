/** First-launch seeds (CONTRACT §3): default profiles per available adapter + the SPEC §7.3 workflows + Morning brief. */
import type { AdapterId, AgentProfile, ProviderInfo, WorkflowDraft } from '../../shared/types'
import { ADAPTER_LABELS, type Store } from './store'

const AGENT_ADAPTERS: AdapterId[] = ['claude', 'codex', 'cursor', 'gemini']

/**
 * Ensures one default profile per available adapter (+ Shell). Idempotent: an adapter is seeded once
 * (meta `seeded_profile:<adapter>`); a profile the user deleted is not re-created here.
 * Returns the adapters that got a new profile.
 */
export function seedProfiles(store: Store, providers: ProviderInfo[]): AdapterId[] {
  const created: AdapterId[] = []
  const available = new Set(providers.filter((p) => p.available).map((p) => p.id))
  available.add('shell')
  for (const adapter of [...AGENT_ADAPTERS, 'shell' as const]) {
    if (!available.has(adapter)) continue
    const key = `seeded_profile:${adapter}`
    if (store.getMeta(key)) continue
    if (!store.defaultProfileFor(adapter)) {
      store.createProfile(
        { name: ADAPTER_LABELS[adapter], adapter, permissionMode: 'bypass', secretNames: ['*'], useApiKeyAuth: false },
        true
      )
      created.push(adapter)
    }
    store.setMeta(key, new Date().toISOString())
  }
  return created
}

/** Default profile for an adapter, created on demand (sessions:create with an adapter that has none). */
export function ensureDefaultProfile(store: Store, adapter: AdapterId): AgentProfile {
  return (
    store.defaultProfileFor(adapter) ??
    store.createProfile(
      { name: ADAPTER_LABELS[adapter], adapter, permissionMode: 'bypass', secretNames: ['*'], useApiKeyAuth: false },
      true
    )
  )
}

/** Drafts come from the engine (src/main/engine/seeds.ts); main only persists them once each. */
export interface SeedWorkflowLike {
  seedKey: string
  draft: WorkflowDraft
}
export type SeedDrafts = (p: { claude: string | null; codex: string | null }) => SeedWorkflowLike[]

/** Seeds the SPEC §7.3 workflows + Morning brief once (deleted seeds stay deleted). Needs a claude profile. */
export function seedWorkflows(store: Store, drafts: SeedDrafts): string[] {
  const profiles = store.listProfiles()
  const pick = (a: AdapterId) => store.defaultProfileFor(a)?.id ?? profiles.find((p) => p.adapter === a)?.id ?? null
  const created: string[] = []
  for (const { seedKey, draft } of drafts({ claude: pick('claude'), codex: pick('codex') })) {
    if (store.seedKeyUsed(seedKey)) continue
    store.createWorkflow(draft, seedKey)
    store.setMeta(`seeded_wf:${seedKey}`, new Date().toISOString())
    created.push(seedKey)
  }
  return created
}
