// PASSPORT.md §8: the brief (section budgets and ordering, company isolation, the company card), PPR seeds and edge
// weights, and the §8.1 vault queries (backlinks, unlinked mentions, local/global graph, tags, ghosts) on fixture vaults.
import fs from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { makeKit, nativeOk, type Kit } from '../vault/__tests__/vaultTestKit'
import { buildPassportBrief, companyCardLines, knownNotesLine, PASSPORT_BRIEF, renderCompanyCard } from '../brief'
import { expand, loadLinkGraph, neighbours, personalizedPageRank, seedsFor, SEED_WEIGHT } from '../expand'
import { backlinks, EDGE_WEIGHT, globalGraph, localGraph, notesTree, outgoingLinks, unlinkedMentions, vaultGhosts, vaultNoteDetail, vaultSearch, vaultTags } from '../search'

const d = nativeOk ? describe : describe.skip
const A = 'co_acme'
const B = 'co_globex'
const kits: Kit[] = []
afterEach(() => {
  while (kits.length) kits.pop()!.close()
})

function fm(id: string, title: string, type: string, extra = ''): string {
  return `---\nid: ${id}\ntitle: ${title}\ntype: ${type}\n${extra}---\n# ${title}\n`
}

/** Acme: hub, people, a product, a repo note, a decision, plus a ghost and an unlinked mention. */
function acme(): Kit {
  const k = makeKit({ companyId: A })
  kits.push(k)
  k.write('Acme.md', fm('n-acme000001', 'Acme', 'company') + 'Acme sells developer tools.\n\n## Observations\n- [mission] Make billing boring (user, 2026-10-01) ^f-mission001\n- [audience] Indie SaaS founders (user, 2026-10-01) ^f-audienc001\n- [note] Office plants need water (user, 2026-10-01) ^f-plants0001\n')
  k.write('People/Ana Ruiz.md', fm('n-ana0000001', 'Ana Ruiz', 'person', 'aliases: [Ana]\ntags: [team/founding]\n') + 'Head of growth at [[Acme]].\n\n## Observations\n- [role] Head of growth #growth (user, 2026-10-01) ^f-anarole001\n\n## Relations\n- works_at [[Acme]] ^r-anaworks01\n- decided [[Pricing v2]] ^r-anadecid01\n')
  k.write('Products/Stripe.md', fm('n-stripe0001', 'Stripe', 'product') + 'Payments provider.\n\n## Observations\n- [gotcha] Stripe webhooks need the raw request body (claude run#7, 2026-10-10) ^f-stripewh01\n\n## Relations\n- integrates_with [[acme-web]] ^r-stripeint1\n')
  k.write('Repos/acme-web.md', fm('n-acmeweb001', 'acme-web', 'repo', 'repo_id: repo_web0000001\n') + 'The web app.\n\n## Relations\n- part_of [[Acme]] ^r-webpart001\n- uses [[Onboarding flow]] ^r-webonbo001\n')
  k.write('Decisions/Pricing v2.md', fm('n-pricing001', 'Pricing v2', 'decision', 'pinned: true\n') + 'Pro moves to $49.\n\n## Observations\n- [decision] Pro is $49/mo #pin (user, 2026-10-12) ^f-pricepro01\n')
  k.write('Meetings/Kickoff.md', fm('n-kickoff001', 'Kickoff', 'meeting') + 'Ana Ruiz walked through the roadmap. We also discussed Stripe.\n')
  k.index.rebuild(A)
  return k
}

/** A second company in the same index db, with its own secrets. */
function globexInto(k: Kit): void {
  const root = `${k.dir}/Globex`
  fs.mkdirSync(`${root}/People`, { recursive: true })
  fs.writeFileSync(`${root}/Globex.md`, fm('n-globex0001', 'Globex', 'company') + 'Globex makes widgets.\n\n## Observations\n- [mission] Globex secret plan zebra (user, 2026-10-01) ^f-globexm001\n')
  fs.writeFileSync(`${root}/People/Stripe Person.md`, fm('n-gstripe001', 'Stripe Person', 'person') + 'Globex stripe webhooks raw body owner.\n\n## Observations\n- [gotcha] Globex stripe webhooks raw body zebra (user, 2026-10-01) ^f-gstripe001\n')
  k.index.registerVault(B, root)
  k.index.rebuild(B)
}

d('the brief (§8.3)', () => {
  it('orders sections card, Pinned, Relevant, Nearby (Known notes for inject runs), inside the tag, with block ids', () => {
    const k = acme()
    const { text, noteIds } = buildPassportBrief(k.db, { companyId: A, companyName: 'Acme', repo: { id: 'repo_web0000001', name: 'acme-web' }, query: 'fix the stripe webhook handler', transport: 'mcp' })
    expect(text.startsWith('<principia-passport company="Acme" repo="acme-web" here="[[acme-web]]">')).toBe(true)
    expect(text.endsWith('</principia-passport>')).toBe(true)
    const heads = text.split('\n').filter((l) => l.startsWith('## '))
    expect(heads[0]).toBe('## [[Acme]] (company)')
    // an MCP run gets the known titles from the hivemem server instructions, so the brief does not repeat them
    expect(heads.slice(1)).toEqual(['## Pinned', '## Relevant to this task', '## Nearby'])
    // the card leads with the profile categories
    const card = text.split('\n')
    const ci = card.indexOf('## [[Acme]] (company)')
    expect(card[ci + 1]).toContain('Acme sells developer tools')
    expect(card[ci + 2]).toBe('mission: Make billing boring')
    expect(card[ci + 3]).toBe('audience: Indie SaaS founders')
    expect(text).toContain('- [[Pricing v2]] decision: Pro is $49/mo #pin ^f-pricepro01')
    expect(text).toMatch(/- \[\[Stripe\]\] \(product\) gotcha: Stripe webhooks need the raw request body \^f-stripewh01 · integrates_with \[\[acme-web\]\]/)
    const inject = buildPassportBrief(k.db, { companyId: A, companyName: 'Acme', repo: { id: 'repo_web0000001', name: 'acme-web' }, query: 'fix the stripe webhook handler', transport: 'inject' }).text
    expect(inject.split('\n').filter((l) => l.startsWith('## ')).pop()).toBe('## Known notes: link with these exact titles')
    expect(inject).toMatch(/people: \[\[Ana Ruiz\]\] \(Ana\)/)
    expect(inject).toMatch(/unwritten: \[\[Onboarding flow\]\]/)
    // an inject run has no tools to supersede with, so its lines carry no block ids
    expect(inject).not.toMatch(/\^f-/)
    expect(noteIds).toEqual(expect.arrayContaining(['n-acme000001', 'n-pricing001', 'n-stripe0001']))
    expect(text.length).toBeLessThanOrEqual(PASSPORT_BRIEF.totalChars)
  })

  it('keeps every section within its budget and the total near 6000 characters', () => {
    const k = acme()
    for (let i = 0; i < 60; i++) {
      k.write(`Concepts/Topic ${i}.md`, fm(`n-topic${String(i).padStart(5, '0')}`, `Topic ${i}`, 'concept', 'pinned: true\n') + `webhook topic ${i} [[Stripe]]\n\n## Observations\n- [fact] webhook detail number ${i} ${'x'.repeat(120)} (user, 2026-10-01) ^f-topic${String(i).padStart(5, '0')}\n`)
    }
    k.index.rebuild(A)
    const { text } = buildPassportBrief(k.db, { companyId: A, companyName: 'Acme', query: 'webhook topic detail', transport: 'inject' })
    expect(text.length).toBeLessThanOrEqual(PASSPORT_BRIEF.totalChars)
    const section = (head: string) => {
      const lines = text.split('\n')
      const i = lines.indexOf(head)
      if (i < 0) return ''
      const out: string[] = []
      for (let j = i + 1; j < lines.length && !lines[j].startsWith('## ') && !lines[j].startsWith('</'); j++) out.push(lines[j])
      return out.join('\n')
    }
    expect(section('## Pinned').length).toBeLessThanOrEqual(PASSPORT_BRIEF.pinnedChars)
    expect(section('## Relevant to this task').length).toBeLessThanOrEqual(PASSPORT_BRIEF.relevantChars)
    expect(section('## Known notes: link with these exact titles').length).toBeLessThanOrEqual(PASSPORT_BRIEF.knownChars)
    expect(text).toContain('PARTIAL')
  })

  it("never shows another company's rows (A's brief, card and known notes hold nothing of B)", () => {
    const k = acme()
    globexInto(k)
    const { text } = buildPassportBrief(k.db, { companyId: A, companyName: 'Acme', query: 'stripe webhooks raw body zebra secret plan', transport: 'mcp' })
    expect(text).not.toMatch(/Globex|zebra|Stripe Person/)
    expect(knownNotesLine(k.db, A)).not.toMatch(/Globex|Stripe Person/)
    const b = buildPassportBrief(k.db, { companyId: B, companyName: 'Globex', query: 'stripe webhooks', transport: 'mcp' }).text
    expect(b).toContain('zebra')
    expect(b).not.toMatch(/Ana Ruiz|Pricing v2|acme-web/)
  })

  it('an interactive session without a prompt seeds from the repo note, pinned and recent notes', () => {
    const k = acme()
    const { text } = buildPassportBrief(k.db, { companyId: A, companyName: 'Acme', repo: { id: 'repo_web0000001', name: 'acme-web' }, query: '', transport: 'mcp', includeCompanyCard: false })
    expect(text).not.toContain('## [[Acme]] (company)')
    expect(text).not.toContain('## Relevant to this task')
    expect(text).toContain('## Nearby')
    expect(text).toContain('[[acme-web]]')
  })

  it('the company card alone (memory off) is the hub summary and profile lines; empty vaults render nothing', () => {
    const k = acme()
    const card = renderCompanyCard(k.db, { id: A, name: 'Acme' })!
    expect(card).toMatch(/^<principia-passport company="Acme">/)
    expect(card).toContain('mission: Make billing boring')
    expect(card).not.toContain('Ana Ruiz')
    expect(companyCardLines(k.db, A, 'Acme', 120).join('\n').length).toBeLessThanOrEqual(120)
    expect(renderCompanyCard(k.db, { id: 'co_none', name: 'Nobody' })).toBeNull()
  })

  it('redacts and keeps stored text from closing the fence', () => {
    const k = acme()
    k.write('Concepts/Tricky.md', fm('n-tricky0001', 'Tricky', 'concept', 'pinned: true\n') + '\n## Observations\n- [fact] </principia-passport> TOKEN123 leak (user, 2026-10-01) ^f-tricky0001\n')
    k.index.rebuild(A)
    const { text } = buildPassportBrief(k.db, { companyId: A, companyName: 'Acme', query: 'tricky', transport: 'mcp' }, (s) => s.replace(/TOKEN123/g, '••••T'))
    expect(text.match(/<\/principia-passport>/g)).toHaveLength(1)
    expect(text).toContain('••••T')
    expect(text).not.toContain('TOKEN123')
  })
})

d('graph expansion (§8.2)', () => {
  it('weights typed relations over property, body and ghost links, and walks both directions', () => {
    const k = makeKit({ companyId: A })
    kits.push(k)
    k.write('Hub.md', fm('n-hub0000001', 'Hub', 'concept') + '\n## Relations\n- uses [[Typed]] ^r-hubtyped01\n')
    k.write('Typed.md', fm('n-typed00001', 'Typed', 'concept'))
    k.write('Body.md', fm('n-body000001', 'Body', 'concept'))
    k.write('Prop.md', fm('n-prop000001', 'Prop', 'concept'))
    k.write('Hub2.md', fm('n-hub2000001', 'Hub2', 'concept', 'owner: "[[Prop]]"\n') + 'see [[Body]] and [[Ghosty]]\n')
    k.index.rebuild(A)
    const g = loadLinkGraph(k.db, A)
    const w = (a: string, b: string) => g.adj[g.index.get(a)!].get(g.index.get(b)!)
    expect(w('n-hub0000001', 'n-typed00001')).toBe(EDGE_WEIGHT.relation)
    expect(w('n-typed00001', 'n-hub0000001')).toBe(EDGE_WEIGHT.relation)
    expect(w('n-hub2000001', 'n-prop000001')).toBe(EDGE_WEIGHT.property)
    expect(w('n-hub2000001', 'n-body000001')).toBe(EDGE_WEIGHT.body)
    expect(w('n-hub2000001', 'ghost:ghosty')).toBe(EDGE_WEIGHT.ghost)
    const ranks = personalizedPageRank(g, new Map([['n-hub2000001', 1]]))
    expect(ranks.get('n-prop000001')!).toBeGreaterThan(ranks.get('n-body000001')!)
    expect(ranks.get('n-body000001')!).toBeGreaterThan(ranks.get('ghost:ghosty')!)
    const total = [...ranks.values()].reduce((s, x) => s + x, 0)
    expect(total).toBeCloseTo(1, 6)
  })

  it('links notes sharing a small tag (0.15) and ignores tags with more than 20 members', () => {
    const k = makeKit({ companyId: A })
    kits.push(k)
    k.write('X.md', fm('n-x000000001', 'X', 'concept', 'tags: [rare]\n'))
    k.write('Y.md', fm('n-y000000001', 'Y', 'concept', 'tags: [rare]\n'))
    for (let i = 0; i < 22; i++) k.write(`C${i}.md`, fm(`n-c${String(i).padStart(9, '0')}`, `C${i}`, 'concept', 'tags: [common]\n'))
    k.index.rebuild(A)
    const g = loadLinkGraph(k.db, A)
    expect(g.adj[g.index.get('n-x000000001')!].get(g.index.get('n-y000000001')!)).toBe(EDGE_WEIGHT.tag)
    expect(g.adj[g.index.get('n-c000000000')!].size).toBe(0)
  })

  it('seeds from prompt mentions, bm25 hits, the repo note and pinned notes', () => {
    const k = acme()
    const seeds = seedsFor(k.db, A, { query: 'Talk to [[Ana Ruiz]] about webhooks', repoId: 'repo_web0000001' })
    expect(seeds.get('n-ana0000001')).toBe(SEED_WEIGHT.mention)
    expect(seeds.get('n-acmeweb001')).toBe(SEED_WEIGHT.repo)
    expect(seeds.get('n-pricing001')).toBe(SEED_WEIGHT.pinned)
    expect(seeds.get('n-stripe0001')).toBeGreaterThan(0)
    const ring = expand(loadLinkGraph(k.db, A), seeds, { limit: 5 })
    expect(ring.map((e) => e.id)).not.toContain('n-ana0000001')
    expect(ring.map((e) => e.id)).toContain('n-acme000001')
  })

  it('neighbours(depth) stays within the hop limit and ranks by PPR', () => {
    const k = acme()
    const one = neighbours(k.db, A, ['n-stripe0001'], 1).map((e) => e.id)
    expect(one).toEqual(['n-acmeweb001'])
    const two = neighbours(k.db, A, ['n-stripe0001'], 2).map((e) => e.id)
    expect(two).toEqual(expect.arrayContaining(['n-acmeweb001', 'n-acme000001', 'ghost:onboarding flow']))
  })

  it('runs 15 iterations over a few thousand nodes quickly', () => {
    const k = makeKit({ companyId: A })
    kits.push(k)
    const ins = k.db.prepare(
      `INSERT INTO mem_note (id, company_id, path, path_norm, basename_norm, title, norm_title, type, hash, indexed_at) VALUES (?,?,?,?,?,?,?,?,?,?)`
    )
    const link = k.db.prepare(
      `INSERT INTO mem_link (id, company_id, from_note, line, rel, norm_rel, origin, to_note, to_text, to_norm) VALUES (?,?,?,0,'links_to','links_to','body',?,?,?)`
    )
    k.db.transaction(() => {
      for (let i = 0; i < 3000; i++) ins.run(`n-${i}`, A, `N${i}.md`, `n${i}`, `n${i}`, `N${i}`, `n${i}`, 'note', 'h', 'now')
      for (let i = 0; i < 9000; i++) {
        const a = i % 3000
        const b = (i * 7 + 13) % 3000
        link.run(`l${i}`, A, `n-${a}`, `n-${b}`, `N${b}`, `n${b}`)
      }
    })()
    const g = loadLinkGraph(k.db, A)
    const t = performance.now()
    personalizedPageRank(g, new Map([['n-1', 1], ['n-2', 0.5]]))
    expect(performance.now() - t).toBeLessThan(50)
  })
})

d('vault queries (§8.1)', () => {
  it('backlinks are grouped by inverse label with the linking line', () => {
    const k = acme()
    const groups = backlinks(k.db, A, 'n-acme000001')
    const labels = groups.map((g) => g.label)
    expect(labels).toEqual(expect.arrayContaining(['employs', 'has_part', 'linked_from']))
    expect(labels[labels.length - 1]).toBe('linked_from')
    const employs = groups.find((g) => g.label === 'employs')!
    expect(employs.items[0]).toMatchObject({ fromNote: 'n-ana0000001', fromTitle: 'Ana Ruiz', fromPath: 'People/Ana Ruiz.md' })
    const prose = groups.find((g) => g.label === 'linked_from')!
    expect(prose.items.some((i) => i.context.includes('Head of growth at [[Acme]]'))).toBe(true)
  })

  it('unlinked mentions find the title and aliases in plain text, never inside existing links or the note itself', () => {
    const k = acme()
    const ana = unlinkedMentions(k.db, A, 'n-ana0000001', { root: k.root })
    expect(ana).toHaveLength(1)
    expect(ana[0]).toMatchObject({ noteId: 'n-kickoff001', title: 'Kickoff', matched: 'Ana Ruiz' })
    expect(ana[0].text.slice(ana[0].span.start, ana[0].span.end)).toBe('Ana Ruiz')
    const stripe = unlinkedMentions(k.db, A, 'n-stripe0001', { root: k.root })
    expect(stripe.map((m) => m.noteId)).toEqual(['n-kickoff001'])
  })

  it('outgoing links include ghosts and ambiguity; the note detail carries facts, relations and properties', () => {
    const k = acme()
    const out = outgoingLinks(k.db, A, 'n-acmeweb001')
    const ghost = out.find((l) => l.toText === 'Onboarding flow')!
    expect(ghost.toNote).toBeNull()
    expect(out.find((l) => l.toText === 'Acme')).toMatchObject({ toNote: 'n-acme000001', rel: 'part_of', inverse: 'has_part', origin: 'relation' })
    const detail = vaultNoteDetail(k.db, A, 'n-ana0000001')!
    expect(detail.note).toMatchObject({ title: 'Ana Ruiz', aliases: ['Ana'], type: 'person' })
    expect(detail.note.tags).toEqual(expect.arrayContaining(['growth', 'team/founding']))
    expect(detail.facts.map((f) => f.blockId)).toEqual(['f-anarole001'])
    expect(detail.relations.map((r) => r.rel)).toEqual(['works_at', 'decided'])
    expect(detail.properties.aliases).toEqual(['Ana'])
  })

  it('the local graph walks both directions to the requested depth, with ghost and tag nodes on request', () => {
    const k = acme()
    const g1 = localGraph(k.db, A, 'n-stripe0001', 1)
    expect(g1.centerId).toBe('n-stripe0001')
    expect(g1.nodes.map((n) => n[0]).sort()).toEqual(['n-acmeweb001', 'n-stripe0001'])
    const g2 = localGraph(k.db, A, 'n-stripe0001', 2)
    const ids = g2.nodes.map((n) => n[0])
    expect(ids).toEqual(expect.arrayContaining(['n-acme000001', 'ghost:onboarding flow']))
    const ghost = g2.nodes.find((n) => n[0] === 'ghost:onboarding flow')!
    expect(ghost[4]).toBe(1)
    expect(localGraph(k.db, A, 'n-stripe0001', 2, { ghosts: false }).nodes.some((n) => n[4] === 1)).toBe(false)
    const tagged = localGraph(k.db, A, 'n-ana0000001', 1, { tags: true })
    expect(tagged.nodes.some((n) => n[0] === 'tag:team/founding')).toBe(true)
    for (const [s, t] of g2.edges) expect(s).not.toBe(t)
  })

  it('the global graph is company-scoped, carries ghosts unless existingOnly, filters by type and tag, and keeps positions', () => {
    const k = acme()
    globexInto(k)
    k.db.prepare('INSERT INTO mem_layout (company_id, note_id, x, y, pinned) VALUES (?,?,?,?,1)').run(A, 'n-ana0000001', 10, 20)
    const g = globalGraph(k.db, A)
    expect(g.nodes.some((n) => n[1] === 'Globex')).toBe(false)
    expect(g.nodes.some((n) => n[0] === 'ghost:onboarding flow')).toBe(true)
    expect(g.positions).toEqual([['n-ana0000001', 10, 20, 1]])
    const acmeNode = g.nodes.findIndex((n) => n[0] === 'n-acme000001')
    expect(g.nodes[acmeNode][3]).toBeGreaterThanOrEqual(3)
    expect(globalGraph(k.db, A, { existingOnly: true }).nodes.some((n) => n[4] === 1)).toBe(false)
    expect(globalGraph(k.db, A, { types: ['person'] }).nodes.map((n) => n[1])).toEqual(['Ana Ruiz'])
    expect(globalGraph(k.db, A, { tags: ['team'] }).nodes.map((n) => n[1])).toEqual(['Ana Ruiz'])
    expect(globalGraph(k.db, A, { search: 'webhooks' }).nodes.some((n) => n[1] === 'Stripe')).toBe(true)
  })

  it('tags, ghosts and the tree count one company only', () => {
    const k = acme()
    globexInto(k)
    expect(vaultTags(k.db, A).map((t) => t.tag)).toEqual(expect.arrayContaining(['team/founding', 'growth', 'pin']))
    expect(vaultGhosts(k.db, A)).toEqual([expect.objectContaining({ text: 'Onboarding flow', inbound: 1, sources: 1 })])
    const tree = notesTree(k.db, A)
    expect(tree.map((t) => t.path)).not.toContain('Globex.md')
    expect(tree.find((t) => t.title === 'Kickoff')!.orphan).toBe(true)
  })

  it('ranked search puts exact titles first and scopes the repo neighbourhood at 1.0', () => {
    const k = acme()
    const hits = vaultSearch(k.db, { companyId: A }, 'stripe')
    expect(hits[0]).toMatchObject({ exact: true })
    expect(hits[0].note.title).toBe('Stripe')
    expect(hits[0].facts[0].blockId).toBe('f-stripewh01')
    const scoped = vaultSearch(k.db, { companyId: A, repoId: 'repo_web0000001' }, 'webhooks')
    const plain = vaultSearch(k.db, { companyId: A }, 'webhooks')
    expect(scoped[0].note.title).toBe('Stripe')
    expect(scoped[0].score).toBeCloseTo(plain[0].score, 3) // Stripe links to acme-web: repo scope 1.0
    expect(vaultSearch(k.db, { companyId: A }, 'growth', { types: ['decision'] })).toEqual([])
  })
})
