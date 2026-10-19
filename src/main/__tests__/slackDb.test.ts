/** SLACK.md §7 (CONTRACT "Slack.4"): Slack tables, widening and the one-time iMessage migration. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Run, Workflow } from '../../shared/types'
import { openDatabase, currentVersion } from '../db'
import { SCHEMA_VERSION } from '../db/schema'
import { Store } from '../db/store'
import { createEngineStore } from '../db/engineStore'
import { LiveStore } from '../db/liveStore'
import { migrateDraftLike } from '../db/slackMigration'

let nativeOk = true
try {
  openDatabase(':memory:').close()
} catch {
  nativeOk = false
}
const d = nativeOk ? describe : describe.skip

d('slack persistence', () => {
  it('creates the Slack tables without a version bump', () => {
    const db = openDatabase(':memory:')
    expect(currentVersion(db)).toBe(SCHEMA_VERSION)
    for (const t of ['connector_secrets', 'slack_workspaces', 'slack_users', 'slack_channels', 'slack_messages', 'slack_messages_fts', 'slack_sync_state', 'slack_thread_sync', 'slack_event_log', 'slack_triggers', 'slack_trigger_state', 'slack_trigger_events', 'slack_drafts', 'slack_outbox']) {
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name = ?").get(t)).toBeTruthy()
    }
    const cols = (t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name)
    expect(cols('runs')).toEqual(expect.arrayContaining(['trigger_ext', 'slack_json']))
    expect(cols('asks')).toContain('slack_draft_id')
    expect(cols('workflows')).toContain('slack_tools')
    expect(cols('slack_event_log')).toEqual(['event_id', 'received_at']) // PO-S8
    expect(cols('slack_channels')).not.toContain('hidden') // PO-S9
  })

  it('one-time migration: imessage notify nodes -> slack, pending drafts too, imessageHandle deleted; runs once', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-slackdb-'))
    const file = path.join(tmp, 'hive.db')
    let db = openDatabase(file)
    const store = new Store(db)
    const wf = store.createWorkflow({
      name: 'PR roundup',
      description: '',
      inputs: [],
      nodes: [
        { id: 'a', type: 'notify', label: 'n', after: [], cwd: null, timeoutMin: 1, title: 't', message: 'm', imessage: true } as never,
        { id: 'b', type: 'notify', label: 'n', after: [], cwd: null, timeoutMin: 1, title: 't', message: 'm', imessage: false } as never
      ]
    })
    // the mapper already reads legacy rows as slack; write the raw legacy JSON back like an older Hive would have
    db.prepare('UPDATE workflows SET nodes_json = ? WHERE id = ?').run(
      JSON.stringify([
        { id: 'a', type: 'notify', label: 'n', after: [], cwd: null, timeoutMin: 1, title: 't', message: 'm', imessage: true },
        { id: 'b', type: 'notify', label: 'n', after: [], cwd: null, timeoutMin: 1, title: 't', message: 'm', imessage: false }
      ]),
      wf.id
    )
    db.prepare("INSERT INTO settings(key, value) VALUES ('imessageHandle', '\"+34600000000\"')").run()
    db.prepare("INSERT INTO meta(key, value) VALUES ('imessage_explained', 'x')").run()
    db.prepare(
      `INSERT INTO author_drafts(id, kind, status, owner_kind, owner_key, owner_label, adapter, payload_json, content_hash, created_at)
       VALUES ('adr_1', 'create', 'pending', 'session', 'k', 'l', 'claude', ?, 'h', 'now')`
    ).run(JSON.stringify({ name: 'x', nodes: [{ id: 'n', type: 'notify', imessage: true }] }))
    db.prepare("DELETE FROM meta WHERE key = 'slack_migrated'").run()
    db.close()
    db = openDatabase(file)
    const raw = JSON.parse((db.prepare('SELECT nodes_json FROM workflows WHERE id = ?').get(wf.id) as { nodes_json: string }).nodes_json)
    expect(raw[0]).toMatchObject({ slack: { kind: 'me' }, migratedFrom: 'imessage' })
    expect(raw[0]).not.toHaveProperty('imessage')
    expect(raw[1]).toMatchObject({ slack: null })
    expect(raw[1]).not.toHaveProperty('migratedFrom')
    expect(JSON.parse((db.prepare("SELECT payload_json FROM author_drafts WHERE id = 'adr_1'").get() as { payload_json: string }).payload_json).nodes[0]).toMatchObject({ slack: { kind: 'me' } })
    expect(db.prepare("SELECT 1 FROM settings WHERE key = 'imessageHandle'").get()).toBeUndefined()
    expect(db.prepare("SELECT 1 FROM meta WHERE key = 'imessage_explained'").get()).toBeUndefined()
    expect(db.prepare("SELECT value FROM meta WHERE key = 'slack_migrated'").get()).toEqual({ value: '1' })
    // runs once: a node written later with imessage stays (the mapper still reads it as slack)
    db.prepare('UPDATE workflows SET nodes_json = ? WHERE id = ?').run(JSON.stringify([{ id: 'c', type: 'notify', imessage: true }]), wf.id)
    db.close()
    db = openDatabase(file)
    expect(JSON.parse((db.prepare('SELECT nodes_json FROM workflows WHERE id = ?').get(wf.id) as { nodes_json: string }).nodes_json)[0]).toHaveProperty('imessage')
    expect(new Store(db).getWorkflow(wf.id)!.nodes[0]).toMatchObject({ slack: { kind: 'me' } })
    db.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('old snapshots read legacy imessage as slack', () => {
    expect(migrateDraftLike({ nodes: [{ id: 'n', type: 'notify', imessage: false }] })).toEqual({ nodes: [{ id: 'n', type: 'notify', slack: null }] })
  })

  it("trigger 'slack' + run context round-trip through the old CHECK; slackTools persists", () => {
    const db = openDatabase(':memory:')
    const es = createEngineStore(db, { describe: () => () => '' })
    const slack = { triggerId: 'stg_1', teamId: 'T1', channelId: 'C1', channelName: 'support', channelKind: 'channel' as const, threadTs: '1.1', messageTs: ['1.1'], userId: 'U1', userName: 'Dana', text: 'hi', permalink: '', isMention: true, isDm: false, catchup: false }
    const run: Run = {
      id: 'r_slack00001', kind: 'prompt', title: 't', target: { kind: 'prompt', profileId: 'prof_1', repoId: null, prompt: 'x' }, workflowId: null, scheduleId: null,
      parentRunId: null, trigger: 'slack', status: 'queued', reason: null, createdAt: new Date().toISOString(), startedAt: null, endedAt: null, artifactsDir: '/tmp/x/', artifactCount: 0, slack
    }
    es.insertRun(run, null)
    expect(db.prepare("SELECT trigger, trigger_ext FROM runs WHERE id = 'r_slack00001'").get()).toEqual({ trigger: 'manual', trigger_ext: 'slack' })
    const back = es.getRun('r_slack00001')!
    expect(back.trigger).toBe('slack')
    expect(back.slack).toEqual(slack)
    const store = new Store(db)
    const wf: Workflow = store.createWorkflow({ name: 'w', description: '', inputs: [], nodes: [], slackTools: true })
    expect(store.getWorkflow(wf.id)!.slackTools).toBe(true)
    expect(store.updateWorkflow(wf.id, { name: 'w', description: '', inputs: [], nodes: [] }).slackTools).toBeUndefined()
  })

  it("slack_reply asks are stored compatibly and survive run-end cancel and boot recovery", () => {
    const db = openDatabase(':memory:')
    const live = new LiveStore(db)
    const now = new Date().toISOString()
    live.insertAgent({
      id: 'ag_root', kind: 'session', parentId: null, rootId: 'ag_root', sessionId: 's_1', runId: null, stepId: null, provider: 'claude', repoId: null, cwd: '/', title: 't',
      agentType: null, externalId: null, toolUseId: null, model: null, depth: 0, background: false, attribution: 'exact', status: 'working', needs: null, activity: null,
      lastTool: null, toolCount: 0, memReads: 0, filesTouched: [], tokensIn: null, tokensOut: null, costUsd: null, modelUsage: null, report: null, startedAt: now, updatedAt: now, endedAt: null
    })
    live.insertAsk({
      id: 'ask_s1', agentId: 'ag_root', rootId: 'ag_root', sessionId: 's_1', runId: null, stepId: null, provider: 'claude', kind: 'slack_reply', channel: 'slack', title: 'Reply in #support',
      detail: null, toolName: null, toolInput: null, question: 'hi', options: [{ id: 'send', label: 'Send', kind: 'allow' }, { id: 'discard', label: 'Discard', kind: 'deny' }],
      status: 'open', answer: null, answeredVia: null, createdAt: now, answeredAt: null, expiresAt: null, slackDraftId: 'sdr_1'
    })
    expect(db.prepare("SELECT kind, channel FROM asks WHERE id = 'ask_s1'").get()).toEqual({ kind: 'question', channel: 'mcp' })
    expect(live.getAsk('ask_s1')).toMatchObject({ kind: 'slack_reply', channel: 'slack', slackDraftId: 'sdr_1' })
    expect(live.cancelOpenAsksForRoot('ag_root')).toEqual([])
    live.bootRecover()
    expect(live.getAsk('ask_s1')!.status).toBe('open')
  })
})
