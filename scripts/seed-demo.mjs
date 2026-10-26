#!/usr/bin/env node
/**
 * docs/DEMO.md: create a fresh, fully synthetic Principia user-data folder to try every feature.
 *
 *   HIVE_USER_DATA=<dir> node scripts/seed-demo.mjs <dir>
 *   HIVE_USER_DATA=<dir> npx electron-vite dev        # then open Principia on it
 *
 * <dir> must not hold a Principia database yet. The seed itself is src/main/demo/seedDemo.ts (tested in
 * seedDemo.test.ts); this script loads it through Vite so the TypeScript sources run as they are, in plain Node.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const target = process.argv[2] || process.env.HIVE_USER_DATA
if (!target || target === '-h' || target === '--help') {
  console.error('Usage: HIVE_USER_DATA=<dir> node scripts/seed-demo.mjs <dir>\nCreates three synthetic demo businesses in a new, empty Principia user-data folder.')
  process.exit(target ? 0 : 1)
}
if (process.env.HIVE_USER_DATA && path.resolve(process.env.HIVE_USER_DATA) !== path.resolve(target)) {
  console.error(`HIVE_USER_DATA (${process.env.HIVE_USER_DATA}) and the folder argument (${target}) differ. Use the same folder for both.`)
  process.exit(1)
}

const server = await createServer({
  root: repo,
  configFile: false,
  logLevel: 'error',
  appType: 'custom',
  server: { middlewareMode: true, hmr: false, ws: false, watch: null },
  resolve: { alias: { '@shared': path.join(repo, 'src/shared') } },
  ssr: { external: ['better-sqlite3'] }
})
try {
  const { seedDemo } = await server.ssrLoadModule('/src/main/demo/seedDemo.ts')
  const res = seedDemo(path.resolve(target))
  console.log(`Demo ready in ${res.userData}`)
  for (const c of res.companies) console.log(`  · ${c.name}`)
  console.log(`  ${res.tasks} tasks, ${res.notes} Knowledge notes, ${res.forumPosts} Forum posts${res.repo ? ', a fixture repository' : ''}`)
  console.log(`\nOpen it with: HIVE_USER_DATA=${res.userData} npx electron-vite dev`)
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e))
  process.exitCode = 1
} finally {
  await server.close()
}
