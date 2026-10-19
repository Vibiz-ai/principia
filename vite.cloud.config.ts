import { defineConfig } from 'vite'
import { builtinModules } from 'node:module'
export default defineConfig({ build: { target: 'node22', outDir: 'out-cloud', lib: { entry: { workflows: 'src/cloud/workflows.ts', 'mcp-gateway': 'src/main/gateway/main.ts' }, formats: ['es'], fileName: (_format, name) => `${name}.mjs` }, rolldownOptions: { external: [...builtinModules, ...builtinModules.map(n => `node:${n}`), 'better-sqlite3'] } } })
