/** SLACK.md §9.6: thread images (ingest keeps file urls, safe download, human-image selection, connector wiring). */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SlackMessage } from '../../../../shared/slack'
import { downloadThreadImages, imageFileName, MAX_IMAGE_BYTES, pickThreadImages, type ImageSink } from '../core/files'
import { messageRow } from '../core/ingest'
import { manifestObject } from '../core/manifest'
import { messageSchema } from '../core/types'
import { diskImageSink } from '../images'
import { isSlackFileUrl, slackDownload } from '../transport/node'
import { FAKE_SCOPES } from '../testing/fakeSlack'
import { CHANNELS, USERS, connect, makeHarness, nativeOk, settle, type Harness } from './harness'

const TOKEN = 'xoxb-111-222-secretsecret'
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
const resolver = { user: () => null, channel: () => null }

describe('ingest keeps file ids and private urls', () => {
  it('maps id and prefers url_private_download', () => {
    const wire = messageSchema.parse({
      type: 'message',
      ts: '1.1',
      user: 'U1',
      text: 'see',
      files: [
        { id: 'F1', name: 'shot.png', mimetype: 'image/png', url_private: 'https://files.slack.com/files-pri/T-F1/shot.png', url_private_download: 'https://files.slack.com/files-pri/T-F1/download/shot.png' },
        { id: 'F2', name: 'b.jpg', mimetype: 'image/jpeg', url_private: 'https://files.slack.com/files-pri/T-F2/b.jpg' },
        { name: 'old.txt' }
      ]
    })
    const row = messageRow(wire, 'C1', resolver as never)
    expect(row.files[0]).toMatchObject({ id: 'F1', name: 'shot.png', urlPrivate: 'https://files.slack.com/files-pri/T-F1/download/shot.png' })
    expect(row.files[1]).toMatchObject({ id: 'F2', urlPrivate: 'https://files.slack.com/files-pri/T-F2/b.jpg' })
    expect(row.files[2]).toMatchObject({ id: null, urlPrivate: null })
  })

  it('manifest asks for files:read', () => {
    expect((manifestObject() as { oauth_config: { scopes: { bot: string[] } } }).oauth_config.scopes.bot).toContain('files:read')
  })
})

// ---------- transport download ----------
type Call = { url: string; auth: string | null; redirect: string | undefined }
function fakeFetch(routes: Record<string, () => Response>): { calls: Call[]; fetch: (url: string, init: RequestInit) => Promise<Response> } {
  const calls: Call[] = []
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, auth: (init.headers as Record<string, string>).Authorization ?? null, redirect: init.redirect })
      const r = routes[url]
      if (!r) return new Response('nope', { status: 404 })
      return r()
    }
  }
}
const img = (bytes = PNG, type = 'image/png', extra: Record<string, string> = {}) => () => new Response(bytes, { status: 200, headers: { 'content-type': type, ...extra } })
const redirect = (to: string) => () => new Response(null, { status: 302, headers: { location: to } })
const F = 'https://files.slack.com/files-pri/T1-F1/download/shot.png'

describe('transport download (Slack hosts only, images only)', () => {
  it('host check', () => {
    expect(isSlackFileUrl(new URL(F))).toBe(true)
    expect(isSlackFileUrl(new URL('https://acme.slack.com/x'))).toBe(true)
    expect(isSlackFileUrl(new URL('http://files.slack.com/x'))).toBe(false)
    expect(isSlackFileUrl(new URL('https://files.slack.com.evil.io/x'))).toBe(false)
    expect(isSlackFileUrl(new URL('https://evilslack.com/x'))).toBe(false)
    expect(isSlackFileUrl(new URL('https://u:p@files.slack.com/x'))).toBe(false)
    expect(isSlackFileUrl(new URL('https://files.slack.com:8443/x'))).toBe(false)
  })

  it('downloads an image with the bearer token and manual redirects inside Slack', async () => {
    const f = fakeFetch({ [F]: redirect('https://files-edge.slack.com/a.png'), 'https://files-edge.slack.com/a.png': img() })
    const got = await slackDownload({ url: F, token: TOKEN, maxBytes: MAX_IMAGE_BYTES }, f.fetch)
    expect(got.contentType).toBe('image/png')
    expect([...got.bytes]).toEqual([...PNG])
    expect(f.calls.map((c) => c.redirect)).toEqual(['manual', 'manual'])
    expect(f.calls.every((c) => c.auth === `Bearer ${TOKEN}`)).toBe(true)
  })

  it('refuses non-Slack hosts before any request', async () => {
    const f = fakeFetch({})
    await expect(slackDownload({ url: 'https://evil.example.com/a.png', token: TOKEN, maxBytes: 100 }, f.fetch)).rejects.toThrow(/not hosted by Slack/)
    await expect(slackDownload({ url: 'http://files.slack.com/a.png', token: TOKEN, maxBytes: 100 }, f.fetch)).rejects.toThrow()
    expect(f.calls).toHaveLength(0)
  })

  it('refuses a redirect that leaves Slack: the token never reaches the other host', async () => {
    const f = fakeFetch({ [F]: redirect('https://cdn.evil.io/a.png'), 'https://cdn.evil.io/a.png': img() })
    await expect(slackDownload({ url: F, token: TOKEN, maxBytes: MAX_IMAGE_BYTES }, f.fetch)).rejects.toThrow(/leaves Slack/)
    expect(f.calls.map((c) => c.url)).toEqual([F])
  })

  it('stops after 3 redirect hops', async () => {
    const routes: Record<string, () => Response> = {}
    for (let i = 0; i < 6; i++) routes[i ? `https://files.slack.com/${i}` : F] = redirect(`https://files.slack.com/${i + 1}`)
    const f = fakeFetch(routes)
    await expect(slackDownload({ url: F, token: TOKEN, maxBytes: MAX_IMAGE_BYTES }, f.fetch)).rejects.toThrow(/Too many redirects/)
    expect(f.calls).toHaveLength(4)
  })

  it('an HTML login page means files:read is missing', async () => {
    const f = fakeFetch({ [F]: img(new TextEncoder().encode('<html>sign in</html>'), 'text/html; charset=utf-8') })
    await expect(slackDownload({ url: F, token: TOKEN, maxBytes: MAX_IMAGE_BYTES }, f.fetch)).rejects.toThrow(/files:read/)
  })

  it('refuses non-image and unsupported image types', async () => {
    for (const t of ['application/pdf', 'image/svg+xml', 'image/heic', '']) {
      const f = fakeFetch({ [F]: img(PNG, t) })
      await expect(slackDownload({ url: F, token: TOKEN, maxBytes: MAX_IMAGE_BYTES }, f.fetch)).rejects.toThrow(/Not a supported image/)
    }
  })

  it('caps size by content-length and while streaming', async () => {
    const big = new Uint8Array(64)
    const declared = fakeFetch({ [F]: img(big, 'image/jpeg', { 'content-length': '64' }) })
    await expect(slackDownload({ url: F, token: TOKEN, maxBytes: 32 }, declared.fetch)).rejects.toThrow(/too large/)
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array(20))
        c.enqueue(new Uint8Array(20))
        c.close()
      }
    })
    const streamed = fakeFetch({ [F]: () => new Response(stream, { status: 200, headers: { 'content-type': 'image/webp' } }) })
    await expect(slackDownload({ url: F, token: TOKEN, maxBytes: 32 }, streamed.fetch)).rejects.toThrow(/too large/)
  })

  it('error messages carry neither the token nor the url', async () => {
    const f = fakeFetch({ [F]: () => new Response('x', { status: 403 }) })
    const e = await slackDownload({ url: F, token: TOKEN, maxBytes: 10 }, f.fetch).catch((x: Error) => x)
    expect(String(e)).not.toContain(TOKEN)
    expect(String(e)).not.toContain('files-pri')
  })
})

// ---------- selection + core download ----------
const msg = (p: Partial<SlackMessage> & { ts: string }): SlackMessage => ({
  teamId: 'T1',
  channelId: 'C1',
  threadTs: '1.0',
  userId: 'U1',
  botId: null,
  subtype: null,
  text: '',
  plain: '',
  files: [],
  reactions: [],
  replyCount: 0,
  latestReply: null,
  editedTs: null,
  deleted: false,
  fromHive: false,
  isMention: false,
  ...p
})
const file = (id: string, mimetype = 'image/png') => ({ id, name: `${id}.png`, mimetype, size: 3, permalink: null, urlPrivate: `https://files.slack.com/files-pri/T1-${id}/${id}.png` })

describe('pickThreadImages', () => {
  it('human images only, newest first, parent included, max 5', () => {
    const msgs = [
      msg({ ts: '1.0', files: [file('P1')], replyCount: 3 }),
      msg({ ts: '2.0', botId: 'B9', files: [file('BOT1')] }),
      msg({ ts: '3.0', userId: 'UOTHERBOT', files: [file('BOT2')] }),
      msg({ ts: '4.0', fromHive: true, files: [file('HIVE')] }),
      msg({ ts: '5.0', files: [file('R1'), file('DOC', 'application/pdf'), file('R2')] }),
      msg({ ts: '6.0', deleted: true, files: [file('DEL')] })
    ]
    const ids = pickThreadImages(msgs, (u) => u === 'UOTHERBOT').map((p) => p.file.id)
    expect(ids).toEqual(['R1', 'R2', 'P1'])
    const many = Array.from({ length: 8 }, (_, i) => msg({ ts: `${10 + i}.0`, files: [file(`M${i}`)] }))
    expect(pickThreadImages(many, () => false).map((p) => p.file.id)).toEqual(['M7', 'M6', 'M5', 'M4', 'M3'])
  })

  it('names are sanitized and unique', () => {
    expect(imageFileName(0, '../../etc/pass wd.PNG', 'image/png')).toBe('1-etc_pass_wd.png')
    expect(imageFileName(1, '.hidden', 'image/jpeg')).toBe('2-hidden.jpg')
    expect(imageFileName(2, '', 'image/webp')).toBe('3-image.webp')
  })
})

describe('downloadThreadImages', () => {
  const logs: { m: string; meta?: object }[] = []
  const log = { info: (m: string, meta?: object) => logs.push({ m, meta }), warn: (m: string, meta?: object) => logs.push({ m, meta }), error: (m: string, meta?: object) => logs.push({ m, meta }) }
  const clock = { now: () => Date.now(), setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms), clearTimeout: (h: unknown) => clearTimeout(h as NodeJS.Timeout) }
  const thread = [msg({ ts: '1.0', files: [file('P1')], replyCount: 1 }), msg({ ts: '2.0', files: [file('R1')] })]
  const store = { getThread: async () => thread, getMessages: async () => [] }
  beforeEach(() => {
    logs.length = 0
  })

  it('writes through the sink; a failed file is skipped and the log has the file id but no token or url', async () => {
    const written: string[] = []
    const sink: ImageSink = { write: async (name) => (written.push(name), `/tmp/x/${name}`) }
    const download = vi.fn(async (req: { url: string; token: string }) => {
      if (req.url.includes('R1')) throw new Error(`boom ${req.token} ${req.url}`)
      return { contentType: 'image/png', bytes: PNG }
    })
    const paths = await downloadThreadImages({ store, teamId: 'T1', token: TOKEN, download, isBotUser: () => false, clock, log, refreshMs: 5 }, 'C1', '1.0', sink)
    expect(paths).toEqual(['/tmp/x/2-P1.png'])
    const text = JSON.stringify(logs)
    expect(text).toContain('R1')
    expect(text).not.toContain(TOKEN)
    expect(text).not.toContain('files-pri')
  })

  it('a slow thread refresh does not block: falls back to the mirror after refreshMs', async () => {
    const sink: ImageSink = { write: async (name) => name }
    const fetchThread = () => new Promise<void>(() => undefined)
    const t0 = Date.now()
    const paths = await downloadThreadImages(
      { store, teamId: 'T1', token: TOKEN, download: async () => ({ contentType: 'image/gif', bytes: PNG }), fetchThread, isBotUser: () => false, clock, log, refreshMs: 20 },
      'C1',
      '1.0',
      sink
    )
    expect(Date.now() - t0).toBeLessThan(2000)
    expect(paths).toEqual(['1-R1.gif', '2-P1.gif'])
  })

  it('disk sink writes 0600 files without overwriting', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-img-'))
    try {
      const sink = diskImageSink(path.join(dir, 'slack-images'))
      const a = await sink.write('1-a.png', PNG)
      const b = await sink.write('1-a.png', PNG)
      expect(a).not.toBe(b)
      expect(fs.statSync(a).mode & 0o777).toBe(0o600)
      expect(path.dirname(a)).toBe(path.join(dir, 'slack-images'))
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ---------- connector wiring on FakeSlack ----------
const d = nativeOk ? describe : describe.skip
d('connector.threadImages (FakeSlack)', () => {
  let h: Harness
  const NOW = new Date('2026-10-16T09:00:00Z').getTime()
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW })
  })
  afterEach(async () => {
    await h?.conn.stop()
    h?.db.close()
    vi.useRealTimers()
  })
  const url = (id: string) => `https://files.slack.com/files-pri/T1-${id}/download/${id}.png`
  const f = (id: string) => ({ id, name: `${id}.png`, mimetype: 'image/png', url_private: url(id).replace('/download', ''), url_private_download: url(id) })
  const parentTs = `${NOW / 1000 - 600}.000100`
  const messages = {
    C1: [
      { ts: parentTs, user: 'U1', text: 'broken page', files: [f('FP')], reply_count: 2 },
      { ts: `${NOW / 1000 - 500}.000100`, user: 'UOTHERBOT', bot_id: 'BOTHER', text: 'render', thread_ts: parentTs, files: [f('FB')] },
      { ts: `${NOW / 1000 - 400}.000100`, user: 'U2', text: '<@UBOT> look', thread_ts: parentTs, files: [f('FR')] }
    ]
  }

  it('downloads human images of parent + replies, newest first, skipping bot images', async () => {
    h = makeHarness({ messages, users: USERS, channels: CHANNELS })
    for (const id of ['FP', 'FB', 'FR']) h.fake.files.set(url(id), { contentType: 'image/png', bytes: PNG })
    await connect(h)
    await settle(2000)
    const written: string[] = []
    const p = h.conn.threadImages('C1', parentTs, { write: async (name) => (written.push(name), `/run/slack-images/${name}`) })
    await vi.advanceTimersByTimeAsync(4000)
    expect(await p).toEqual(['/run/slack-images/1-FR.png', '/run/slack-images/2-FP.png'])
    expect(h.fake.downloads.map((x) => x.url)).toEqual([url('FR'), url('FP')])
    expect(JSON.stringify(h.logs)).not.toContain(h.fake.tokens.bot)
  })

  it('missing files:read: a reinstall warning, and downloads fail softly', async () => {
    h = makeHarness({ messages, users: USERS, channels: CHANNELS, scopes: FAKE_SCOPES.filter((s) => s !== 'files:read') })
    h.fake.files.set(url('FR'), { contentType: 'image/png', bytes: PNG })
    await connect(h)
    await settle(2000)
    expect(h.conn.status().warnings.join(' ')).toMatch(/Reinstall the Slack app to let Principia see images/)
    const p = h.conn.threadImages('C1', parentTs, { write: async (n) => n })
    await vi.advanceTimersByTimeAsync(4000)
    expect(await p).toEqual([])
  })
})

