/** Test harness: a SlackConnector on FakeSlack + an in-memory hive.db (vitest fake timers drive both). */
import { vi } from 'vitest'
import { openDatabase, type DB } from '../../../db'
import type { Cipher } from '../../../vault'
import { newId } from '../../../../shared/ids'
import type { SlackChannel, SlackInboundMessage, SlackMessage, SlackStatus } from '../../../../shared/slack'
import { SlackConnector } from '../core/connector'
import type { AskPort, SettingsPort, SlackDraftOwner, SlackDraftRow } from '../core/ports'
import { ConnectorSecrets } from '../secrets'
import { SlackSqlite, createSqliteSlackStore } from '../store/sqlite'
import { FakeSlack, globalClock, type FakeSlackOptions } from '../testing/fakeSlack'

export let nativeOk = true
try {
  openDatabase(':memory:').close()
} catch {
  nativeOk = false
}

export const fakeCipher = (available = true): Cipher => ({
  available: () => available,
  encrypt: (s) => Buffer.from(`enc:${Buffer.from(s).toString('base64')}`),
  decrypt: (b) => Buffer.from(b.toString().slice(4), 'base64').toString()
})

export interface Harness {
  db: DB
  fake: FakeSlack
  sql: SlackSqlite
  conn: SlackConnector
  secrets: ConnectorSecrets
  settings: { backfillDays: number; catchupMin: number; autoPaused: boolean; alertUserId: string | null }
  statuses: SlackStatus[]
  inbound: SlackInboundMessage[]
  messages: { channelId: string; messages: SlackMessage[] }[]
  channels: SlackChannel[][]
  drafts: SlackDraftRow[]
  asks: { open: { draftId: string; title: string; owner: SlackDraftOwner }[]; closed: { askId: string; outcome: string }[] }
  suggestions: { userId: string; name: string }[]
  fatal: string[]
  logs: { level: string; m: string; meta?: object }[]
  redactions: Map<string, string>
}

export const USERS = [
  { id: 'U1', name: 'dana', real_name: 'Dana Lee' },
  { id: 'U2', name: 'sam', real_name: 'Sam Roe' },
  { id: 'UOTHERBOT', name: 'otherbot', real_name: 'Other Bot', is_bot: true, bot_id: 'BOTHER' }
]
export const CHANNELS: FakeSlackOptions['channels'] = [
  { id: 'C1', name: 'support', kind: 'channel', members: ['UBOT', 'U1', 'U2'] },
  { id: 'C2', name: 'random', kind: 'channel', members: ['UBOT', 'U1'] },
  { id: 'C3', name: 'notjoined', kind: 'channel', members: ['U1'] },
  { id: 'G1', name: 'private-x', kind: 'private', members: ['UBOT', 'U1'] },
  { id: 'D1', name: 'U1', kind: 'dm', members: ['UBOT', 'U1'], user: 'U1' }
]

export function makeHarness(o: Partial<FakeSlackOptions> & { backfillDays?: number; db?: DB; fake?: FakeSlack } = {}): Harness {
  const db = o.db ?? openDatabase(':memory:')
  const fake = o.fake ?? new FakeSlack({ clock: globalClock, users: USERS, channels: CHANNELS, ...o })
  const sql = new SlackSqlite(db, () => new Date())
  const store = createSqliteSlackStore(sql)
  const redactions = new Map<string, string>()
  const secrets = new ConnectorSecrets(db, fakeCipher(), { addRedactions: (n, v) => redactions.set(n, v), removeRedactions: (n) => redactions.delete(n) })
  const settings = { backfillDays: o.backfillDays ?? 7, catchupMin: 10, autoPaused: false, alertUserId: null as string | null }
  const sp: SettingsPort = {
    backfillDays: () => settings.backfillDays,
    triggerCatchupMin: () => settings.catchupMin,
    autoPaused: () => settings.autoPaused,
    alertUserId: () => settings.alertUserId
  }
  const h = {
    db,
    fake,
    sql,
    secrets,
    settings,
    statuses: [],
    inbound: [],
    messages: [],
    channels: [],
    drafts: [],
    asks: { open: [], closed: [] },
    suggestions: [],
    fatal: [],
    logs: [],
    redactions
  } as unknown as Harness
  const asks: AskPort = {
    open: async (a) => {
      h.asks.open.push({ draftId: a.draftId, title: a.title, owner: a.owner })
      return `ask_${h.asks.open.length}`
    },
    close: async (askId, outcome) => {
      h.asks.closed.push({ askId, outcome })
    }
  }
  const redactAll = (s: string) => {
    let out = s
    for (const [n, v] of redactions) out = out.split(v).join(`••••${n}`)
    return out
  }
  h.conn = new SlackConnector({
    store,
    secrets,
    http: fake.http,
    socket: fake.socket,
    asks,
    clock: globalClock,
    log: {
      info: (m, meta) => h.logs.push({ level: 'info', m, meta }),
      warn: (m, meta) => h.logs.push({ level: 'warn', m, meta }),
      error: (m, meta) => h.logs.push({ level: 'error', m, meta })
    },
    events: {
      status: (s) => h.statuses.push(s),
      messages: (b) => h.messages.push(b),
      channels: (l) => h.channels.push(l),
      inbound: (m) => h.inbound.push(m),
      alertSuggestion: (s) => h.suggestions.push(s),
      draft: (d) => h.drafts.push(d),
      fatal: (m) => h.fatal.push(m)
    },
    settings: sp,
    redact: redactAll,
    newId: (k) => newId(k),
    random: () => 0.5
  })
  return h
}

/** Connect with the fake's tokens and wait for hello. */
export async function connect(h: Harness): Promise<void> {
  const p = h.conn.connectTokens({ botToken: h.fake.tokens.bot, appToken: h.fake.tokens.app })
  await vi.advanceTimersByTimeAsync(10)
  await p
  await vi.advanceTimersByTimeAsync(50)
}

/** Let async work (sync, backfill, post-ack handlers) settle. */
export async function settle(ms = 100): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
}
