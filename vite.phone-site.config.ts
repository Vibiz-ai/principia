/**
 * Principia on your phone, hosted (docs/REMOTE.md RA6): the same app as vite.phone.config.ts, built as a standalone
 * static site for its own https origin (Vercel). It talks to the Mac cross-origin: bearer token, CORS for this one
 * origin, the socket's first message. The site holds no data.
 *
 * Build: `npm run build:phone-site` -> dist-phone-site/ (with vercel.json copied in from phone-site/vercel.json).
 * Deploy: `npx vercel deploy dist-phone-site --prod` (no build or install on Vercel: static files and one function with
 * no dependencies, phone-site/api/where.mjs, which needs a Redis store, REMOTE.md RA8).
 * PHONE_SITE_CLOUD_ORIGIN=https://cloud.example.com adds a Principia Cloud origin to the CSP's connect-src.
 * Local stand-in for Vercel: `npm run preview:phone-site` (127.0.0.1, the same headers, plus loopback in connect-src so
 * it can reach a Phone server on this Mac without a tunnel).
 */
import fs from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig, type Plugin } from 'vite'

const OUT = resolve(__dirname, process.env.PHONE_SITE_OUT_DIR ?? 'dist-phone-site')
const VERCEL = resolve(__dirname, 'phone-site/vercel.json')
const LOOKUP = resolve(__dirname, 'phone-site/api/where.mjs')

interface VercelJson {
  headers: { source: string; headers: { key: string; value: string }[] }[]
}
/** https://x.example -> 'https://x.example wss://x.example'; anything else is refused (no wildcard, no path) */
function cloudSources(raw: string | undefined): string {
  if (!raw) return ''
  const u = new URL(raw)
  if (u.protocol !== 'https:' || u.origin !== raw.replace(/\/+$/, '')) throw new Error(`PHONE_SITE_CLOUD_ORIGIN must be an https origin, got ${raw}`)
  return ` ${u.origin} wss://${u.host}`
}
function siteVercelJson(cloud = process.env.PHONE_SITE_CLOUD_ORIGIN): VercelJson {
  const v = JSON.parse(fs.readFileSync(VERCEL, 'utf8')) as VercelJson
  const extra = cloudSources(cloud)
  if (extra) for (const r of v.headers) for (const h of r.headers) if (h.key === 'Content-Security-Policy') h.value = h.value.replace(/connect-src ([^;]*)/, (_m, list: string) => `connect-src ${list}${extra}`)
  return v
}
function siteHeaders(loopback: boolean): Record<string, string> {
  const all = siteVercelJson().headers.find((r) => r.source === '/(.*)')!.headers
  const out: Record<string, string> = {}
  for (const h of all) out[h.key] = h.key === 'Content-Security-Policy' && loopback ? h.value.replace(/connect-src ([^;]*)/, 'connect-src $1 http://127.0.0.1:* ws://127.0.0.1:* http://localhost:* ws://localhost:*') : h.value
  // a local http preview: no HSTS on 127.0.0.1
  if (loopback) delete out['Strict-Transport-Security']
  return out
}

const vercelJson = (): Plugin => ({
  name: 'phone-site-vercel-json',
  apply: 'build',
  closeBundle() {
    fs.writeFileSync(resolve(OUT, 'vercel.json'), `${JSON.stringify(siteVercelJson(), null, 2)}\n`)
    fs.mkdirSync(resolve(OUT, 'api'), { recursive: true })
    fs.copyFileSync(LOOKUP, resolve(OUT, 'api/where.mjs'))
  }
})

export default defineConfig({
  root: resolve(__dirname, 'src/cloud/phone'),
  base: '/',
  publicDir: resolve(__dirname, 'src/cloud/phone/public'),
  resolve: { alias: { '@shared': resolve(__dirname, 'src/shared') } },
  define: { __PHONE_HOSTED__: 'true' },
  plugins: [vercelJson()],
  build: {
    outDir: OUT,
    emptyOutDir: true,
    target: ['es2020', 'safari15'],
    modulePreload: { polyfill: false },
    assetsInlineLimit: 0,
    sourcemap: false
  },
  preview: { host: '127.0.0.1', strictPort: true, headers: siteHeaders(true) }
})
