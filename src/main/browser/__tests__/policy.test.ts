import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { checkUrl, isExecutableName, partitionFor, permissionAllowed, safeDownloadName, uniquePath } from '../policy'
import { handleDownload, type DownloadItemLike } from '../downloads'
import type { BrowserDownload } from '../../../shared/browser'

const guard = { blockedOrigins: () => ['http://localhost:5173', 'http://127.0.0.1:43111', 'http://127.0.0.1:43112'] }

describe('checkUrl', () => {
  it('opens web pages', () => {
    expect(checkUrl('https://example.com/a?b=1', guard)).toEqual({ ok: true, url: 'https://example.com/a?b=1' })
    expect(checkUrl('about:blank', guard).ok).toBe(true)
    // a local test site on another port is fine
    expect(checkUrl('http://127.0.0.1:8080/form.html', guard).ok).toBe(true)
  })
  it('blocks files and app pages', () => {
    for (const u of ['file:///etc/passwd', 'chrome://settings', 'devtools://devtools/x', 'javascript:alert(1)', 'about:config', 'principia://board']) expect(checkUrl(u, guard).ok, u).toBe(false)
    expect(checkUrl('not a url', guard).ok).toBe(false)
  })
  it("blocks Principia's own origins, whatever loopback name or scheme reaches them", () => {
    for (const u of ['http://localhost:5173/', 'http://127.0.0.1:5173/#/x', 'http://[::1]:43111/v1/call', 'http://localhost:43112/']) expect(checkUrl(u, guard).ok, u).toBe(false)
    expect(checkUrl('ws://127.0.0.1:43111/socket', guard, 'request').ok).toBe(false)
  })
  it('lets pages open web sockets but not navigate to them', () => {
    expect(checkUrl('wss://chat.example.com/s', guard, 'request').ok).toBe(true)
    expect(checkUrl('wss://chat.example.com/s', guard).ok).toBe(false)
  })
})

describe('permissions and partitions', () => {
  it('denies camera, microphone, location and notifications by default', () => {
    for (const p of ['media', 'geolocation', 'notifications', 'midi', 'openExternal', 'pointerLock', 'fullscreen']) expect(permissionAllowed(p), p).toBe(false)
    expect(permissionAllowed('clipboard-sanitized-write')).toBe(true)
  })
  it('gives each company its own persistent partition', () => {
    expect(partitionFor('co_acme')).toBe('persist:company-co_acme')
    expect(partitionFor('co_a')).not.toBe(partitionFor('co_b'))
    expect(partitionFor('../x')).toBe('persist:company-___x')
  })
})

describe('download names', () => {
  it('keeps names inside the folder and unique', () => {
    expect(safeDownloadName('../../.ssh/id_rsa')).toBe('id_rsa')
    expect(safeDownloadName('.hidden')).toBe('hidden')
    expect(safeDownloadName('')).toBe('download')
    const taken = new Set(['/d/report.pdf', '/d/report (2).pdf'])
    expect(uniquePath('/d', 'report.pdf', (p) => taken.has(p))).toBe(path.join('/d', 'report (3).pdf'))
  })
  it('knows which files can run code', () => {
    for (const n of ['setup.dmg', 'Tool.app', 'run.sh', 'x.pkg', 'a.command', 'b.EXE']) expect(isExecutableName(n), n).toBe(true)
    for (const n of ['report.pdf', 'photo.png', 'data.csv', 'README']) expect(isExecutableName(n), n).toBe(false)
  })
})

class FakeItem implements DownloadItemLike {
  savePath = ''
  state = 'progressing'
  received = 0
  private updated: ((e: unknown, s: string) => void)[] = []
  private done: ((e: unknown, s: string) => void)[] = []
  constructor(
    private name: string,
    private total: number
  ) {}
  getFilename = (): string => this.name
  getTotalBytes = (): number => this.total
  getReceivedBytes = (): number => this.received
  setSavePath = (p: string): void => void (this.savePath = p)
  pause = (): void => void (this.state = 'paused')
  resume = (): void => void (this.state = 'progressing')
  cancel = (): void => {
    this.state = 'cancelled'
    for (const f of this.done) f({}, 'cancelled')
  }
  on(_ev: 'updated', fn: (e: unknown, s: string) => void): void {
    this.updated.push(fn)
  }
  once(_ev: 'done', fn: (e: unknown, s: string) => void): void {
    this.done.push(fn)
  }
  progress(n: number): void {
    this.received = n
    for (const f of this.updated) f({}, 'progressing')
  }
  finish(): void {
    for (const f of this.done) f({}, 'completed')
  }
}

function ctx(confirm: boolean) {
  const updates: BrowserDownload[] = []
  const notes: string[] = []
  const asked: string[] = []
  return { updates, notes, asked, c: { dir: '/co/Downloads', maxBytes: 1000, exists: () => false, mkdir: () => undefined, rename: () => undefined, remove: () => undefined, confirm: async (n: string) => (asked.push(n), confirm), update: (d: BrowserDownload) => updates.push(d), note: (t: string) => notes.push(t) } }
}

describe('handleDownload', () => {
  it("saves into the company's Downloads folder and tells the agent", () => {
    const item = new FakeItem('report.pdf', 100)
    const { c, notes } = ctx(true)
    handleDownload(item, c)
    expect(item.savePath).toBe(path.join('/co/Downloads', 'report.pdf'))
    item.progress(100)
    item.finish()
    expect(notes).toEqual([`Downloaded report.pdf to ${path.join('/co/Downloads', 'report.pdf')}.`])
  })
  it('stops a download over the size cap', () => {
    const big = new FakeItem('big.zip', 5000)
    const { c, notes } = ctx(true)
    expect(handleDownload(big, c).state).toBe('cancelled')
    expect(big.state).toBe('cancelled')
    expect(notes[0]).toMatch(/larger than/)
    // unknown size that grows past the cap
    const grows = new FakeItem('stream.bin.zip', 0)
    handleDownload(grows, c)
    grows.progress(2000)
    expect(grows.state).toBe('cancelled')
  })
  it('holds a file that can run code until the founder says yes, and cancels on no', async () => {
    const yes = new FakeItem('Installer.dmg', 10)
    const a = ctx(true)
    handleDownload(yes, a.c)
    expect(yes.state).toBe('paused')
    expect(a.asked).toEqual(['Installer.dmg'])
    await new Promise((r) => setTimeout(r, 0))
    expect(yes.state).toBe('progressing')
    const no = new FakeItem('evil.command', 10)
    const b = ctx(false)
    handleDownload(no, b.c)
    await new Promise((r) => setTimeout(r, 0))
    expect(no.state).toBe('cancelled')
    expect(b.notes).toContain('The founder declined the download of evil.command.')
  })
  it('never writes a file that can run code under its own name before the yes, even when it finishes at once', async () => {
    for (const say of [true, false]) {
      const item = new FakeItem('installer.command', 18)
      const moved: [string, string][] = []
      const removed: string[] = []
      let answer!: (v: boolean) => void
      const updates: BrowserDownload[] = []
      const c = { dir: '/co/Downloads', exists: () => false, mkdir: () => undefined, rename: (a: string, b: string) => void moved.push([a, b]), remove: (p: string) => void removed.push(p), confirm: () => new Promise<boolean>((r) => (answer = r)), update: (d: BrowserDownload) => updates.push(d), note: () => undefined }
      handleDownload(item, c)
      // held under a name that cannot run, in a hidden folder
      expect(item.savePath).toMatch(/[/\\]\.waiting[/\\]dl\d+\.part$/)
      // the whole file arrives before pause() takes hold
      item.received = 18
      item.finish()
      expect(moved).toEqual([])
      expect(updates.at(-1)!.state).toBe('waiting')
      answer(say)
      await new Promise((r) => setTimeout(r, 0))
      if (say) {
        expect(moved).toEqual([[item.savePath, path.join('/co/Downloads', 'installer.command')]])
        expect(updates.at(-1)!.state).toBe('completed')
        expect(removed).toEqual([])
      } else {
        expect(moved).toEqual([])
        expect(removed).toEqual([item.savePath])
        expect(updates.at(-1)!.state).toBe('cancelled')
      }
    }
  })
})
