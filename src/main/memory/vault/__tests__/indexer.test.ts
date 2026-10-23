import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { dumpDerived, targetNorm } from '../indexer'
import { readLog } from '../log'
import { isNotePath, toVaultAbs, toVaultRel } from '../paths'
import { OBSIDIAN_APP, seedVault } from '../seed'
import { readSnapshot } from '../snapshots'
import { ExpectedWrites, VaultWatcher } from '../watcher'
import { openIndexDb, getLayout, saveLayout } from '../indexDb'
import { CO, makeKit, nativeOk, note, type Kit } from './vaultTestKit'

const d = nativeOk ? describe : describe.skip

const ANA = 'n-ana0000001'
const ACME = 'n-acme000001'
let kit: Kit
afterEach(() => kit?.close())

const noteRow = (id: string) => kit.db.prepare('SELECT * FROM mem_note WHERE company_id = ? AND id = ?').get(CO, id) as Record<string, unknown> | undefined
const links = (from: string) =>
  kit.db.prepare('SELECT * FROM mem_link WHERE company_id = ? AND from_note = ? ORDER BY line, id').all(CO, from) as Array<Record<string, unknown>>
const facts = (noteId: string) => kit.db.prepare('SELECT * FROM mem_fact WHERE company_id = ? AND note_id = ? ORDER BY line').all(CO, noteId) as Array<Record<string, unknown>>

d('paths', () => {
  it('accepts notes and rejects dot folders, system folders and conflict copies', () => {
    expect(isNotePath('People/Ana Ruiz.md')).toBe(true)
    expect(isNotePath('Acme.md')).toBe(true)
    expect(isNotePath('.obsidian/x.md')).toBe(false)
    expect(isNotePath('.principia/snapshots/n-x.md')).toBe(false)
    expect(isNotePath('.trash/Old.md')).toBe(false)
    expect(isNotePath('_templates/Person.md')).toBe(false)
    expect(isNotePath('People/Ana (conflicted copy 2026-10-01).md')).toBe(false)
    expect(isNotePath('People/Ana.sync-conflict-20261001-101010-ABC.md')).toBe(false)
    expect(isNotePath('People/.Ana.md.principia-tmp')).toBe(false)
    expect(isNotePath('image.png')).toBe(false)
    expect(() => toVaultAbs('/v', '../x.md')).toThrow()
    expect(() => toVaultAbs('/v', '/etc/x.md')).toThrow()
    expect(toVaultRel('/v', '/v/People/A.md')).toBe('People/A.md')
  })
})

d('seed', () => {
  it('creates the skeleton, hub note and .obsidian defaults once, and never overwrites', () => {
    kit = makeKit()
    const r = seedVault(kit.root, { companyId: CO, companyName: 'Acme: Labs', now: new Date('2026-10-20T10:00:00Z') })
    expect(r.obsidianSeeded).toBe(true)
    expect(r.hubPath).toBe('Acme- Labs.md')
    expect(kit.read('Acme- Labs.md')).toMatch(/^---\nid: n-[0-9a-z]{10}\ntitle: "?Acme: Labs"?\ntype: company\n/)
    expect(JSON.parse(kit.read('.obsidian/app.json'))).toEqual(OBSIDIAN_APP)
    expect(JSON.parse(kit.read('.obsidian/graph.json')).colorGroups.length).toBeGreaterThan(5)
    expect(JSON.parse(kit.read('.principia/vault.json'))).toMatchObject({ companyId: CO, formatVersion: 1 })
    expect(kit.read('_schema/Relations.md')).toContain('- works_at :: employs ::')
    expect(kit.exists('_templates/Person.md')).toBe(true)
    for (const f of ['People', 'Customers', 'Inbox', 'Decisions']) expect(fs.statSync(path.join(kit.root, f)).isDirectory()).toBe(true)

    kit.write('.obsidian/app.json', '{"mine":true}')
    fs.rmSync(path.join(kit.root, '.obsidian', 'graph.json'))
    const again = seedVault(kit.root, { companyId: CO, companyName: 'Acme: Labs' })
    expect(again.created).toEqual([])
    expect(again.obsidianSeeded).toBe(false)
    expect(kit.read('.obsidian/app.json')).toBe('{"mine":true}')
    expect(kit.exists('.obsidian/graph.json')).toBe(false) // .obsidian exists: never written again
  })

  it('adopts an existing vault: keeps its .obsidian and finds a differently named hub', () => {
    kit = makeKit()
    kit.write('.obsidian/app.json', '{}')
    kit.write('HQ.md', '---\ntype: company\n---\n# HQ\n')
    const r = seedVault(kit.root, { companyId: CO, companyName: 'Acme' })
    expect(r.hubPath).toBe('HQ.md')
    expect(kit.exists('Acme.md')).toBe(false)
    expect(kit.read('.obsidian/app.json')).toBe('{}')
  })
})

d('indexer', () => {
  it('indexes notes, facts, relations, property links, tags and FTS from the files', () => {
    kit = makeKit()
    kit.write('Acme.md', `---\nid: ${ACME}\ntitle: Acme\ntype: company\n---\n# Acme\nWe sell [[Pro Plan]].\n`)
    kit.write(
      'People/Ana Ruiz.md',
      note(
        ANA,
        'Ana Ruiz',
        'Head of growth at [[Acme]].\n\n## Observations\n- [role] Head of growth #growth (user, 2026-10-01) ^f-7k2a9q1c0b\n- [decision] Price [[Pro Plan]] at $49 #pin (claude run#183, 2026-10-12) ^f-9q1c3m8d2e\n\n## Relations\n- works_at [[Acme]] ^r-3m8d0a1b2c\n\n## History\n- [superseded] Price at $39 (by ^f-9q1c3m8d2e; claude run#183, 2026-10-12) ^f-0p1o2i3u4y\n',
        'aliases: [Ana]\ntags: [team/founding]\ncompany: "[[Acme]]"\n'
      )
    )
    const stats = kit.index.rebuild(CO)
    expect(stats.notes).toBe(2)
    const ana = noteRow(ANA)!
    expect(ana).toMatchObject({ title: 'Ana Ruiz', type: 'person', path: 'People/Ana Ruiz.md', summary: 'Head of growth at [[Acme]].' })
    const f = facts(ANA)
    expect(f.map((x) => [x.id, x.status, x.category, x.pinned])).toEqual([
      ['mfa_7k2a9q1c0b', 'active', 'role', 0],
      ['mfa_9q1c3m8d2e', 'active', 'decision', 1],
      ['mfa_0p1o2i3u4y', 'superseded', 'superseded', 0]
    ])
    expect(f[1]).toMatchObject({ actor: 'claude', run_id: '183', kind: 'decision' })
    expect(f[2].superseded_by).toBe('mfa_9q1c3m8d2e')
    const l = links(ANA)
    const rel = l.find((x) => x.origin === 'relation')!
    expect(rel).toMatchObject({ id: 'mrel_3m8d0a1b2c', norm_rel: 'works_at', to_note: ACME, block_id: 'r-3m8d0a1b2c' })
    expect(l.find((x) => x.origin === 'property')).toMatchObject({ rel: 'company', to_note: ACME })
    const ghost = l.find((x) => x.origin === 'fact')!
    expect(ghost).toMatchObject({ to_note: null, to_norm: 'pro plan', from_fact: 'mfa_9q1c3m8d2e' })
    expect(kit.db.prepare(`SELECT count(*) AS n FROM mem_link WHERE company_id = ? AND to_note IS NULL AND to_norm = 'pro plan'`).get(CO)).toEqual({ n: 2 })
    const tags = kit.db.prepare('SELECT DISTINCT tag_norm FROM mem_tag WHERE company_id = ? AND note_id = ? ORDER BY 1').all(CO, ANA)
    expect(tags).toEqual([{ tag_norm: 'growth' }, { tag_norm: 'pin' }, { tag_norm: 'team/founding' }])
    const hit = kit.db.prepare(`SELECT ref_kind, ref_id FROM mem_fts WHERE mem_fts MATCH 'growth' AND company_id = ? ORDER BY ref_kind`).all(CO)
    expect(hit).toEqual([
      { ref_kind: 'fact', ref_id: 'mfa_7k2a9q1c0b' },
      { ref_kind: 'note', ref_id: ANA }
    ])
    expect(kit.db.prepare('SELECT name, type FROM mem_entity WHERE company_id = ? AND id = ?').get(CO, ANA)).toEqual({ name: 'Ana Ruiz', type: 'person' })
    expect(kit.db.prepare('SELECT type, to_id FROM mem_relation WHERE company_id = ?').all(CO)).toEqual([{ type: 'works_at', to_id: ACME }])
    expect(readSnapshot(kit.root, ANA)).toBe(kit.read('People/Ana Ruiz.md'))
  })

  it('resolves a ghost when the note is created, and unresolves it when the title goes away', () => {
    kit = makeKit()
    kit.write('People/Ana.md', note(ANA, 'Ana', 'Works on [[Pro Plan]] and [[Products/Pro Plan]].\n'))
    kit.index.rebuild(CO)
    expect(links(ANA).every((l) => l.to_note === null)).toBe(true)
    kit.write('Products/Pro Plan.md', '---\nid: n-pro0000001\ntype: product\n---\n# Pro Plan\n')
    expect(kit.index.indexNote(CO, 'Products/Pro Plan.md').status).toBe('indexed')
    expect(links(ANA).map((l) => l.to_note)).toEqual(['n-pro0000001', 'n-pro0000001'])
    // renamed in Obsidian without updating links (moved file, same id): basename link turns ghost, title link survives via title
    fs.renameSync(path.join(kit.root, 'Products/Pro Plan.md'), path.join(kit.root, 'Products/Pro.md'))
    const r = kit.index.indexPaths(CO, ['Products/Pro Plan.md', 'Products/Pro.md'])
    expect(r.map((x) => x.status).sort()).toEqual(['missing', 'moved'])
    expect(noteRow('n-pro0000001')!.path).toBe('Products/Pro.md')
    expect(links(ANA).map((l) => l.to_note)).toEqual([null, null])
  })

  it('stores ambiguous links with candidates and resolves aliases', () => {
    kit = makeKit()
    kit.write('People/Mercury.md', note('n-merc000001', 'Mercury', ''))
    kit.write('Customers/Mercury.md', '---\nid: n-merc000002\ntype: customer\n---\n# Mercury\n')
    kit.write('People/Ana.md', note(ANA, 'Ana', 'Talks to [[Mercury]] and [[Bob]].\n'))
    kit.write('People/Robert.md', note('n-bob0000001', 'Robert', '', 'aliases: [Bob]\n'))
    kit.index.rebuild(CO)
    const [merc, bob] = links(ANA)
    expect(merc).toMatchObject({ to_note: null, ambiguous: 1, candidates_json: JSON.stringify(['n-merc000001', 'n-merc000002']) })
    expect(bob).toMatchObject({ to_note: 'n-bob0000001', ambiguous: 0 })
    expect(targetNorm('[[People/Ana.md#^f-x|A]]')).toEqual({ name: 'People/Ana.md', norm: 'people/ana' })
  })

  it('short-circuits unchanged files and logs external semantic changes only', async () => {
    kit = makeKit()
    kit.write('People/Ana.md', note(ANA, 'Ana', '\n## Observations\n- [fact] One ^f-aaaaaaaaaa\n- [fact] Two ^f-bbbbbbbbbb\n'))
    kit.index.rebuild(CO)
    expect(kit.index.indexNote(CO, 'People/Ana.md').status).toBe('unchanged')
    kit.write('People/Ana.md', note(ANA, 'Ana', '\n## Observations\n- [fact] One edited ^f-aaaaaaaaaa\n- [fact] Three\n'))
    expect(kit.index.indexNote(CO, 'People/Ana.md').status).toBe('indexed')
    const ev = kit.db.prepare('SELECT op, target_kind, target_id, block_id FROM mem_event WHERE company_id = ? ORDER BY seq').all(CO) as Array<Record<string, unknown>>
    expect(ev.map((e) => `${e.op}:${e.block_id ?? e.target_id}`).sort()).toEqual(
      expect.arrayContaining(['update:f-aaaaaaaaaa', 'removed_external:f-bbbbbbbbbb', expect.stringMatching(/^create:h:/)])
    )
    // the vanished stamped line is kept as a tombstone with a review item; the log mirrors mem_event
    const tomb = facts(ANA).find((f) => f.id === 'mfa_bbbbbbbbbb')!
    expect(tomb).toMatchObject({ status: 'removed_external', text: 'Two' })
    const prop = kit.db.prepare(`SELECT kind, payload_json, status FROM mem_proposal WHERE company_id = ?`).get(CO) as Record<string, string>
    expect(prop.kind).toBe('external_removal')
    expect(JSON.parse(prop.payload_json)).toMatchObject({ noteId: ANA, blockIds: ['f-bbbbbbbbbb'], wholeNote: false })
    expect(readLog(kit.root).length).toBe(ev.length)
    // Restore re-appends the line with its block id, which drops the tombstone
    const r = await kit.writer.restoreRemovedLines(CO, ANA, ['mfa_bbbbbbbbbb'], { actor: 'user' })
    expect(r.status).toBe('ok')
    expect(kit.read('People/Ana.md')).toMatch(/- \[fact\] Two \(user, \d{4}-\d{2}-\d{2}\) \^f-bbbbbbbbbb\n/)
    expect(facts(ANA).find((f) => f.id === 'mfa_bbbbbbbbbb')!.status).toBe('active')
  })

  it('handles an external delete: removed_external, ghosts, a review item, survives rebuild, restores from the snapshot', async () => {
    kit = makeKit()
    kit.write('Acme.md', `---\nid: ${ACME}\ntype: company\n---\n# Acme\n\n## Observations\n- [fact] Founded 2020 ^f-cccccccccc\n`)
    kit.write('People/Ana.md', note(ANA, 'Ana', 'At [[Acme]].\n'))
    kit.index.rebuild(CO)
    const before = kit.read('Acme.md')
    fs.renameSync(path.join(kit.root, 'Acme.md'), path.join(kit.dir, 'elsewhere.md')) // gone from the vault
    expect(kit.index.indexNote(CO, 'Acme.md').status).toBe('removed')
    expect(noteRow(ACME)!.removed_at).toBeTruthy()
    expect(facts(ACME).map((f) => f.status)).toEqual(['removed_external'])
    expect(links(ANA)[0].to_note).toBeNull()
    expect(kit.db.prepare('SELECT count(*) AS n FROM mem_entity WHERE company_id = ?').get(CO)).toEqual({ n: 1 })
    expect(kit.db.prepare(`SELECT kind FROM mem_proposal WHERE company_id = ? AND status = 'pending'`).all(CO)).toEqual([{ kind: 'external_removal' }])
    kit.index.rebuild(CO)
    expect(noteRow(ACME)!.removed_at).toBeTruthy()
    expect(facts(ACME).length).toBe(1)

    const r = await kit.writer.restoreRemoved(CO, ACME, { actor: 'user' })
    expect(r.status).toBe('ok')
    expect(kit.read('Acme.md')).toBe(before)
    expect(noteRow(ACME)!.removed_at).toBeNull()
    expect(facts(ACME).map((f) => f.status)).toEqual(['active'])
    expect(links(ANA)[0].to_note).toBe(ACME)
    expect(kit.db.prepare(`SELECT status FROM mem_proposal WHERE company_id = ? AND kind = 'external_removal'`).get(CO)).toEqual({ status: 'stale' })
  })

  it('accept removal drops the rows of a deleted note', () => {
    kit = makeKit()
    kit.write('People/Ana.md', note(ANA, 'Ana', '\n- [fact] x ^f-dddddddddd\n'))
    kit.index.rebuild(CO)
    fs.renameSync(path.join(kit.root, 'People/Ana.md'), path.join(kit.dir, 'gone.md'))
    kit.index.scan(CO)
    expect(kit.index.acceptRemoval(CO, ANA)).toBe(true)
    expect(noteRow(ANA)).toBeUndefined()
    expect(facts(ANA)).toEqual([])
  })

  it('a copied file with a duplicate frontmatter id gets a fresh id (logged), the original keeps its own', () => {
    kit = makeKit()
    const text = note(ANA, 'Ana', '\n- [fact] Same line ^f-eeeeeeeeee\n')
    kit.write('People/Ana.md', text)
    kit.index.rebuild(CO)
    kit.write('People/Copy of Ana.md', text)
    kit.index.indexNote(CO, 'People/Copy of Ana.md')
    const copy = kit.index.noteByPath(CO, 'People/Copy of Ana.md')!
    expect(copy.id).not.toBe(ANA)
    expect(kit.read('People/Copy of Ana.md')).toContain(`id: ${copy.id}`)
    expect(kit.read('People/Ana.md')).toBe(text)
    expect(kit.index.findBlock(CO, 'f-eeeeeeeeee')!.noteId).toBe(ANA)
    expect(facts(copy.id)[0]).toMatchObject({ block_id: null, dup_of: 'f-eeeeeeeeee' }) // the copied block id is not targetable
    // a copy at a smaller path takes the block id over (the order a rebuild sees); removing it hands it back
    kit.write('People/Aaa.md', text.replace(ANA, 'n-aaa0000001'))
    kit.index.indexNote(CO, 'People/Aaa.md')
    expect(kit.index.findBlock(CO, 'f-eeeeeeeeee')!.noteId).toBe('n-aaa0000001')
    fs.renameSync(path.join(kit.root, 'People/Aaa.md'), path.join(kit.dir, 'gone.md'))
    kit.index.indexNote(CO, 'People/Aaa.md')
    expect(kit.index.findBlock(CO, 'f-eeeeeeeeee')!.noteId).toBe(ANA)
    expect(readLog(kit.root).some((e) => e.op === 'id_assigned' && e.targetId === copy.id)).toBe(true)
    // a rebuild settles on the same rows
    const inc = dumpDerived(kit.db, CO)
    kit.index.rebuild(CO)
    expect(dumpDerived(kit.db, CO)).toEqual(inc)
  })

  it('an id-less note moved outside Principia keeps no orphan rows', () => {
    kit = makeKit()
    kit.write('Inbox/Idea.md', '# Idea\nSee [[Ana]].\n')
    kit.write('People/Ana.md', note(ANA, 'Ana', ''))
    kit.index.rebuild(CO)
    fs.mkdirSync(path.join(kit.root, 'Concepts'), { recursive: true })
    fs.renameSync(path.join(kit.root, 'Inbox/Idea.md'), path.join(kit.root, 'Concepts/Idea.md'))
    const r = kit.index.indexPaths(CO, ['Inbox/Idea.md', 'Concepts/Idea.md'])
    expect(r.map((x) => x.status).sort()).toEqual(['indexed', 'moved'])
    expect(kit.db.prepare('SELECT id FROM mem_note WHERE company_id = ? ORDER BY id').all(CO)).toEqual([{ id: 'h:Concepts/Idea.md' }, { id: ANA }])
    expect(kit.db.prepare(`SELECT count(*) AS n FROM mem_proposal`).get()).toEqual({ n: 0 })
  })

  it('keeps companies apart in one index db, even with identical vault layouts', () => {
    kit = makeKit()
    const other = path.join(kit.dir, 'Other')
    fs.mkdirSync(path.join(other, 'Inbox'), { recursive: true })
    kit.index.registerVault('co_other', other)
    for (const root of [kit.root, other]) {
      fs.mkdirSync(path.join(root, 'Inbox'), { recursive: true })
      fs.writeFileSync(path.join(root, 'Inbox', 'Note.md'), `---\nid: ${ANA}\n---\n# Note\n- [fact] Same text\n- [fact] Stamped ^f-ffffffffff\n`)
    }
    kit.index.rebuild(CO)
    kit.index.rebuild('co_other')
    expect(kit.db.prepare('SELECT company_id, count(*) AS n FROM mem_fact GROUP BY company_id ORDER BY 1').all()).toEqual([
      { company_id: CO, n: 2 },
      { company_id: 'co_other', n: 2 }
    ])
    expect(kit.index.findBlock(CO, 'f-ffffffffff')!.noteId).toBe(ANA)
    kit.index.rebuild(CO)
    expect(kit.db.prepare('SELECT count(*) AS n FROM mem_note').get()).toEqual({ n: 2 })
    expect(kit.db.prepare(`SELECT count(*) AS n FROM mem_fts WHERE mem_fts MATCH 'stamped' AND company_id = 'co_other'`).get()).toEqual({ n: 2 })
  })

  it('repo_ids_json follows repos: links to repo notes', () => {
    kit = makeKit()
    kit.write('Repos/acme-web.md', '---\nid: n-repo000001\ntype: repo\nrepo_id: repo_web\n---\n# acme-web\n')
    kit.write('People/Ana.md', note(ANA, 'Ana', '', 'repos: ["[[acme-web]]"]\n'))
    kit.index.rebuild(CO)
    expect(noteRow(ANA)!.repo_ids_json).toBe('["repo_web"]')
    kit.write('Repos/acme-web.md', '---\nid: n-repo000001\ntype: repo\nrepo_id: repo_web2\n---\n# acme-web\n')
    kit.index.indexNote(CO, 'Repos/acme-web.md')
    expect(noteRow(ANA)!.repo_ids_json).toBe('["repo_web2"]')
  })

  it('persists graph layout as operational data that survives a rebuild', () => {
    kit = makeKit()
    kit.write('People/Ana.md', note(ANA, 'Ana', ''))
    kit.index.rebuild(CO)
    saveLayout(kit.db, CO, [{ noteId: ANA, x: 1.5, y: -2, pinned: true }])
    kit.index.rebuild(CO)
    expect(getLayout(kit.db, CO)).toEqual([{ noteId: ANA, x: 1.5, y: -2, pinned: true }])
  })

  it('opens read-only with query_only for the MCP child', () => {
    kit = makeKit()
    const ro = openIndexDb(path.join(kit.dir, 'passport-index.db'), { readonly: true })
    expect(() => ro.prepare(`INSERT INTO mem_meta VALUES ('a','b')`).run()).toThrow()
    ro.close()
  })
})

// ---------- incremental == rebuild (randomized edits) ----------

function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

d('incremental index equals a full rebuild', () => {
  // P2_SEED=<n> replays one seed; 20 and 28 once caught ownership of copied block ids depending on index order
  const seeds = process.env.P2_SEED ? [Number(process.env.P2_SEED)] : [42, 20, 28]
  it.each(seeds)('after 300 random external edits, renames, copies, deletes and creates (seed %i)', (seed) => {
    kit = makeKit()
    const rand = rng(seed)
    const pick = <T,>(xs: T[]): T => xs[Math.floor(rand() * xs.length)]
    const titles = ['Ana', 'Bob', 'Acme', 'Pro Plan', 'Globex', 'Pricing', 'Onboarding', 'Stripe', 'Mercury', 'Zed']
    for (let i = 0; i < 30; i++) titles.push(`Thing ${i}`)
    const folders = ['People', 'Customers', 'Concepts', 'Inbox', '']
    const ids = new Map<string, string>() // path -> id (or '' for id-less)
    let counter = 0
    const id10 = () => (counter++).toString(36).padStart(10, '0')
    const body = (): string => {
      const lines: string[] = []
      if (rand() < 0.7) lines.push(`Text about [[${pick(titles)}]] and #tag${Math.floor(rand() * 3)}.`)
      lines.push('', '## Observations')
      for (let i = Math.floor(rand() * 4); i > 0; i--) lines.push(`- [${pick(['fact', 'decision', 'gotcha'])}] ${pick(['Uses', 'Likes', 'Owns'])} [[${pick(titles)}]] ${Math.floor(rand() * 5)}${rand() < 0.5 ? ` ^f-${id10()}` : ''}`)
      lines.push('', '## Relations')
      for (let i = Math.floor(rand() * 3); i > 0; i--) lines.push(`- ${pick(['works_at', 'uses', 'relates_to'])} [[${pick(titles)}${rand() < 0.2 ? '|alias' : ''}]]${rand() < 0.5 ? ` ^r-${id10()}` : ''}`)
      return lines.join('\n') + '\n'
    }
    const render = (rel: string, title: string): string => {
      const id = ids.get(rel)
      const aliases = rand() < 0.2 ? `aliases: [${pick(titles)}]\n` : ''
      const fm = id ? `---\nid: ${id}\ntitle: ${title}\n${aliases}---\n` : rand() < 0.5 ? '' : `---\n${aliases}---\n`
      return `${fm}# ${title}\n${body()}`
    }
    const relFor = (title: string): string => {
      const f = pick(folders)
      return f ? `${f}/${title}${rand() < 0.3 ? ` ${Math.floor(rand() * 3)}` : ''}.md` : `${title}.md`
    }
    const touched: string[] = []
    for (let step = 0; step < 300; step++) {
      const existing = [...ids.keys()]
      const r = rand()
      if (r < 0.35 || existing.length < 3) {
        const title = pick(titles)
        const rel = relFor(title)
        if (ids.has(rel)) continue
        ids.set(rel, rand() < 0.75 ? `n-${id10()}` : '')
        kit.write(rel, render(rel, title))
        touched.push(rel)
      } else if (r < 0.75) {
        const rel = pick(existing)
        kit.write(rel, render(rel, pick(titles)))
        touched.push(rel)
      } else if (r < 0.8) {
        // a copied file: same frontmatter id and block ids (the indexer stamps a fresh note id on the copy)
        const rel = pick(existing)
        const to = relFor(pick(titles))
        if (ids.has(to)) continue
        kit.write(to, kit.read(rel))
        ids.set(to, '')
        touched.push(to)
      } else if (r < 0.9) {
        const rel = pick(existing)
        const to = relFor(pick(titles))
        if (ids.has(to)) continue
        fs.mkdirSync(path.dirname(path.join(kit.root, to)), { recursive: true })
        fs.renameSync(path.join(kit.root, rel), path.join(kit.root, to))
        ids.set(to, ids.get(rel)!)
        ids.delete(rel)
        touched.push(rel, to)
      } else {
        const rel = pick(existing)
        fs.renameSync(path.join(kit.root, rel), path.join(kit.dir, `trash-${step}.md`))
        ids.delete(rel)
        touched.push(rel)
      }
      // index in small batches like the watcher does
      if (rand() < 0.5) kit.index.indexPaths(CO, touched.splice(0))
    }
    kit.index.indexPaths(CO, touched.splice(0))
    const incremental = dumpDerived(kit.db, CO)
    expect((incremental.notes as unknown[]).length).toBeGreaterThan(10)
    expect((incremental.links as Array<{ to_note: string | null }>).some((l) => l.to_note)).toBe(true)
    kit.index.rebuild(CO)
    const rebuilt = dumpDerived(kit.db, CO)
    for (const k of Object.keys(rebuilt)) expect({ [k]: incremental[k] }).toEqual({ [k]: rebuilt[k] })
  }, 30_000) // ~1.5 s alone, past the 5 s default under the full parallel suite
})

d('rebuild performance', () => {
  it('rebuilds 5k notes in under 5 s', () => {
    kit = makeKit()
    const folders = ['People', 'Customers', 'Concepts', 'Decisions', 'Inbox']
    for (const f of folders) fs.mkdirSync(path.join(kit.root, f), { recursive: true })
    for (let i = 0; i < 5000; i++) {
      const id = `n-${i.toString(36).padStart(10, '0')}`
      const text = `---\nid: ${id}\ntitle: Note ${i}\ntype: concept\ntags: [t${i % 20}]\ncreated: 2026-10-01\n---\n# Note ${i}\nAbout [[Note ${(i * 7) % 5000}]] and [[Missing ${i % 50}]].\n\n## Observations\n- [fact] Fact one for note ${i} #x (user, 2026-10-01) ^f-${i.toString(36).padStart(10, 'a')}\n- [decision] Decided ${i} with [[Note ${(i + 1) % 5000}]]\n\n## Relations\n- relates_to [[Note ${(i + 3) % 5000}]] ^r-${i.toString(36).padStart(10, 'b')}\n`
      fs.writeFileSync(path.join(kit.root, folders[i % 5], `Note ${i}.md`), text)
    }
    const t0 = Date.now()
    const stats = kit.index.rebuild(CO)
    const ms = Date.now() - t0
    expect(stats.notes).toBe(5000)
    expect(ms).toBeLessThan(5000)
    expect(kit.db.prepare('SELECT count(*) AS n FROM mem_link WHERE company_id = ? AND to_note IS NOT NULL').get(CO)).toEqual({ n: 15000 })
    // a second rebuild skips rewriting unchanged snapshots
    const t1 = Date.now()
    kit.index.rebuild(CO)
    expect(Date.now() - t1).toBeLessThan(5000)
    // startup scan with nothing changed is cheap and touches nothing
    expect(kit.index.scan(CO)).toEqual([])
  }, 30_000)
})

d('watcher', () => {
  it('indexes an edit made outside Principia within 1 s', async () => {
    kit = makeKit()
    kit.write('People/Ana.md', note(ANA, 'Ana', 'v1\n'))
    kit.index.rebuild(CO)
    const w = new VaultWatcher(kit.index, CO, { rescanMs: 0 })
    expect(w.start()).toBe(true)
    try {
      await new Promise((r) => setTimeout(r, 100))
      const t0 = Date.now()
      kit.write('People/Ana.md', note(ANA, 'Ana', 'v2 mentions [[Acme]]\n'))
      while (Date.now() - t0 < 2000 && noteRow(ANA)!.summary !== 'v2 mentions [[Acme]]') await new Promise((r) => setTimeout(r, 20))
      expect(noteRow(ANA)!.summary).toBe('v2 mentions [[Acme]]')
      expect(Date.now() - t0).toBeLessThan(1000)
      expect(kit.changed.some((e) => e.paths.includes('People/Ana.md'))).toBe(true)

      // a new note in a new folder
      const t1 = Date.now()
      kit.write('Customers/Globex.md', '# Globex\n')
      while (Date.now() - t1 < 2000 && !kit.index.noteByPath(CO, 'Customers/Globex.md')) await new Promise((r) => setTimeout(r, 20))
      expect(kit.index.noteByPath(CO, 'Customers/Globex.md')).toBeTruthy()
      expect(Date.now() - t1).toBeLessThan(1000)
    } finally {
      w.stop()
    }
  })

  it('debounces per path, coalesces rename pairs, ignores .principia and suppresses own writes', () => {
    kit = makeKit()
    const expected = new ExpectedWrites()
    kit.write('People/Ana.md', note(ANA, 'Ana', 'v1\n'))
    kit.index.rebuild(CO)
    const batches: string[][] = []
    const w = new VaultWatcher(kit.index, CO, { rescanMs: 0, expected, onBatch: (r) => batches.push(r.map((x) => `${x.status}:${x.path}`)) })
    fs.renameSync(path.join(kit.root, 'People/Ana.md'), path.join(kit.root, 'People/Ana Ruiz.md'))
    for (let i = 0; i < 5; i++) w.onEvent('People/Ana.md')
    w.onEvent('People/Ana Ruiz.md')
    w.onEvent('.principia/log.jsonl')
    w.onEvent('.obsidian/workspace.json')
    w.flush()
    expect(batches).toEqual([['moved:People/Ana Ruiz.md', 'missing:People/Ana.md']])
    expect(kit.db.prepare(`SELECT count(*) AS n FROM mem_proposal`).get()).toEqual({ n: 0 })
    // own write: registered hash + already indexed -> skipped
    const abs = path.join(kit.root, 'People/Ana Ruiz.md')
    const text = note(ANA, 'Ana', 'v2\n')
    fs.writeFileSync(abs, text)
    kit.index.indexNote(CO, 'People/Ana Ruiz.md', { own: true })
    expected.register(abs, kit.index.noteByPath(CO, 'People/Ana Ruiz.md')!.hash)
    w.onEvent('People/Ana Ruiz.md')
    expect(w.flush()).toEqual([])
    w.stop()
  })

  it('rescan picks up changes fs.watch missed', () => {
    kit = makeKit()
    kit.write('People/Ana.md', note(ANA, 'Ana', 'v1\n'))
    kit.index.rebuild(CO)
    const w = new VaultWatcher(kit.index, CO, { rescanMs: 0 })
    kit.write('People/Bob.md', '# Bob\n')
    kit.write('People/Ana.md', note(ANA, 'Ana', 'v2, longer\n'))
    const r = w.rescanNow()
    expect(r.map((x) => `${x.status}:${x.path}`).sort()).toEqual(['indexed:People/Ana.md', 'indexed:People/Bob.md'])
    w.stop()
  })
})

d('vault folder and isolation guards', () => {
  it('a vanished vault folder is not read as every note deleted, by indexNote, scan or rebuild', () => {
    kit = makeKit()
    kit.write('People/Ana.md', note(ANA, 'Ana', '\n- [fact] x ^f-aaaaaaaaaa\n'))
    kit.write('Acme.md', `---\nid: ${ACME}\ntype: company\n---\n# Acme\n`)
    kit.index.rebuild(CO)
    const before = dumpDerived(kit.db, CO)
    fs.renameSync(kit.root, `${kit.root}-unmounted`)
    expect(kit.index.indexPaths(CO, ['People/Ana.md', 'Acme.md']).map((r) => r.status)).toEqual(['missing', 'missing'])
    expect(kit.index.scan(CO)).toEqual([])
    expect(kit.index.rebuild(CO).notes).toBe(0)
    expect(dumpDerived(kit.db, CO)).toEqual(before)
    expect(kit.db.prepare('SELECT count(*) AS n FROM mem_proposal').get()).toEqual({ n: 0 })
    expect(kit.db.prepare('SELECT state FROM mem_vault WHERE company_id = ?').get(CO)).toEqual({ state: 'missing' })
    fs.renameSync(`${kit.root}-unmounted`, kit.root)
    kit.index.scan(CO)
    expect(dumpDerived(kit.db, CO)).toEqual(before)
  })

  it('a rebuild that did not finish is redone on the next start', () => {
    kit = makeKit()
    kit.write('People/Ana.md', note(ANA, 'Ana', ''))
    kit.index.rebuild(CO)
    expect(kit.index.registerVault(CO, kit.root)).toBe(false)
    // simulate a crash after the rebuild cleared its marker
    kit.db.prepare(`UPDATE mem_vault SET state = 'indexing', last_full_scan_at = NULL WHERE company_id = ?`).run(CO)
    expect(kit.index.registerVault(CO, kit.root)).toBe(true)
  })

  it('a line cut from one note and pasted into another is a move, not an external removal', () => {
    kit = makeKit()
    kit.write('People/Ana.md', note(ANA, 'Ana', '\n- [fact] moving ^f-aaaaaaaaaa\n'))
    kit.write('People/Bo.md', note('n-bo00000001', 'Bo', '\n'))
    kit.index.rebuild(CO)
    kit.write('People/Ana.md', note(ANA, 'Ana', '\n'))
    kit.write('People/Bo.md', note('n-bo00000001', 'Bo', '\n- [fact] moving ^f-aaaaaaaaaa\n'))
    // the paste is seen first: the cut note still holds the block id for a moment
    kit.index.indexNote(CO, 'People/Bo.md')
    kit.index.indexNote(CO, 'People/Ana.md')
    expect(kit.index.findBlock(CO, 'f-aaaaaaaaaa')!.noteId).toBe('n-bo00000001')
    expect(kit.db.prepare('SELECT count(*) AS n FROM mem_proposal').get()).toEqual({ n: 0 })
    expect(kit.db.prepare(`SELECT count(*) AS n FROM mem_fact WHERE status = 'removed_external'`).get()).toEqual({ n: 0 })
    const inc = dumpDerived(kit.db, CO)
    kit.index.rebuild(CO)
    expect(dumpDerived(kit.db, CO)).toEqual(inc)
  })

  it('refuses a vault folder shared with or nested in another company vault', () => {
    kit = makeKit()
    expect(() => kit.index.registerVault('co_other', kit.root)).toThrow(/overlaps/)
    expect(() => kit.index.registerVault('co_other', path.join(kit.root, 'People'))).toThrow(/overlaps/)
    expect(() => kit.index.registerVault('co_other', kit.dir)).toThrow(/overlaps/)
    expect(kit.index.hasVault('co_other')).toBe(false)
    expect(kit.index.registerVault('co_other', `${kit.root}-2`)).toBe(true)
    expect(kit.index.registerVault(CO, kit.root)).toBe(true) // re-registering the same company is fine
  })

  it('graph layout follows a hand-written note when Principia stamps its id', async () => {
    kit = makeKit()
    kit.write('Inbox/Idea.md', '# Idea\n')
    kit.index.rebuild(CO)
    saveLayout(kit.db, CO, [{ noteId: 'h:Inbox/Idea.md', x: 3, y: 4, pinned: true }])
    const r = await kit.writer.apply(CO, [{ op: 'observe', note: 'Idea', category: 'fact', text: 'Stamped' }], { actor: 'user' })
    const id = r.results[0].noteId!
    expect(id).toMatch(/^n-/)
    expect(getLayout(kit.db, CO)).toEqual([{ noteId: id, x: 3, y: 4, pinned: true }])
  })
})
