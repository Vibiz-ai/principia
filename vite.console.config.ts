/**
 * The Principia Cloud web console (docs/CLOUD.md §13.2): static files served by the control plane at /console.
 * No inline script anywhere (CSP default-src 'self'): one module script and one stylesheet, both from 'self'.
 * Build: `vite build --config vite.console.config.ts` (BE wires the npm script and the Dockerfile).
 */
import { resolve } from 'node:path'
import { defineConfig } from 'vite'

export default defineConfig({
  root: resolve(__dirname, 'src/cloud/console'),
  base: '/console/',
  publicDir: resolve(__dirname, 'src/cloud/console/public'),
  build: {
    outDir: resolve(__dirname, 'out-cloud/console'),
    emptyOutDir: true,
    target: 'es2022',
    modulePreload: { polyfill: false },
    assetsInlineLimit: 0,
    sourcemap: false
  }
})
