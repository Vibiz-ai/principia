import path from 'node:path'
import type { ArtifactKind } from '../shared/types'

/** CONTRACT §7 kind table, extension -> [kind, mime]. */
const TABLE: Record<string, [ArtifactKind, string]> = {}
const add = (kind: ArtifactKind, entries: Record<string, string>) => {
  for (const [ext, mime] of Object.entries(entries)) TABLE[ext] = [kind, mime]
}
add('image', {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  svg: 'image/svg+xml', avif: 'image/avif', heic: 'image/heic'
})
add('video', { mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', m4v: 'video/x-m4v' })
add('audio', {
  mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', ogg: 'audio/ogg', flac: 'audio/flac', aac: 'audio/aac'
})
add('html', { html: 'text/html', htm: 'text/html' })
add('markdown', { md: 'text/markdown', markdown: 'text/markdown' })
add('pdf', { pdf: 'application/pdf' })
add('code', {
  ts: 'text/typescript', tsx: 'text/tsx', js: 'text/javascript', jsx: 'text/jsx', mjs: 'text/javascript',
  cjs: 'text/javascript', json: 'application/json', py: 'text/x-python', rb: 'text/x-ruby', go: 'text/x-go',
  rs: 'text/x-rust', swift: 'text/x-swift', java: 'text/x-java', kt: 'text/x-kotlin', c: 'text/x-c', h: 'text/x-c',
  cpp: 'text/x-c++', css: 'text/css', scss: 'text/x-scss', sh: 'application/x-sh', zsh: 'application/x-sh',
  yaml: 'application/yaml', yml: 'application/yaml', toml: 'application/toml', sql: 'application/sql',
  txt: 'text/plain', csv: 'text/csv', log: 'text/plain', xml: 'application/xml'
})

export function classify(file: string): { kind: ArtifactKind; mime: string } {
  const ext = path.extname(file).slice(1).toLowerCase()
  const hit = TABLE[ext]
  return hit ? { kind: hit[0], mime: hit[1] } : { kind: 'other', mime: 'application/octet-stream' }
}

/** Paths the indexer never indexes: dotfiles/dirs, dependency and VCS folders. `rel` is relative to the root. */
export function isIgnoredRel(rel: string): boolean {
  if (!rel || rel === '.') return false
  return rel.split(/[\\/]/).some((seg) => seg.startsWith('.') || seg === 'node_modules' || seg === '__pycache__')
}
