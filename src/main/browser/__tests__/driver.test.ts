import { describe, expect, it } from 'vitest'
import { BrowserError, CdpDriver, parseKey } from '../driver'
import { FakeCdp } from './fakeCdp'

const AX = {
  nodes: [
    { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'Form' }, childIds: ['2', '3', '4'] },
    { nodeId: '2', parentId: '1', role: { value: 'textbox' }, name: { value: 'Name' }, backendDOMNodeId: 11 },
    { nodeId: '3', parentId: '1', role: { value: 'button' }, name: { value: 'Save' }, backendDOMNodeId: 12 },
    { nodeId: '4', parentId: '1', role: { value: 'combobox' }, name: { value: 'Plan' }, backendDOMNodeId: 13 }
  ]
}

function setup(hits = 1): { cdp: FakeCdp; d: CdpDriver } {
  const cdp = new FakeCdp()
  cdp.on('Accessibility.getFullAXTree', () => AX)
  cdp.on('Runtime.evaluate', () => ({ result: { value: { title: 'Form', url: 'http://local/' } } }))
  cdp.on('DOM.getContentQuads', () => ({ quads: [[10, 20, 110, 20, 110, 60, 10, 60]] }))
  cdp.on('DOM.resolveNode', (p) => ({ object: { objectId: `obj-${p.backendNodeId}` } }))
  // the page saw `hits` real mouse events (0 = the view had no frame to hit-test against)
  cdp.on('Runtime.callFunctionOn', (p) => ({ result: { value: String(p.functionDeclaration).includes('__pbHits ||') ? hits : ['Pro'] } }))
  return { cdp, d: new CdpDriver(cdp, { timeoutMs: 200 }) }
}
const refOf = (text: string, name: string): string => new RegExp(`"${name}" \\[ref=(e\\d+)\\]`).exec(text)![1]!

describe('CdpDriver', () => {
  it('enables the domains once and reads the main frame', async () => {
    const { cdp, d } = setup()
    await d.init()
    await d.init()
    expect(cdp.methods().filter((m) => m === 'Page.enable')).toHaveLength(1)
    expect(cdp.methods()).toEqual(expect.arrayContaining(['Page.enable', 'Runtime.enable', 'Network.enable', 'DOM.enable', 'Page.getFrameTree']))
  })

  it('clicks by ref: scroll into view, centre of the content quad, press and release', async () => {
    const { cdp, d } = setup()
    const s = await d.snapshot()
    await d.click(refOf(s.text, 'Save'))
    const mouse = cdp.calls.filter((c) => c.method === 'Input.dispatchMouseEvent').map((c) => c.params)
    expect(cdp.calls.find((c) => c.method === 'DOM.scrollIntoViewIfNeeded')?.params).toEqual({ backendNodeId: 12 })
    expect(mouse.map((m) => m.type)).toEqual(['mouseMoved', 'mousePressed', 'mouseReleased'])
    expect(mouse[1]).toMatchObject({ x: 60, y: 40, button: 'left', clickCount: 1 })
  })

  it('clicks from inside the page when the real click never reached it', async () => {
    const { cdp, d } = setup(0)
    const s = await d.snapshot()
    expect(await d.click(refOf(s.text, 'Save'))).toBe('script')
    const fns = cdp.calls.filter((c) => c.method === 'Runtime.callFunctionOn').map((c) => String(c.params.functionDeclaration))
    expect(fns.some((f) => f.includes('this.click()'))).toBe(true)
    const { d: d2 } = setup(1)
    const s2 = await d2.snapshot()
    expect(await d2.click(refOf(s2.text, 'Save'))).toBe('mouse')
  })

  it('types by ref: focus, select what is there, insert the text, Enter when asked', async () => {
    const { cdp, d } = setup()
    const s = await d.snapshot()
    await d.type(refOf(s.text, 'Name'), 'Ana', { submit: true })
    const m = cdp.methods()
    expect(cdp.calls.find((c) => c.method === 'DOM.focus')?.params).toEqual({ backendNodeId: 11 })
    expect(m.indexOf('Runtime.callFunctionOn')).toBeLessThan(m.indexOf('Input.insertText'))
    expect(cdp.calls.find((c) => c.method === 'Input.insertText')?.params).toEqual({ text: 'Ana' })
    const keys = cdp.calls.filter((c) => c.method === 'Input.dispatchKeyEvent').map((c) => c.params)
    expect(keys[0]).toMatchObject({ type: 'keyDown', key: 'Enter', text: '\r' })
  })

  it('selects options through the element itself', async () => {
    const { cdp, d } = setup()
    const s = await d.snapshot()
    expect(await d.select(refOf(s.text, 'Plan'), ['Pro'])).toEqual(['Pro'])
    expect(cdp.calls.filter((c) => c.method === 'Runtime.callFunctionOn').pop()?.params).toMatchObject({ objectId: 'obj-13', arguments: [{ value: ['Pro'] }] })
  })

  it('refuses an unknown or stale ref with a plain message', async () => {
    const { cdp, d } = setup()
    const s = await d.snapshot()
    const ref = refOf(s.text, 'Save')
    await expect(d.click('e999')).rejects.toThrow(/Unknown ref e999/)
    // the main frame navigated: old refs point nowhere
    cdp.emit('Page.frameNavigated', { frame: { id: 'MAIN' } })
    await expect(d.click(ref)).rejects.toThrow(BrowserError)
    // a sub-frame navigating keeps them
    const s2 = await d.snapshot()
    cdp.emit('Page.frameNavigated', { frame: { id: 'SUB', parentId: 'MAIN' } })
    expect(() => d.target(refOf(s2.text, 'Save'))).not.toThrow()
  })

  it('times out a command that hangs instead of hanging the agent', async () => {
    const { cdp, d } = setup()
    cdp.on('Page.navigate', () => new Promise(() => undefined))
    await expect(d.navigate('https://example.com/')).rejects.toThrow(/did not answer/)
  })

  it('waits for the page load after navigating', async () => {
    const { cdp, d } = setup()
    cdp.on('Page.navigate', () => {
      setTimeout(() => cdp.emit('Page.loadEventFired'), 20)
      return { frameId: 'MAIN', loaderId: 'L1' }
    })
    const t0 = Date.now()
    await d.navigate('https://example.com/')
    expect(Date.now() - t0).toBeGreaterThanOrEqual(15)
    cdp.on('Page.navigate', () => ({ errorText: 'net::ERR_NAME_NOT_RESOLVED' }))
    await expect(d.navigate('https://nope.invalid/')).rejects.toThrow(/ERR_NAME_NOT_RESOLVED/)
  })

  it('accepts alerts and dismisses confirms so the page never blocks', async () => {
    const { cdp, d } = setup()
    await d.init()
    cdp.emit('Page.javascriptDialogOpening', { type: 'alert', message: 'Hi' })
    cdp.emit('Page.javascriptDialogOpening', { type: 'confirm', message: 'Delete?' })
    await new Promise((r) => setTimeout(r, 0))
    const h = cdp.calls.filter((c) => c.method === 'Page.handleJavaScriptDialog').map((c) => c.params.accept)
    expect(h).toEqual([true, false])
    expect(d.consoleText()).toContain('[confirm dialog dismissed] Delete?')
  })

  it('keeps console messages and network requests', async () => {
    const { cdp, d } = setup()
    await d.init()
    cdp.emit('Runtime.consoleAPICalled', { type: 'error', args: [{ value: 'boom' }, { value: 2 }] })
    cdp.emit('Runtime.consoleAPICalled', { type: 'log', args: [{ value: 'hello' }] })
    cdp.emit('Network.requestWillBeSent', { requestId: 'r1', request: { method: 'GET', url: 'https://a.test/x.js' }, type: 'Script' })
    cdp.emit('Network.responseReceived', { requestId: 'r1', response: { status: 404 } })
    cdp.emit('Network.requestWillBeSent', { requestId: 'r2', request: { method: 'POST', url: 'https://a.test/api' }, type: 'Fetch' })
    cdp.emit('Network.responseReceived', { requestId: 'r2', response: { status: 200 } })
    expect(d.consoleText('error')).toBe('[error] boom 2')
    expect(d.consoleText()).toContain('[info] hello')
    expect(d.networkText({ failed: true })).toBe('GET 404 Script https://a.test/x.js')
    expect(d.networkText({ filter: '/api' })).toBe('POST 200 Fetch https://a.test/api')
  })
})

describe('parseKey', () => {
  it('maps names, letters and chords', () => {
    expect(parseKey('Enter')).toMatchObject({ key: 'Enter', vk: 13, text: '\r', modifiers: 0 })
    expect(parseKey('Control+a')).toMatchObject({ key: 'a', code: 'KeyA', modifiers: 2 })
    expect(parseKey('Control+a').text).toBeUndefined()
    expect(parseKey('Shift+Tab')).toMatchObject({ key: 'Tab', modifiers: 8 })
    expect(parseKey('x')).toMatchObject({ key: 'x', text: 'x' })
    expect(() => parseKey('Hyper+x')).toThrow(/Unknown modifier/)
    expect(() => parseKey('Banana')).toThrow(/Unknown key/)
  })
})
