/**
 * SLACK.md §7.2 / §10.4: iMessage -> Slack for notify nodes. Pure helpers (used by the one-time db migration, the
 * workflow mappers for old snapshots, and `.hive.json` import) plus the migration itself.
 * Rule: `imessage: true` -> `slack: {kind:'me'}, migratedFrom: 'imessage'`; `imessage: false` -> `slack: null`.
 * The brief's "Slack DM if configured, else Mac-only with a note" is met at send time (notifyNode.ts).
 */
import type { DB } from './index'

type Raw = Record<string, unknown>
const isObj = (v: unknown): v is Raw => !!v && typeof v === 'object' && !Array.isArray(v)

/** One notify node, legacy -> current. Returns the same object when nothing changes. */
export function migrateNotifyNode<T>(n: T): T {
  if (!isObj(n) || n.type !== 'notify' || !('imessage' in n)) return n
  const { imessage, ...rest } = n
  const out: Raw = { ...rest }
  if (out.slack === undefined) out.slack = imessage === true ? { kind: 'me' } : null
  if (imessage === true && out.migratedFrom === undefined) out.migratedFrom = 'imessage'
  return out as T
}

export function migrateNodes<T>(nodes: T[]): { nodes: T[]; changed: boolean } {
  let changed = false
  const out = nodes.map((n) => {
    const m = migrateNotifyNode(n)
    if (m !== n) changed = true
    return m
  })
  return { nodes: out, changed }
}

/** A WorkflowDraft-like object (workflow, author draft payload, import file). */
export function migrateDraftLike<T>(d: T): T {
  if (!isObj(d) || !Array.isArray(d.nodes)) return d
  const { nodes, changed } = migrateNodes(d.nodes as unknown[])
  return changed ? ({ ...d, nodes } as T) : d
}

/** One-time data migration (meta.slack_migrated = 1), inside one transaction. Idempotent. */
export function migrateSlackData(db: DB): { workflows: number; drafts: number } {
  const done = db.prepare("SELECT value FROM meta WHERE key = 'slack_migrated'").get() as { value: string } | undefined
  if (done) return { workflows: 0, drafts: 0 }
  return db.transaction(() => {
    let workflows = 0
    let drafts = 0
    const wfs = db.prepare('SELECT id, nodes_json FROM workflows').all() as { id: string; nodes_json: string }[]
    const upWf = db.prepare('UPDATE workflows SET nodes_json = ? WHERE id = ?')
    for (const w of wfs) {
      let nodes: unknown
      try {
        nodes = JSON.parse(w.nodes_json)
      } catch {
        continue
      }
      if (!Array.isArray(nodes)) continue
      const m = migrateNodes(nodes)
      if (m.changed) {
        upWf.run(JSON.stringify(m.nodes), w.id)
        workflows++
      }
    }
    const hasDrafts = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='author_drafts'").get()
    if (hasDrafts) {
      const rows = db.prepare("SELECT id, payload_json FROM author_drafts WHERE status = 'pending'").all() as { id: string; payload_json: string }[]
      const up = db.prepare('UPDATE author_drafts SET payload_json = ? WHERE id = ?')
      for (const r of rows) {
        let p: unknown
        try {
          p = JSON.parse(r.payload_json)
        } catch {
          continue
        }
        const m = migrateDraftLike(p)
        if (m !== p) {
          up.run(JSON.stringify(m), r.id)
          drafts++
        }
      }
    }
    db.prepare("DELETE FROM settings WHERE key = 'imessageHandle'").run()
    db.prepare("DELETE FROM meta WHERE key = 'imessage_explained'").run()
    db.prepare("INSERT INTO meta(key, value) VALUES ('slack_migrated', '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run()
    return { workflows, drafts }
  })()
}
