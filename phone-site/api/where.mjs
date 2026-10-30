/**
 * REMOTE.md RA8: the sealed address lookup, the phone site's one function. It keeps random ids and ciphertext for 30
 * days and can read neither: an address opens only with a key the Mac and that one phone derive. It is a convenience
 * and never an authority: the phone still makes the Mac prove itself (`/api/hello`) before it sends its token.
 *
 * GET  /api/where?id=<64 hex>  -> { sealed } or 404
 * PUT  /api/where?id=<64 hex>  { write, sealed } -> 204, only when sha256hex(write) = id
 *
 * Needs a Redis with the Upstash REST API (Vercel Marketplace): KV_REST_API_URL and KV_REST_API_TOKEN, or
 * UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN. No dependencies, so the site still deploys without an install.
 */
import { createHash } from 'node:crypto'

const TTL_S = 30 * 86_400
const ID_RE = /^[0-9a-f]{64}$/
/** keep in step with RDV_SEALED_RE in src/shared/rendezvous.ts */
const SEALED_RE = /^[A-Za-z0-9_-]{40,400}$/
const MAX_BODY = 1024
/** a phone waiting asks 3 times a minute; a Mac writes once per paired phone per new address */
export const LIMITS = { readPerMinute: 30, writePerHour: 20, writesPerHourAll: 2000 }

const json = (status, body) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })

function redis(env) {
  const url = env.KV_REST_API_URL ?? env.UPSTASH_REDIS_REST_URL
  const token = env.KV_REST_API_TOKEN ?? env.UPSTASH_REDIS_REST_TOKEN
  return url && token ? { url, token } : null
}
/** Several commands in one round trip. Throws when the store fails: the caller answers 503. */
async function pipeline(db, commands) {
  const res = await fetch(`${db.url}/pipeline`, { method: 'POST', headers: { authorization: `Bearer ${db.token}`, 'content-type': 'application/json' }, body: JSON.stringify(commands) })
  if (!res.ok) throw new Error(`store ${res.status}`)
  const out = await res.json()
  return out.map((r) => {
    if (r.error) throw new Error('store error')
    return r.result
  })
}
/** Vercel sets x-real-ip itself; a caller cannot choose it */
const caller = (req) => req.headers.get('x-real-ip') ?? 'unknown'
const idOf = (req) => {
  const id = new URL(req.url).searchParams.get('id')
  return id && ID_RE.test(id) ? id : null
}
const counted = (key, ttl) => [['INCR', key], ['EXPIRE', key, ttl]]

export async function GET(req, env = process.env) {
  const id = idOf(req)
  if (!id) return json(400, { message: 'Bad id' })
  const db = redis(env)
  if (!db) return json(503, { message: 'No store' })
  try {
    const minute = Math.floor(Date.now() / 60_000)
    const [n, , sealed] = await pipeline(db, [...counted(`rdv:r:${caller(req)}:${minute}`, 120), ['GET', `rdv:${id}`]])
    if (n > LIMITS.readPerMinute) return json(429, { message: 'Too many tries' })
    return sealed ? json(200, { sealed }) : json(404, { message: 'Not found' })
  } catch {
    return json(503, { message: 'Store unavailable' })
  }
}

export async function PUT(req, env = process.env) {
  const id = idOf(req)
  if (!id) return json(400, { message: 'Bad id' })
  const text = await req.text().catch(() => '')
  if (text.length > MAX_BODY) return json(413, { message: 'Too large' })
  let body
  try {
    body = JSON.parse(text)
  } catch {
    return json(400, { message: 'Bad body' })
  }
  if (typeof body?.write !== 'string' || typeof body.sealed !== 'string' || !SEALED_RE.test(body.sealed)) return json(400, { message: 'Bad body' })
  if (createHash('sha256').update(body.write).digest('hex') !== id) return json(403, { message: 'Not yours' })
  const db = redis(env)
  if (!db) return json(503, { message: 'No store' })
  try {
    const hour = Math.floor(Date.now() / 3_600_000)
    // one at a time: a caller already over its own limit must not use up everyone else's
    const [mine] = await pipeline(db, counted(`rdv:w:${caller(req)}:${hour}`, 7200))
    if (mine > LIMITS.writePerHour) return json(429, { message: 'Too many tries' })
    const [all] = await pipeline(db, counted(`rdv:w:${hour}`, 7200))
    if (all > LIMITS.writesPerHourAll) return json(429, { message: 'Too many tries' })
    await pipeline(db, [['SET', `rdv:${id}`, body.sealed, 'EX', TTL_S]])
    return json(204)
  } catch {
    return json(503, { message: 'Store unavailable' })
  }
}
