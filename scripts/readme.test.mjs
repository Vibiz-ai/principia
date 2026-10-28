import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// The README is the first page most people see: its local links must resolve and its download must be the current one.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const stripHtmlComments = input => {
  let previous
  let current = input
  do {
    previous = current
    current = current.replace(/<!--[\s\S]*?-->/g, '')
  } while (current !== previous)
  return current
}
const readme = stripHtmlComments(readFileSync(path.join(root, 'README.md'), 'utf8'))
const slug = heading => heading.trim().toLowerCase().replace(/[^\w\- ]/g, '').replace(/ /g, '-')
const anchors = new Set([...readme.matchAll(/^#{1,6} (.+)$/gm)].map(m => slug(m[1])))
const targets = [
  ...[...readme.matchAll(/\]\(([^)\s]+)\)/g)].map(m => m[1]),
  ...[...readme.matchAll(/(?:src|srcset)="([^"]+)"/g)].map(m => m[1])
]

test('every local link and image in the README points at a file in the repository', () => {
  const missing = targets
    .filter(t => !/^[a-z]+:/i.test(t) && !t.startsWith('#'))
    .map(t => t.split('#')[0])
    .filter(t => !existsSync(path.join(root, t)))
  assert.deepEqual(missing, [])
})

test('in-page links land on a heading', () => {
  const broken = targets.filter(t => t.startsWith('#')).filter(t => !anchors.has(t.slice(1)))
  assert.deepEqual(broken, [])
})

test('the website links to the quick start by its anchor', () => {
  const site = readFileSync(path.join(root, 'website/src/main.tsx'), 'utf8')
  for (const [, anchor] of site.matchAll(/principia#([\w-]+)/g)) assert.ok(anchors.has(anchor), `README has no #${anchor}`)
  assert.ok(anchors.has('desktop-quick-start'))
})

test('the Mac download is the latest signed release, not a pinned preview', () => {
  const downloads = targets.filter(t => /\/releases\/(?:latest\/)?download\//.test(t))
  assert.ok(downloads.length > 0, 'README has a download link')
  for (const link of downloads) assert.match(link, /\/releases\/latest\/download\/Principia-arm64\.dmg$/)
  assert.doesNotMatch(readme, /preview\.\d|Open Anyway/)
})

test('the demo GIF is in the README and small enough for GitHub to show (under 10 MB)', () => {
  const gifs = targets.filter(t => /\.gif$/i.test(t))
  assert.ok(gifs.includes('website/public/principia-demo.gif'), 'README shows the demo GIF')
  for (const gif of gifs) assert.ok(statSync(path.join(root, gif)).size < 10 * 1024 * 1024, `${gif} is 10 MB or more`)
})
