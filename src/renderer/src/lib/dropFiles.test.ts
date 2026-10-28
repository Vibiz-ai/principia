import { describe, expect, it, vi } from 'vitest'
import { dropMentions, mentionOf, pendingAttachments, withMentions, type DropIO } from './dropFiles'

const file = (name: string, type: string, path = ''): File & { path: string } => Object.assign(new File([new Uint8Array([1, 2, 3])], name, { type }), { path })
const io = (over: Partial<DropIO> = {}): DropIO => ({ pathFor: (f) => (f as File & { path: string }).path, saveImage: vi.fn(async () => '/data/pastes/shot.png'), ...over })

describe('dropped files in New conversation (PR-11)', () => {
  it('writes a path as an @mention, quoted when it has spaces', () => {
    expect(mentionOf('/Users/m/logo.png')).toBe('@/Users/m/logo.png')
    expect(mentionOf('/Users/m/Screen Shot 1.png')).toBe('@"/Users/m/Screen Shot 1.png"')
  })
  it('adds mentions after what you typed, with one space between and one after', () => {
    expect(withMentions('', ['@/a.png'])).toBe('@/a.png ')
    expect(withMentions('look at this', ['@/a.png', '@/b.jpg'])).toBe('look at this @/a.png @/b.jpg ')
    expect(withMentions('look at this ', ['@/a.png'])).toBe('look at this @/a.png ')
    expect(withMentions('unchanged', [])).toBe('unchanged')
  })
  it('a dropped image from Finder keeps its own path (nothing is copied)', async () => {
    const save = vi.fn(async () => 'never')
    const r = await dropMentions([file('logo.png', 'image/png', '/Users/m/logo.png')], io({ saveImage: save }))
    expect(r).toEqual({ mentions: ['@/Users/m/logo.png'], skipped: [] })
    expect(save).not.toHaveBeenCalled()
  })
  it('a pasted screenshot (no file behind it) is saved first, then mentioned', async () => {
    const save = vi.fn(async () => '/data/pastes/shot.png')
    const r = await dropMentions([file('image.png', 'image/png')], io({ saveImage: save }))
    expect(r.mentions).toEqual(['@/data/pastes/shot.png'])
    expect(save).toHaveBeenCalledWith(expect.any(Uint8Array), 'image/png')
  })
  it('skips, by name, what has no path and cannot be saved (and a failed save)', async () => {
    const r = await dropMentions([file('notes.txt', 'text/plain'), file('pic.heic', 'image/heic'), file('a.png', 'image/png')], io({ saveImage: async () => Promise.reject(new Error('disk full')) }))
    expect(r).toEqual({ mentions: [], skipped: ['notes.txt', 'pic.heic', 'a.png'] })
  })
  it('any file from Finder goes in by its path, images or not', async () => {
    const r = await dropMentions([file('brief.pdf', 'application/pdf', '/Users/m/brief.pdf'), file('a.webp', 'image/webp', '/tmp/a.webp')], io())
    expect(r.mentions).toEqual(['@/Users/m/brief.pdf', '@/tmp/a.webp'])
  })
})

describe('Send waits for images still being saved (PR-16, Codex on #79)', () => {
  const later = <T,>(): { p: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } => {
    let resolve!: (v: T) => void
    let reject!: (e: unknown) => void
    const p = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)))
    return { p, resolve, reject }
  }
  it('a message sent right after a paste carries the screenshot, and the box is not written to after', async () => {
    // the composer: text in a box, a paste that saves the image, a Send that waits then clears the box
    let box = 'look at this'
    const sent: string[] = []
    const saving = later<string>()
    const attaching = pendingAttachments()
    void attaching.track(dropMentions([file('image.png', 'image/png')], io({ saveImage: () => saving.p })).then((r) => void (box = withMentions(box, r.mentions))))
    const send = (async () => {
      await attaching.settled()
      sent.push(box.trim())
      box = ''
    })()
    await Promise.resolve()
    expect(sent).toEqual([]) // Enter was pressed while the image was saving: nothing went out yet
    saving.resolve('/data/pastes/shot.png')
    await send
    expect(sent).toEqual(['look at this @/data/pastes/shot.png'])
    expect(box).toBe('')
  })
  it('nothing pending: settled is immediate', async () => {
    const a = pendingAttachments()
    expect(a.size).toBe(0)
    await expect(a.settled()).resolves.toBeUndefined()
  })
  it('a failed save does not hold Send forever, and is forgotten', async () => {
    const a = pendingAttachments()
    const s = later<void>()
    const tracked = a.track(s.p).catch(() => 'failed')
    expect(a.size).toBe(1)
    s.reject(new Error('disk full'))
    await a.settled()
    expect(a.size).toBe(0)
    expect(await tracked).toBe('failed')
  })
  it('waits for every attachment, including one added while waiting', async () => {
    const a = pendingAttachments()
    const one = later<void>()
    const two = later<void>()
    let done = false
    void a.track(one.p)
    const waiting = a.settled().then(() => (done = true))
    one.resolve()
    void a.track(two.p)
    await Promise.resolve()
    await Promise.resolve()
    expect(done).toBe(false)
    two.resolve()
    await waiting
    expect(done).toBe(true)
  })
})
