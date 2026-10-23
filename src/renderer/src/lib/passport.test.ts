import { describe, expect, it } from 'vitest'
import type { VaultGhost, VaultLink, VaultProposal } from '@shared/passport'
import {
  applyCompletion,
  blockLink,
  buildFolderTree,
  buildTagTree,
  bulkAcceptIds,
  completionContext,
  diffRows,
  firstLoadFilters,
  groupInbox,
  inboxSection,
  linkCompletions,
  linkValueTitle,
  liveAction,
  makeResolver,
  mergeSections,
  missingProperties,
  propertyKind,
  recentNotes,
  saveLanding,
  tagCompletions,
  typeCounts,
  type TreeNote
} from './passport'

const note = (id: string, path: string, title: string, type = 'note', extra: Partial<TreeNote> = {}): TreeNote => ({
  id,
  path,
  title,
  type,
  status: 'active',
  pinned: false,
  modified: null,
  orphan: false,
  ...extra
})
const TREE: TreeNote[] = [
  note('n-acme', 'Acme.md', 'Acme', 'company'),
  note('n-ana', 'People/Ana Ruiz.md', 'Ana Ruiz', 'person', { aliases: ['Ana'], modified: '2026-10-19' }),
  note('n-lau', 'People/Lautaro.md', 'Lautaro', 'person', { modified: '2026-10-20' }),
  note('n-pro', 'Offers/Pro Plan.md', 'Pro Plan', 'offer'),
  note('n-merc1', 'Customers/Mercury (Customer).md', 'Mercury', 'customer'),
  note('n-merc2', 'Concepts/Mercury (Concept).md', 'Mercury', 'concept'),
  note('n-deep', 'Processes/Sales/Onboarding.md', 'Onboarding', 'process')
]
const ghost = (text: string, inbound = 1): VaultGhost => ({ text, norm: text.toLowerCase(), inbound, sources: inbound, ambiguous: false, candidates: [], guessedType: null })

describe('vault tree', () => {
  it('nests folders with counts, folders first', () => {
    const root = buildFolderTree(TREE)
    expect(root.count).toBe(7)
    expect(root.notes.map((n) => n.title)).toEqual(['Acme'])
    expect(root.folders.map((f) => [f.name, f.count])).toEqual([
      ['Concepts', 1],
      ['Customers', 1],
      ['Offers', 1],
      ['People', 2],
      ['Processes', 1]
    ])
    expect(root.folders[4]!.folders[0]).toMatchObject({ name: 'Sales', path: 'Processes/Sales', count: 1 })
  })

  it('filters by type and drops empty folders', () => {
    const root = buildFolderTree(TREE, 'person')
    expect(root.count).toBe(2)
    expect(root.folders.map((f) => f.name)).toEqual(['People'])
    expect(typeCounts(TREE)[0]).toEqual({ type: 'person', count: 2 })
  })

  it('lists recent notes newest first', () => {
    expect(recentNotes(TREE).map((n) => n.title)).toEqual(['Lautaro', 'Ana Ruiz'])
  })

  it('builds a nested tag tree with totals', () => {
    const t = buildTagTree([
      { tag: 'team/founding', display: 'team/founding', count: 2 },
      { tag: 'team', display: 'team', count: 1 },
      { tag: 'pricing', display: 'pricing', count: 1 }
    ])
    expect(t.map((x) => [x.tag, x.total])).toEqual([
      ['team', 3],
      ['pricing', 1]
    ])
    expect(t[0]!.children[0]).toMatchObject({ name: 'founding', tag: 'team/founding', count: 2 })
  })
})

describe('makeResolver', () => {
  it('copes with an empty vault and legacy outgoing rows', () => {
    const r = makeResolver([], [])
    expect(r('Anything')).toBeNull()
    expect(r('People/Ana')).toBeNull()
  })

  it('prefers the index answer from outgoing links, then path, basename, title, alias', () => {
    const out = [{ toText: 'Mercury', toNote: 'n-merc1', toTitle: 'Mercury' } as VaultLink]
    const r = makeResolver(TREE, out)
    expect(r('mercury')?.noteId).toBe('n-merc1')
    expect(r('People/Ana Ruiz')?.noteId).toBe('n-ana')
    expect(r('Sales/Onboarding')?.noteId).toBe('n-deep') // path suffix
    expect(r('Ana')?.noteId).toBe('n-ana') // alias
    expect(r('Nobody')).toBeNull()
  })

  it('keeps an ambiguous title a ghost', () => {
    expect(makeResolver(TREE)('Mercury')).toBeNull()
    expect(makeResolver(TREE)('Mercury (Customer)')?.noteId).toBe('n-merc1') // unique basename
  })

  it('a ghost in outgoing stays a ghost even if a later tree entry looks similar', () => {
    const r = makeResolver(TREE, [{ toText: 'Globex', toNote: null, toTitle: null } as VaultLink])
    expect(r('Globex')).toBeNull()
  })
})

describe('completion', () => {
  it('detects an open [[ and # before the caret', () => {
    expect(completionContext('see [[Ana R', 11)).toEqual({ kind: 'link', start: 6, query: 'Ana R' })
    expect(completionContext('see [[Ana]] x', 13)).toBeNull()
    expect(completionContext('a #pri', 6)).toEqual({ kind: 'tag', start: 3, query: 'pri' })
    expect(completionContext('#', 1)).toBeNull() // could be a heading
    expect(completionContext('# Title', 7)).toBeNull()
    expect(completionContext('`code [[x', 9)).toBeNull()
    expect(completionContext('line one [[\nnext', 16)).toBeNull()
  })

  it('offers titles, aliases as Title|alias, ghosts and a new link', () => {
    const items = linkCompletions('ana', TREE, [ghost('Anabel')])
    expect(items[0]).toMatchObject({ kind: 'note', insert: 'Ana Ruiz', noteId: 'n-ana' })
    expect(items.find((i) => i.kind === 'alias')).toMatchObject({ label: 'Ana', insert: 'Ana Ruiz|Ana' })
    expect(items.find((i) => i.kind === 'ghost')?.insert).toBe('Anabel')
    expect(items.some((i) => i.kind === 'new')).toBe(false) // the alias matches exactly
    expect(linkCompletions('Zed', TREE, []).pop()).toMatchObject({ kind: 'new', insert: 'Zed' })
    expect(linkCompletions('Lautaro', TREE, []).some((i) => i.kind === 'new')).toBe(false)
    expect(linkCompletions('', TREE, [ghost('Popular', 3)]).some((i) => i.label === 'Popular')).toBe(true)
  })

  it('inserts the pick and closes the link once', () => {
    const t = 'see [[Ana R'
    const ctx = completionContext(t, t.length)!
    expect(applyCompletion(t, t.length, ctx, { kind: 'alias', label: 'Ana', detail: '', insert: 'Ana Ruiz|Ana' })).toEqual({ text: 'see [[Ana Ruiz|Ana]]', caret: 20 })
    const t2 = 'see [[An]] later'
    const c2 = completionContext(t2, 8)!
    expect(applyCompletion(t2, 8, c2, { kind: 'note', label: 'Ana Ruiz', detail: '', insert: 'Ana Ruiz' }).text).toBe('see [[Ana Ruiz]] later')
  })

  it('completes tags', () => {
    const tags = [
      { tag: 'pricing', display: 'pricing', count: 3 },
      { tag: 'team/founding', display: 'team/founding', count: 1 }
    ]
    expect(tagCompletions('pri', tags).map((i) => i.insert)).toEqual(['pricing'])
    const t = 'cost #pri'
    const ctx = completionContext(t, t.length)!
    expect(applyCompletion(t, t.length, ctx, tagCompletions('pri', tags)[0]!)).toEqual({ text: 'cost #pricing ', caret: 14 })
  })

  it('formats block links', () => {
    expect(blockLink('Ana Ruiz', '^f-9q1c3m8d2e')).toBe('[[Ana Ruiz#^f-9q1c3m8d2e]]')
  })
})

describe('live updates', () => {
  it('replaces a clean editor, flags a dirty one, ignores its own save', () => {
    expect(liveAction({ baseHash: 'a', diskHash: 'a', dirty: true })).toBe('none')
    expect(liveAction({ baseHash: 'a', diskHash: 'b', dirty: false })).toBe('replace')
    expect(liveAction({ baseHash: 'a', diskHash: 'b', dirty: true })).toBe('banner')
  })
})

describe('save landing', () => {
  it('applies an answer only to the note it saved', () => {
    expect(saveLanding({ openNoteId: 'n-a', savedNoteId: 'n-a', status: 'saved' })).toBe('apply')
    expect(saveLanding({ openNoteId: 'n-a', savedNoteId: 'n-a', status: 'conflict' })).toBe('apply')
    // blur saved A, then B opened before the answer: A's detail must not replace B (the next autosave would write
    // B's text into A's file)
    expect(saveLanding({ openNoteId: 'n-b', savedNoteId: 'n-a', status: 'saved' })).toBe('ignore')
    expect(saveLanding({ openNoteId: 'n-b', savedNoteId: 'n-a', status: 'conflict' })).toBe('report')
    expect(saveLanding({ openNoteId: null, savedNoteId: 'n-a', status: 'saved' })).toBe('ignore')
  })
})

describe('persisted settings', () => {
  const defaults = { filters: { search: '', orphans: true, existingOnly: false }, groups: [{ query: 'path:"People"', color: '#4f9dde' }], k: 1 }

  it('merges saved sections over defaults, filling fields added later', () => {
    const m = mergeSections(defaults, { filters: { search: 'ana' }, groups: [], k: 2 })
    expect(m.filters).toEqual({ search: 'ana', orphans: true, existingOnly: false })
    expect(m.groups).toEqual([])
    expect(m.k).toBe(2)
  })

  it('falls back to defaults for missing, corrupt or wrongly shaped values', () => {
    expect(mergeSections(defaults, null)).toBe(defaults)
    expect(mergeSections(defaults, 'nope')).toBe(defaults)
    expect(mergeSections(defaults, [1, 2])).toBe(defaults)
    const m = mergeSections(defaults, { filters: [1], groups: { a: 1 }, k: 'x' })
    expect(m).toEqual(defaults)
  })

  it('hides ghosts and orphans on the first load of a huge vault only', () => {
    const f = { search: '', existingOnly: false, orphans: true }
    expect(firstLoadFilters(2000, f)).toBeNull()
    expect(firstLoadFilters(5001, f)).toEqual({ search: '', existingOnly: true, orphans: false })
    expect(firstLoadFilters(9000, { ...f, existingOnly: true, orphans: false })).toBeNull()
  })
})

describe('inbox', () => {
  const p = (id: string, kind: VaultProposal['kind'], source: VaultProposal['source'], score: number, needsDecision = false): VaultProposal => ({
    id,
    companyId: 'co_a',
    kind,
    title: id,
    ops: [],
    evidence: [],
    preview: [],
    score,
    source,
    status: 'pending',
    needsDecision,
    createdAt: '2026-10-20T00:00:00Z',
    decidedAt: null,
    decidedBy: null
  })
  const items = [p('a', 'link', 'mentions', 0.9), p('b', 'link', 'mentions', 0.8), p('c', 'link', 'mentions', 0.5), p('d', 'link', 'llm', 0.95), p('e', 'fact_supersede', 'writer', 1, true), p('f', 'merge', 'dupes', 0.9)]

  it('sections proposals with Needs decision first', () => {
    const g = groupInbox(items)
    expect(g.map((s) => s.key)).toEqual(['decision', 'links', 'merges'])
    expect(g[1]!.items.map((x) => x.id)).toEqual(['d', 'a', 'b', 'c'])
    expect(inboxSection({ kind: 'conflict', needsDecision: false })).toBe('decision')
  })

  it('bulk accept takes same kind and source above the threshold, deterministic sources only', () => {
    expect(bulkAcceptIds(items, items[0]!)).toEqual(['a', 'b'])
    expect(bulkAcceptIds(items, items[2]!)).toEqual(['a', 'b', 'c']) // the focused one always counts
    expect(bulkAcceptIds(items, items[3]!)).toEqual([]) // llm
    expect(bulkAcceptIds(items, items[4]!)).toEqual([]) // needs decision
  })

  it('diffs a preview with folded context', () => {
    const before = ['# A', '1', '2', '3', '4', '5', '6', 'old', 'z'].join('\n')
    const after = ['# A', '1', '2', '3', '4', '5', '6', 'new', 'z'].join('\n')
    const rows = diffRows(before, after)
    expect(rows.map((r) => r.kind)).toEqual(['…', ' ', ' ', '-', '+', ' '])
    expect(rows.find((r) => r.kind === '-')?.text).toBe('old')
    expect(rows[0]!.text).toBe('5 unchanged lines')
  })
})

describe('properties', () => {
  it('reads property kinds and link values', () => {
    expect(propertyKind('company', '[[Acme]]')).toBe('link')
    expect(propertyKind('repos', ['[[acme-web]]'])).toBe('links')
    expect(propertyKind('pinned', false)).toBe('checkbox')
    expect(propertyKind('aliases', ['Ana'])).toBe('list')
    expect(propertyKind('due', '2026-10-01')).toBe('date')
    expect(linkValueTitle('[[Acme|the company]]')).toBe('Acme')
    expect(linkValueTitle('Acme')).toBeNull()
  })

  it('hints missing expected fields', () => {
    expect(missingProperties('person', {})).toEqual(['company'])
    expect(missingProperties('person', { company: '[[Acme]]' })).toEqual([])
    expect(missingProperties('note', {})).toEqual([])
  })
})

describe('merge', () => {
  it('merges one-sided changes and resolves conflicts by pick', async () => {
    const { merge3 } = await import('@shared/vault/diff3')
    const { joinRegions } = await import('./passport')
    const base = 'a\nb\nc\nd\n'
    const ours = 'a\nB-mine\nc\nd\n'
    const theirs = 'a\nB-theirs\nc\nD\n'
    const r = merge3(base, ours, theirs)
    const idx = r.regions.findIndex((x) => !x.stable && x.conflict)
    expect(idx).toBeGreaterThanOrEqual(0)
    expect(joinRegions(r.regions, { [idx]: 'ours' })).toBe('a\nB-mine\nc\nD\n')
    expect(joinRegions(r.regions, { [idx]: 'theirs' })).toBe('a\nB-theirs\nc\nD\n')
    expect(joinRegions(r.regions, { [idx]: 'both' })).toBe('a\nB-mine\nB-theirs\nc\nD\n')
  })
})
