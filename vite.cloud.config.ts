import { defineConfig } from 'vite'
import { builtinModules } from 'node:module'
import { CLOUD_AGENT_ENTRIES } from './src/cloud/agent/entries'
// CLOUD.md §15 build seams: the control plane (BE) plus the runtime's extra bundles (AI owns src/cloud/agent/entries.ts).
export default defineConfig({ build: { target: 'node22', outDir: 'out-cloud', emptyOutDir: false, lib: { entry: { workflows: 'src/cloud/workflows.ts', 'mcp-gateway': 'src/main/gateway/main.ts', control: 'src/cloud/control/main.ts', ...CLOUD_AGENT_ENTRIES }, formats: ['es'], fileName: (_format, name) => `${name}.mjs` }, rolldownOptions: { external: [...builtinModules, ...builtinModules.map(n => `node:${n}`), 'better-sqlite3'] } } })
