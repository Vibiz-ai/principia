import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AUTO_SCORE, detectLogos, imageSize, nameKind, scoreCandidate } from './logoDetect'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})
function repo(name: string, files: Record<string, string | Buffer>): { name: string; path: string } {
  const root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'logo-detect-')), name)
  dirs.push(path.dirname(root))
  for (const [rel, body] of Object.entries(files)) {
    const p = path.join(root, rel)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, body)
  }
  return { name, path: root }
}
/** a PNG header (IHDR) of w × h, padded so it is not "empty" */
function png(w: number, h: number, salt = 0): Buffer {
  const b = Buffer.alloc(400)
  b.writeUInt32BE(0x89504e47, 0)
  b.writeUInt32BE(0x0d0a1a0a, 4)
  b.writeUInt32BE(13, 8)
  b.write('IHDR', 12, 'ascii')
  b.writeUInt32BE(w, 16)
  b.writeUInt32BE(h, 20)
  b[399] = salt
  return b
}
const svg = (w: number, h: number, body = '') => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><circle cx="1" cy="1" r="1"/>${body}${' '.repeat(200)}</svg>`
function ico(size: number): Buffer {
  const b = Buffer.alloc(300)
  b.writeUInt16LE(0, 0)
  b.writeUInt16LE(1, 2)
  b.writeUInt16LE(1, 4)
  b[6] = size
  b[7] = size
  return b
}

describe('imageSize', () => {
  it('reads png, svg (viewBox, then width/height), ico, gif, webp and jpeg headers', () => {
    expect(imageSize(png(180, 120), 'png')).toEqual({ width: 180, height: 120 })
    expect(imageSize(Buffer.from('<svg viewBox="0 0 626 207" width="10">'), 'svg')).toEqual({ width: 626, height: 207 })
    expect(imageSize(Buffer.from('<?xml version="1.0"?><svg width="48px" height="40">'), 'svg')).toEqual({ width: 48, height: 40 })
    expect(imageSize(ico(32), 'ico')).toEqual({ width: 32, height: 32 })
    expect(imageSize(ico(0), 'ico')).toEqual({ width: 256, height: 256 })
    const gif = Buffer.alloc(16)
    gif.write('GIF89a', 0, 'ascii')
    gif.writeUInt16LE(64, 6)
    gif.writeUInt16LE(32, 8)
    expect(imageSize(gif, 'gif')).toEqual({ width: 64, height: 32 })
    const webp = Buffer.alloc(32)
    webp.write('RIFF', 0, 'ascii')
    webp.write('WEBPVP8X', 8, 'ascii')
    webp.writeUIntLE(511, 24, 3)
    webp.writeUIntLE(255, 27, 3)
    expect(imageSize(webp, 'webp')).toEqual({ width: 512, height: 256 })
    const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0, 0, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x60, 0x00, 0x80, 0x03, 0, 0, 0, 0, 0, 0, 0])
    expect(imageSize(jpg, 'jpg')).toEqual({ width: 128, height: 96 })
    expect(imageSize(Buffer.from('nope'), 'png')).toBeNull()
  })
})

describe('nameKind', () => {
  it('knows logos, brand names, app icons and favicons, and drops social cards and other companies’ logos', () => {
    expect(nameKind('public/logo.svg')).toBe('logo')
    expect(nameKind('public/images/acme-logo-white.png')).toBe('logo')
    expect(nameKind('assets/brand/mark.svg')).toBe('logo')
    expect(nameKind('public/acme.svg', ['acme'])).toBe('brand')
    expect(nameKind('app/icon.png')).toBe('icon')
    expect(nameKind('public/apple-touch-icon.png')).toBe('icon')
    expect(nameKind('public/android-chrome-512x512.png')).toBe('icon')
    expect(nameKind('app/favicon.ico')).toBe('favicon')
    expect(nameKind('public/og-image.png')).toBeNull()
    expect(nameKind('public/logo-banner.png')).toBeNull()
    expect(nameKind('public/hero.png')).toBeNull()
    expect(nameKind('public/team/brando.png')).toBeNull()
    expect(nameKind('src/components/Arrow.svg')).toBeNull()
    // an integrations folder holds other companies' logos; only the company's own name counts there
    expect(nameKind('public/images/logos/stripe.png', ['acme'])).toBeNull()
    expect(nameKind('public/partners/stripe-logo.png', ['acme'])).toBeNull()
    expect(nameKind('public/logos/acme-logo.svg', ['acme'])).toBe('logo')
  })
})

describe('scoreCandidate', () => {
  const base = { hints: [] as ('manifest' | 'readme')[], bytes: 4000 }
  const score = (rel: string, ext: 'svg' | 'png' | 'ico', w: number | null, h: number | null, brand: string[] = []) => scoreCandidate({ ...base, rel, ext, width: w, height: h }, brand)
  it('ranks svg logos over big png logos over app icons over tiny favicons', () => {
    const order = [
      score('public/logo.svg', 'svg', 400, 400),
      score('public/logo.png', 'png', 600, 600),
      score('public/apple-touch-icon.png', 'png', 180, 180),
      score('public/favicon-32x32.png', 'png', 32, 32),
      score('app/favicon.ico', 'ico', 32, 32)
    ]
    expect([...order].sort((a, b) => b - a)).toEqual(order)
  })
  it('prefers square marks over wide wordmarks, and the brand name in a logo file', () => {
    expect(score('public/logo.svg', 'svg', 400, 400)).toBeGreaterThan(score('public/logo-wordmark.svg', 'svg', 626, 207))
    expect(score('public/images/logo-acme.svg', 'svg', 400, 400, ['acme'])).toBeGreaterThan(score('public/images/logo.svg', 'svg', 400, 400, ['acme']))
  })
  it('is confident for a real logo or app icon, not for a 32 px favicon.ico', () => {
    expect(score('public/logo.svg', 'svg', 40, 40)).toBeGreaterThanOrEqual(AUTO_SCORE)
    expect(score('app/icon.png', 'png', 512, 512)).toBeGreaterThanOrEqual(AUTO_SCORE)
    expect(score('public/apple-touch-icon.png', 'png', 180, 180)).toBeGreaterThanOrEqual(AUTO_SCORE)
    expect(score('app/favicon.ico', 'ico', 32, 32)).toBeLessThan(AUTO_SCORE)
  })
  it('a web manifest icon gets a boost', () => {
    expect(scoreCandidate({ ...base, rel: 'public/icon-192.png', ext: 'png', width: 192, height: 192, hints: ['manifest'] })).toBeGreaterThan(score('public/icon-192.png', 'png', 192, 192))
  })
})

describe('detectLogos', () => {
  it('finds the logo in a Next.js-style repo and ranks it first, skipping node_modules and build output', () => {
    const r = repo('acme-web', {
      'package.json': '{}',
      'app/favicon.ico': ico(32),
      'app/layout.tsx': 'export default 1',
      'public/apple-touch-icon.png': png(180, 180, 1),
      'public/images/logo-acme.svg': svg(400, 400),
      'public/images/acme-wordmark.svg': svg(626, 207, '<path d="M0 0"/>'),
      'public/images/logos/stripe.png': png(1000, 1000, 2),
      'public/og-image.png': png(1200, 630, 3),
      'node_modules/some-lib/logo.svg': svg(100, 100, '<rect/>'),
      '.next/static/media/logo.svg': svg(100, 100, '<g/>'),
      'dist/logo.png': png(512, 512, 4)
    })
    const found = detectLogos([r], { brandNames: ['Acme'] })
    expect(found[0]!.rel).toBe('public/images/logo-acme.svg')
    expect(found[0]!.confident).toBe(true)
    const rels = found.map((f) => f.rel)
    expect(rels).toContain('public/apple-touch-icon.png')
    expect(rels).toContain('app/favicon.ico')
    expect(rels.some((p) => p.includes('node_modules') || p.startsWith('.next') || p.startsWith('dist/'))).toBe(false)
    expect(rels).not.toContain('public/og-image.png')
    expect(rels).not.toContain('public/images/logos/stripe.png')
  })
  it('reads the icons a site.webmanifest lists and the README’s first local image', () => {
    const r = repo('shop', {
      'public/site.webmanifest': JSON.stringify({ icons: [{ src: '/pwa-512.png', sizes: '512x512' }, { src: 'https://cdn.example.com/x.png' }] }),
      'public/pwa-512.png': png(512, 512, 5),
      'docs/mark.png': png(256, 256, 6),
      'README.md': '# Shop\n\n<img src="docs/mark.png" width="80">\n\n![remote](https://example.com/a.png)'
    })
    const found = detectLogos([r])
    expect(found.find((f) => f.rel === 'public/pwa-512.png')?.hints).toEqual(['manifest'])
    expect(found.find((f) => f.rel === 'docs/mark.png')?.hints).toEqual(['readme'])
  })
  it('collapses the same bytes in two places and only reports a favicon when nothing better exists', () => {
    const same = svg(64, 64, '<path d="M1 1"/>')
    const r = repo('dup', { 'public/logo.svg': same, 'src/assets/logo.svg': same })
    expect(detectLogos([r]).map((f) => f.rel)).toEqual(['public/logo.svg'])
    const only = repo('tiny', { 'app/favicon.ico': ico(16) })
    const f = detectLogos([only])
    expect(f).toHaveLength(1)
    expect(f[0]!.confident).toBe(false)
  })
  it('takes the electron-builder app icon in build/ even though build output is skipped', () => {
    const r = repo('desk', { 'build/icon.png': png(1024, 1024, 7), 'build/other/logo.png': png(512, 512, 8) })
    expect(detectLogos([r]).map((f) => f.rel)).toEqual(['build/icon.png'])
  })
  it('spans several repositories, skips missing ones and stays within the entry budget', () => {
    const a = repo('alpha', { 'public/favicon.svg': svg(32, 32) })
    const b = repo('beta', { 'assets/logo.png': png(512, 512, 9) })
    const found = detectLogos([a, { name: 'gone', path: '/Users/me/nowhere/gone' }, b])
    expect(found.map((f) => `${f.repo}/${f.rel}`)).toEqual(['beta/assets/logo.png', 'alpha/public/favicon.svg'])
    const big = repo('big', Object.fromEntries([...Array.from({ length: 50 }, (_, i) => [`aaa/f${i}.txt`, 'x']), ['zzz/logo.svg', svg(10, 10)]]))
    expect(detectLogos([big], { maxEntries: 20 })).toEqual([])
  })
})
