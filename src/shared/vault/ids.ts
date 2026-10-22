// Vault ids (PASSPORT.md §3.1, §3.2). Pure: no fs, no node imports, so main, the MCP child and the
// renderer share one implementation.
//
// - note ids:  `n-<10 base36>` in frontmatter `id:`; notes without one are keyed `h:<path>`
// - block ids: `f-<10>` (observation) / `r-<10>` (relation), written as `^f-…` at the end of the line.
//   They map 1:1 to v1 ids: `mfa_x` <-> `f-x`, `mrel_x` <-> `r-x`, `ment_x` <-> `n-x`.
// - soft keys: `h:<sha1(path|normalized text)>` for hand-written lines without an id.
// Block ids are handled WITHOUT the leading `^` everywhere in code; only the file text carries it.

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'
const SUFFIX_LEN = 10

export type BlockKind = 'f' | 'r'

/** Principia-owned block id (without `^`). */
export const BLOCK_ID_RE = /^([fr])-([0-9a-z]{10})$/
/** Principia note id. */
export const NOTE_ID_RE = /^n-[0-9a-z]{10}$/
/** Any Obsidian block id (without `^`): letters, digits and dashes. */
export const ANY_BLOCK_ID_RE = /^[A-Za-z0-9-]+$/

function randomSuffix(): string {
  const bytes = new Uint8Array(SUFFIX_LEN)
  globalThis.crypto.getRandomValues(bytes)
  let s = ''
  for (const b of bytes) s += ALPHABET[b % 36]
  return s
}

export function newNoteId(): string {
  return `n-${randomSuffix()}`
}

export function newBlockId(kind: BlockKind): string {
  return `${kind}-${randomSuffix()}`
}

export function isNoteId(s: string): boolean {
  return NOTE_ID_RE.test(s)
}

export function isBlockId(s: string): boolean {
  return BLOCK_ID_RE.test(s)
}

export function blockKind(blockId: string): BlockKind | null {
  const m = BLOCK_ID_RE.exec(blockId)
  return m ? (m[1] as BlockKind) : null
}

/** Accepts `^f-x`, `f-x`, `[[Note#^f-x]]` or `Note#^f-x`; returns `f-x` or null. */
export function parseBlockRef(ref: string): string | null {
  const m = /(?:^|[\s#^])\^?([fr]-[0-9a-z]{10})(?:\]\])?\s*$/.exec(ref.trim())
  return m && isBlockId(m[1]) ? m[1] : null
}

const V1_TO_KIND: Record<string, BlockKind> = { mfa: 'f', mrel: 'r' }
const KIND_TO_V1: Record<BlockKind, string> = { f: 'mfa', r: 'mrel' }

/** `mfa_0sfppfcd3n` -> `f-0sfppfcd3n`, `mrel_x` -> `r-x`; null for anything else. */
export function v1ToBlockId(v1Id: string): string | null {
  const m = /^(mfa|mrel)_([0-9a-z]{10})$/.exec(v1Id)
  return m ? `${V1_TO_KIND[m[1]]}-${m[2]}` : null
}

/** `f-x` -> `mfa_x`, `r-x` -> `mrel_x`; null when not a Principia block id. */
export function blockIdToV1(blockId: string): string | null {
  const m = BLOCK_ID_RE.exec(blockId.replace(/^\^/, ''))
  return m ? `${KIND_TO_V1[m[1] as BlockKind]}_${m[2]}` : null
}

/** `ment_x` -> `n-x`. */
export function v1EntityToNoteId(v1Id: string): string | null {
  const m = /^ment_([0-9a-z]{10})$/.exec(v1Id)
  return m ? `n-${m[1]}` : null
}

/** Index key for a note without frontmatter `id` (PASSPORT.md §3.1). */
export function pathNoteKey(path: string): string {
  return `h:${path}`
}

/** Whitespace-collapsed NFKC text used for soft keys and text hashes. */
export function normalizeLineText(text: string): string {
  return text.normalize('NFKC').replace(/\s+/g, ' ').trim()
}

/** Soft key for a hand-written line without a block id: `h:<sha1(path|normalized text)>`. */
export function softKey(path: string, text: string): string {
  return `h:${sha1Hex(`${path}|${normalizeLineText(text)}`)}`
}

/** mem_fact / mem_link row id: v1-compatible for real ids, soft key otherwise. */
export function lineRowId(blockId: string | null, path: string, text: string): string {
  return (blockId && blockIdToV1(blockId)) || softKey(path, text)
}

/** Lowercased, whitespace-collapsed text hash for per-note dedup (mem_fact.text_hash). */
export function textHash(text: string): string {
  return sha1Hex(normalizeLineText(text).toLowerCase())
}

/** Content hash used as the writer/editor base hash. */
export function contentHash(text: string): string {
  return sha1Hex(text)
}

// --- SHA-1 (sync, pure; Web Crypto's digest is async and node:crypto is not available in the renderer)

export function sha1Hex(input: string): string {
  const msg = new TextEncoder().encode(input)
  const bitLen = msg.length * 8
  const padded = new Uint8Array((((msg.length + 8) >> 6) + 1) << 6)
  padded.set(msg)
  padded[msg.length] = 0x80
  const view = new DataView(padded.buffer)
  view.setUint32(padded.length - 8, Math.floor(bitLen / 0x100000000))
  view.setUint32(padded.length - 4, bitLen >>> 0)
  let h0 = 0x67452301
  let h1 = 0xefcdab89
  let h2 = 0x98badcfe
  let h3 = 0x10325476
  let h4 = 0xc3d2e1f0
  const w = new Uint32Array(80)
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4)
    for (let i = 16; i < 80; i++) {
      const x = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]
      w[i] = (x << 1) | (x >>> 31)
    }
    let a = h0
    let b = h1
    let c = h2
    let d = h3
    let e = h4
    for (let i = 0; i < 80; i++) {
      let f: number
      let k: number
      if (i < 20) {
        f = (b & c) | (~b & d)
        k = 0x5a827999
      } else if (i < 40) {
        f = b ^ c ^ d
        k = 0x6ed9eba1
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d)
        k = 0x8f1bbcdc
      } else {
        f = b ^ c ^ d
        k = 0xca62c1d6
      }
      const t = (((a << 5) | (a >>> 27)) + f + e + k + w[i]) >>> 0
      e = d
      d = c
      c = (b << 30) | (b >>> 2)
      b = a
      a = t
    }
    h0 = (h0 + a) >>> 0
    h1 = (h1 + b) >>> 0
    h2 = (h2 + c) >>> 0
    h3 = (h3 + d) >>> 0
    h4 = (h4 + e) >>> 0
  }
  return [h0, h1, h2, h3, h4].map((h) => (h >>> 0).toString(16).padStart(8, '0')).join('')
}
