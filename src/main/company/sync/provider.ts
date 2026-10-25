/**
 * LINEAR.md §2: the seam between the Board and an issue tracker. A provider speaks the tracker's API and answers in
 * Board terms (our statuses, our 0–4 priority, label names), so the sync engine never learns a tracker's vocabulary.
 * Linear is the first provider (linear.ts); GitHub Issues is a later one. No Electron imports.
 */
import type { TaskStatus } from '../../../shared/company'

export type SyncProviderKind = 'linear'

export interface RemoteTeam { id: string; key: string; name: string }

/** A workflow state of the team, kept so the engine can tell two "started" states apart. */
export interface RemoteState { id: string; name: string; type: string; position: number }

/** One issue as the tracker has it, in Board terms. */
export interface RemoteIssue {
  id: string
  /** "ENG-123" */
  key: string
  url: string
  title: string
  /** Markdown */
  description: string
  /** the tracker's state; `status` is what it means on the Board */
  stateId: string
  status: TaskStatus
  priority: 0 | 1 | 2 | 3 | 4
  labels: string[]
  estimate: number | null
  /** YYYY-MM-DD */
  dueDate: string | null
  /** the parent issue's id in the tracker */
  parentId: string | null
  /** ISO, the tracker's clock */
  updatedAt: string
  /** completed or canceled (closed issues older than the first-pull window are never imported) */
  closed: boolean
}

/** What the engine sends: any subset of the fields, in Board terms. `parentId` is the tracker's id of the parent. */
export interface IssueFields {
  title?: string
  description?: string
  status?: TaskStatus
  priority?: 0 | 1 | 2 | 3 | 4
  labels?: string[]
  estimate?: number | null
  dueDate?: string | null
  parentId?: string | null
}

export interface ChangedPage {
  issues: RemoteIssue[]
  /** the newest updatedAt seen (the next cursor); null when nothing came back */
  cursor: string | null
  /** stopped at the page cap: more changes are waiting for the next poll */
  truncated: boolean
}

export interface TeamInfo {
  states: RemoteState[]
  /** the team uses estimates (Linear: issueEstimationType is not "notUsed") */
  estimates: boolean
}

export interface TaskSyncProvider {
  readonly kind: SyncProviderKind
  /** Checks the key: the workspace name and its teams. Throws SyncError('auth') for a key the tracker turns down. */
  teams(): Promise<{ workspace: string | null; teams: RemoteTeam[] }>
  states(teamId: string): Promise<TeamInfo>
  /**
   * Issues of the team changed after `cursor` (ISO), oldest first. cursor null = the first pull: open issues plus
   * those closed in the last FIRST_PULL_CLOSED_DAYS days, capped.
   */
  changedSince(teamId: string, cursor: string | null): Promise<ChangedPage>
  create(teamId: string, fields: IssueFields & { title: string }): Promise<RemoteIssue>
  /** `currentStateId`: the issue's state as last seen, kept when it already means the status being sent. */
  update(teamId: string, id: string, fields: IssueFields, currentStateId?: string | null): Promise<RemoteIssue>
}

export const FIRST_PULL_CLOSED_DAYS = 14
/** A first pull brings at most this many issues; later polls catch up page by page. */
export const FIRST_PULL_CAP = 250

/** `refused`: Linear turned one request down (that task waits, the rest goes on). `gone`: the issue itself is not there (deleted, or out of the key's reach); only that task is affected. */
export type SyncErrorCode = 'auth' | 'network' | 'rate_limited' | 'remote' | 'refused' | 'gone'
const MESSAGES: Record<SyncErrorCode, string> = {
  auth: 'Linear turned down the key.',
  network: 'Could not reach Linear. Principia tries again shortly.',
  rate_limited: 'Linear asked Principia to slow down. It tries again later.',
  remote: 'Linear had a problem answering. Principia tries again later.',
  refused: 'Linear turned the request down.',
  gone: 'The issue is gone from Linear.'
}
/** A tracker failure with a fixed code. The message is ours, never the tracker's (which could quote the request). */
export class SyncError extends Error {
  readonly code: SyncErrorCode
  constructor(code: SyncErrorCode, message?: string) {
    super(message ?? MESSAGES[code])
    this.code = code
    this.name = 'SyncError'
  }
}
