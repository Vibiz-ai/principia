import http from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { BROWSER_TOOLS, type BrowserActivity, type BrowserTabView } from '../../../shared/browser'
import { CdpDriver } from '../driver'
import { BrowserService } from '../service'
import { runBrowserTool, TAKEOVER_MESSAGE, type CompanyBrowser } from '../tools'
import { FakeCdp } from './fakeCdp'

/** One company's fake browser: a fake CDP page plus what the tools asked for. */
class FakeBrowser implements CompanyBrowser {
  cdp = new FakeCdp()
  d = new CdpDriver(this.cdp, { timeoutMs: 200 })
  over = false
  opened: string[] = []
  navigated: string[] = []
  shots = 0
  files: string[] = []
  notes: string[] = []
  tabList: BrowserTabView[] = [{ id: 't1', url: 'https://a.test/', title: 'A', loading: false, canGoBack: false, canGoForward: false }]
  constructor(readonly name: string, ax = 1) {
    this.cdp.on('Accessibility.getFullAXTree', () => ({ nodes: [{ nodeId: '1', role: { value: 'RootWebArea' }, childIds: Array.from({ length: ax }, (_, i) => `b${i}`) }, ...Array.from({ length: ax }, (_, i) => ({ nodeId: `b${i}`, parentId: '1', role: { value: 'button' }, name: { value: `${name} button ${i}` }, backendDOMNodeId: 100 + i }))] }))
    this.cdp.on('Runtime.evaluate', () => ({ result: { value: { title: name, url: `https://${name}.test/` } } }))
    this.cdp.on('DOM.getContentQuads', () => ({ quads: [[0, 0, 10, 0, 10, 10, 0, 10]] }))
    this.cdp.on('Page.navigate', (p) => (this.navigated.push(String(p.url)), {}))
  }
  takeover = (): boolean => this.over
  driver = async (): Promise<{ tabId: string; driver: CdpDriver }> => ({ tabId: 't1', driver: this.d })
  openTab = async (url?: string): Promise<string> => (this.opened.push(url ?? ''), 't2')
  selectTab = (): void => undefined
  closeTab = (): void => undefined
  tabs = (): BrowserTabView[] => this.tabList
  activeTabId = (): string => 't1'
  nav = async (): Promise<void> => undefined
  checkUrl = (u: string) => (u.startsWith('file:') ? { ok: false as const, reason: 'file: addresses are blocked' } : { ok: true as const, url: u })
  screenshot = async () => (this.shots++, { path: `/co/${this.name}/shot.png`, jpegBase64: 'AAAA' })
  writeSnapshot = (t: string): string => (this.files.push(t), `/co/${this.name}/snap.md`)
  takeDownloadNotes = (): string[] => this.notes.splice(0)
}

const caller = (log: string[] = []) => ({ agent: 'Claude', sessionKey: 's1', activity: (d: string) => void log.push(d) })

describe('runBrowserTool', () => {
  it('pauses actions while the founder has taken over, but still lets the agent look', async () => {
    const b = new FakeBrowser('acme')
    b.over = true
    const nav = await runBrowserTool(b, caller(), 'browser_navigate', { url: 'https://example.com' })
    expect(nav.isError).toBe(true)
    expect(nav.content[0]).toEqual({ type: 'text', text: TAKEOVER_MESSAGE })
    for (const t of ['browser_click', 'browser_type', 'browser_press', 'browser_select', 'browser_back', 'browser_reload'] as const) expect((await runBrowserTool(b, caller(), t, { ref: 'e1', text: 'x', key: 'Enter', values: ['a'] })).isError, t).toBe(true)
    expect(b.navigated).toEqual([])
    expect((await runBrowserTool(b, caller(), 'browser_snapshot', {})).isError).toBeFalsy()
    expect((await runBrowserTool(b, caller(), 'browser_screenshot', {})).isError).toBeFalsy()
    expect((await runBrowserTool(b, caller(), 'browser_tabs', {})).isError).toBeFalsy()
    // handed back: the agent continues
    b.over = false
    expect((await runBrowserTool(b, caller(), 'browser_navigate', { url: 'example.com' })).isError).toBeFalsy()
    expect(b.navigated[0]).toMatch(/^https:\/\/example\.com/)
  })

  it('a timed wait during a takeover returns as soon as the founder hands the browser back', async () => {
    const b = new FakeBrowser('acme')
    b.over = true
    const t0 = Date.now()
    setTimeout(() => (b.over = false), 300)
    const r = await runBrowserTool(b, caller(), 'browser_wait', { for: 'time', seconds: 30 })
    expect(Date.now() - t0).toBeLessThan(2_000)
    expect(r.content[0]).toEqual({ type: 'text', text: expect.stringContaining('handed the browser back') })
  })

  it('returns screenshots as an image block plus where the file is', async () => {
    const b = new FakeBrowser('acme')
    const r = await runBrowserTool(b, caller(), 'browser_screenshot', {})
    expect(r.content[0]).toMatchObject({ type: 'text' })
    expect((r.content[0] as { text: string }).text).toContain('/co/acme/shot.png')
    expect(r.content[1]).toEqual({ type: 'image', data: 'AAAA', mimeType: 'image/jpeg' })
  })

  it('writes a big snapshot to a file and returns its path', async () => {
    const b = new FakeBrowser('acme', 600)
    const r = await runBrowserTool(b, caller(), 'browser_snapshot', {})
    const text = (r.content[0] as { text: string }).text
    expect(text.length).toBeLessThan(12_500)
    expect(text).toContain('The full snapshot is in /co/acme/snap.md')
    expect(b.files[0]).toContain('acme button 599')
  })

  it('refuses blocked addresses and says what it is doing in plain words', async () => {
    const b = new FakeBrowser('acme')
    const log: string[] = []
    expect((await runBrowserTool(b, caller(log), 'browser_navigate', { url: 'file:///etc/passwd' })).isError).toBe(true)
    await runBrowserTool(b, caller(log), 'browser_snapshot', {})
    const s = (await runBrowserTool(b, caller(log), 'browser_snapshot', {})).content[0] as { text: string }
    const ref = /\[ref=(e\d+)\]/.exec(s.text)![1]!
    await runBrowserTool(b, caller(log), 'browser_click', { ref, element: 'the first button' })
    expect(log).toContain('Clicking “the first button”')
  })

  it('appends download notes to the next result', async () => {
    const b = new FakeBrowser('acme')
    b.notes.push('Downloaded a.pdf to /co/acme/Downloads/a.pdf.')
    const r = await runBrowserTool(b, caller(), 'browser_tabs', {})
    expect((r.content[0] as { text: string }).text).toContain('Downloaded a.pdf')
  })
})

describe('BrowserService', () => {
  let svc: BrowserService | null = null
  afterEach(async () => {
    await svc?.stop()
    svc = null
  })
  function make() {
    const browsers: Record<string, FakeBrowser> = { co_a: new FakeBrowser('a'), co_b: new FakeBrowser('b') }
    const activity: [string, BrowserActivity][] = []
    svc = new BrowserService({ backend: { forCompany: (id) => browsers[id]!, setActivity: (id, a) => void activity.push([id, a]) }, bridgeScript: '/x/mcp-browser.js', execPath: '/x/Principia' })
    return { svc, browsers, activity }
  }
  const post = (port: number, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> =>
    new Promise((resolve, reject) => {
      const data = JSON.stringify(body)
      const req = http.request({ host: '127.0.0.1', port, path: '/v1/call', method: 'POST', headers: { 'content-type': 'application/json', ...headers } }, (res) => {
        let b = ''
        res.on('data', (c) => (b += c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: b }))
      })
      req.on('error', reject)
      req.end(data)
    })

  it("a token reaches only its own company's browser, whatever the arguments say", async () => {
    const { svc, browsers, activity } = make()
    const ta = svc.grant({ companyId: 'co_a', agent: 'Claude', sessionKey: 'pane:1' })
    const r = await svc.call(ta, 'browser_snapshot', { companyId: 'co_b', tabId: 't9' })!
    expect((r.content[0] as { text: string }).text).toContain('a button 0')
    expect((r.content[0] as { text: string }).text).not.toContain('b button')
    expect(browsers.co_b!.cdp.calls).toHaveLength(0)
    expect(activity.every(([id]) => id === 'co_a')).toBe(true)
    expect(activity[0]![1]).toMatchObject({ agent: 'Claude', sessionKey: 'pane:1', doing: 'Reading the page' })
  })

  it('needs a token over HTTP, refuses web pages, and serves the tools with one', async () => {
    const { svc } = make()
    await svc.start()
    const port = svc.port
    expect((await post(port, { tool: 'browser_tabs', args: {} })).status).toBe(401)
    expect((await post(port, { tool: 'browser_tabs', args: {} }, { authorization: 'Bearer ' + 'x'.repeat(32) })).status).toBe(401)
    const token = svc.grant({ companyId: 'co_b', agent: 'Codex', sessionKey: 'run:1' })
    expect((await post(port, { tool: 'browser_tabs' }, { authorization: `Bearer ${token}`, origin: 'https://evil.example' })).status).toBe(403)
    const ok = await post(port, { tool: 'browser_tabs', args: {} }, { authorization: `Bearer ${token}` })
    expect(ok.status).toBe(200)
    expect(JSON.parse(ok.body).content[0].text).toContain('t1: A')
    svc.revoke(token)
    expect((await post(port, { tool: 'browser_tabs', args: {} }, { authorization: `Bearer ${token}` })).status).toBe(401)
  })

  it('gives each spawn its own token in the MCP spec, and none without a company or before it listens', async () => {
    const { svc } = make()
    expect(svc.attachment({ companyId: 'co_a', agent: 'Claude', sessionKey: 'x' })).toBeNull()
    await svc.start()
    const a = svc.attachment({ companyId: 'co_a', agent: 'Claude', sessionKey: 'x' })!
    const b = svc.attachment({ companyId: 'co_a', agent: 'Claude', sessionKey: 'y' })!
    expect(a).toMatchObject({ name: 'principia-browser', command: '/x/Principia', args: ['/x/mcp-browser.js'] })
    expect(a.env.ELECTRON_RUN_AS_NODE).toBe('1')
    expect(a.env.PRINCIPIA_BROWSER_URL).toBe(svc.url)
    expect(a.env.PRINCIPIA_BROWSER_TOKEN).not.toBe(b.env.PRINCIPIA_BROWSER_TOKEN)
    expect(svc.lookup(a.env.PRINCIPIA_BROWSER_TOKEN!)?.companyId).toBe('co_a')
    expect(svc.attachment({ companyId: '', agent: 'Claude', sessionKey: 'z' })).toBeNull()
    expect(svc.toolNames()).toEqual(BROWSER_TOOLS)
  })

  it("runs one company's calls one at a time", async () => {
    const { svc, browsers } = make()
    const t = svc.grant({ companyId: 'co_a', agent: 'Claude', sessionKey: 's' })
    const order: string[] = []
    browsers.co_a!.cdp.on('Runtime.evaluate', async () => {
      order.push('start')
      await new Promise((r) => setTimeout(r, 15))
      order.push('end')
      return { result: { value: true } }
    })
    await Promise.all([svc.call(t, 'browser_wait', { for: 'text', text: 'x' }), svc.call(t, 'browser_wait', { for: 'text', text: 'y' })])
    expect(order).toEqual(['start', 'end', 'start', 'end'])
  })
})
