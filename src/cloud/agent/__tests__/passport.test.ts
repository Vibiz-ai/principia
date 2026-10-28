import { afterEach, describe, expect, it } from 'vitest'
import { PassportClient, harvestNotes, notesBody } from '../passport'
import { fakePassportHost, type FakeHost } from './fakes'
import { budget } from '../../../test/timing'

let host: FakeHost | null = null
afterEach(async () => {
  await host?.close()
  host = null
})
const material = (h: FakeHost) => ({ internalUrl: h.url, publicUrl: 'https://passport.example.com', passportId: 'pp_acme', token: h.token })

describe('passport L0 card', () => {
  it('fetches the framed card with the runtime grant and caches it by revision', async () => {
    host = await fakePassportHost()
    const c = new PassportClient()
    expect(await c.card(material(host))).toContain('Acme sells invoicing')
    expect(host.requests.map((r) => r.path)).toEqual(['/v1/passports/pp_acme?format=json', '/v1/passports/pp_acme'])
    expect(host.requests.every((r) => r.auth === `Bearer ${host!.token}`)).toBe(true)
    // same revision: one small JSON read, no markdown fetch
    await c.card(material(host))
    expect(host.requests.length).toBe(3)
    // a new revision fetches the card again
    host.revision = 4
    host.card = '<company-passport>\nAcme now sells to cafes too.\n</company-passport>'
    expect(await c.card(material(host))).toContain('cafes')
    expect(host.requests.length).toBe(5)
    expect(c.cached(material(host))).toContain('cafes')
    // a department adds ?department=
    expect(await c.card(material(host), 'marketing')).toContain('## marketing')
    expect(host.requests.at(-1)!.path).toBe('/v1/passports/pp_acme?department=marketing')
  })

  it('a slow or down host never blocks a run: null without a card, the last card otherwise', async () => {
    host = await fakePassportHost()
    const c = new PassportClient({ timeoutMs: 100 })
    host.delayMs = budget(400) // scaled with the limit, so it still proves we gave up at the timeout, not the reply
    const t = Date.now()
    expect(await c.card(material(host))).toBeNull()
    expect(Date.now() - t).toBeLessThan(budget(350))
    host.delayMs = 0
    expect(await c.card(material(host))).toContain('Acme sells')
    host.delayMs = 400
    host.revision = 9
    expect(await c.card(material(host))).toContain('Acme sells')
    expect(await new PassportClient({ timeoutMs: 100 }).card({ ...material(host), internalUrl: 'http://127.0.0.1:9' })).toBeNull()
  })

  it('a wrong token is not a card', async () => {
    host = await fakePassportHost()
    expect(await new PassportClient().card({ ...material(host), token: 'opk_wrong' })).toBeNull()
  })
})

describe('harvested notes become passport writes', () => {
  const output = 'Done.\n<passport-notes>\n### [[Launch]] (product)\n- [decision] The launch email goes out on Tuesdays\n- uses [[Mailchimp]]\n- [fact] api key sk-ant-api03-zzzzzzzzzzzzzzzzzzzzzzzz is set\n</passport-notes>'
  it('parses and screens a read-write step answer; other steps write nothing', () => {
    const notes = harvestNotes({ adapter: 'claude', memory: 'read-write', status: 'passed', output })
    expect(notes).toHaveLength(1)
    expect(notesBody(notes[0]!)).toEqual({ note: 'Launch', type: 'product', facts: [{ category: 'decision', text: 'The launch email goes out on Tuesdays' }], relations: [{ rel: 'uses', to: 'Mailchimp' }] })
    expect(harvestNotes({ adapter: 'claude', memory: 'read', status: 'passed', output })).toEqual([])
    expect(harvestNotes({ adapter: 'claude', memory: 'read-write', status: 'failed', output })).toEqual([])
    expect(harvestNotes({ adapter: 'shell', memory: 'read-write', status: 'passed', output })).toEqual([])
  })
  it('posts one /notes write per note (SPEC §11.2 passport_write input)', async () => {
    host = await fakePassportHost()
    const notes = harvestNotes({ adapter: 'codex', memory: 'read-write', status: 'passed', output })
    expect(await new PassportClient().writeNotes(material(host), notes)).toEqual(['proposed'])
    expect(host.notes).toEqual([{ note: 'Launch', type: 'product', facts: [{ category: 'decision', text: 'The launch email goes out on Tuesdays' }], relations: [{ rel: 'uses', to: 'Mailchimp' }] }])
  })
})
