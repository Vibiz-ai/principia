/**
 * Principia on your phone (docs/REMOTE.md): static files the Mac's Phone server serves (out/phone, next to out/main).
 * No inline script anywhere (CSP default-src 'self'): one module script and one stylesheet, both from 'self'.
 * Build: `npm run build` runs it after electron-vite (`vite build --config vite.phone.config.ts`).
 */
import { resolve } from 'node:path'
import { defineConfig } from 'vite'

export default defineConfig({
  root: resolve(__dirname, 'src/cloud/phone'),
  base: '/',
  publicDir: resolve(__dirname, 'src/cloud/phone/public'),
  resolve: { alias: { '@shared': resolve(__dirname, 'src/shared') } },
  // the Mac's own bundle is same-origin (cookie + CSRF); the hosted build is vite.phone-site.config.ts
  define: { __PHONE_HOSTED__: 'false' },
  build: {
    outDir: resolve(__dirname, process.env.PHONE_OUT_DIR ?? 'out/phone'),
    emptyOutDir: true,
    target: ['es2020', 'safari15'],
    modulePreload: { polyfill: false },
    assetsInlineLimit: 0,
    sourcemap: false
  }
})
