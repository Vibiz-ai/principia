/**
 * Slack slice (SLACK.md §12): connection status, the conversation list, the user directory and drafts.
 * Snapshot via invoke, then live via events (never polls). Degrades quietly when main doesn't serve Slack yet.
 */
import { useEffect, useMemo, useSyncExternalStore } from 'react'
import type { Id } from '@shared/types'
import type { SlackChannel, SlackDraft, SlackStatus, SlackUser } from '@shared/slack'
import { isNotImplemented, onSlackEvent, slackCall, type SlackUiCommand } from '../lib/slackApi'
import { userName } from '../lib/slack'
import { errorMessage, hive } from '../lib/hive'
import { getState, navigate, toast, updateSettings } from './store'

export interface SlackState {
  /** null = not asked yet; false = main doesn't serve Slack. */
  available: boolean | null
  status: SlackStatus | null
  channels: SlackChannel[]
  users: Record<string, SlackUser>
  drafts: Record<Id, SlackDraft>
  /** Last "show this draft" request (notification / hub click): the card scrolls into view. */
  draftFocus: { draftId: Id; nonce: number } | null
}

let st: SlackState = { available: null, status: null, channels: [], users: {}, drafts: {}, draftFocus: null }
const ls = new Set<() => void>()
export function getSlack(): SlackState {
  return st
}
export function setSlack(p: Partial<SlackState> | ((s: SlackState) => Partial<SlackState>)): void {
  st = { ...st, ...(typeof p === 'function' ? p(st) : p) }
  for (const l of ls) l()
}
export function useSlack<T>(sel: (s: SlackState) => T): T {
  return useSyncExternalStore(
    (l) => {
      ls.add(l)
      return () => ls.delete(l)
    },
    () => sel(st)
  )
}

export const isConnected = (s: SlackStatus | null): boolean => s?.state === 'connected'
/** Set up = tokens saved (any state but disabled). */
export const isSetUp = (s: SlackStatus | null): boolean => !!s && s.state !== 'disabled'

// ---------- loading ----------
export async function loadSlack(): Promise<void> {
  try {
    const status = await slackCall('slack:status')
    setSlack({ status, available: true })
    if (status.state !== 'disabled') await Promise.allSettled([refreshChannels(), refreshUsers(), loadSlackDrafts()])
  } catch (e) {
    setSlack({ available: isNotImplemented(e) ? false : true })
  }
}
export async function refreshStatus(): Promise<SlackStatus | null> {
  try {
    const status = await slackCall('slack:status')
    setSlack({ status })
    return status
  } catch {
    return null
  }
}
export async function refreshChannels(): Promise<void> {
  try {
    const channels = await slackCall('slack:channels', {})
    setSlack({ channels })
    noteSlackUsers(channels.map((c) => (c.kind === 'dm' ? c.dmUserId : null)))
  } catch {
    /* list stays as it was */
  }
}
export async function refreshUsers(): Promise<void> {
  try {
    const list = await slackCall('slack:users', { includeBots: true })
    const users: Record<string, SlackUser> = {}
    for (const u of list) users[u.id] = u
    setSlack({ users })
  } catch {
    /* names fall back to ids */
  }
}

// ---------- lazy user resolution ----------
/*
 * Main fills the user directory (users.list, users.info) after the socket is already 'connected', and no event says
 * when it lands. So whatever renders a user id the directory doesn't know yet notes it here, and we re-read the
 * directory with backoff until every noted id resolves (or gives up on ids that never do, e.g. deleted users).
 */
const USER_RETRY_BASE_MS = 1_000
const USER_RETRY_MAX_MS = 30_000
const USER_MAX_TRIES = 8
const missingUsers = new Set<string>()
const userTries = new Map<string, number>()
const givenUpUsers = new Set<string>()
let userTimer: ReturnType<typeof setTimeout> | null = null
let userRound = 0

function scheduleUserRefresh(): void {
  if (userTimer || missingUsers.size === 0) return
  const delay = Math.min(USER_RETRY_MAX_MS, USER_RETRY_BASE_MS * 2 ** userRound)
  userTimer = setTimeout(() => void runUserRefresh(), delay)
}
async function runUserRefresh(): Promise<void> {
  await refreshUsers()
  userTimer = null
  for (const id of [...missingUsers]) {
    if (st.users[id]) {
      missingUsers.delete(id)
      userTries.delete(id)
      continue
    }
    const n = (userTries.get(id) ?? 0) + 1
    if (n >= USER_MAX_TRIES) {
      missingUsers.delete(id)
      userTries.delete(id)
      givenUpUsers.add(id)
    } else userTries.set(id, n)
  }
  userRound = missingUsers.size ? userRound + 1 : 0
  scheduleUserRefresh()
}
/** Note user ids being shown; any the directory doesn't know yet are re-fetched shortly. Safe to call from render. */
export function noteSlackUsers(ids: Iterable<string | null | undefined>): void {
  let added = false
  for (const id of ids) {
    if (!id || st.users[id] || missingUsers.has(id) || givenUpUsers.has(id)) continue
    missingUsers.add(id)
    added = true
  }
  if (added && userTimer === null) {
    userRound = 0
    scheduleUserRefresh()
  }
}
/** Hook form of noteSlackUsers for components that render user ids. */
export function useNoteSlackUsers(ids: (string | null | undefined)[]): void {
  const users = useSlack((s) => s.users)
  const key = ids.filter(Boolean).join(',')
  useEffect(() => {
    if (key) noteSlackUsers(key.split(','))
  }, [key, users])
}
/** Test hook: forget the lazy-resolution bookkeeping. */
export function resetSlackUserResolution(): void {
  if (userTimer) clearTimeout(userTimer)
  userTimer = null
  userRound = 0
  missingUsers.clear()
  userTries.clear()
  givenUpUsers.clear()
}
export async function loadSlackDrafts(): Promise<void> {
  try {
    const list = await slackCall('slack:drafts', { status: ['pending', 'failed', 'sending'] })
    setSlack((s) => {
      const drafts: Record<Id, SlackDraft> = {}
      for (const d of Object.values(s.drafts)) if (d.status !== 'pending' && d.status !== 'failed') drafts[d.id] = d
      for (const d of list) drafts[d.id] = d
      return { drafts }
    })
  } catch {
    /* no cards */
  }
}

let wired = false
export function wireSlackEvents(): void {
  if (wired) return
  wired = true
  onSlackEvent('slack:status', (status) => {
    const was = st.status?.state
    setSlack({ status, available: true })
    if (was !== status.state && status.state === 'connected') {
      givenUpUsers.clear()
      void refreshChannels()
      void refreshUsers()
    }
  })
  onSlackEvent('slack:channels', (channels) => {
    setSlack({ channels })
    noteSlackUsers(channels.map((c) => (c.kind === 'dm' ? c.dmUserId : null)))
  })
  onSlackEvent('slack:messages', ({ messages }) => noteSlackUsers(messages.map((m) => (m.fromHive ? null : m.userId))))
  onSlackEvent('slack:draft', (d) => setSlack((s) => ({ drafts: { ...s.drafts, [d.id]: d } })))
  hive.on('ui:command', (cmd) => runSlackCommand(cmd as unknown as SlackUiCommand))
}

export function runSlackCommand(cmd: SlackUiCommand): void {
  if (cmd.kind === 'openSlack') void navigate({ name: 'slack', channelId: cmd.channelId, threadTs: cmd.threadTs, nonce: Date.now() })
  else if (cmd.kind === 'openSlackDraft') void openSlackDraft(cmd.draftId)
}

/** Notification click / hub: the draft card lives in its thread on the Slack page. */
export async function openSlackDraft(draftId: Id): Promise<void> {
  let d: SlackDraft | undefined = st.drafts[draftId]
  if (!d) {
    try {
      d = (await slackCall('slack:draftGet', { id: draftId })).draft
      setSlack((s) => ({ drafts: { ...s.drafts, [d!.id]: d! } }))
    } catch (e) {
      toast(`Couldn’t open the draft: ${errorMessage(e)}`, 'error')
      return
    }
  }
  setSlack((s) => ({ draftFocus: { draftId, nonce: (s.draftFocus?.nonce ?? 0) + 1 } }))
  void navigate({ name: 'slack', channelId: d.channelId, threadTs: d.threadTs ?? undefined, nonce: Date.now() })
}

// ---------- derived ----------
export function useUnreadCount(): number {
  const channels = useSlack((s) => s.channels)
  return useMemo(() => channels.filter((c) => c.unread && c.isMember && !c.isArchived).length, [channels])
}
export function usePendingSlackDrafts(): SlackDraft[] {
  const drafts = useSlack((s) => s.drafts)
  return useMemo(
    () =>
      Object.values(drafts)
        .filter((d) => d.status === 'pending' || d.status === 'failed' || d.status === 'sending')
        .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1)),
    [drafts]
  )
}
export function channelById(id: string | null | undefined): SlackChannel | undefined {
  return id ? st.channels.find((c) => c.id === id) : undefined
}
export function nameOfUser(id: string | null | undefined): string {
  if (!id) return 'Unknown'
  return userName(st.users[id], id)
}

// ---------- actions ----------
export async function decideSlackDraft(id: Id, decision: 'send' | 'discard', text?: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const d = await slackCall('slack:draftDecide', { id, decision, text })
    setSlack((s) => ({ drafts: { ...s.drafts, [d.id]: d } }))
    if (d.status === 'sent') toast(`Sent to ${d.channelName}`)
    else if (d.status === 'discarded') toast('Draft discarded')
    return { ok: d.status !== 'failed', error: d.error ?? undefined }
  } catch (e) {
    const code = (e as { code?: string }).code
    if (code === 'conflict') {
      toast('Already decided elsewhere.')
      void loadSlackDrafts()
      return { ok: false }
    }
    return { ok: false, error: errorMessage(e) }
  }
}

/** PO-S1: "Send your alerts here?" — Hive never sets it without this click. */
export async function acceptAlertSuggestion(): Promise<void> {
  const sug = st.status?.alertSuggestion
  if (!sug) return
  await updateSettings({ slackAlertUserId: sug.userId })
  toast(`Alerts go to ${sug.name} on Slack`)
  void refreshStatus()
}

/** PO-S3e kill switch. */
export async function setAutoPaused(paused: boolean): Promise<void> {
  await updateSettings({ slackAutoPaused: paused })
  if (getState().settings?.slackAutoPaused === paused) toast(paused ? 'Auto-replies paused: every reply becomes a draft' : 'Auto-replies resumed')
}
