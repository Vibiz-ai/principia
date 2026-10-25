/** LINEAR.md §6: what the renderer sees of a company's Linear sync. No key value ever appears in these types. */
/** `syncedWith`: other companies already synced with this team (their Boards would mirror each other) */
export interface LinearTeamView { id: string; key: string; name: string; syncedWith?: string[] }
/** `status`: the issue's status in Board terms as last seen (in_review: "in review in Linear") */
export interface LinearTaskLink { key: string; url: string; status?: 'triage' | 'backlog' | 'todo' | 'in_progress' | 'in_review' | 'blocked' | 'done' | 'canceled' }
export type LinearSyncState = 'ok' | 'auth' | 'network' | 'error'
export interface LinearStatusView {
  companyId: string
  connected: boolean
  /** "lin_…ab12" from the Keys page's mask; null when no key is saved */
  keyMasked: string | null
  team: LinearTeamView | null
  workspace: string | null
  autosync: boolean
  state: LinearSyncState
  /** our words, safe to show */
  message: string | null
  lastSyncedAt: string | null
  syncing: boolean
  linkedCount: number
  /** taskId → its issue */
  links: Record<string, LinearTaskLink>
}
export interface LinearKeyCheck { ok: boolean; workspace: string | null; teams: LinearTeamView[]; message: string | null }
export interface LinearConnectInput { companyId: string; key?: string; teamId: string; autosync: boolean; sendOpen: boolean }
/** The company key Linear sync keeps its key in. Write-only: the Keys page lists and replaces it, never reveals it. */
export const LINEAR_KEY_NAME = 'LINEAR_API_KEY'
export const LINEAR_KEY_WRITE_ONLY = 'Linear sync keeps this key write-only. To see it, open Linear › Settings › Security & access.'
export const isWriteOnlyKey = (name: string, companyId: string | null | undefined): boolean => !!companyId && name === LINEAR_KEY_NAME
export const LINEAR_REJECTED = 'Linear turned down the key.'
export const LINEAR_REJECTED_AUTOSYNC_OFF = 'Linear turned down the key. Autosync is off.'
