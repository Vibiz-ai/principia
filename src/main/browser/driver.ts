/**
 * BROWSER.md §4: one tab driven over the Chrome DevTools Protocol. The transport is Electron's webContents.debugger
 * (no remote-debugging port); tests pass a fake. No Electron import here.
 */
import { formatSnapshot, RefMap, type AXNode, type ChildFrame, type RefTarget } from './snapshot'

export interface CdpTransport {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>
  /** CDP events of this target; returns unsubscribe */
  onEvent(fn: (method: string, params: Record<string, unknown>) => void): () => void
}

export interface ConsoleEntry {
  level: string
  text: string
  at: number
  source?: string
}
export interface NetEntry {
  id: string
  method: string
  url: string
  type: string
  status?: number
  failed?: string
  at: number
}

export class BrowserError extends Error {}

const CONSOLE_MAX = 300
const NET_MAX = 400
export const COMMAND_TIMEOUT_MS = 15_000

type Any = Record<string, any>

/** CDP key definitions for browser_press. */
const KEYS: Record<string, { code: string; key: string; vk: number; text?: string }> = {
  enter: { code: 'Enter', key: 'Enter', vk: 13, text: '\r' },
  tab: { code: 'Tab', key: 'Tab', vk: 9 },
  escape: { code: 'Escape', key: 'Escape', vk: 27 },
  esc: { code: 'Escape', key: 'Escape', vk: 27 },
  backspace: { code: 'Backspace', key: 'Backspace', vk: 8 },
  delete: { code: 'Delete', key: 'Delete', vk: 46 },
  space: { code: 'Space', key: ' ', vk: 32, text: ' ' },
  arrowup: { code: 'ArrowUp', key: 'ArrowUp', vk: 38 },
  arrowdown: { code: 'ArrowDown', key: 'ArrowDown', vk: 40 },
  arrowleft: { code: 'ArrowLeft', key: 'ArrowLeft', vk: 37 },
  arrowright: { code: 'ArrowRight', key: 'ArrowRight', vk: 39 },
  home: { code: 'Home', key: 'Home', vk: 36 },
  end: { code: 'End', key: 'End', vk: 35 },
  pageup: { code: 'PageUp', key: 'PageUp', vk: 33 },
  pagedown: { code: 'PageDown', key: 'PageDown', vk: 34 }
}
const MODS: Record<string, number> = { alt: 1, option: 1, control: 2, ctrl: 2, meta: 4, cmd: 4, command: 4, shift: 8 }

export function parseKey(chord: string): { key: string; code: string; vk: number; text?: string; modifiers: number } {
  const parts = chord.split('+').map((p) => p.trim()).filter(Boolean)
  if (!parts.length) throw new BrowserError('No key given.')
  let modifiers = 0
  for (const m of parts.slice(0, -1)) {
    const bit = MODS[m.toLowerCase()]
    if (!bit) throw new BrowserError(`Unknown modifier ${m}. Use Control, Alt, Shift or Meta.`)
    modifiers |= bit
  }
  const last = parts[parts.length - 1]!
  const def = KEYS[last.toLowerCase()]
  if (def) return { ...def, modifiers }
  if ([...last].length === 1) {
    const ch = last
    const up = ch.toUpperCase()
    const isLetter = /[a-z]/i.test(ch)
    const isDigit = /[0-9]/.test(ch)
    const code = isLetter ? `Key${up}` : isDigit ? `Digit${ch}` : ''
    const vk = isLetter || isDigit ? up.charCodeAt(0) : 0
    // a chord with Control / Meta types nothing
    return { key: ch, code, vk, ...(modifiers & 6 ? {} : { text: ch }), modifiers }
  }
  if (/^F([1-9]|1[0-2])$/i.test(last)) {
    const n = Number(last.slice(1))
    return { key: last.toUpperCase(), code: last.toUpperCase(), vk: 111 + n, modifiers }
  }
  throw new BrowserError(`Unknown key ${last}.`)
}

export interface DriverOptions {
  timeoutMs?: number
  now?: () => number
}

export class CdpDriver {
  readonly refs = new RefMap()
  readonly consoleLog: ConsoleEntry[] = []
  private net = new Map<string, NetEntry>()
  private netOrder: string[] = []
  private mainFrameId: string | null = null
  private loading = false
  private loadWaiters: (() => void)[] = []
  private navStarted = 0
  private off: (() => void) | null = null
  private ready: Promise<void> | null = null
  private readonly timeoutMs: number
  private readonly now: () => number

  constructor(
    private readonly t: CdpTransport,
    o: DriverOptions = {}
  ) {
    this.timeoutMs = o.timeoutMs ?? COMMAND_TIMEOUT_MS
    this.now = o.now ?? Date.now
  }

  /** Enables the domains once (Page, Runtime, Network, Log, DOM). Safe to call again after a re-attach. */
  init(): Promise<void> {
    if (this.ready) return this.ready
    this.off?.()
    this.off = this.t.onEvent((m, p) => this.onEvent(m, p))
    this.ready = (async () => {
      await this.send('Page.enable')
      await this.send('Runtime.enable')
      await this.send('Network.enable', { maxTotalBufferSize: 0, maxResourceBufferSize: 0 }).catch(() => this.send('Network.enable'))
      await this.send('Log.enable').catch(() => undefined)
      await this.send('DOM.enable').catch(() => undefined)
      const tree = (await this.send('Page.getFrameTree')) as Any
      this.mainFrameId = tree?.frameTree?.frame?.id ?? null
    })()
    this.ready.catch(() => {
      this.ready = null
    })
    return this.ready
  }

  /** The debugger was detached: the next call enables everything again. */
  reset(): void {
    this.ready = null
    this.off?.()
    this.off = null
  }

  dispose(): void {
    this.reset()
    for (const w of this.loadWaiters.splice(0)) w()
  }

  async send(method: string, params?: Record<string, unknown>): Promise<Any> {
    let timer: NodeJS.Timeout | null = null
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new BrowserError(`The page did not answer in ${Math.round(this.timeoutMs / 1000)} s (${method}).`)), this.timeoutMs)
    })
    try {
      return (await Promise.race([this.t.send(method, params), timeout])) as Any
    } catch (e) {
      if (e instanceof BrowserError) throw e
      throw new BrowserError(cdpMessage(e))
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  private onEvent(method: string, p: Any): void {
    switch (method) {
      case 'Page.frameNavigated':
        if (!p.frame?.parentId) {
          this.mainFrameId = p.frame?.id ?? this.mainFrameId
          // a new document: old refs point nowhere
          this.refs.reset()
        }
        return
      case 'Page.javascriptDialogOpening': {
        // a dialog blocks the page (and every command after it): alerts and leave-page prompts are accepted,
        // confirm / prompt are dismissed; the agent reads what it said in browser_console
        const type = String(p.type ?? 'alert')
        const accept = type === 'alert' || type === 'beforeunload'
        this.pushConsole({ level: 'warning', text: `[${type} dialog ${accept ? 'accepted' : 'dismissed'}] ${String(p.message ?? '')}`, at: this.now() })
        void this.t.send('Page.handleJavaScriptDialog', { accept }).catch(() => undefined)
        return
      }
      case 'Page.navigatedWithinDocument':
        return
      case 'Page.frameStartedLoading':
        if (!this.mainFrameId || p.frameId === this.mainFrameId) {
          this.loading = true
          this.navStarted = this.now()
        }
        return
      case 'Page.frameStoppedLoading':
        if (!this.mainFrameId || p.frameId === this.mainFrameId) this.settle()
        return
      case 'Page.loadEventFired':
        this.settle()
        return
      case 'Runtime.consoleAPICalled': {
        const text = ((p.args as Any[]) ?? []).map(remoteText).join(' ')
        this.pushConsole({ level: levelOf(String(p.type ?? 'log')), text, at: this.now() })
        return
      }
      case 'Runtime.exceptionThrown': {
        const d = p.exceptionDetails ?? {}
        this.pushConsole({ level: 'error', text: String(d.exception?.description ?? d.text ?? 'Uncaught error').split('\n').slice(0, 4).join('\n'), at: this.now(), source: d.url })
        return
      }
      case 'Log.entryAdded': {
        const e = p.entry ?? {}
        this.pushConsole({ level: levelOf(String(e.level ?? 'info')), text: String(e.text ?? ''), at: this.now(), source: e.url })
        return
      }
      case 'Network.requestWillBeSent': {
        const id = String(p.requestId)
        if (!this.net.has(id)) this.netOrder.push(id)
        this.net.set(id, { id, method: String(p.request?.method ?? 'GET'), url: String(p.request?.url ?? ''), type: String(p.type ?? ''), at: this.now() })
        while (this.netOrder.length > NET_MAX) this.net.delete(this.netOrder.shift()!)
        return
      }
      case 'Network.responseReceived': {
        const e = this.net.get(String(p.requestId))
        if (e) {
          e.status = Number(p.response?.status ?? 0)
          if (p.type) e.type = String(p.type)
        }
        return
      }
      case 'Network.loadingFailed': {
        const e = this.net.get(String(p.requestId))
        if (e) e.failed = String(p.blockedReason ?? p.errorText ?? 'failed')
        return
      }
    }
  }

  private pushConsole(e: ConsoleEntry): void {
    this.consoleLog.push({ ...e, text: e.text.slice(0, 2000) })
    if (this.consoleLog.length > CONSOLE_MAX) this.consoleLog.splice(0, this.consoleLog.length - CONSOLE_MAX)
  }

  private settle(): void {
    this.loading = false
    for (const w of this.loadWaiters.splice(0)) w()
  }

  /** Resolves when the main frame stops loading (or after timeoutMs; never rejects). */
  waitForLoad(timeoutMs = 15_000): Promise<boolean> {
    if (!this.loading) return Promise.resolve(true)
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.loadWaiters = this.loadWaiters.filter((w) => w !== done)
        resolve(false)
      }, timeoutMs)
      const done = (): void => {
        clearTimeout(t)
        resolve(true)
      }
      this.loadWaiters.push(done)
    })
  }

  /** After an input: when it started a navigation, wait for the new page (short grace, then load). */
  async settleAfterAction(graceMs = 250, loadMs = 10_000): Promise<void> {
    const before = this.navStarted
    await sleep(graceMs)
    if (this.loading || this.navStarted !== before) await this.waitForLoad(loadMs)
  }

  async navigate(url: string): Promise<void> {
    await this.init()
    this.loading = true
    this.navStarted = this.now()
    const r = await this.send('Page.navigate', { url })
    if (r?.errorText && r.errorText !== 'net::ERR_ABORTED') {
      this.settle()
      throw new BrowserError(`Could not open ${url}: ${r.errorText}`)
    }
    // same-document navigation: no loader, nothing to wait for
    if (!r?.loaderId) this.settle()
    await this.waitForLoad(20_000)
  }

  async evaluate<T = unknown>(expression: string): Promise<T> {
    await this.init()
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r?.exceptionDetails) throw new BrowserError(String(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? 'Script error').split('\n')[0])
    return r?.result?.value as T
  }

  async snapshot(o: { full?: boolean; title?: string; url?: string } = {}): Promise<{ text: string; interactive: number }> {
    await this.init()
    const ax = (await this.send('Accessibility.getFullAXTree')) as { nodes?: AXNode[] }
    const nodes = ax?.nodes ?? []
    const frames = new Map<number, ChildFrame>()
    for (const n of nodes) {
      const role = String(n.role?.value ?? '')
      if ((role !== 'Iframe' && role !== 'IframePresentational') || typeof n.backendDOMNodeId !== 'number' || frames.size >= 8) continue
      try {
        const d = await this.send('DOM.describeNode', { backendNodeId: n.backendDOMNodeId, depth: 1 })
        const frameId = d?.node?.frameId ?? d?.node?.contentDocument?.frameId
        const url = String(d?.node?.contentDocument?.documentURL ?? d?.node?.attributes?.[d?.node?.attributes?.indexOf?.('src') + 1] ?? '')
        if (!frameId) {
          frames.set(n.backendDOMNodeId, { frameId: '', url, error: 'another site, in its own process' })
          continue
        }
        const sub = (await this.send('Accessibility.getFullAXTree', { frameId })) as { nodes?: AXNode[] }
        frames.set(n.backendDOMNodeId, { frameId, url, nodes: sub?.nodes ?? [] })
      } catch (e) {
        frames.set(n.backendDOMNodeId, { frameId: '', url: '', error: e instanceof Error ? e.message.slice(0, 80) : 'unreadable' })
      }
    }
    const meta = o.title !== undefined && o.url !== undefined ? { title: o.title, url: o.url } : await this.evaluate<{ title: string; url: string }>('({ title: document.title, url: location.href })').catch(() => ({ title: '', url: '' }))
    const out = formatSnapshot({ title: meta.title, url: meta.url, nodes, frames, refs: this.refs, full: o.full })
    return { text: out.text, interactive: out.interactive }
  }

  target(ref: string): RefTarget {
    const t = this.refs.get(ref)
    if (!t) throw new BrowserError(`Unknown ref ${ref}. Take a new browser_snapshot: refs change when the page changes.`)
    return t
  }

  /** Scrolls the element into view and returns its centre in CSS pixels of the viewport. */
  async point(ref: string): Promise<{ x: number; y: number; box: { x: number; y: number; width: number; height: number } }> {
    const t = this.target(ref)
    await this.init()
    await this.send('DOM.scrollIntoViewIfNeeded', { backendNodeId: t.backendNodeId }).catch(() => undefined)
    let quad: number[] | null = null
    try {
      const q = await this.send('DOM.getContentQuads', { backendNodeId: t.backendNodeId })
      quad = ((q?.quads as number[][]) ?? []).find((qq) => area(qq) > 1) ?? null
    } catch {
      /* fall back to the box model */
    }
    if (!quad) {
      try {
        const b = await this.send('DOM.getBoxModel', { backendNodeId: t.backendNodeId })
        quad = (b?.model?.border as number[]) ?? null
      } catch {
        quad = null
      }
    }
    if (!quad || area(quad) <= 1) throw new BrowserError(`${t.role} ${t.name ? `"${t.name}" ` : ''}(${ref}) is not visible on the page.`)
    const xs = [quad[0]!, quad[2]!, quad[4]!, quad[6]!]
    const ys = [quad[1]!, quad[3]!, quad[5]!, quad[7]!]
    const box = { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) }
    return { x: box.x + box.width / 2, y: box.y + box.height / 2, box }
  }

  /**
   * A real mouse click (CDP input) at the element's centre. When the page never saw it (a view that is not on screen
   * has no frame to hit-test against), the element is clicked from inside the page instead: `how` says which.
   */
  async click(ref: string, o: { double?: boolean; button?: 'left' | 'right' | 'middle' } = {}): Promise<'mouse' | 'script'> {
    const { x, y } = await this.point(ref)
    const button = o.button ?? 'left'
    const buttons = button === 'left' ? 1 : button === 'right' ? 2 : 4
    await this.arm(ref, 'mousedown')
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
    const clicks = o.double ? 2 : 1
    for (let i = 1; i <= clicks; i++) {
      await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, buttons, clickCount: i })
      await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, buttons: 0, clickCount: i })
    }
    if (await this.landed(ref)) return 'mouse'
    await this.callOn(
      ref,
      `function (button, double) {
        const b = button === 'right' ? 2 : button === 'middle' ? 1 : 0
        const init = { bubbles: true, cancelable: true, composed: true, view: window, button: b, buttons: 0 }
        if (typeof this.focus === 'function') this.focus()
        for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) this.dispatchEvent(new (t.startsWith('pointer') ? PointerEvent : MouseEvent)(t, init))
        if (b === 2) { this.dispatchEvent(new MouseEvent('contextmenu', init)); return }
        this.click()
        if (double) { this.click(); this.dispatchEvent(new MouseEvent('dblclick', { ...init, detail: 2 })) }
      }`,
      [button, !!o.double]
    )
    return 'script'
  }

  async hover(ref: string): Promise<void> {
    const { x, y } = await this.point(ref)
    await this.arm(ref, 'mousemove')
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
    if (await this.landed(ref)) return
    await this.callOn(ref, `function () { for (const t of ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'mousemove']) this.dispatchEvent(new (t.startsWith('pointer') ? PointerEvent : MouseEvent)(t, { bubbles: !t.endsWith('enter'), composed: true, view: window })) }`)
  }

  /** Counts the next real `type` event in the element's document (see landed). */
  private async arm(ref: string, type: string): Promise<void> {
    await this.callOn(ref, `function (type) { const d = this.ownerDocument; d.__pbHits = 0; d.addEventListener(type, () => { d.__pbHits++ }, { capture: true, once: true }) }`, [type]).catch(() => undefined)
  }
  private async landed(ref: string): Promise<boolean> {
    const n = await this.callOn<number>(ref, 'function () { return Number(this.ownerDocument.__pbHits || 0) }').catch(() => 1)
    return Number(n) > 0
  }

  private async objectId(ref: string): Promise<string> {
    const t = this.target(ref)
    const r = await this.send('DOM.resolveNode', { backendNodeId: t.backendNodeId })
    const id = r?.object?.objectId
    if (!id) throw new BrowserError(`The element ${ref} is gone. Take a new browser_snapshot.`)
    return String(id)
  }

  async callOn<T>(ref: string, fn: string, args: unknown[] = []): Promise<T> {
    const objectId = await this.objectId(ref)
    const r = await this.send('Runtime.callFunctionOn', { objectId, functionDeclaration: fn, arguments: args.map((value) => ({ value })), returnByValue: true, awaitPromise: true })
    if (r?.exceptionDetails) throw new BrowserError(String(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? 'Script error').split('\n')[0])
    return r?.result?.value as T
  }

  async type(ref: string, text: string, o: { append?: boolean; submit?: boolean } = {}): Promise<void> {
    const t = this.target(ref)
    await this.init()
    await this.send('DOM.scrollIntoViewIfNeeded', { backendNodeId: t.backendNodeId }).catch(() => undefined)
    await this.send('DOM.focus', { backendNodeId: t.backendNodeId })
    if (!o.append) {
      await this.callOn(
        ref,
        `function () {
          if (typeof this.select === 'function' && ('value' in this)) { this.select(); return }
          if (this.isContentEditable) { const r = document.createRange(); r.selectNodeContents(this); const s = getSelection(); s.removeAllRanges(); s.addRange(r) }
        }`
      )
      if (!text) await this.key('Backspace')
    } else {
      await this.callOn(
        ref,
        `function () {
          if (typeof this.setSelectionRange === 'function' && typeof this.value === 'string') { try { this.setSelectionRange(this.value.length, this.value.length) } catch {} }
        }`
      )
    }
    if (text) await this.send('Input.insertText', { text })
    if (o.submit) await this.key('Enter')
  }

  async key(chord: string): Promise<void> {
    const k = parseKey(chord)
    await this.init()
    const base = { key: k.key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk, modifiers: k.modifiers }
    await this.send('Input.dispatchKeyEvent', { type: k.text ? 'keyDown' : 'rawKeyDown', ...base, ...(k.text ? { text: k.text, unmodifiedText: k.text } : {}) })
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
  }

  async select(ref: string, values: string[]): Promise<string[]> {
    const picked = await this.callOn<string[] | string>(
      ref,
      `function (values) {
        if (!(this instanceof HTMLSelectElement)) return 'not-select'
        const want = values.map((v) => String(v).trim())
        const picked = []
        for (const o of Array.from(this.options)) {
          const hit = want.includes(o.value) || want.includes(o.label.trim()) || want.includes((o.textContent || '').trim())
          if (hit && (this.multiple || picked.length === 0)) { o.selected = true; picked.push(o.label || o.value) }
          else if (this.multiple) o.selected = false
        }
        if (!picked.length) return picked
        this.dispatchEvent(new Event('input', { bubbles: true }))
        this.dispatchEvent(new Event('change', { bubbles: true }))
        return picked
      }`,
      [values]
    )
    if (picked === 'not-select') throw new BrowserError(`${ref} is not a <select>. Click it and pick the option by its ref instead.`)
    if (!Array.isArray(picked) || !picked.length) throw new BrowserError(`None of ${JSON.stringify(values)} is an option of ${ref}.`)
    return picked
  }

  async scroll(o: { ref?: string; direction?: 'down' | 'up'; pages?: number }): Promise<void> {
    if (o.ref) {
      const t = this.target(o.ref)
      await this.send('DOM.scrollIntoViewIfNeeded', { backendNodeId: t.backendNodeId })
      return
    }
    const pages = Math.max(0.1, Math.min(20, Number(o.pages ?? 1)))
    const dir = o.direction === 'up' ? -1 : 1
    await this.evaluate(`window.scrollBy(0, ${dir} * ${pages} * window.innerHeight * 0.9)`)
  }

  /** Polls until the condition holds (or throws after timeoutMs). */
  async waitFor(o: { for: 'load' | 'selector' | 'text' | 'time'; selector?: string; text?: string; gone?: boolean; seconds?: number }, timeoutMs = 20_000): Promise<string> {
    if (o.for === 'time') {
      const s = Math.max(0, Math.min(30, Number(o.seconds ?? 1)))
      await sleep(s * 1000)
      return `Waited ${s} s.`
    }
    if (o.for === 'load') {
      const ok = await this.waitForLoad(timeoutMs)
      const state = await this.evaluate<string>('document.readyState').catch(() => '')
      return ok ? `Page loaded (${state || 'ready'}).` : `Still loading after ${Math.round(timeoutMs / 1000)} s (${state}).`
    }
    const want = o.for === 'selector' ? o.selector : o.text
    if (!want) throw new BrowserError(o.for === 'selector' ? 'Give a selector.' : 'Give the text to wait for.')
    const expr =
      o.for === 'selector'
        ? `(() => { try { return !!document.querySelector(${JSON.stringify(want)}) } catch (e) { return 'bad' } })()`
        : `(document.body ? document.body.innerText : '').includes(${JSON.stringify(want)})`
    const until = this.now() + Math.max(100, Math.min(timeoutMs, 60_000))
    for (;;) {
      const r = await this.evaluate<boolean | string>(expr).catch(() => false)
      if (r === 'bad') throw new BrowserError(`${want} is not a valid CSS selector.`)
      if (!!r !== !!o.gone) return `${o.gone ? 'Gone' : 'Found'}: ${want}`
      if (this.now() > until) throw new BrowserError(`Waited ${Math.round(timeoutMs / 1000)} s and ${o.gone ? 'it is still there' : 'it did not appear'}: ${want}`)
      await sleep(200)
    }
  }

  consoleText(level: 'all' | 'error' | 'warning' = 'all', limit = 50): string {
    const keep = level === 'error' ? new Set(['error']) : level === 'warning' ? new Set(['error', 'warning']) : null
    const rows = this.consoleLog.filter((e) => !keep || keep.has(e.level)).slice(-Math.max(1, Math.min(200, limit)))
    if (!rows.length) return 'No console messages.'
    return rows.map((e) => `[${e.level}] ${e.text}${e.source ? ` (${e.source.slice(0, 120)})` : ''}`).join('\n')
  }

  networkText(o: { failed?: boolean; filter?: string; limit?: number } = {}): string {
    let rows = this.netOrder.map((id) => this.net.get(id)!).filter(Boolean)
    if (o.failed) rows = rows.filter((r) => r.failed || (r.status ?? 0) >= 400)
    if (o.filter) rows = rows.filter((r) => r.url.includes(o.filter!))
    rows = rows.slice(-Math.max(1, Math.min(200, o.limit ?? 50)))
    if (!rows.length) return 'No requests.'
    return rows.map((r) => `${r.method} ${r.failed ? `FAILED(${r.failed})` : (r.status ?? '…')} ${r.type || '-'} ${r.url.length > 300 ? `${r.url.slice(0, 300)}…` : r.url}`).join('\n')
  }

  /** CSS viewport size, for cropping element screenshots. */
  async viewport(): Promise<{ width: number; height: number }> {
    return this.evaluate<{ width: number; height: number }>('({ width: window.innerWidth, height: window.innerHeight })')
  }
}

function area(q: number[]): number {
  if (q.length < 8) return 0
  let a = 0
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4
    a += q[i * 2]! * q[j * 2 + 1]! - q[j * 2]! * q[i * 2 + 1]!
  }
  return Math.abs(a / 2)
}

function remoteText(o: Any): string {
  if (!o) return ''
  if (o.value !== undefined) return typeof o.value === 'string' ? o.value : JSON.stringify(o.value)
  if (o.unserializableValue) return String(o.unserializableValue)
  return String(o.description ?? o.type ?? '')
}
function levelOf(t: string): string {
  if (t === 'error' || t === 'assert') return 'error'
  if (t === 'warning' || t === 'warn') return 'warning'
  if (t === 'debug' || t === 'verbose') return 'debug'
  return 'info'
}
function cdpMessage(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e)
  return m.replace(/^Error:\s*/, '').split('\n')[0]!.slice(0, 300)
}
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
