import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

const shared = { '@shared': resolve(__dirname, 'src/shared') }
// SLACK.md §2.4: the dev-only fake Slack exists only in `npm run build:fakeslack` (out-fakeslack/); every other build
// compiles `if (__HIVE_FAKE_SLACK__ …)` to `if (false …)` and drops the fake from the bundle
const FAKE_SLACK = process.env.HIVE_BUILD_FAKE_SLACK === '1'
const outDir = (p: string) => (FAKE_SLACK ? resolve(__dirname, 'out-fakeslack', p) : undefined)

export default defineConfig({
  main: {
    resolve: { alias: shared },
    define: { __HIVE_FAKE_SLACK__: JSON.stringify(FAKE_SLACK) },
    build: {
      ...(FAKE_SLACK ? { outDir: outDir('main') } : {}),
      // chokidar 5 (+ readdirp) is ESM-only: bundle it into the CJS main build instead of relying on require(esm)
      externalizeDeps: { exclude: ['chokidar', 'readdirp'] },
      rollupOptions: {
        // second entry: the hivemem stdio MCP server (docs/MEMORY.md §1), run by agent CLIs via ELECTRON_RUN_AS_NODE
        // third entry: the live hook script (docs/LIVE.md §5), run by agent CLI hooks via ELECTRON_RUN_AS_NODE
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          'mcp-memory': resolve(__dirname, 'src/main/memory/server/main.ts'),
          'hive-hook': resolve(__dirname, 'src/main/live/hookMain.ts'),
          // fourth entry: the `hive` authoring stdio MCP server (docs/AUTHORING.md §1.1), interactive claude panes only
          'mcp-hive': resolve(__dirname, 'src/main/author/server/main.ts'),
          'mcp-gateway': resolve(__dirname, 'src/main/gateway/main.ts'),
          // FORUM.md §4.1: the `forum` CLI + principia-forum stdio MCP server, run by agent steps via ELECTRON_RUN_AS_NODE
          'forum-cli': resolve(__dirname, 'src/main/forum/cli/main.ts'),
          // open-passport docs/connect.md: the Open Passport stdio MCP server other apps run on the live vault
          'mcp-passport': resolve(__dirname, 'src/main/memory/passportMcpMain.ts')
        },
        // native modules stay external and are asar-unpacked by electron-builder
        external: ['better-sqlite3', 'node-pty']
      }
    }
  },
  preload: {
    resolve: { alias: shared },
    build: {
      ...(FAKE_SLACK ? { outDir: outDir('preload') } : {}),
      // sandboxed preload must be a single CommonJS file with only `electron` required
      externalizeDeps: false,
      rollupOptions: { output: { format: 'cjs' } }
    }
  },
  renderer: {
    resolve: { alias: { ...shared, '@renderer': resolve(__dirname, 'src/renderer/src') } },
    plugins: [react()],
    ...(FAKE_SLACK ? { build: { outDir: outDir('renderer') } } : {}),
    server: { host: '127.0.0.1', strictPort: false } // dev-only HMR server for the renderer bundle; never in the packaged app
  }
})
