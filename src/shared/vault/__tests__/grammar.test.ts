import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { TitleTrie, autolinkText, findNoteMentions } from '../autolink'
import { diffLines, merge3, splitKeepEol } from '../diff3'
import {
  formatEntryLines,
  formatYamlString,
  frontmatterData,
  parseFrontmatter,
  parseScalar,
  setFrontmatterInText
} from '../frontmatter'
import {
  formatHistory,
  formatObservation,
  formatRelation,
  isTaskLine,
  parseBulletLine,
  scanLinks,
  scanTags,
  splitLines,
  tagMatches
} from '../grammar'
import {
  blockIdToV1,
  contentHash,
  lineRowId,
  newBlockId,
  newNoteId,
  parseBlockRef,
  sha1Hex,
  softKey,
  v1EntityToNoteId,
  v1ToBlockId
} from '../ids'
import {
  DEFAULT_RELATIONS,
  buildOntology,
  guessTargetType,
  inverseLabel,
  normalizeRelType,
  parseOntology,
  relationNearMisses,
  renderOntologyNote
} from '../ontology'
import { findBlock, highlightNote, parseNote } from '../parse'
import {
  PatchError,
  addAlias,
  appendObservation,
  appendRelation,
  archive,
  ensureNoteId,
  invalidate,
  linkMention,
  materializeId,
  relocateRemovedFacts,
  removeAlias,
  restoreLine,
  retargetLinks,
  setProperty,
  supersede
} from '../patch'
import { buildResolver, damerauLevenshtein, didYouMean, isFuzzyMatch, linkTextFor, normName, tokenJaccard } from '../resolve'
import { renderNote, serializeNote } from '../serialize'
import { isIgnoredVaultPath, pathForNewNote, sanitizeFilename, stemKey, uniqueStem } from '../slug'

const FIXTURES = join(__dirname, 'fixtures')
const fixtureNames = readdirSync(FIXTURES)
  .filter((f) => f.endsWith('.md'))
  .sort()
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8')

const PROV = { actor: 'claude' as const, runId: '200', date: '2026-10-21' }

/** Lines removed from `a` and added in `b` (terminators included). */
function changes(a: string, b: string): { removed: string[]; added: string[] } {
  const ops = diffLines(splitKeepEol(a), splitKeepEol(b))
  return {
    removed: ops.filter((o) => o.op === 'delete').flatMap((o) => o.lines),
    added: ops.filter((o) => o.op === 'insert').flatMap((o) => o.lines)
  }
}

describe('golden fixtures', () => {
  it('has 30+ fixtures', () => {
    expect(fixtureNames.length).toBeGreaterThanOrEqual(30)
  })

  it.each(fixtureNames)('%s round-trips byte-identical (as-is, CRLF, without trailing newline)', (name) => {
    const text = fixture(name)
    const variants = [text, text.replace(/\r?\n/g, '\r\n'), text.replace(/\r?\n$/, ''), text.replace(/\r\n/g, '\n')]
    for (const v of variants) {
      const note = parseNote(v, { path: `Notes/${name}` })
      expect(serializeNote(note)).toBe(v)
      // parsing is deterministic and EOL-independent for derived data
      expect(parseNote(serializeNote(note), { path: `Notes/${name}` }).facts.map((f) => f.text)).toEqual(note.facts.map((f) => f.text))
    }
    const lf = parseNote(text.replace(/\r\n/g, '\n'), { path: 'a.md' })
    const crlf = parseNote(text.replace(/\r?\n/g, '\r\n'), { path: 'a.md' })
    expect(crlf.links.map((l) => [l.origin, l.rel, l.target])).toEqual(lf.links.map((l) => [l.origin, l.rel, l.target]))
    expect(crlf.relations.map((r) => [r.normRel, r.link.target, r.context])).toEqual(lf.relations.map((r) => [r.normRel, r.link.target, r.context]))
    expect(crlf.tags.map((t) => t.norm)).toEqual(lf.tags.map((t) => t.norm))
  })

  it('keeps the exact bytes of CRLF, mixed-EOL, BOM and no-trailing-newline files', () => {
    expect(fixture('03-crlf.md')).toContain('\r\n')
    expect(fixture('20-mixed-eol.md')).toMatch(/\r\n[^\r]*[^\r]\n/)
    expect(fixture('15-bom.md').charCodeAt(0)).toBe(0xfeff)
    expect(fixture('04-no-trailing-newline.md').endsWith('\n')).toBe(false)
    expect(parseNote(fixture('03-crlf.md')).eol).toBe('\r\n')
    expect(parseNote(fixture('15-bom.md')).id).toBe('n-gggggggggg')
    expect(parseNote(fixture('16-empty.md')).lines.lines).toEqual([])
  })

  it('parses the spec example (§3) exactly', () => {
    const n = parseNote(fixture('01-spec-example.md'), { path: 'People/Ana Ruiz.md' })
    expect(n).toMatchObject({ id: 'n-7k2a9q1c0b', title: 'Ana Ruiz', type: 'person', aliases: ['Ana'], status: 'active', pinned: false })
    expect(n.summary).toBe('Head of growth at [[Acme]]. Owns pricing together with [[Lautaro]].')
    expect(n.facts.map((f) => [f.blockId, f.status, f.category, f.kind, f.pinned])).toEqual([
      ['f-7k2a9q1c0b', 'active', 'role', 'other', false],
      ['f-9q1c3m8d2e', 'active', 'decision', 'decision', true],
      ['f-0p1o2i3u4y', 'superseded', 'superseded', 'other', false]
    ])
    expect(n.facts[0].id).toBe('mfa_7k2a9q1c0b')
    expect(n.facts[1].prov).toEqual({ actor: 'claude', via: null, runId: '183', sessionId: null, date: '2026-10-12' })
    expect(n.facts[2].supersededBy).toBe('f-9q1c3m8d2e')
    expect(n.relations.map((r) => [r.id, r.normRel, r.link.target, r.context, r.status])).toEqual([
      ['mrel_3m8d0a1b2c', 'works_at', 'Acme', null, 'active'],
      ['mrel_1a0b9z8y7x', 'decided', 'Pricing v2', 'since 2026-09', 'active'],
      ['mrel_5t6y7u8i9o', 'works_at', 'Globex', null, 'invalid']
    ])
    expect(n.relations[2].reason).toBe('left company')
    expect(n.links.map((l) => `${l.origin}:${l.rel}:${l.target}:${l.status}`)).toEqual([
      'property:company:Acme:active',
      'property:repos:acme-web:active',
      'body:links_to:Acme:active',
      'body:links_to:Lautaro:active',
      'fact:links_to:Pro Plan:active',
      'relation:works_at:Acme:active',
      'relation:decided:Pricing v2:active',
      'fact:links_to:Pro Plan:invalid',
      'relation:works_at:Globex:invalid'
    ])
    expect(n.links.find((l) => l.origin === 'fact')?.factId).toBe('mfa_9q1c3m8d2e')
    expect(n.tags.map((t) => `${t.origin}:${t.norm}`)).toEqual(['frontmatter:team/founding', 'body:growth', 'body:pricing', 'body:pin'])
  })

  it('renderNote reproduces the spec example byte for byte', () => {
    const text = renderNote({
      id: 'n-7k2a9q1c0b',
      title: 'Ana Ruiz',
      type: 'person',
      aliases: ['Ana'],
      tags: ['team/founding'],
      properties: [
        ['company', '[[Acme]]'],
        ['repos', ['[[acme-web]]']],
        ['pinned', false]
      ],
      created: '2026-10-01',
      modified: '2026-10-20',
      source: 'agent',
      summary: 'Head of growth at [[Acme]]. Owns pricing together with [[Lautaro]].',
      observations: [
        { category: 'role', text: 'Head of growth', tags: ['growth'], prov: { actor: 'user', date: '2026-10-01' }, blockId: 'f-7k2a9q1c0b' },
        { category: 'decision', text: 'Price [[Pro Plan]] at $49/mo #pricing', pinned: true, prov: { actor: 'claude', runId: '183', date: '2026-10-12' }, blockId: 'f-9q1c3m8d2e' }
      ],
      relations: [
        { rel: 'works_at', target: 'Acme', blockId: 'r-3m8d0a1b2c' },
        { rel: 'decided', target: 'Pricing v2', context: 'since 2026-09', prov: { actor: 'claude', runId: '183', date: '2026-10-12' }, blockId: 'r-1a0b9z8y7x' }
      ],
      history: [
        { state: 'superseded', text: 'Price [[Pro Plan]] at $39/mo', supersededBy: 'f-9q1c3m8d2e', prov: { actor: 'claude', runId: '183', date: '2026-10-12' }, blockId: 'f-0p1o2i3u4y' },
        { state: 'invalidated', text: 'works_at [[Globex]]', reason: 'left company', prov: { actor: 'user', date: '2026-10-02' }, blockId: 'r-5t6y7u8i9o' }
      ]
    })
    expect(text).toBe(fixture('01-spec-example.md'))
  })

  it('ignores [[ and observations inside code fences, inline code and comments', () => {
    const n = parseNote(fixture('06-code-fences.md'))
    expect(n.links.map((l) => l.target)).toEqual(['Yes Link'])
    expect(n.facts).toHaveLength(1)
    expect(n.facts[0].text).toBe('Webhooks need the raw body, not `JSON.parse([[x]])` #stripe')
    expect(n.tags.map((t) => t.norm)).toEqual(['stripe'])
    const c = parseNote(fixture('35-inline-fields.md'))
    expect(c.links.map((l) => l.target)).toEqual(['Ana Ruiz', 'Quoted'])
    const u = parseNote(fixture('19-unclosed-fence.md'))
    expect(u.links.map((l) => l.target)).toEqual(['Visible'])
    expect(u.facts).toEqual([])
    expect(u.warnings).toContain('unclosed code fence')
  })

  it('separates checkboxes and link items from observations', () => {
    const n = parseNote(fixture('07-checkboxes.md'))
    expect(n.facts.map((f) => [f.category, f.text, f.implicitCategory])).toEqual([
      ['todo', 'real observation with category', false],
      ['note', 'bullet with a tag #idea', true]
    ])
    expect(n.links.map((l) => [l.target, l.markdown])).toEqual([
      ['Launch Plan', false],
      ['Bob Smith', false],
      ['Specs/Launch Spec', true]
    ])
    expect(isTaskLine('- [ ] x')).toBe(true)
    expect(isTaskLine('- [x] x')).toBe(true)
    expect(isTaskLine('- [fact] x')).toBe(false)
  })

  it('reads quoted multi-word and camelCase relations, context and provenance', () => {
    const n = parseNote(fixture('08-quoted-relations.md'))
    expect(n.relations.map((r) => [r.rel, r.normRel, r.link.target, r.link.display, r.context, r.prov.runId])).toEqual([
      ['based on', 'based_on', 'Customer Interviews', null, null, null],
      ['decidedBy', 'decided_by', 'Ana Ruiz', null, '2026-09', null],
      ['part of', 'part_of', 'Q4 Plan', 'the Q4 plan', null, null],
      ['depends_on', 'depends_on', 'Stripe', null, 'billing', 'r_abc123']
    ])
    expect(n.links.at(-1)).toMatchObject({ origin: 'body', target: 'Bob Smith' })
    const ctx = parseNote(fixture('30-relations-context.md'))
    expect(ctx.relations.map((r) => r.context)).toEqual(['via webhooks', 'primary db', 'cache', 'see [[Runbook]]'])
    expect(ctx.links.filter((l) => l.origin === 'body').map((l) => l.target)).toEqual(['Runbook', 'Kafka'])
  })

  it('reads embeds, heading links, block links and path links', () => {
    const e = parseNote(fixture('09-embeds.md'))
    expect(e.links.map((l) => [l.target, l.heading, l.embed, l.attachment])).toEqual([
      ['logo.png', null, true, true],
      ['Brand Guidelines', null, true, false],
      ['Brand Guidelines', 'Colors', true, false],
      ['diagram.excalidraw.md', null, true, false],
      ['Pitch Deck.pdf', null, true, true]
    ])
    const h = parseNote(fixture('10-heading-block-links.md'))
    expect(h.links.map((l) => [l.target, l.heading, l.block, l.display])).toEqual([
      ['Ana Ruiz', 'Observations', null, null],
      ['Ana Ruiz', null, 'f-9q1c3m8d2e', null],
      ['People/Ana Ruiz', null, null, null],
      ['People/Ana Ruiz.md', null, null, 'Ana'],
      ['Pricing v2', null, 'r-dddddddddd', 'the decision']
    ])
    const t = parseNote(fixture('14-aliases-display.md'))
    expect(t.links.map((l) => [l.target, l.display])).toEqual([
      ['Ana Ruiz', 'Ana'],
      ['Bob Smith', null],
      ['Ana Ruiz', 'Ana']
    ])
    const md = parseNote(fixture('13-md-links.md'))
    expect(md.links.map((l) => [l.target, l.heading])).toEqual([
      ['People/Ana Ruiz', null],
      ['People/Bob Smith', null],
      ['Stripe', 'Webhooks']
    ])
    expect(md.tags).toEqual([])
  })

  it('indexes History lines as superseded / invalid', () => {
    const n = parseNote(fixture('11-history.md'))
    expect(n.facts.map((f) => [f.status, f.blockId, f.supersededBy, f.reason])).toEqual([
      ['active', 'f-1111111111', null, null],
      ['superseded', 'f-2222222222', 'f-1111111111', null],
      ['invalid', 'f-4444444444', null, 'wrong'],
      ['superseded', null, null, null],
      ['superseded', null, null, null]
    ])
    expect(n.relations).toHaveLength(1)
    expect(n.relations[0]).toMatchObject({ status: 'invalid', normRel: 'integrates_with', reason: 'replaced' })
    expect(n.relations[0].prov).toMatchObject({ actor: 'claude', runId: '9' })
    expect(n.links.every((l) => l.status === 'invalid')).toBe(true)
  })

  it('reads tags: body, headings, nested, frontmatter; skips digits, urls and code', () => {
    const n = parseNote(fixture('12-tags.md'))
    expect(n.tags.map((t) => t.norm)).toEqual([
      'project/alpha',
      'quoted',
      'heading-tag',
      'tag-one',
      'nested/deep/tag',
      'paren',
      'v2',
      'tag-in-h2',
      'start-of-line',
      'fact-tag',
      'pin'
    ])
    expect(n.facts[0].pinned).toBe(true)
    expect(tagMatches('nested', 'nested/deep/tag')).toBe(true)
    expect(tagMatches('#Nested/Deep', 'nested/deep/tag')).toBe(true)
    expect(tagMatches('nest', 'nested')).toBe(false)
  })

  it('reads provenance variants and leaves look-alikes in the text', () => {
    const n = parseNote(fixture('22-provenance.md'), { defaultDate: '2026-01-01' })
    expect(n.facts.map((f) => [f.prov.actor, f.prov.runId, f.prov.sessionId, f.prov.via, f.prov.date, f.provExplicit])).toEqual([
      ['claude', '183', null, null, '2026-10-12', true],
      ['codex', null, 's_abc123def0', null, '2026-10-13', true],
      ['user', null, null, 'sg-1234', '2026-10-20', true],
      ['migration', null, null, null, '2026-10-01', true],
      ['gemini', 'r_x9', null, null, '2026-10-14', true],
      ['user', null, null, null, '2026-01-01', false],
      ['user', null, null, null, '2026-01-01', false]
    ])
    expect(n.facts[5].text).toBe('not a provenance (see above, 2026-10-01)')
  })

  it('gives hand-written lines stable soft keys', () => {
    const text = fixture('21-hand-written.md')
    const a = parseNote(text, { path: 'People/Hand Written.md' })
    const b = parseNote(`${text}\n- [fact] another\n`, { path: 'People/Hand Written.md' })
    expect(a.id).toBeNull()
    expect(a.key).toBe('h:People/Hand Written.md')
    expect(a.facts.every((f) => f.id.startsWith('h:') && f.blockId === null)).toBe(true)
    expect(b.facts.slice(0, 3).map((f) => f.id)).toEqual(a.facts.map((f) => f.id))
    expect(new Set(a.facts.map((f) => f.id)).size).toBe(3)
    expect(parseNote(text, { path: 'Other.md' }).facts[0].id).not.toBe(a.facts[0].id)
    expect(a.links.map((l) => `${l.origin}:${l.target}`)).toEqual(['fact:Figma', 'relation:Acme', 'bullet:Bob Smith'])
  })

  it('reads link-valued properties of any key, block and flow lists', () => {
    const n = parseNote(fixture('29-property-links.md'))
    expect(n.links.map((l) => `${l.rel}:${l.target}${l.display ? `|${l.display}` : ''}`)).toEqual([
      'owner:Ana Ruiz',
      'repos:acme-web',
      'repos:acme-api',
      'reviewers:Bob Smith',
      'reviewers:Ana Ruiz|Ana',
      'notes:Pricing v2',
      'notes:Stripe'
    ])
  })

  it('handles nested bullets, other markers, titles with slashes and unicode', () => {
    const n = parseNote(fixture('27-nested-bullets.md'))
    expect(n.facts.map((f) => f.category)).toEqual(['fact', 'decision'])
    expect(n.relations.map((r) => r.link.target)).toEqual(['Redis'])
    expect(n.links.map((l) => `${l.origin}:${l.target}`)).toEqual(['relation:Redis', 'bullet:Star Bullet'])
    const f = parseNote(fixture('25-file-entity.md'), { path: 'Files/scripts-sync-migration.sh.md' })
    expect(f.title).toBe('scripts/sync-migration.sh')
    expect(f.facts[0].text).toBe('Must run before `npm run build`')
    const u = parseNote(fixture('31-unicode.md'))
    expect(u.title).toBe('Café Ünïcödé')
    expect(u.tags.map((t) => t.norm)).toEqual(['ascii_ok'])
    expect(u.links[0].target).toBe('Zoë Müller')
  })

  it('degrades gracefully on broken frontmatter', () => {
    const open = parseNote(fixture('18-unclosed-frontmatter.md'), { path: 'Broken.md' })
    expect(open.frontmatter).toBeNull()
    expect(open.warnings).toContain('frontmatter is not closed')
    expect(open.links.map((l) => l.target)).toEqual(['Somewhere'])
    const bad = parseNote(fixture('34-malformed-yaml.md'), { path: 'Bad.md' })
    expect(bad.frontmatter?.ok).toBe(false)
    expect(bad.title).toBe('Bad')
    expect(() => setProperty(fixture('34-malformed-yaml.md'), 'modified', '2026-10-21')).toThrow(PatchError)
    expect(parseNote(fixture('33-dots-close.md')).title).toBe('Dots close')
  })
})

describe('frontmatter (byte-preserving YAML subset)', () => {
  it('re-renders Principia-written entries exactly', () => {
    for (const name of ['01-spec-example.md', '23-company-hub.md', '24-repo-note.md', '25-file-entity.md', '29-property-links.md']) {
      const text = fixture(name)
      const fm = parseFrontmatter(text)!
      const { lines } = splitLines(text)
      for (const e of fm.entries) {
        const block = e.style === 'block'
        expect(formatEntryLines(e.key, e.value, { block, itemIndent: e.itemIndent }).join('\n')).toBe(lines.slice(e.start, e.end).join('\n'))
      }
    }
  })

  it('parses scalars, quotes, lists, block scalars, comments and nested maps', () => {
    const d = frontmatterData(parseFrontmatter(fixture('05-unknown-frontmatter.md')))
    expect(d.title).toBe('Mercury: the bank')
    expect(d.custom_key).toBe('some value')
    expect(d.nested).toEqual({ raw: '  a: 1\n  b: [x, y]' })
    expect(d.aliases).toEqual(['Mercury', 'Mercury Bank'])
    expect(d.description).toBe('multi line\nblock scalar\n')
    expect(d.weird).toEqual({ raw: '{a: 1}' })
    expect(d.rating).toBe(4.5)
    const q = frontmatterData(parseFrontmatter(fixture('28-quoting.md')))
    expect(q).toMatchObject({
      title: "It's quoted",
      aliases: ['Esc "aped"', 'single', 'plain words', 'comma, inside'],
      tags: [],
      empty: null,
      number_string: '42',
      bool_string: 'true',
      date: '2026-10-01',
      unicode: 'Café'
    })
  })

  it('quotes only what YAML would misread, and round-trips through the parser', () => {
    const cases = ['Ana Ruiz', 'Mercury: the bank', '[[Acme]]', '42', 'true', 'no', '', ' pad', '#tag', 'a, b', "It's", 'say "hi"', '2026-10-01', 'C:\\x', '- dash', 'Café']
    for (const s of cases) expect(parseScalar(formatYamlString(s))).toBe(s)
    expect(formatYamlString('Ana Ruiz')).toBe('Ana Ruiz')
    expect(formatYamlString('2026-10-01')).toBe('2026-10-01')
    expect(formatYamlString('[[Acme]]')).toBe('"[[Acme]]"')
    expect(formatYamlString('42')).toBe('"42"')
  })

  it('setProperty replaces only the entry lines, keeps comments, style and EOL', () => {
    const text = fixture('05-unknown-frontmatter.md')
    const r = setProperty(text, 'custom_key', 'new value')
    expect(changes(text, r.text)).toEqual({ removed: ['custom_key: some value   # trailing comment\n'], added: ['custom_key: new value   # trailing comment\n'] })
    const al = setProperty(text, 'aliases', ['Mercury', 'Mercury Bank', 'MB'])
    expect(changes(text, al.text)).toEqual({ removed: [], added: ['  - MB\n'] })
    const add = setProperty(text, 'modified', '2026-10-21')
    expect(changes(text, add.text)).toEqual({ removed: [], added: ['modified: 2026-10-21\n'] })
    expect(add.text.split('\n').indexOf('modified: 2026-10-21')).toBe(19)
    const crlf = fixture('03-crlf.md')
    const c = setProperty(crlf, 'modified', '2026-10-21')
    expect(changes(crlf, c.text)).toEqual({ removed: [], added: ['modified: 2026-10-21\r\n'] })
    expect(setProperty(text, 'rating', 4.5).changed).toBe(false)
    const rm = setProperty(text, 'weird', undefined)
    expect(changes(text, rm.text)).toEqual({ removed: ['weird: {a: 1}\n'], added: [] })
  })

  it('creates frontmatter when missing, also in empty files', () => {
    const r = setProperty('# Hi\nbody', 'id', 'n-0000000000')
    expect(r.text).toBe('---\nid: n-0000000000\n---\n# Hi\nbody')
    expect(setFrontmatterInText('', 'title', 'X')).toBe('---\ntitle: X\n---\n')
    const only = fixture('17-only-frontmatter.md')
    expect(setProperty(only, 'pinned', true).text).toBe(only.replace('type: concept\n', 'type: concept\npinned: true\n'))
  })

  it('aliases, ids and archive are frontmatter-only edits', () => {
    const text = fixture('01-spec-example.md')
    const a = addAlias(text, 'Ani')
    expect(changes(text, a.text)).toEqual({ removed: ['aliases: [Ana]\n'], added: ['aliases: [Ana, Ani]\n'] })
    expect(addAlias(text, 'ana').changed).toBe(false)
    expect(addAlias(text, 'Ana Ruiz').changed).toBe(false)
    expect(removeAlias(a.text, 'ANI').text).toBe(text)
    const ar = archive(text, 'Ana R.')
    expect(changes(text, ar.text)).toEqual({ removed: ['status: active\n'], added: ['status: archived\n', 'merged_into: "[[Ana R.]]"\n'] })
    expect(ensureNoteId(text, 'n-1111111111')).toMatchObject({ changed: false, id: 'n-7k2a9q1c0b' })
    const hand = fixture('21-hand-written.md')
    const e = ensureNoteId(hand, 'n-1111111111')
    expect(changes(hand, e.text)).toEqual({ removed: [], added: ['id: n-1111111111\n'] })
    expect(parseNote(e.text).id).toBe('n-1111111111')
  })
})

describe('patch ops change only the intended lines', () => {
  const spec = fixture('01-spec-example.md')

  it('appendObservation appends at the end of Observations', () => {
    const r = appendObservation(spec, { category: 'metric', text: 'NPS 61', prov: PROV, blockId: 'f-aaaaaaaaaa' })
    expect(changes(spec, r.text)).toEqual({ removed: [], added: ['- [metric] NPS 61 (claude run#200, 2026-10-21) ^f-aaaaaaaaaa\n'] })
    expect(r.line).toBe(20)
    expect(splitLines(r.text).lines[r.line!]).toContain('NPS 61')
    expect(findBlock(parseNote(r.text), 'f-aaaaaaaaaa')?.line).toBe(20)
  })

  it('creates a missing section before later sections, or at the end', () => {
    const noObs = fixture('24-repo-note.md')
    const r = appendObservation(noObs, { category: 'fact', text: 'Deployed on Vercel', blockId: 'f-bbbbbbbbbb' })
    expect(changes(noObs, r.text)).toEqual({ removed: [], added: ['## Observations\n', '- [fact] Deployed on Vercel ^f-bbbbbbbbbb\n', '\n'] })
    expect(r.text).toContain('# acme-web\n\n## Observations\n- [fact] Deployed on Vercel ^f-bbbbbbbbbb\n\n## Relations\n')
    const plain = '# Note\nSome text.\n'
    const p = appendRelation(plain, { rel: 'uses', target: 'Stripe', blockId: 'r-cccccccccc' })
    expect(p.text).toBe('# Note\nSome text.\n\n## Relations\n- uses [[Stripe]] ^r-cccccccccc\n')
    const order = fixture('36-relations-only-section-order.md')
    const o = appendObservation(order, { category: 'fact', text: 'x', blockId: 'f-dddddddddd' })
    expect(o.text.indexOf('## Observations')).toBeLessThan(o.text.indexOf('## History'))
    expect(changes(order, o.text).removed).toEqual([])
  })

  it('keeps a missing trailing newline missing and uses the file EOL', () => {
    const nt = fixture('04-no-trailing-newline.md')
    const r = appendObservation(nt, { category: 'fact', text: 'second', blockId: 'f-eeeeeeeeee' })
    expect(r.text).toBe(`${nt}\n- [fact] second ^f-eeeeeeeeee`)
    const crlf = fixture('03-crlf.md')
    const c = appendObservation(crlf, { category: 'fact', text: 'crlf', blockId: 'f-ffffffffff' })
    expect(changes(crlf, c.text)).toEqual({ removed: [], added: ['- [fact] crlf ^f-ffffffffff\r\n'] })
    const crlfNt = fixture('32-crlf-no-trailing.md')
    const cn = appendRelation(crlfNt, { rel: 'uses', target: 'Redis', blockId: 'r-gggggggggg' })
    expect(cn.text).toBe(`${crlfNt}\r\n- uses [[Redis]] ^r-gggggggggg`)
  })

  it('supersede appends the new line and moves the old one to History', () => {
    const r = supersede(spec, 'f-7k2a9q1c0b', { text: 'VP of growth', blockId: 'f-hhhhhhhhhh' }, PROV)
    expect(changes(spec, r.text)).toEqual({
      removed: ['- [role] Head of growth #growth (user, 2026-10-01) ^f-7k2a9q1c0b\n'],
      added: [
        '- [role] VP of growth (claude run#200, 2026-10-21) ^f-hhhhhhhhhh\n',
        '- [superseded] Head of growth #growth (by ^f-hhhhhhhhhh; claude run#200, 2026-10-21) ^f-7k2a9q1c0b'
      ].map((s) => (s.endsWith('\n') ? s : `${s}\n`))
    })
    const n = parseNote(r.text)
    expect(findBlock(n, 'f-7k2a9q1c0b')).toMatchObject({ status: 'superseded', supersededBy: 'f-hhhhhhhhhh' })
    expect(findBlock(n, 'f-hhhhhhhhhh')).toMatchObject({ status: 'active', category: 'role' })
    expect(r.blockId).toBe('f-hhhhhhhhhh')
  })

  it('invalidate moves a relation to History with its reason; restore moves it back', () => {
    const r = invalidate(spec, '^r-3m8d0a1b2c', 'moved on', { actor: 'user', date: '2026-10-21' })
    expect(changes(spec, r.text)).toEqual({
      removed: ['- works_at [[Acme]] ^r-3m8d0a1b2c\n'],
      added: ['- [invalidated] works_at [[Acme]] (reason: moved on; user, 2026-10-21) ^r-3m8d0a1b2c\n']
    })
    expect(findBlock(parseNote(r.text), 'r-3m8d0a1b2c')).toMatchObject({ status: 'invalid', reason: 'moved on' })
    const back = restoreLine(r.text, 'r-3m8d0a1b2c')
    expect(back.text).toBe(spec.replace('- works_at [[Acme]] ^r-3m8d0a1b2c\n- decided [[Pricing v2]] (since 2026-09) (claude run#183, 2026-10-12) ^r-1a0b9z8y7x\n', '- decided [[Pricing v2]] (since 2026-09) (claude run#183, 2026-10-12) ^r-1a0b9z8y7x\n- works_at [[Acme]] ^r-3m8d0a1b2c\n'))
    const f = restoreLine(spec, 'f-0p1o2i3u4y', { category: 'decision' })
    expect(changes(spec, f.text)).toEqual({
      removed: ['- [superseded] Price [[Pro Plan]] at $39/mo (by ^f-9q1c3m8d2e; claude run#183, 2026-10-12) ^f-0p1o2i3u4y\n'],
      added: ['- [decision] Price [[Pro Plan]] at $39/mo ^f-0p1o2i3u4y\n']
    })
  })

  it('never guesses: missing or misplaced block ids throw', () => {
    const codeOf = (fn: () => unknown): string | undefined => {
      try {
        fn()
      } catch (e) {
        return e instanceof PatchError ? e.code : 'other'
      }
      return undefined
    }
    expect(codeOf(() => invalidate(spec, 'f-zzzzzzzzzz', 'x'))).toBe('block_not_found')
    expect(codeOf(() => invalidate(spec, 'f-0p1o2i3u4y', 'x'))).toBe('already_history')
    expect(codeOf(() => restoreLine(spec, 'f-7k2a9q1c0b'))).toBe('not_history')
    expect(codeOf(() => supersede(spec, 'r-3m8d0a1b2c', { text: 'x' }, PROV))).toBe('not_a_fact')
    expect(codeOf(() => materializeId(spec, 14))).toBe('bad_line')
    // an id inside a code fence is not a block
    expect(codeOf(() => invalidate(fixture('06-code-fences.md'), 'f-zzzzzzzzzz', 'x'))).toBe('block_not_found')
  })

  it('materializeId stamps a real id on a hand-written line only', () => {
    const hand = fixture('21-hand-written.md')
    const r = materializeId(hand, 8, 'f-iiiiiiiiii')
    expect(changes(hand, r.text)).toEqual({ removed: ['- [fact] Likes [[Figma]] #tools\n'], added: ['- [fact] Likes [[Figma]] #tools ^f-iiiiiiiiii\n'] })
    expect(parseNote(r.text, { path: 'a.md' }).facts[1].id).toBe('mfa_iiiiiiiiii')
    const rel = materializeId(hand, 12)
    expect(rel.blockId).toMatch(/^r-[0-9a-z]{10}$/)
    expect(materializeId(spec, 18)).toMatchObject({ changed: false, blockId: 'f-7k2a9q1c0b' })
    expect(() => materializeId('- [fact] x ^custom\n', 0)).toThrow(/already ends/)
  })

  it('linkMention wraps exactly the span', () => {
    const text = '# N\nTalked with ana about `Ana` and pricing.\n'
    const r = linkMention(text, 1, { start: 12, end: 15 }, 'Ana Ruiz')
    expect(r.text).toBe('# N\nTalked with [[Ana Ruiz|ana]] about `Ana` and pricing.\n')
    const exact = linkMention('Ana Ruiz said\n', 0, { start: 0, end: 8 }, 'Ana Ruiz')
    expect(exact.text).toBe('[[Ana Ruiz]] said\n')
    expect(() => linkMention(text, 1, { start: 23, end: 26 }, 'Ana Ruiz')).toThrow(/inside code/)
    expect(() => linkMention(spec, 15, { start: 20, end: 24 }, 'Acme')).toThrow(/overlaps/)
    expect(() => linkMention(spec, 2, { start: 0, end: 2 }, 'X')).toThrow(/not body/)
  })

  it('linkMention with the expected text refuses a stale span instead of linking other words', () => {
    const text = '# N\nTalked with ana about pricing.\n'
    expect(linkMention(text, 1, { start: 12, end: 15 }, 'Ana Ruiz', 'Ana').text).toBe('# N\nTalked with [[Ana Ruiz|ana]] about pricing.\n')
    // the line changed under the suggestion: the same offsets now hold "abo"
    expect(() => linkMention('# N\nTalked with Bob about pricing.\n', 1, { start: 16, end: 19 }, 'Ana Ruiz', 'ana')).toThrow(/no longer "ana"/)
  })

  it('retargetLinks renames and merges, in body and frontmatter, never in code', () => {
    const text = '---\ncompany: "[[Acme]]"\n---\nSee [[Acme]], [[acme|the co]], [[Acme#Mission]] and `[[Acme]]`.\n```\n[[Acme]]\n```\n- works_at [[Acme]] ^r-1111111111\n'
    const isAcme = (t: string): boolean => normName(t) === 'acme'
    const r = retargetLinks(text, isAcme, 'Acme Inc')
    expect(r.count).toBe(5)
    expect(r.text).toBe('---\ncompany: "[[Acme Inc]]"\n---\nSee [[Acme Inc]], [[Acme Inc|the co]], [[Acme Inc#Mission]] and `[[Acme]]`.\n```\n[[Acme]]\n```\n- works_at [[Acme Inc]] ^r-1111111111\n')
    const m = retargetLinks(text, isAcme, 'Globex', { keepOldAsDisplay: true })
    expect(m.text).toContain('See [[Globex|Acme]], [[Globex|the co]], [[Globex#Mission|Acme]]')
    expect(m.text).toContain('company: "[[Globex|Acme]]"')
    expect(parseNote(m.text).relations[0].link).toMatchObject({ target: 'Globex', display: 'Acme' })
    expect(retargetLinks(spec, (t) => t === 'Nobody', 'X')).toMatchObject({ changed: false, count: 0, text: spec })
  })

  it('relocates facts removed in the editor to History instead of dropping them', () => {
    const edited = spec.replace('- [role] Head of growth #growth (user, 2026-10-01) ^f-7k2a9q1c0b\n', '')
    const r = relocateRemovedFacts(spec, edited, { actor: 'user', date: '2026-10-21' })
    expect(r.moved).toEqual(['f-7k2a9q1c0b'])
    expect(changes(edited, r.text)).toEqual({
      removed: [],
      added: ['- [invalidated] Head of growth #growth (reason: removed in editor; user, 2026-10-21) ^f-7k2a9q1c0b\n']
    })
    expect(relocateRemovedFacts(spec, spec, { actor: 'user', date: '2026-10-21' })).toEqual({ text: spec, moved: [], kept: [] })
    const histLine = '- [invalidated] works_at [[Globex]] (reason: left company; user, 2026-10-02) ^r-5t6y7u8i9o\n'
    const noHist = spec.replace(histLine, '')
    const k = relocateRemovedFacts(spec, noHist, { actor: 'user', date: '2026-10-21' })
    expect(k).toMatchObject({ moved: [], kept: ['r-5t6y7u8i9o'] })
    expect(changes(noHist, k.text)).toEqual({ removed: [], added: [histLine] })
  })
})

describe('line grammar', () => {
  it('formats lines that parse back to the same fields', () => {
    const o = formatObservation({ category: 'price', text: 'Pro is $49\nper month', tags: ['pricing', '#pricing', '123'], pinned: true, prov: { actor: 'user', via: 'sg-9', date: '2026-10-20' }, blockId: 'f-1234567890' })
    expect(o).toBe('- [price] Pro is $49 per month #pricing #pin (user via suggestion sg-9, 2026-10-20) ^f-1234567890')
    const po = parseBulletLine(o)
    expect(po).toMatchObject({ kind: 'observation', category: 'price', text: 'Pro is $49 per month #pricing #pin', blockId: 'f-1234567890' })
    const r = formatRelation({ rel: 'based on', target: 'Interviews', display: 'the interviews', context: 'Q3 (draft)', blockId: 'r-1234567890' })
    expect(r).toBe('- "based on" [[Interviews|the interviews]] (Q3 draft) ^r-1234567890')
    expect(parseBulletLine(r)).toMatchObject({ kind: 'relation', rel: 'based on', context: 'Q3 draft', link: { target: 'Interviews', display: 'the interviews' } })
    const h = formatHistory({ state: 'invalidated', text: 'x', reason: 'a (b)\nc', prov: { actor: 'user', date: '2026-10-20' } })
    expect(h).toBe('- [invalidated] x (reason: a b c; user, 2026-10-20)')
    expect(parseBulletLine(h, true)).toMatchObject({ kind: 'history', state: 'invalidated', reason: 'a b c', text: 'x' })
    expect(formatObservation({ category: '[x]', text: 'ends with ^f-1234567890' })).toBe('- [note] ends with \\^f-1234567890')
  })

  it('scans links and tags with offsets', () => {
    const line = 'A [[X|y]] b ![[Img.png]] `[[no]]` [t](Y.md) #tag'
    expect(scanLinks(line).map((l) => [line.slice(l.start, l.end), l.target])).toEqual([
      ['[[X|y]]', 'X'],
      ['![[Img.png]]', 'Img.png'],
      ['[t](Y.md)', 'Y']
    ])
    expect(scanTags(line).map((t) => line.slice(t.start, t.end))).toEqual(['#tag'])
  })

  it('highlights grammar tokens for the editor', () => {
    const tokens = highlightNote('---\nid: n-1\n---\n- [fact] see [[X]] #t (user, 2026-10-01) ^f-1234567890\n')
    expect(tokens.filter((t) => t.line === 3).map((t) => t.kind)).toEqual(['category', 'link', 'tag', 'prov', 'block'])
    expect(tokens.filter((t) => t.kind === 'frontmatter')).toHaveLength(3)
  })
})

describe('resolution matrix', () => {
  const notes = [
    { id: 'n-ana', path: 'People/Ana Ruiz.md', title: 'Ana Ruiz', aliases: ['Ana', 'AR'] },
    { id: 'n-bob', path: 'People/Bob Smith.md', title: 'Bob Smith', aliases: ['Bob'] },
    { id: 'n-mer1', path: 'Customers/Mercury.md', title: 'Mercury' },
    { id: 'n-mer2', path: 'Concepts/Mercury.md', title: 'Mercury' },
    { id: 'n-mc', path: 'Customers/Mercury (Customer).md', title: 'Mercury Bank' },
    { id: 'n-file', path: 'Files/scripts-sync-migration.sh.md', title: 'scripts/sync-migration.sh' },
    { id: 'n-ali1', path: 'People/Robert Smith.md', title: 'Robert Smith', aliases: ['Bobby'] },
    { id: 'n-ali2', path: 'People/Bobby Tables.md', title: 'Robert Tables', aliases: ['bobby'] },
    { id: 'n-cafe', path: 'Concepts/Café.md', title: 'Café' }
  ]
  const r = buildResolver(notes)

  it.each([
    ['[[People/Ana Ruiz]]', 'resolved', 'n-ana', 'path'],
    ['People/Ana Ruiz.md', 'resolved', 'n-ana', 'path'],
    ['people/ana ruiz', 'resolved', 'n-ana', 'path'],
    ['Customers/Mercury', 'resolved', 'n-mer1', 'path'],
    ['Ana Ruiz', 'resolved', 'n-ana', 'basename'],
    ['  ana   RUIZ ', 'resolved', 'n-ana', 'basename'],
    ['[[Ana Ruiz#^f-9q1c3m8d2e|cite]]', 'resolved', 'n-ana', 'basename'],
    ['Ana Ruiz.md', 'resolved', 'n-ana', 'basename'],
    ['Mercury (Customer)', 'resolved', 'n-mc', 'basename'],
    ['Mercury Bank', 'resolved', 'n-mc', 'title'],
    ['scripts/sync-migration.sh', 'resolved', 'n-file', 'title'],
    ['scripts-sync-migration.sh', 'resolved', 'n-file', 'basename'],
    ['Ana', 'resolved', 'n-ana', 'alias'],
    ['bob', 'resolved', 'n-bob', 'alias'],
    ['Café', 'resolved', 'n-cafe', 'basename'],
    ['Cafe\u0301', 'resolved', 'n-cafe', 'basename'],
    ['Mercury', 'ambiguous', null, 'basename'],
    ['Bobby', 'ambiguous', null, 'alias'],
    ['Onboarding flow', 'ghost', null, null],
    ['Elsewhere/Ana Ruiz', 'ghost', null, null],
    ['[[#Heading]]', 'ghost', null, null]
  ])('%s -> %s', (target, status, id, via) => {
    const res = r.resolve(target)
    expect(res.status).toBe(status)
    if (res.status === 'resolved') expect([res.id, res.via]).toEqual([id, via])
    if (res.status === 'ambiguous') expect(res.via).toBe(via)
  })

  it('reports candidates for ambiguous links', () => {
    const res = r.resolve('Mercury')
    expect(res.status === 'ambiguous' && res.candidates.sort()).toEqual(['n-mer1', 'n-mer2'])
    expect(r.resolve('Onboarding Flow')).toEqual({ status: 'ghost', norm: 'onboarding flow' })
  })

  it('resolves forward references once the note exists', () => {
    expect(r.resolve('Onboarding flow').status).toBe('ghost')
    const r2 = buildResolver([...notes, { id: 'n-onb', path: 'Processes/Onboarding Flow.md', title: 'Onboarding Flow' }])
    expect(r2.resolve('onboarding flow')).toMatchObject({ status: 'resolved', id: 'n-onb' })
  })

  it('fuzzy matches only suggest', () => {
    expect(r.resolve('Ana Ruis').status).toBe('ghost')
    expect(didYouMean('Ana Ruis', notes)[0]).toMatchObject({ id: 'n-ana' })
    expect(didYouMean('Smith Bob', notes)[0]).toMatchObject({ id: 'n-bob' })
    expect(isFuzzyMatch('Onboarding flow', 'Onboarding flows')).toBe(true)
    expect(isFuzzyMatch('Bob', 'Rob')).toBe(false)
    expect(damerauLevenshtein('abcd', 'acbd')).toBe(1)
    expect(tokenJaccard('a b c', 'a b c d')).toBe(0.75)
    expect(linkTextFor(notes[0], 'Ana')).toBe('[[Ana Ruiz|Ana]]')
    expect(linkTextFor(notes[5])).toBe('[[scripts-sync-migration.sh]]')
  })
})

describe('ids', () => {
  it('maps v1 ids to block ids and back', () => {
    expect(v1ToBlockId('mfa_0sfppfcd3n')).toBe('f-0sfppfcd3n')
    expect(v1ToBlockId('mrel_abcdefghij')).toBe('r-abcdefghij')
    expect(v1ToBlockId('ment_abcdefghij')).toBeNull()
    expect(blockIdToV1('f-0sfppfcd3n')).toBe('mfa_0sfppfcd3n')
    expect(blockIdToV1('^r-abcdefghij')).toBe('mrel_abcdefghij')
    expect(blockIdToV1('para-1')).toBeNull()
    expect(v1EntityToNoteId('ment_0sfppfcd3n')).toBe('n-0sfppfcd3n')
    expect(parseBlockRef('[[Ana Ruiz#^f-9q1c3m8d2e]]')).toBe('f-9q1c3m8d2e')
    expect(parseBlockRef('^r-1a0b9z8y7x')).toBe('r-1a0b9z8y7x')
    expect(parseBlockRef('nope')).toBeNull()
    expect(newNoteId()).toMatch(/^n-[0-9a-z]{10}$/)
    expect(newBlockId('f')).toMatch(/^f-[0-9a-z]{10}$/)
    expect(lineRowId('f-0sfppfcd3n', 'a.md', 'x')).toBe('mfa_0sfppfcd3n')
    expect(lineRowId(null, 'a.md', 'x')).toBe(softKey('a.md', ' x '))
  })

  it('sha1 matches known vectors', () => {
    expect(sha1Hex('')).toBe('da39a3ee5e6b4b0d3255bfef95601890afd80709')
    expect(sha1Hex('abc')).toBe('a9993e364706816aba3e25717850c26c9cd0d89d')
    expect(sha1Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe('84983e441c3bd26ebaae4aa1f95129e5e54670f1')
    expect(sha1Hex('é'.repeat(100))).toBe(sha1Hex('é'.repeat(100)))
    expect(contentHash('a')).toBe('86f7e437faa5a7fce15d1ddcb9eaeaea377667b8')
  })
})

describe('filenames', () => {
  it('sanitizes titles', () => {
    expect(sanitizeFilename('scripts/sync-migration.sh')).toBe('scripts-sync-migration.sh')
    expect(sanitizeFilename('a#b|c^d:e[f]g\\h/i*j"k<l>m?n')).toBe('a-b-c-d-e-f-g-h-i-j-k-l-m-n')
    expect(sanitizeFilename('  .hidden  name. ')).toBe('hidden name')
    expect(sanitizeFilename('')).toBe('Untitled')
    expect(sanitizeFilename('CON')).toBe('CON-')
    expect(sanitizeFilename('x'.repeat(300))).toHaveLength(180)
  })

  it('suffixes the type on basename collisions', () => {
    const taken = new Set(['mercury', 'mercury (customer)'].map(stemKey))
    expect(uniqueStem('Ana', 'person', (k) => taken.has(k))).toBe('Ana')
    expect(uniqueStem('MERCURY', 'concept', (k) => taken.has(k))).toBe('MERCURY (Concept)')
    expect(uniqueStem('Mercury', 'customer', (k) => taken.has(k))).toBe('Mercury (Customer) 2')
    expect(pathForNewNote({ title: 'scripts/sync-migration.sh', type: 'file' }, () => false)).toBe('Files/scripts-sync-migration.sh.md')
    expect(pathForNewNote({ title: 'Acme', type: 'company' }, () => false)).toBe('Acme.md')
    expect(pathForNewNote({ title: 'Thing', type: 'weird' }, () => false)).toBe('Inbox/Thing.md')
    expect(pathForNewNote({ title: 'X', type: 'person', folder: 'Team/' }, () => false)).toBe('Team/X.md')
    expect(isIgnoredVaultPath('.obsidian/app.json')).toBe(true)
    expect(isIgnoredVaultPath('People/.trash/x.md')).toBe(true)
    expect(isIgnoredVaultPath('People/Ana.md')).toBe(false)
  })
})

describe('diff3', () => {
  const base = 'a\nb\nc\nd\ne\n'

  it('merges non-overlapping edits cleanly', () => {
    const ours = 'a\nB\nc\nd\ne\n'
    const theirs = 'a\nb\nc\nd\nE\nf\n'
    const m = merge3(base, ours, theirs)
    expect(m).toMatchObject({ clean: true, conflicts: 0, text: 'a\nB\nc\nd\nE\nf\n' })
  })

  it('merges identical edits and pure insertions', () => {
    expect(merge3(base, 'a\nX\nc\nd\ne\n', 'a\nX\nc\nd\ne\n')).toMatchObject({ clean: true, text: 'a\nX\nc\nd\ne\n' })
    expect(merge3(base, '0\na\nb\nc\nd\ne\n', 'a\nb\nc\nd\ne\nz\n')).toMatchObject({ clean: true, text: '0\na\nb\nc\nd\ne\nz\n' })
    expect(merge3(base, base, base).text).toBe(base)
    expect(merge3('', 'x\n', '').text).toBe('x\n')
  })

  it('reports conflicting edits with regions and markers', () => {
    const m = merge3(base, 'a\nOURS\nc\nd\ne\n', 'a\nTHEIRS\nc\nd\ne\n')
    expect(m.clean).toBe(false)
    expect(m.conflicts).toBe(1)
    const conflict = m.regions.find((r) => !r.stable)
    expect(conflict).toMatchObject({ conflict: true, base: ['b\n'], ours: ['OURS\n'], theirs: ['THEIRS\n'] })
    expect(m.text).toBe('a\n<<<<<<< ours\nOURS\n=======\nTHEIRS\n>>>>>>> theirs\nc\nd\ne\n')
  })

  it('merges an editor save against an agent append byte for byte (CRLF)', () => {
    const b = fixture('03-crlf.md')
    const ours = b.replace('Edited on Windows', 'Edited on Windows 11')
    const theirs = appendObservation(b, { category: 'fact', text: 'agent line', blockId: 'f-jjjjjjjjjj' }).text
    const m = merge3(b, ours, theirs)
    expect(m.clean).toBe(true)
    expect(m.text).toBe(theirs.replace('Edited on Windows', 'Edited on Windows 11'))
  })

  it('diffLines finds minimal edits', () => {
    expect(diffLines(['a', 'b', 'c'], ['a', 'x', 'c'])).toEqual([
      { op: 'equal', lines: ['a'] },
      { op: 'delete', lines: ['b'] },
      { op: 'insert', lines: ['x'] },
      { op: 'equal', lines: ['c'] }
    ])
    const a = Array.from({ length: 500 }, (_, i) => `l${i}`)
    const b = [...a.slice(0, 200), 'new', ...a.slice(201)]
    expect(diffLines(a, b).filter((o) => o.op !== 'equal')).toEqual([
      { op: 'delete', lines: ['l200'] },
      { op: 'insert', lines: ['new'] }
    ])
  })
})

describe('autolink trie', () => {
  const notes = [
    { id: 'n-ana', title: 'Ana Ruiz', aliases: ['Ana'], path: 'People/Ana Ruiz.md' },
    { id: 'n-pro', title: 'Pro Plan', path: 'Offers/Pro Plan.md' },
    { id: 'n-stripe', title: 'Stripe', path: 'Products/Stripe.md' },
    { id: 'n-pro2', title: 'Pro Plan Annual', path: 'Offers/Pro Plan Annual.md' },
    { id: 'n-ai', title: 'AI', path: 'Concepts/AI.md' },
    { id: 'n-m1', title: 'Mercury', path: 'Customers/Mercury.md' },
    { id: 'n-m2', title: 'Mercury Concept', aliases: ['mercury'], path: 'Concepts/Mercury Concept.md' },
    { id: 'n-team', title: 'Team', path: 'Concepts/Team.md' },
    { id: 'n-file', title: 'scripts/sync-migration.sh', path: 'Files/scripts-sync-migration.sh.md' }
  ]
  const trie = new TitleTrie(notes, { minLength: 2 })

  it('links exact, unambiguous, case-insensitive matches, longest first', () => {
    const r = autolinkText('Ana moved the pro plan annual and Pro  Plan to stripe.', trie)
    expect(r.text).toBe('[[Ana Ruiz|Ana]] moved the [[Pro Plan Annual|pro plan annual]] and [[Pro Plan|Pro  Plan]] to [[Stripe|stripe]].')
    expect(r.linked.map((l) => l.noteId)).toEqual(['n-ana', 'n-pro2', 'n-pro', 'n-stripe'])
  })

  it('skips code, existing links, ambiguous names, stopwords and short names in another case', () => {
    expect(autolinkText('`Stripe` and [[Stripe]] and Stripe', trie).text).toBe('`Stripe` and [[Stripe]] and [[Stripe]]')
    expect(autolinkText('Mercury is a customer', trie).text).toBe('Mercury is a customer')
    expect(autolinkText('the team uses AI and ai', trie).text).toBe('the team uses [[AI]] and ai')
    expect(autolinkText('Stripes are not Stripe-like', trie).text).toBe('Stripes are not [[Stripe]]-like')
    expect(autolinkText('Ana', trie, { excludeIds: ['n-ana'] }).text).toBe('Ana')
    expect(autolinkText('ana', trie).text).toBe('ana')
    expect(autolinkText('run scripts/sync-migration.sh now', trie).text).toBe('run [[scripts-sync-migration.sh|scripts/sync-migration.sh]] now')
  })

  it('caps links per text', () => {
    expect(autolinkText('Stripe Stripe Stripe Stripe Stripe Stripe Stripe', trie).linked).toHaveLength(5)
    expect(autolinkText('Stripe Stripe Stripe', trie, { max: 1 }).text).toBe('[[Stripe]] Stripe Stripe')
  })

  it('finds unlinked mentions in a note outside frontmatter, code, provenance and itself', () => {
    const text = '---\nid: n-ana\ntitle: Ana Ruiz\n---\n# Ana Ruiz\nWorks with Stripe and [[Pro Plan]].\n```\nStripe\n```\n- [fact] Negotiated Pro Plan (claude run#1, 2026-10-01) ^f-1234567890\n'
    const note = parseNote(text, { path: 'People/Ana Ruiz.md' })
    const ms = findNoteMentions(note, trie, { excludeIds: ['n-ana'] })
    expect(ms.map((m) => [m.line, m.title, m.alias, m.exactCase])).toEqual([
      [5, 'Stripe', false, true],
      [9, 'Pro Plan', false, true]
    ])
    const c = new TitleTrie([{ id: 'n-claude', title: 'Claude' }])
    expect(findNoteMentions(note, c)).toEqual([])
  })
})

describe('ontology', () => {
  it('normalizes relation types', () => {
    expect(normalizeRelType('decidedBy')).toBe('decided_by')
    expect(normalizeRelType('"based on"')).toBe('based_on')
    expect(normalizeRelType('Works-At')).toBe('works_at')
    expect(normalizeRelType('works for')).toBe('works_at')
    expect(normalizeRelType('related_to')).toBe('relates_to')
    expect(normalizeRelType('links')).toBe('links_to')
    expect(normalizeRelType('custom_thing')).toBe('custom_thing')
  })

  it('round-trips the default Relations.md and reads custom lines', () => {
    const md = renderOntologyNote()
    const parsed = parseOntology(md)
    expect(parsed.warnings).toEqual([])
    expect(parsed.defs).toEqual(DEFAULT_RELATIONS)
    const custom = parseOntology('# Relations\n## Mine\n- `mentors` :: mentored_by :: person → person\n- pairs_with :: (symmetric) :: any → any\n- broken line :: only two\n```\n- in_code :: x :: y\n```\n- mentors :: again :: dup\n')
    expect(custom.defs.map((d) => [d.type, d.inverse, d.group, d.symmetric, d.domain, d.range])).toEqual([
      ['mentors', 'mentored_by', 'Mine', false, ['person'], ['person']],
      ['pairs_with', 'pairs_with', 'Mine', true, [], []]
    ])
    expect(custom.warnings).toHaveLength(2)
  })

  it('labels inverses, flags near misses and guesses ghost types', () => {
    expect(inverseLabel('decided_by')).toBe('decided')
    expect(inverseLabel('competes_with')).toBe('competes_with')
    expect(inverseLabel('owner')).toBe('owner of')
    expect(relationNearMisses('work_at')).toContain('works_at')
    expect(relationNearMisses('dependson')).toContain('depends_on')
    expect(relationNearMisses('works_at')).toEqual([])
    expect(guessTargetType('works_at')).toBe('company')
    expect(guessTargetType('decided')).toBe('decision')
    expect(guessTargetType('relates_to')).toBeNull()
    const ont = buildOntology(parseOntology('- mentors :: mentored_by :: person → person\n').defs)
    expect(inverseLabel('mentors', ont)).toBe('mentored_by')
  })
})

describe('review hardening', () => {
  it('reads History reasons that contain "; " and restores them cleanly', () => {
    const line = formatHistory({
      state: 'invalidated',
      text: 'works_at [[Globex]]',
      reason: 'left; moved abroad',
      prov: { actor: 'user', date: '2026-10-02' },
      blockId: 'r-5t6y7u8i9o'
    })
    expect(line).toBe('- [invalidated] works_at [[Globex]] (reason: left; moved abroad; user, 2026-10-02) ^r-5t6y7u8i9o')
    const b = parseBulletLine(line, true)
    expect(b).toMatchObject({ kind: 'history', reason: 'left; moved abroad', text: 'works_at [[Globex]]', prov: { actor: 'user' } })
    expect(b?.kind === 'history' && b.relation?.context).toBeNull()
    // no provenance: the whole detail is the reason
    expect(parseBulletLine('- [invalidated] x (reason: a; b) ^f-0123456789', true)).toMatchObject({ reason: 'a; b', text: 'x', prov: null })
    const text = `# T\n\n## History\n${line}\n`
    expect(restoreLine(text, 'r-5t6y7u8i9o').text).toBe('# T\n\n## Relations\n- works_at [[Globex]] ^r-5t6y7u8i9o\n\n## History\n')
  })

  it('keeps row ids unique for repeated hand-written lines and copied block ids', () => {
    const text = '# T\n## Observations\n- [todo] call #x\n- [todo] call #x\n- [a1] b ^f-0123456789\n- [a1] c ^f-0123456789\n'
    const n = parseNote(text, { path: 'T.md' })
    const ids = n.facts.map((f) => f.id)
    expect(new Set(ids).size).toBe(4)
    expect(ids[1]).toBe(`${ids[0]}:2`)
    expect(ids[2]).toBe('mfa_0123456789')
    expect(n.facts[3]).toMatchObject({ blockId: null, anchor: 'f-0123456789', text: 'c' })
    expect(n.warnings.some((w) => w.includes('duplicate block id'))).toBe(true)
    expect(findBlock(n, 'f-0123456789')?.line).toBe(4)
    // the copy is never re-stamped silently
    expect(() => materializeId(text, 5)).toThrow(PatchError)
  })

  it('keeps markdown table rows intact when rewriting or adding links', () => {
    const table = '| who | note |\n|---|---|\n| [[Old\\|x]] | [[Old]] |\n'
    const r = retargetLinks(table, (t) => t === 'Old', 'New', { keepOldAsDisplay: true })
    expect(r.text).toBe('| who | note |\n|---|---|\n| [[New\\|x]] | [[New\\|Old]] |\n')
    expect(parseNote(r.text).links.map((l) => `${l.target}|${l.display}`)).toEqual(['New|x', 'New|Old'])
    const m = linkMention('| ana | y |\n', 0, { start: 2, end: 5 }, 'Ana Ruiz')
    expect(m.text).toBe('| [[Ana Ruiz\\|ana]] | y |\n')
  })

  it('refuses empty observations and relations instead of writing unparseable lines', () => {
    expect(() => appendObservation('# T\n', { category: 'fact', text: '  ' })).toThrow(/needs text/)
    expect(() => appendRelation('# T\n', { rel: 'uses', target: '' })).toThrow(PatchError)
    expect(() => supersede('## Observations\n- [fact] a ^f-0123456789\n', 'f-0123456789', { text: '' }, PROV)).toThrow(PatchError)
  })

  it('caps filenames by UTF-8 bytes on whole code points', () => {
    const stem = sanitizeFilename('日本語'.repeat(80))
    expect(new TextEncoder().encode(stem).length).toBeLessThanOrEqual(180)
    expect(stem).toBe('日本語'.repeat(20))
    const emoji = sanitizeFilename('😀'.repeat(100))
    expect(emoji).toBe('😀'.repeat(45))
  })

  it('only reads block refs at a boundary', () => {
    expect(parseBlockRef('ref-0123456789')).toBeNull()
    expect(parseBlockRef('[[Ana Ruiz#^f-9q1c3m8d2e]]')).toBe('f-9q1c3m8d2e')
    expect(parseBlockRef('Ana Ruiz#^r-9q1c3m8d2e')).toBe('r-9q1c3m8d2e')
    expect(parseBlockRef(' ^f-9q1c3m8d2e ')).toBe('f-9q1c3m8d2e')
  })

  it('keeps a BOM first when frontmatter is created', () => {
    const r = ensureNoteId('\uFEFF# T\n', 'n-0123456789')
    expect(r.text).toBe('\uFEFF---\nid: n-0123456789\n---\n# T\n')
    const n = parseNote(r.text)
    expect(n.id).toBe('n-0123456789')
    expect(n.h1).toBe('T')
  })

  it('merge3 and diffLines satisfy the identity laws on random inputs', () => {
    let seed = 7
    const rnd = (n: number): number => ((seed = (seed * 1103515245 + 12345) % 2147483648), seed % n)
    const gen = (): string => Array.from({ length: rnd(8) }, () => `${'abcde'[rnd(5)]}\n`).join('')
    const mutate = (s: string): string => {
      const L = splitKeepEol(s)
      for (let k = rnd(3); k > 0; k--) {
        const at = rnd(L.length + 1)
        if (rnd(2) && L.length) L.splice(Math.min(at, L.length - 1), 1)
        else L.splice(at, 0, `${'xyz'[rnd(3)]}\n`)
      }
      return L.join('')
    }
    for (let t = 0; t < 1000; t++) {
      const base = gen()
      const a = mutate(base)
      const b = mutate(base)
      expect(merge3(base, a, base).text).toBe(a)
      expect(merge3(base, base, b).text).toBe(b)
      expect(merge3(base, a, a).text).toBe(a)
      const ops = diffLines(splitKeepEol(base), splitKeepEol(a))
      expect(ops.filter((o) => o.op !== 'delete').flatMap((o) => o.lines).join('')).toBe(a)
      expect(ops.filter((o) => o.op !== 'insert').flatMap((o) => o.lines).join('')).toBe(base)
    }
  })

  it('never throws and round-trips byte soup', () => {
    let seed = 11
    const rnd = (n: number): number => ((seed = (seed * 1103515245 + 12345) % 2147483648), seed % n)
    const parts = ['-', ' ', '[', ']', '(', ')', '#', '^', '`', '\n', '\r\n', '|', 'a', 'f-0123456789', '---', ':', '"', "'", '%%', '!', '\t', '~~~', '\uFEFF']
    for (let t = 0; t < 2000; t++) {
      const s = Array.from({ length: rnd(60) }, () => parts[rnd(parts.length)]).join('')
      expect(serializeNote(parseNote(s, { path: 'x.md' }))).toBe(s)
      expect(() => highlightNote(s)).not.toThrow()
    }
  })
})
