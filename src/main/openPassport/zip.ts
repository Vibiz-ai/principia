// Vendored from open-passport 0.1.0 (packages/js/src/node/zip.ts). Do not edit here: change it upstream and re-run scripts/vendor.mjs.
// Minimal deterministic ZIP (SPEC.md §3.1 `.passport.zip`): deflate or store entries, fixed timestamps, sorted paths.
// Reading refuses unsafe paths, encryption, zip64 and oversized entries.
import zlib from 'node:zlib'
import { byteOrder, type AnyFiles } from './manifest'
import { ALLOWED_EXT, MAX_FILE_BYTES, MAX_FILES, MAX_TOTAL_BYTES, safeRelPath } from './screen'

const TEXT = /\.(md|json|txt|csv)$/i
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

export function crc32(b: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** 1980-01-01 00:00 in DOS format: archives of the same files are byte-identical. */
const DOS_TIME = 0
const DOS_DATE = (0 << 9) | (1 << 5) | 1

export function writeZip(files: AnyFiles): Uint8Array {
  const enc = new TextEncoder()
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  const paths = [...files.keys()].sort(byteOrder)
  for (const p of paths) {
    const v = files.get(p)!
    const data = typeof v === 'string' ? enc.encode(v) : v
    const name = Buffer.from(p, 'utf8')
    const deflated = zlib.deflateRawSync(data, { level: 9 })
    const useDeflate = deflated.length < data.length
    const body = useDeflate ? deflated : Buffer.from(data)
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6) // UTF-8 names
    local.writeUInt16LE(useDeflate ? 8 : 0, 8)
    local.writeUInt16LE(DOS_TIME, 10)
    local.writeUInt16LE(DOS_DATE, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    locals.push(local, name, body)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(useDeflate ? 8 : 0, 10)
    central.writeUInt16LE(DOS_TIME, 12)
    central.writeUInt16LE(DOS_DATE, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, name)
    offset += local.length + name.length + body.length
  }
  const cd = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(paths.length, 8)
  end.writeUInt16LE(paths.length, 10)
  end.writeUInt32LE(cd.length, 12)
  end.writeUInt32LE(offset, 16)
  return new Uint8Array(Buffer.concat([...locals, cd, end]))
}

/** Reads a zip into files. Entries under a single top folder are re-rooted (a zipped `acme/` folder works too). */
export function readZip(input: Uint8Array): AnyFiles {
  const buf = Buffer.from(input.buffer, input.byteOffset, input.byteLength)
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('not a zip file')
  const count = buf.readUInt16LE(eocd + 10)
  if (count > MAX_FILES) throw new Error(`more than ${MAX_FILES} entries`)
  let ptr = buf.readUInt32LE(eocd + 16)
  const raw: [string, Uint8Array][] = []
  let total = 0
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(ptr) !== 0x02014b50) throw new Error('corrupt zip directory')
    const flags = buf.readUInt16LE(ptr + 8)
    const method = buf.readUInt16LE(ptr + 10)
    const crc = buf.readUInt32LE(ptr + 16)
    const csize = buf.readUInt32LE(ptr + 20)
    const usize = buf.readUInt32LE(ptr + 24)
    const nlen = buf.readUInt16LE(ptr + 28)
    const xlen = buf.readUInt16LE(ptr + 30)
    const clen = buf.readUInt16LE(ptr + 32)
    const extAttr = buf.readUInt32LE(ptr + 38)
    const lho = buf.readUInt32LE(ptr + 42)
    const name = buf.toString('utf8', ptr + 46, ptr + 46 + nlen)
    ptr += 46 + nlen + xlen + clen
    if (name.endsWith('/')) continue
    if (flags & 1) throw new Error(`encrypted entry ${name}`)
    if (csize === 0xffffffff || usize === 0xffffffff) throw new Error('zip64 is not supported')
    if (((extAttr >>> 16) & 0o170000) === 0o120000) throw new Error(`symlink entry ${name}`)
    if (!safeRelPath(name)) throw new Error(`unsafe path ${name}`)
    if (usize > MAX_FILE_BYTES) throw new Error(`entry too large ${name}`)
    total += usize
    if (total > MAX_TOTAL_BYTES) throw new Error('archive too large')
    if (buf.readUInt32LE(lho) !== 0x04034b50) throw new Error('corrupt zip entry')
    const start = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28)
    const body = buf.subarray(start, start + csize)
    const data = method === 8 ? zlib.inflateRawSync(body, { maxOutputLength: MAX_FILE_BYTES }) : method === 0 ? body : null
    if (!data) throw new Error(`unsupported compression in ${name}`)
    if (data.length !== usize || crc32(data) !== crc) throw new Error(`checksum mismatch in ${name}`)
    raw.push([name, new Uint8Array(data)])
  }
  // re-root a single top folder
  const tops = new Set(raw.map(([n]) => n.split('/')[0]))
  const strip = tops.size === 1 && raw.every(([n]) => n.includes('/')) && !raw.some(([n]) => n === 'passport.json') ? `${[...tops][0]}/` : ''
  const out: AnyFiles = new Map()
  const dec = new TextDecoder()
  for (const [n, d] of raw) {
    const p = n.slice(strip.length)
    if (!ALLOWED_EXT.test(p) && p !== 'passport.json') continue
    out.set(p, TEXT.test(p) ? dec.decode(d) : d)
  }
  return out
}

/**
 * Reads selected text entries of a large foreign zip (an app's data export, not a passport): only entries `want`
 * accepts are inflated, each up to `maxEntryBytes`; the same path, symlink and encryption refusals as readZip.
 */
export function readZipText(input: Uint8Array, want: (name: string) => boolean, limits: { maxEntryBytes: number; maxTotalBytes: number }): Map<string, string> {
  const buf = Buffer.from(input.buffer, input.byteOffset, input.byteLength)
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('not a zip file')
  const count = buf.readUInt16LE(eocd + 10)
  let ptr = buf.readUInt32LE(eocd + 16)
  const out = new Map<string, string>()
  const dec = new TextDecoder()
  let total = 0
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(ptr) !== 0x02014b50) throw new Error('corrupt zip directory')
    const flags = buf.readUInt16LE(ptr + 8)
    const method = buf.readUInt16LE(ptr + 10)
    const crc = buf.readUInt32LE(ptr + 16)
    const csize = buf.readUInt32LE(ptr + 20)
    const usize = buf.readUInt32LE(ptr + 24)
    const nlen = buf.readUInt16LE(ptr + 28)
    const xlen = buf.readUInt16LE(ptr + 30)
    const clen = buf.readUInt16LE(ptr + 32)
    const extAttr = buf.readUInt32LE(ptr + 38)
    const lho = buf.readUInt32LE(ptr + 42)
    const name = buf.toString('utf8', ptr + 46, ptr + 46 + nlen)
    ptr += 46 + nlen + xlen + clen
    if (name.endsWith('/') || !safeRelPath(name) || name.split('/').some((s) => s.startsWith('.') || s === '__MACOSX') || !want(name)) continue
    if (flags & 1 || csize === 0xffffffff || usize === 0xffffffff || ((extAttr >>> 16) & 0o170000) === 0o120000) continue
    if (usize > limits.maxEntryBytes) continue
    total += usize
    if (total > limits.maxTotalBytes) throw new Error('export too large to import at once')
    if (buf.readUInt32LE(lho) !== 0x04034b50) throw new Error('corrupt zip entry')
    const start = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28)
    const body = buf.subarray(start, start + csize)
    const data = method === 8 ? zlib.inflateRawSync(body, { maxOutputLength: limits.maxEntryBytes }) : method === 0 ? body : null
    if (!data || data.length !== usize || crc32(data) !== crc) continue
    out.set(name, dec.decode(data))
  }
  return out
}
