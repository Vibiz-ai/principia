#!/usr/bin/env node
/**
 * docs/IOS.md: copies the phone site's art into the iOS app's asset catalog, so the native app draws the same white line
 * art as the web app. Run from the repo root after the art or the busts change:
 *
 *   node scripts/ios-assets.mjs
 *
 * - the four engravings (src/cloud/phone/public/art/*.webp) -> Art<Name>.imageset as PNG (macOS `sips` converts them)
 * - every persona bust (src/cloud/console/busts.gen.ts, generated from the desktop's Bust) -> Bust<Name>.imageset as a
 *   vector SVG (no class, data- or aria- attributes; white strokes on transparent)
 * The fonts (Cinzel, static instances from the variable woff2) are made once by hand; see docs/IOS.md.
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const cat = path.join(root, 'ios/Principia/Resources/Assets.xcassets')
fs.mkdirSync(cat, { recursive: true })
fs.writeFileSync(path.join(cat, 'Contents.json'), JSON.stringify({ info: { author: 'xcode', version: 1 } }, null, 2) + '\n')

const imageset = (name, file, extra = {}) => {
  const dir = path.join(cat, `${name}.imageset`)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'Contents.json'), JSON.stringify({ images: [{ filename: file, idiom: 'universal' }], info: { author: 'xcode', version: 1 }, ...extra }, null, 2) + '\n')
  return dir
}

// engravings
const art = path.join(root, 'src/cloud/phone/public/art')
for (const f of fs.readdirSync(art).filter((x) => x.endsWith('.webp'))) {
  const base = f.replace(/\.webp$/, '')
  const name = `Art${base[0].toUpperCase()}${base.slice(1)}`
  const dir = imageset(name, `${base}.png`)
  execFileSync('sips', ['-s', 'format', 'png', path.join(art, f), '--out', path.join(dir, `${base}.png`)], { stdio: 'ignore' })
}

// busts
const gen = fs.readFileSync(path.join(root, 'src/cloud/console/busts.gen.ts'), 'utf8')
const json = /export const BUSTS[^=]*=\s*(\{[\s\S]*\})\s*;?\s*$/.exec(gen)
if (!json) throw new Error('busts.gen.ts: BUSTS not found')
const busts = JSON.parse(json[1])
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
const keep = (k) => !(k === 'class' || k.startsWith('data-') || k.startsWith('aria-'))
const svg = (n, top = false) => {
  const attrs = Object.entries(n.a ?? {})
    .filter(([k]) => keep(k))
    .map(([k, v]) => ` ${k}="${esc(k === 'stroke-width' ? String(v).replace(/px$/, '') : v)}"`)
    .join('')
  const ns = top ? ' xmlns="http://www.w3.org/2000/svg" width="100" height="100"' : ''
  const kids = (n.c ?? []).map((c) => svg(c)).join('')
  return `<${n.t}${ns}${attrs}>${kids}</${n.t}>`
}
for (const [name, node] of Object.entries(busts)) {
  const id = `Bust${name.replace(/[^A-Za-z0-9]/g, '')}`
  const dir = imageset(id, 'bust.svg', { properties: { 'preserves-vector-representation': true, 'template-rendering-intent': 'original' } })
  fs.writeFileSync(path.join(dir, 'bust.svg'), `<?xml version="1.0" encoding="UTF-8"?>\n${svg(node, true)}\n`)
}
// app icon: the arch (public/icon.svg) at 1024, rendered by Quick Look, flattened (an app icon has no alpha)
{
  const dir = path.join(cat, 'AppIcon.appiconset')
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'ios-icon-'))
  execFileSync('qlmanage', ['-t', '-s', '1024', '-o', tmp, path.join(root, 'src/cloud/phone/public/icon.svg')], { stdio: 'ignore' })
  execFileSync('sips', ['-s', 'format', 'jpeg', path.join(tmp, 'icon.svg.png'), '--out', path.join(tmp, 'icon.jpg')], { stdio: 'ignore' })
  execFileSync('sips', ['-s', 'format', 'png', path.join(tmp, 'icon.jpg'), '--out', path.join(dir, 'icon-1024.png')], { stdio: 'ignore' })
  fs.rmSync(tmp, { recursive: true, force: true })
  fs.writeFileSync(path.join(dir, 'Contents.json'), JSON.stringify({ images: [{ filename: 'icon-1024.png', idiom: 'universal', platform: 'ios', size: '1024x1024' }], info: { author: 'xcode', version: 1 } }, null, 2) + '\n')
}
console.log(`ios assets: ${fs.readdirSync(art).length} engravings, ${Object.keys(busts).length} busts`)
