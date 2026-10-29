import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { mentionInsert } from './fieldDrop'

describe('mentionInsert', () => {
  it('adds the mention at the end with a space before and after', () => {
    expect(mentionInsert('look at', 7, 7, ['@/a.png'])).toEqual({ insert: ' @/a.png ', caret: 16 })
  })
  it('no space before in an empty box or after a space', () => {
    expect(mentionInsert('', 0, 0, ['@/a.png'])).toEqual({ insert: '@/a.png ', caret: 8 })
    expect(mentionInsert('see ', 4, 4, ['@/a.png', '@/b.png'])).toEqual({ insert: '@/a.png @/b.png ', caret: 20 })
  })
  it('in the middle, keeps the text after and does not double its space', () => {
    expect(mentionInsert('see this', 3, 3, ['@/a.png'])).toEqual({ insert: ' @/a.png', caret: 11 })
  })
  it('replaces the selection', () => {
    const v = 'see HERE now'
    const { insert } = mentionInsert(v, 4, 8, ['@/a.png'])
    expect(v.slice(0, 4) + insert + v.slice(8)).toBe('see @/a.png now')
  })
})

// a tiny DOM: just what wireFieldDrops touches (the test environment is node)
class FakeNode {
  parent: FakeNode | null = null
  contains(n: unknown): boolean {
    for (let c = n as FakeNode | null; c; c = c.parent) if (c === this) return true
    return false
  }
}
class FakeElement extends FakeNode {
  tag = 'div'
  attrs: Record<string, string> = {}
  cls = new Set<string>()
  classList = { add: (c: string) => this.cls.add(c), remove: (c: string) => this.cls.delete(c) }
  getAttribute(k: string): string | null {
    return this.attrs[k] ?? null
  }
  closest(sel: string): FakeElement | null {
    const want = sel.split(',').map((s) => s.trim())
    if (want.some((w) => w === this.tag || (w.startsWith('.') && this.cls.has(w.slice(1))) || (w.startsWith('[') && w.slice(1, -1) in this.attrs))) return this
    return this.parent instanceof FakeElement ? this.parent.closest(sel) : null
  }
  kids: FakeElement[] = []
  add<T extends FakeElement>(c: T): T {
    c.parent = this
    this.kids.push(c)
    return c
  }
  querySelector(sel: string): FakeElement | null {
    for (const k of this.kids) {
      if (k.closest(sel) === k) return k
      const hit = k.querySelector(sel)
      if (hit) return hit
    }
    return null
  }
}
class FakeField extends FakeElement {
  declare value: string
  _value = ''
  selectionStart = 0
  selectionEnd = 0
  disabled = false
  readOnly = false
  isConnected = true
  ownerDocument = { execCommand: () => false }
  inputs = 0
  focus(): void {
    doc.activeElement = this
  }
  setSelectionRange(a: number, b: number): void {
    this.selectionStart = a
    this.selectionEnd = b
  }
  dispatchEvent(e: { type: string }): boolean {
    if (e.type === 'input') this.inputs++
    return true
  }
}
class FakeTextArea extends FakeField {
  tag = 'textarea'
}
class FakeInput extends FakeField {
  tag = 'input'
}
// as in the DOM, `value` is the element class's own accessor (the one React tracks)
for (const C of [FakeTextArea, FakeInput]) Object.defineProperty(C.prototype, 'value', { get(this: FakeField) { return this._value }, set(this: FakeField, v: string) { this._value = v }, configurable: true })

const listeners = new Map<string, (e: unknown) => void>()
const doc = { activeElement: null as unknown, addEventListener: (t: string, f: (e: unknown) => void) => void listeners.set(t, f), removeEventListener: (t: string) => void listeners.delete(t) }

beforeAll(() => {
  Object.assign(globalThis, { Node: FakeNode, Element: FakeElement, HTMLTextAreaElement: FakeTextArea, HTMLInputElement: FakeInput, Event: class { constructor(public type: string) {} } })
})

const file = (name: string, type: string, path = ''): File => ({ name, type, path, arrayBuffer: async () => new ArrayBuffer(2) }) as unknown as File
const ev = (target: unknown, files: File[], over: Record<string, unknown> = {}) => ({
  target,
  defaultPrevented: false,
  preventDefault: vi.fn(function (this: { defaultPrevented: boolean }) { this.defaultPrevented = true }),
  dataTransfer: { types: files.length ? ['Files'] : ['text/plain'], files, dropEffect: 'none' },
  ...over
})

async function wire() {
  const { wireFieldDrops } = await import('./fieldDrop')
  const skipped = vi.fn()
  const saveImage = vi.fn(async () => '/data/pastes/shot.png')
  const off = wireFieldDrops(doc as unknown as Document, { pathFor: (f) => (f as File & { path: string }).path, saveImage, skipped })
  return { off, skipped, saveImage }
}
const flush = () => new Promise((r) => setTimeout(r, 0))

describe('wireFieldDrops', () => {
  let off: (() => void) | null = null
  afterEach(() => off?.())

  it('an image dropped on a text box becomes an @path mention React sees', async () => {
    const w = await wire()
    off = w.off
    const box = new FakeTextArea()
    box._value = 'fix the logo'
    const over = ev(box, [file('logo.png', 'image/png', '/Users/m/logo.png')])
    listeners.get('dragover')!(over)
    expect(over.preventDefault).toHaveBeenCalled()
    expect(box.cls.has('field-drop-over')).toBe(true)
    const drop = ev(box, [file('logo.png', 'image/png', '/Users/m/logo.png')])
    listeners.get('drop')!(drop)
    expect(drop.preventDefault).toHaveBeenCalled()
    expect(box.cls.has('field-drop-over')).toBe(false)
    await flush()
    expect(box.value).toBe('fix the logo @/Users/m/logo.png ')
    expect(box.inputs).toBe(1)
  })

  it('a screenshot pasted into a one-line input is saved and mentioned', async () => {
    const w = await wire()
    off = w.off
    const input = new FakeInput()
    const paste = { target: input, defaultPrevented: false, preventDefault: vi.fn(), clipboardData: { files: [file('image.png', 'image/png')], getData: () => '' } }
    listeners.get('paste')!(paste)
    await flush()
    expect(w.saveImage).toHaveBeenCalled()
    expect(input.value).toBe('@/data/pastes/shot.png ')
  })

  it('leaves alone what a box handled itself, text pastes, passwords, read-only boxes and the terminal', async () => {
    const w = await wire()
    off = w.off
    const handled = new FakeTextArea()
    listeners.get('drop')!(ev(handled, [file('a.png', 'image/png', '/a.png')], { defaultPrevented: true }))
    const pw = new FakeInput()
    pw.attrs.type = 'password'
    const pwDrop = ev(pw, [file('a.png', 'image/png', '/a.png')])
    listeners.get('drop')!(pwDrop)
    const ro = new FakeTextArea()
    ro.readOnly = true
    listeners.get('drop')!(ev(ro, [file('a.png', 'image/png', '/a.png')]))
    const term = new FakeElement()
    term.cls.add('xterm')
    const helper = new FakeTextArea()
    helper.parent = term
    listeners.get('drop')!(ev(helper, [file('a.png', 'image/png', '/a.png')]))
    const withText = new FakeTextArea()
    listeners.get('paste')!({ target: withText, defaultPrevented: false, preventDefault: vi.fn(), clipboardData: { files: [file('image.png', 'image/png')], getData: () => 'hello' } })
    await flush()
    expect([handled.value, pw.value, ro.value, helper.value, withText.value]).toEqual(['', '', '', '', ''])
    expect(pwDrop.preventDefault).not.toHaveBeenCalled()
  })

  it('a file it cannot use is named back', async () => {
    const w = await wire()
    off = w.off
    const box = new FakeTextArea()
    listeners.get('drop')!(ev(box, [file('pic.heic', 'image/heic')]))
    await flush()
    expect(w.skipped).toHaveBeenCalledWith(['pic.heic'])
    expect(box.value).toBe('')
  })

  it('a file dropped anywhere on a Forum conversation lands in its message box', async () => {
    const w = await wire()
    off = w.off
    const zone = new FakeElement()
    zone.attrs['data-field-drop-zone'] = ''
    const message = zone.add(new FakeElement())
    const composer = zone.add(new FakeElement())
    const box = composer.add(new FakeTextArea())
    box.attrs['data-field-drop-target'] = ''
    box._value = 'look'
    const over = ev(message, [file('shot.png', 'image/png', '/Users/m/shot.png')])
    listeners.get('dragover')!(over)
    expect(over.preventDefault).toHaveBeenCalled()
    expect(box.cls.has('field-drop-over')).toBe(true)
    // moving between rows inside the conversation keeps the box lit
    listeners.get('dragleave')!({ target: message, relatedTarget: composer })
    expect(box.cls.has('field-drop-over')).toBe(true)
    listeners.get('dragleave')!({ target: message, relatedTarget: new FakeElement() })
    expect(box.cls.has('field-drop-over')).toBe(false)
    listeners.get('drop')!(ev(message, [file('shot.png', 'image/png', '/Users/m/shot.png')]))
    await flush()
    expect(box.value).toBe('look @/Users/m/shot.png ')
  })

  it('outside a drop zone, or on another field inside one, it does not redirect', async () => {
    const w = await wire()
    off = w.off
    const loose = new FakeElement()
    const looseDrop = ev(loose, [file('a.png', 'image/png', '/a.png')])
    listeners.get('drop')!(looseDrop)
    expect(looseDrop.preventDefault).not.toHaveBeenCalled()
    const zone = new FakeElement()
    zone.attrs['data-field-drop-zone'] = ''
    const box = zone.add(new FakeTextArea())
    box.attrs['data-field-drop-target'] = ''
    const pw = zone.add(new FakeInput())
    pw.attrs.type = 'password'
    listeners.get('drop')!(ev(pw, [file('a.png', 'image/png', '/a.png')]))
    const archived = new FakeElement()
    archived.attrs['data-field-drop-zone'] = ''
    const off2 = archived.add(new FakeTextArea())
    off2.attrs['data-field-drop-target'] = ''
    off2.disabled = true
    listeners.get('drop')!(ev(archived, [file('a.png', 'image/png', '/a.png')]))
    await flush()
    expect([box.value, pw.value, off2.value]).toEqual(['', '', ''])
  })
})
