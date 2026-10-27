/**
 * A reader for Finder's .DS_Store files, Node built-ins only (scripts/mac-sign.mjs checks the dmg window template with
 * it before copying it into a release dmg; scripts/mac-sign.test.mjs checks the template against build/dmg/layout.json).
 * Read-only and small: the buddy-allocator file, its B-tree of records, the binary plists inside (bwsp, icvp) and the
 * classic Mac alias that points at the window's background picture.
 *
 * Format notes: https://metacpan.org/dist/Mac-Finder-DSStore/view/DSStoreFormat.pod (records), Apple's CFBinaryPList.c
 * (bplist00), mac_alias' alias.py (alias record v2).
 */

/** Every record of a .DS_Store: {name, code, type, value}. Throws on anything that is not one. */
export function readDsStore(buf) {
  if (buf.length < 36 || buf.readUInt32BE(0) !== 1 || buf.toString('latin1', 4, 8) !== 'Bud1') throw new Error('not a .DS_Store (no Bud1 header)')
  // offsets in the file are relative to byte 4
  const at = (off) => off + 4
  const rootOff = buf.readUInt32BE(8)
  let p = at(rootOff)
  const nBlocks = buf.readUInt32BE(p)
  p += 8
  const blocks = []
  for (let i = 0; i < nBlocks; i++) blocks.push(buf.readUInt32BE(p + 4 * i))
  p += 4 * (Math.ceil(nBlocks / 256) * 256)
  const nToc = buf.readUInt32BE(p)
  p += 4
  const toc = {}
  for (let i = 0; i < nToc; i++) {
    const len = buf[p]
    const name = buf.toString('latin1', p + 1, p + 1 + len)
    toc[name] = buf.readUInt32BE(p + 1 + len)
    p += 1 + len + 4
  }
  if (toc.DSDB === undefined) throw new Error('not a .DS_Store (no DSDB)')
  const block = (id) => {
    const addr = blocks[id]
    if (addr === undefined) throw new Error(`.DS_Store: no block ${id}`)
    return at(addr & ~0x1f)
  }
  const db = block(toc.DSDB)
  const records = []
  const readRecord = (q) => {
    const nameLen = buf.readUInt32BE(q)
    q += 4
    const name = utf16be(buf.subarray(q, q + 2 * nameLen))
    q += 2 * nameLen
    const code = buf.toString('latin1', q, q + 4)
    const type = buf.toString('latin1', q + 4, q + 8)
    q += 8
    let value
    switch (type) {
      case 'bool': value = buf[q] !== 0; q += 1; break
      case 'long': case 'shor': value = buf.readUInt32BE(q); q += 4; break
      case 'type': value = buf.toString('latin1', q, q + 4); q += 4; break
      case 'comp': case 'dutc': value = buf.readBigUInt64BE(q); q += 8; break
      case 'blob': { const n = buf.readUInt32BE(q); value = buf.subarray(q + 4, q + 4 + n); q += 4 + n; break }
      case 'ustr': { const n = buf.readUInt32BE(q); value = utf16be(buf.subarray(q + 4, q + 4 + 2 * n)); q += 4 + 2 * n; break }
      default: throw new Error(`.DS_Store: unknown record type ${JSON.stringify(type)}`)
    }
    records.push({ name, code, type, value })
    return q
  }
  const walk = (id, depth = 0) => {
    if (depth > 32) throw new Error('.DS_Store: B-tree too deep')
    let q = block(id)
    const right = buf.readUInt32BE(q)
    const count = buf.readUInt32BE(q + 4)
    q += 8
    for (let i = 0; i < count; i++) {
      if (right) {
        walk(buf.readUInt32BE(q), depth + 1)
        q += 4
      }
      q = readRecord(q)
    }
    if (right) walk(right, depth + 1)
  }
  walk(buf.readUInt32BE(db))
  return records
}

function utf16be(b) {
  const s = Buffer.from(b)
  s.swap16()
  return s.toString('utf16le')
}

/** A binary property list (bplist00) as plain JS: dicts → objects, data → Buffer, dates → Date. */
export function parseBplist(buf) {
  if (buf.toString('latin1', 0, 8) !== 'bplist00') throw new Error('not a binary plist')
  const t = buf.length - 32
  const offSize = buf[t + 6]
  const refSize = buf[t + 7]
  const numObjects = Number(buf.readBigUInt64BE(t + 8))
  const top = Number(buf.readBigUInt64BE(t + 16))
  const tableOff = Number(buf.readBigUInt64BE(t + 24))
  const uint = (o, n) => { let v = 0; for (let i = 0; i < n; i++) v = v * 256 + buf[o + i]; return v }
  const offsets = []
  for (let i = 0; i < numObjects; i++) offsets.push(uint(tableOff + i * offSize, offSize))
  const obj = (ref, depth = 0) => {
    if (depth > 64) throw new Error('binary plist too deep')
    let o = offsets[ref]
    const marker = buf[o]
    const hi = marker >> 4
    const lo = marker & 0xf
    const length = () => {
      if (lo !== 0xf) return { n: lo, start: o + 1 }
      const intMarker = buf[o + 1]
      const size = 1 << (intMarker & 0xf)
      return { n: uint(o + 2, size), start: o + 2 + size }
    }
    switch (hi) {
      case 0x0: return marker === 0x09 ? true : marker === 0x08 ? false : null
      case 0x1: { const size = 1 << lo; return size === 8 ? Number(buf.readBigInt64BE(o + 1)) : uint(o + 1, size) }
      case 0x2: return lo === 2 ? buf.readFloatBE(o + 1) : buf.readDoubleBE(o + 1)
      case 0x3: return new Date((buf.readDoubleBE(o + 1) + 978307200) * 1000)
      case 0x4: { const { n, start } = length(); return buf.subarray(start, start + n) }
      case 0x5: { const { n, start } = length(); return buf.toString('latin1', start, start + n) }
      case 0x6: { const { n, start } = length(); return utf16be(buf.subarray(start, start + 2 * n)) }
      case 0xa: { const { n, start } = length(); return Array.from({ length: n }, (_, i) => obj(uint(start + i * refSize, refSize), depth + 1)) }
      case 0xd: {
        const { n, start } = length()
        const out = {}
        for (let i = 0; i < n; i++) out[obj(uint(start + i * refSize, refSize), depth + 1)] = obj(uint(start + (n + i) * refSize, refSize), depth + 1)
        return out
      }
      default: throw new Error(`binary plist: unsupported object 0x${marker.toString(16)}`)
    }
  }
  return obj(top)
}

/** The volume and file a classic Mac alias record (version 2) points at: {volume, file, carbonPath, posixPath}. */
export function readAlias(buf) {
  if (buf.readUInt16BE(6) !== 2) throw new Error('not a version 2 alias record')
  const pstr = (o, max) => buf.toString('utf8', o + 1, o + 1 + Math.min(buf[o], max - 1))
  const volume = pstr(10, 28)
  const file = pstr(50, 64)
  // the tagged extras after the fixed 150-byte part: 2 carbon path, 18 POSIX path, …; -1 ends them
  const extras = {}
  let q = 150
  while (q + 4 <= buf.length) {
    const tag = buf.readInt16BE(q)
    const len = buf.readUInt16BE(q + 2)
    if (tag === -1) break
    extras[tag] = buf.subarray(q + 4, q + 4 + len)
    q += 4 + len + (len & 1)
  }
  return { volume, file, carbonPath: extras[2]?.toString('utf8') ?? null, posixPath: extras[18]?.toString('utf8') ?? null }
}

const UUID = /[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}/g

/** Where the volume UUID sits in the background bookmark (pBBk) of `buf`: {offset, uuid}. Throws unless exactly one. */
function bookmarkUuidAt(buf) {
  const rec = readDsStore(buf).find((r) => r.name === '.' && r.code === 'pBBk')
  if (!rec) throw new Error('.DS_Store has no background bookmark (pBBk)')
  const hits = [...rec.value.toString('latin1').matchAll(UUID)]
  if (hits.length !== 1) throw new Error(`.DS_Store background bookmark holds ${hits.length} volume UUIDs, expected 1`)
  return { offset: rec.value.byteOffset - buf.byteOffset + hits[0].index, uuid: hits[0][0] }
}

/**
 * A copy of .DS_Store `buf` whose background bookmark names the volume `uuid`. Finder looks the background picture up
 * by the bookmark's volume UUID, and every new dmg volume has a new one, so the template's is replaced: 36 ASCII
 * bytes for 36, in place, nothing else in the file moves.
 */
export function withBookmarkVolumeUuid(buf, uuid) {
  const u = String(uuid).toUpperCase()
  if (!new RegExp(`^${UUID.source}$`).test(u)) throw new Error(`not a volume UUID: ${uuid}`)
  const out = Buffer.from(buf)
  const { offset } = bookmarkUuidAt(out)
  out.write(u, offset, 'latin1')
  return out
}

/**
 * What a dmg window .DS_Store says, in the terms of build/dmg/layout.json: window bounds and chrome, icon size and
 * positions (by file name), and where the background picture is (volume name + path inside it).
 */
export function dmgWindowLayout(buf) {
  const records = readDsStore(buf)
  const root = (code) => records.find((r) => r.name === '.' && r.code === code)?.value
  const bwsp = root('bwsp') ? parseBplist(root('bwsp')) : {}
  const icvp = root('icvp') ? parseBplist(root('icvp')) : {}
  const m = /^\{\{(-?\d+), (-?\d+)\}, \{(\d+), (\d+)\}\}$/.exec(bwsp.WindowBounds ?? '')
  const icons = {}
  for (const r of records) if (r.code === 'Iloc' && r.type === 'blob') icons[r.name] = { x: r.value.readUInt32BE(0), y: r.value.readUInt32BE(4) }
  const alias = Buffer.isBuffer(icvp.backgroundImageAlias) ? readAlias(icvp.backgroundImageAlias) : null
  return {
    window: m ? { x: +m[1], y: +m[2], width: +m[3], height: +m[4] } : null,
    toolbar: bwsp.ShowToolbar ?? null,
    sidebar: bwsp.ShowSidebar ?? null,
    statusBar: bwsp.ShowStatusBar ?? null,
    pathBar: bwsp.ShowPathbar ?? null,
    view: records.find((r) => r.name === '.' && r.code === 'icvl')?.value ?? null,
    iconSize: icvp.iconSize ?? null,
    textSize: icvp.textSize ?? null,
    backgroundType: icvp.backgroundType ?? null,
    background: alias && { volume: alias.volume, file: alias.file, posixPath: alias.posixPath },
    bookmarkVolume: records.some((r) => r.name === '.' && r.code === 'pBBk') ? bookmarkUuidAt(buf).uuid : null,
    icons
  }
}
