import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { VaultOp } from '../../../../shared/passport'
import { listConflicts } from '../indexDb'
import { readLog } from '../log'
import { WriterLocks, readLockFile } from '../lock'
import { vaultFiles } from '../paths'
import { CO, makeKit, nativeOk, type Kit } from './vaultTestKit'

const d = nativeOk ? describe : describe.skip
const NOW = new Date('2026-10-20T12:00:00')
const now = () => NOW
const agent = { actor: 'claude' as const, runId: '183', grantId: 'g_1' }
const user = { actor: 'user' as const }

let kit: Kit
afterEach(() => kit?.close())

const ok = async (ops: VaultOp[], ctx: Parameters<Kit['writer']['apply']>[2] = agent) => {
  const r = await kit.writer.apply(CO, ops, ctx)
  for (const x of r.results) if (x.status === 'error') throw new Error(x.reason ?? 'error')
  return r
}
const facts = (noteId: string) =>
  kit.db.prepare('SELECT id, block_id, status, category, text, actor, run_id FROM mem_fact WHERE company_id = ? AND note_id = ? ORDER BY line').all(CO, noteId) as Array<Record<string, unknown>>
const eventCount = () => (kit.db.prepare('SELECT count(*) AS n FROM mem_event WHERE company_id = ?').get(CO) as { n: number }).n

d('writer ops', () => {
  it('createNote renders the §3 layout in the type folder, indexes and logs it; a second create is a noop', async () => {
    kit = makeKit({ now })
    const r = await ok([{ op: 'createNote', title: 'Ana Ruiz', type: 'person', summary: 'Head of growth.', aliases: ['Ana'], properties: { company: '[[Acme]]', pinned: false } }])
    const res = r.results[0]
    expect(res).toMatchObject({ status: 'ok', path: 'People/Ana Ruiz.md' })
    const text = kit.read('People/Ana Ruiz.md')
    expect(text).toBe(
      `---\nid: ${res.noteId}\ntitle: Ana Ruiz\ntype: person\naliases: [Ana]\nstatus: active\ncompany: "[[Acme]]"\npinned: false\ncreated: 2026-10-20\nmodified: 2026-10-20\nsource: agent\n---\n# Ana Ruiz\nHead of growth.\n`
    )
    expect(kit.index.noteById(CO, res.noteId!)!.hash).toBe(res.hash)
    expect(readLog(kit.root).map((e) => [e.op, e.targetKind, e.actor, e.grantId, e.runId])).toEqual([['create', 'note', 'claude', 'g_1', '183']])
    expect((await ok([{ op: 'createNote', title: 'ana ruiz', type: 'person' }])).results[0]).toMatchObject({ status: 'noop', noteId: res.noteId })
    expect((await ok([{ op: 'createNote', title: 'Ana', type: 'person' }])).results[0].status).toBe('noop') // resolves through the alias
    // basenames stay unique per vault: a second "Mercury" gets the type suffix
    await ok([{ op: 'createNote', title: 'Mercury', type: 'person' }])
    kit.write('Customers/x.md', '# x\n')
    expect((await ok([{ op: 'createNote', title: 'Mercury Labs', type: 'customer' }])).results[0].path).toBe('Customers/Mercury Labs.md')
    kit.write('Inbox/Stray.md', '# Stray\n') // on disk, not indexed yet
    expect((await ok([{ op: 'createNote', title: 'Stray', type: 'note' }])).results[0].path).toBe('Inbox/Stray (Note).md')
  })

  it('observe appends with provenance and a block id, dedups by text and refuses unknown notes', async () => {
    kit = makeKit({ now })
    const { results } = await ok([{ op: 'createNote', title: 'Ana', type: 'person' }])
    const id = results[0].noteId!
    const r = await ok([{ op: 'observe', note: '[[Ana]]', category: 'decision', text: 'Price [[Pro Plan]] at $49', tags: ['pricing'] }])
    const blockId = r.results[0].blockId!
    expect(blockId).toMatch(/^f-[0-9a-z]{10}$/)
    expect(kit.read('People/Ana.md')).toContain(`## Observations\n- [decision] Price [[Pro Plan]] at $49 #pricing (claude run#183, 2026-10-20) ^${blockId}\n`)
    expect(facts(id)).toEqual([{ id: `mfa_${blockId.slice(2)}`, block_id: blockId, status: 'active', category: 'decision', text: 'Price [[Pro Plan]] at $49 #pricing', actor: 'claude', run_id: '183' }])
    const again = await ok([{ op: 'observe', note: 'Ana', category: 'fact', text: 'price [[Pro Plan]]  at $49', tags: ['pricing'] }])
    expect(again.results[0]).toMatchObject({ status: 'noop', blockId })
    const bad = await kit.writer.apply(CO, [{ op: 'observe', note: 'Nobody', category: 'fact', text: 'x' }], agent)
    expect(bad.results[0]).toMatchObject({ status: 'error' })
    expect(bad.results[0].reason).toMatch(/note_not_found/)
    const empty = await kit.writer.apply(CO, [{ op: 'observe', note: 'Ana', category: 'fact', text: '  ' }], agent)
    expect(empty.results[0].reason).toMatch(/empty_text/)
  })

  it('relate writes ghosts that resolve when the note appears, uses real titles for aliases, and dedups', async () => {
    kit = makeKit({ now })
    await ok([
      { op: 'createNote', title: 'Ana', type: 'person' },
      { op: 'createNote', title: 'Robert', type: 'person', aliases: ['Bob'] },
      { op: 'relate', from: 'Ana', rel: 'works_at', to: 'Acme', context: 'since 2024' },
      { op: 'relate', from: 'Ana', rel: 'reports_to', to: 'Bob' }
    ])
    const text = kit.read('People/Ana.md')
    expect(text).toMatch(/- works_at \[\[Acme\]\] \(since 2024\) \(claude run#183, 2026-10-20\) \^r-[0-9a-z]{10}\n/)
    expect(text).toMatch(/- reports_to \[\[Robert\|Bob\]\] \(claude run#183, 2026-10-20\) \^r-/)
    const ana = kit.index.noteByPath(CO, 'People/Ana.md')!
    const ghost = () => kit.db.prepare(`SELECT to_note FROM mem_link WHERE company_id = ? AND from_note = ? AND norm_rel = 'works_at'`).get(CO, ana.id) as { to_note: string | null }
    expect(ghost().to_note).toBeNull()
    const acme = await ok([{ op: 'createNote', title: 'Acme', type: 'company' }])
    expect(acme.results[0].path).toBe('Acme.md')
    expect(ghost().to_note).toBe(acme.results[0].noteId)
    expect((await ok([{ op: 'relate', from: 'Ana', rel: 'worksAt', to: '[[Acme]]' }])).results[0].status).toBe('noop')
  })

  it('supersede moves the old line to History; invalidate and restoreLine round-trip a relation', async () => {
    kit = makeKit({ now })
    await ok([{ op: 'createNote', title: 'Ana', type: 'person' }])
    const o = await ok([{ op: 'observe', note: 'Ana', category: 'price', text: 'Pro at $39' }])
    const old = o.results[0].blockId!
    const s = await ok([{ op: 'supersede', blockId: `^${old}`, text: 'Pro at $49' }])
    const next = s.results[0].blockId!
    expect(next).not.toBe(old)
    const text = kit.read('People/Ana.md')
    expect(text).toContain(`- [price] Pro at $49 (claude run#183, 2026-10-20) ^${next}`)
    expect(text).toContain(`## History\n- [superseded] Pro at $39 (by ^${next}; claude run#183, 2026-10-20) ^${old}`)
    const id = kit.index.noteByPath(CO, 'People/Ana.md')!.id
    expect(facts(id).map((f) => [f.block_id, f.status])).toEqual([
      [next, 'active'],
      [old, 'superseded']
    ])
    const rel = await ok([{ op: 'relate', from: 'Ana', rel: 'works_at', to: 'Globex' }])
    const r = rel.results[0].blockId!
    await ok([{ op: 'invalidate', blockId: r, reason: 'left; moved abroad' }], user)
    expect(kit.read('People/Ana.md')).toContain(`- [invalidated] works_at [[Globex]] (reason: left; moved abroad; user, 2026-10-20) ^${r}`)
    expect(kit.db.prepare('SELECT status FROM mem_link WHERE company_id = ? AND id = ?').get(CO, `mrel_${r.slice(2)}`)).toEqual({ status: 'invalid' })
    await ok([{ op: 'restoreLine', blockId: `[[Ana#^${r}]]` }], user)
    expect(kit.db.prepare('SELECT status FROM mem_link WHERE company_id = ? AND id = ?').get(CO, `mrel_${r.slice(2)}`)).toEqual({ status: 'active' })
    expect(readLog(kit.root).map((e) => e.op)).toEqual(['create', 'create', 'supersede', 'create', 'invalidate', 'restore'])
  })

  it('a missing block id produces a conflict row and a review item, never a guess', async () => {
    kit = makeKit({ now })
    await ok([{ op: 'createNote', title: 'Ana', type: 'person' }])
    const r = await kit.writer.apply(CO, [{ op: 'supersede', blockId: 'f-0000000000', text: 'x' }], agent)
    expect(r.results[0]).toMatchObject({ status: 'conflict', blockId: 'f-0000000000' })
    expect(r.conflicts).toHaveLength(1)
    expect(r.conflicts[0].reason).toMatch(/block_not_found/)

    // the line was deleted in Obsidian and the watcher has not caught up: the index still knows the block
    const o = await ok([{ op: 'observe', note: 'Ana', category: 'fact', text: 'Likes tea' }])
    const b = o.results[0].blockId!
    const before = kit.read('People/Ana.md').replace(/- \[fact\] Likes tea.*\n/, '')
    kit.write('People/Ana.md', before)
    const c = await kit.writer.apply(CO, [{ op: 'invalidate', blockId: b, reason: 'wrong' }], agent)
    expect(c.results[0]).toMatchObject({ status: 'conflict', path: 'People/Ana.md' })
    expect(kit.read('People/Ana.md')).toBe(before)
    const rows = listConflicts(kit.db, CO, { open: true })
    expect(rows).toHaveLength(2)
    const row = rows.find((x) => x.path === 'People/Ana.md')!
    expect(JSON.parse(row.op_json)).toEqual({ op: 'invalidate', blockId: b, reason: 'wrong' })
    expect(row.current_hash).toBeTruthy()
    expect(kit.db.prepare(`SELECT count(*) AS n FROM mem_proposal WHERE company_id = ? AND kind = 'conflict' AND status = 'pending'`).get(CO)).toEqual({ n: 2 })
  })

  it('replaying an opId returns the first result and writes nothing', async () => {
    kit = makeKit({ now })
    await ok([{ op: 'createNote', title: 'Ana', type: 'person' }])
    const ctx = { ...agent, opId: 'g_1:call-7' }
    const first = await ok([{ op: 'observe', note: 'Ana', category: 'fact', text: 'One' }], ctx)
    const n = eventCount()
    const text = kit.read('People/Ana.md')
    const again = await ok([{ op: 'observe', note: 'Ana', category: 'fact', text: 'Two' }], ctx)
    expect(again).toEqual(first)
    expect(kit.read('People/Ana.md')).toBe(text)
    expect(eventCount()).toBe(n)
  })

  it('20 parallel observes on one note lose nothing', async () => {
    kit = makeKit({ now })
    await ok([{ op: 'createNote', title: 'Ana', type: 'person' }])
    const all = await Promise.all(Array.from({ length: 20 }, (_, i) => kit.writer.apply(CO, [{ op: 'observe', note: 'Ana', category: 'fact', text: `Fact number ${i}` }], { ...agent, opId: `g:${i}` })))
    expect(all.every((r) => r.results[0].status === 'ok')).toBe(true)
    const text = kit.read('People/Ana.md')
    for (let i = 0; i < 20; i++) expect(text).toContain(`Fact number ${i} (claude`)
    const id = kit.index.noteByPath(CO, 'People/Ana.md')!.id
    expect(facts(id)).toHaveLength(20)
    expect(new Set(all.map((r) => r.results[0].blockId)).size).toBe(20)
  })

  it('CAS: a human save between read and rename is kept, and the op is recomputed on the new bytes', async () => {
    let human = 0
    kit = makeKit({
      now,
      writer: {
        hooks: {
          beforeCommit: (abs, attempt) => {
            if (attempt === 0 && abs.endsWith('Ana.md') && fs.existsSync(abs) && human++ === 0) fs.appendFileSync(abs, 'Saved in Obsidian mid-op.\n')
          }
        }
      }
    })
    await ok([{ op: 'createNote', title: 'Ana', type: 'person' }])
    const r = await ok([{ op: 'observe', note: 'Ana', category: 'fact', text: 'Agent fact' }])
    expect(r.results[0].status).toBe('ok')
    const text = kit.read('People/Ana.md')
    expect(text).toContain('Saved in Obsidian mid-op.')
    expect(text).toContain('- [fact] Agent fact')
    expect(human).toBe(1)
    expect(fs.readdirSync(path.join(kit.root, 'People')).filter((f) => !f.startsWith('.'))).toEqual(['Ana.md'])
  })

  it('CAS: a file that keeps changing ends in a conflict, never a lost update', async () => {
    let n = 0
    kit = makeKit({ now, writer: { hooks: { beforeCommit: (abs) => abs.endsWith('Ana.md') && fs.existsSync(abs) && fs.appendFileSync(abs, `edit ${n++}\n`) } } })
    await ok([{ op: 'createNote', title: 'Ana', type: 'person' }])
    const r = await kit.writer.apply(CO, [{ op: 'observe', note: 'Ana', category: 'fact', text: 'Agent fact' }], agent)
    expect(r.results[0]).toMatchObject({ status: 'conflict' })
    expect(r.results[0].reason).toMatch(/cas_exhausted/)
    expect(n).toBe(4)
    const text = kit.read('People/Ana.md')
    expect(text).toContain('edit 3')
    expect(text).not.toContain('Agent fact')
  })

  it('setProperty, addAlias and archive patch frontmatter only; reserved keys are refused', async () => {
    kit = makeKit({ now })
    await ok([{ op: 'createNote', title: 'Ana', type: 'person' }])
    await ok([
      { op: 'setProperty', note: 'Ana', key: 'owner', value: '[[Lautaro]]' },
      { op: 'addAlias', note: 'Ana', alias: 'A. Ruiz' },
      { op: 'archive', note: 'Ana' }
    ])
    const text = kit.read('People/Ana.md')
    expect(text).toContain('owner: "[[Lautaro]]"')
    expect(text).toContain('aliases: [A. Ruiz]')
    expect(text).toContain('status: archived')
    const row = kit.index.noteByPath(CO, 'People/Ana.md')!
    expect(row.status).toBe('archived')
    expect(kit.db.prepare(`SELECT to_text FROM mem_link WHERE company_id = ? AND origin = 'property'`).all(CO)).toEqual([{ to_text: 'Lautaro' }])
    const bad = await kit.writer.apply(CO, [{ op: 'setProperty', note: 'Ana', key: 'id', value: 'n-0000000000' }], agent)
    expect(bad.results[0].reason).toMatch(/reserved_key/)
    expect((await ok([{ op: 'archive', note: 'Ana' }])).results[0].status).toBe('noop')
  })

  it('stamps a real id on a hand-written note at its first edit and never rewrites unparseable frontmatter', async () => {
    kit = makeKit({ now })
    kit.write('Inbox/Idea.md', '# Idea\nA thought.\n')
    kit.write('Inbox/Broken.md', '---\ntitle: [unclosed\n---\n# Broken\n')
    kit.index.rebuild(CO)
    expect(kit.index.noteByPath(CO, 'Inbox/Idea.md')!.id).toBe('h:Inbox/Idea.md')
    const r = await ok([{ op: 'observe', note: 'Idea', category: 'fact', text: 'Now tracked' }])
    expect(r.results[0].noteId).toMatch(/^n-/)
    expect(kit.read('Inbox/Idea.md')).toMatch(/^---\nid: n-[0-9a-z]{10}\nmodified: 2026-10-20\n---\n# Idea\nA thought\.\n\n## Observations\n- \[fact\] Now tracked/)
    expect(kit.db.prepare('SELECT id FROM mem_note WHERE company_id = ?').all(CO)).toHaveLength(2)
    const before = kit.read('Inbox/Broken.md')
    const b = await kit.writer.apply(CO, [{ op: 'observe', note: 'Broken', category: 'fact', text: 'x' }], agent)
    expect(b.results[0].status).toBe('error')
    expect(kit.read('Inbox/Broken.md')).toBe(before)
  })

  it('rename moves the file, keeps the id, adds the old title as alias and rewrites links vault-wide', async () => {
    kit = makeKit({ now })
    const c = await ok([
      { op: 'createNote', title: 'Pro Plan', type: 'offer' },
      { op: 'createNote', title: 'Ana', type: 'person' }
    ])
    const id = c.results[0].noteId!
    await ok([
      { op: 'relate', from: 'Ana', rel: 'decided', to: 'Pro Plan' },
      { op: 'observe', note: 'Ana', category: 'fact', text: 'Sells [[Pro Plan|the plan]] and [[Offers/Pro Plan]]' }
    ])
    kit.write('Inbox/Note.md', '# Note\nSee [[pro plan#Pricing]] and `[[Pro Plan]]` in code.\n')
    kit.index.indexNote(CO, 'Inbox/Note.md')
    const r = await ok([{ op: 'rename', note: 'Pro Plan', newTitle: 'Pro' }], user)
    expect(r.results[0]).toMatchObject({ status: 'ok', path: 'Offers/Pro.md', noteId: id })
    expect((r.results[0] as { linksRewritten?: number }).linksRewritten).toBe(4)
    expect(kit.exists('Offers/Pro Plan.md')).toBe(false)
    const text = kit.read('Offers/Pro.md')
    expect(text).toContain('title: Pro\n')
    expect(text).toContain('aliases: [Pro Plan]')
    expect(text).toContain('# Pro\n')
    const ana = kit.read('People/Ana.md')
    expect(ana).toContain('- decided [[Pro]]')
    expect(ana).toContain('Sells [[Pro|the plan]] and [[Pro]]')
    // the first Principia edit of a hand-written note also stamps its id (§3.1)
    expect(kit.read('Inbox/Note.md')).toMatch(/\n---\n# Note\nSee \[\[Pro#Pricing\]\] and `\[\[Pro Plan\]\]` in code\.\n$/)
    expect(kit.db.prepare('SELECT count(*) AS n FROM mem_link WHERE company_id = ? AND to_note = ?').get(CO, id)).toEqual({ n: 4 })
    expect(kit.db.prepare('SELECT count(*) AS n FROM mem_note WHERE company_id = ?').get(CO)).toEqual({ n: 3 })
  })

  it('merge B into A: links become [[A|B]], observations move with provenance, B is archived with merged_into', async () => {
    kit = makeKit({ now })
    await ok([
      { op: 'createNote', title: 'Stripe', type: 'product' },
      { op: 'createNote', title: 'Stripe Inc', type: 'product', aliases: ['Stripe Payments'] },
      { op: 'createNote', title: 'Ana', type: 'person' },
      { op: 'observe', note: 'Stripe Inc', category: 'fact', text: 'Charges 2.9%' },
      { op: 'observe', note: 'Stripe', category: 'fact', text: 'Used for billing' },
      { op: 'relate', from: 'Ana', rel: 'uses', to: 'Stripe Inc' }
    ])
    const r = await ok([{ op: 'merge', from: 'Stripe Inc', into: 'Stripe' }], user)
    expect(r.results[0].status).toBe('ok')
    expect(kit.read('People/Ana.md')).toContain('- uses [[Stripe|Stripe Inc]]')
    const a = kit.read('Products/Stripe.md')
    expect(a).toMatch(/- \[fact\] Charges 2\.9% \(merged from \[\[Stripe Inc\]\]\) \(claude run#183, 2026-10-20\) \^f-/)
    expect(a).toContain('aliases: [Stripe Payments]')
    const b = kit.read('Products/Stripe Inc.md')
    expect(b).toContain('status: archived')
    expect(b).toContain('merged_into: "[[Stripe]]"')
    expect(b).toContain('- [fact] Charges 2.9%') // never deleted
    expect(b).not.toContain('Stripe Payments')
  })

  it('linkMention wraps plain text; materializeId stamps a hand-written line', async () => {
    kit = makeKit({ now })
    await ok([{ op: 'createNote', title: 'Acme', type: 'company' }])
    kit.write('Inbox/Note.md', '# Note\nWe met Acme today.\n- [fact] Hand written fact\n')
    kit.index.indexNote(CO, 'Inbox/Note.md')
    await ok([{ op: 'linkMention', note: 'Inbox/Note.md', line: 1, span: { start: 7, end: 11 }, target: 'Acme' }], user)
    // that first edit added frontmatter (the note's id), so line numbers moved: ops address the current file
    const line = kit.read('Inbox/Note.md').split('\n').findIndex((l) => l.startsWith('- [fact] Hand written'))
    const m = await ok([{ op: 'materializeId', note: 'Note', line }], user)
    const text = kit.read('Inbox/Note.md')
    expect(text).toContain('We met [[Acme]] today.')
    expect(text).toContain(`- [fact] Hand written fact ^${m.results[0].blockId}`)
    expect(kit.index.findBlock(CO, m.results[0].blockId!)).toMatchObject({ kind: 'fact' })
  })
})

d('editor saves', () => {
  const setup = async () => {
    kit = makeKit({ now })
    await ok([
      { op: 'createNote', title: 'Ana', type: 'person' },
      { op: 'observe', note: 'Ana', category: 'fact', text: 'Keep me' }
    ])
    return kit.index.noteByPath(CO, 'People/Ana.md')!
  }

  it('saves with a current base and moves deleted block-id lines to History', async () => {
    const row = await setup()
    const text = kit.read('People/Ana.md')
    const edited = text.replace(/- \[fact\] Keep me.*\n/, '').replace('# Ana\n', '# Ana\nNew prose.\n')
    const r = await kit.writer.save(CO, { path: row.path, baseHash: row.hash, text: edited }, user)
    expect(r).toMatchObject({ status: 'saved', movedToHistory: 1 })
    const now = kit.read('People/Ana.md')
    expect(now).toContain('New prose.')
    expect(now).toMatch(/## History\n- \[invalidated\] Keep me \(reason: removed in editor; user, 2026-10-20\) \^f-/)
  })

  it('merges a stale base cleanly with diff3, or returns the merge view on a conflict', async () => {
    const row = await setup()
    const base = kit.read('People/Ana.md')
    await ok([{ op: 'observe', note: 'Ana', category: 'fact', text: 'Agent wrote this meanwhile' }])
    const r = await kit.writer.save(CO, { path: row.path, baseHash: row.hash, text: base.replace('# Ana\n', '# Ana\nUser prose.\n') }, user)
    expect(r.status).toBe('saved')
    const merged = kit.read('People/Ana.md')
    expect(merged).toContain('User prose.')
    expect(merged).toContain('Agent wrote this meanwhile')

    const row2 = kit.index.noteByPath(CO, 'People/Ana.md')!
    const base2 = kit.read('People/Ana.md')
    kit.write('People/Ana.md', base2.replace('User prose.', 'Obsidian prose.'))
    kit.index.indexNote(CO, 'People/Ana.md')
    const c = await kit.writer.save(CO, { path: row2.path, baseHash: row2.hash, text: base2.replace('User prose.', 'Editor prose.') }, user)
    expect(c).toMatchObject({ status: 'conflict', clean: false })
    expect(kit.read('People/Ana.md')).toContain('Obsidian prose.')
  })
})

d('writer.lock', () => {
  it('a second live instance makes the vault read-only; a stale lock is taken over; release never removes the file', async () => {
    kit = makeKit({ now, writer: { locks: new WriterLocks({ heartbeat: false }) } })
    const lock = vaultFiles(kit.root).writerLock
    fs.mkdirSync(path.dirname(lock), { recursive: true })
    fs.writeFileSync(lock, JSON.stringify({ pid: process.ppid, host: os.hostname(), startedAt: NOW.toISOString() }))
    const r = await kit.writer.apply(CO, [{ op: 'createNote', title: 'Ana', type: 'person' }], user)
    expect(r.results[0]).toMatchObject({ status: 'error' })
    expect(r.results[0].reason).toMatch(/read-only/)
    expect(kit.exists('People/Ana.md')).toBe(false)
    expect(kit.writer.readOnlyReason(CO)).toMatch(/pid/)

    fs.writeFileSync(lock, JSON.stringify({ pid: 2 ** 22 + 12345, host: os.hostname(), startedAt: NOW.toISOString() })) // dead pid
    expect((await kit.writer.apply(CO, [{ op: 'createNote', title: 'Ana', type: 'person' }], user)).results[0].status).toBe('ok')
    expect(readLockFile(kit.root)!.pid).toBe(process.pid)

    // another host's fresh heartbeat holds it too
    const locks = new WriterLocks({ heartbeat: false })
    fs.writeFileSync(lock, JSON.stringify({ pid: 1, host: 'other-mac', startedAt: new Date().toISOString(), heartbeatAt: new Date().toISOString() }))
    expect(locks.acquire(kit.root).held).toBe(false)
    fs.writeFileSync(lock, JSON.stringify({ pid: 1, host: 'other-mac', startedAt: '2026-01-01T00:00:00Z', heartbeatAt: '2026-01-01T00:00:00Z' }))
    expect(locks.acquire(kit.root).held).toBe(true)
    locks.release(kit.root)
    expect(fs.existsSync(lock)).toBe(true)
    expect(readLockFile(kit.root)!.pid).toBe(0)
  })
})

// ---------- never delete (PASSPORT.md §1.5, §6.4) ----------

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name !== '__tests__') out.push(...sourceFiles(abs))
    } else if (/\.ts$/.test(e.name) && !/\.test\.ts$/.test(e.name)) out.push(abs)
  }
  return out
}

describe('never delete', () => {
  it('no module under memory/ calls unlink/rm on a vault path; memory/vault/ has no removal calls at all', () => {
    const memoryDir = path.resolve(__dirname, '../..')
    const REMOVE = /\b(unlink|unlinkSync|rm|rmSync|rmdir|rmdirSync)\s*\(/
    const VAULTISH = /vault|root|note|passport|snapshot|\.md\b/i
    const offenders: string[] = []
    for (const file of sourceFiles(memoryDir)) {
      const inVault = file.includes(`${path.sep}vault${path.sep}`)
      const lines = fs.readFileSync(file, 'utf8').split('\n')
      lines.forEach((raw, i) => {
        const line = raw.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '')
        if (!REMOVE.test(line)) return
        if (inVault || VAULTISH.test(line)) offenders.push(`${path.relative(memoryDir, file)}:${i + 1}: ${raw.trim()}`)
      })
    }
    expect(offenders).toEqual([])
  })

  it('the writer exports no delete op', async () => {
    const mod = await import('../writer')
    const proto = Object.getOwnPropertyNames(mod.VaultWriter.prototype)
    expect(proto.filter((n) => /^(delete|remove|unlink|rm)/i.test(n))).toEqual([])
  })
})

d('writer guards', () => {
  it('rename never replaces a file the index has not seen', async () => {
    kit = makeKit({ now })
    await ok([{ op: 'createNote', title: 'Pro Plan', type: 'offer' }])
    const squatters = ['Offers/Pro.md', ...Array.from({ length: 48 }, (_, i) => `Offers/Pro ${i + 2}.md`)]
    for (const rel of squatters) kit.write(rel, `untracked ${rel}\n`)
    const r = await kit.writer.apply(CO, [{ op: 'rename', note: 'Pro Plan', newTitle: 'Pro' }], user)
    expect(r.results[0].status).toBe('error')
    for (const rel of squatters) expect(kit.read(rel)).toBe(`untracked ${rel}\n`)
    expect(kit.read('Offers/Pro Plan.md')).toContain('title: Pro Plan\n')
  })

  it('merge carries on past a linker it cannot rewrite', async () => {
    kit = makeKit({ now })
    await ok([
      { op: 'createNote', title: 'Stripe', type: 'product' },
      { op: 'createNote', title: 'Stripe Inc', type: 'product' },
      { op: 'createNote', title: 'Ana', type: 'person' },
      { op: 'relate', from: 'Ana', rel: 'uses', to: 'Stripe Inc' }
    ])
    const broken = '---\ntitle: [unclosed\n---\n# Broken\nSee [[Stripe Inc]].\n'
    kit.write('Inbox/Broken.md', broken)
    kit.index.indexNote(CO, 'Inbox/Broken.md')
    const r = await kit.writer.apply(CO, [{ op: 'merge', from: 'Stripe Inc', into: 'Stripe' }], user)
    expect(r.results[0].status).toBe('ok')
    expect(kit.read('Inbox/Broken.md')).toBe(broken)
    expect(kit.read('People/Ana.md')).toContain('- uses [[Stripe|Stripe Inc]]')
    expect(kit.read('Products/Stripe Inc.md')).toContain('merged_into: "[[Stripe]]"')
    expect(readLog(kit.root).some((e) => e.op === 'link' && e.path === 'People/Ana.md')).toBe(true)
  })
})
