/**
 * Packaged-app smoke test: launches the built, unsigned Principia.app through Playwright's Electron driver and checks
 * what unit tests cannot see — the app starts from its asar, the preload bridge works, better-sqlite3 opens the
 * database and node-pty spawns a shell from the unpacked native modules, and the app quits cleanly.
 *
 * Throwaway HIVE_USER_DATA (a separate instance: no updates, no principia:// registration, never the installed app's
 * data), HIVE_NO_SCHEDULER=1, no AI agents and no network calls. The app: PRINCIPIA_APP (the .app or its binary), else
 * release/mac-arm64/Principia.app from `npm run pack:dir`.
 */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { HiveApi } from '../src/shared/ipc'

// the preload bridge (src/preload/index.d.ts declares the same for the renderer project)
declare global {
  interface Window {
    hive: HiveApi
  }
}

function executable(): string {
  const given = resolve(process.env.PRINCIPIA_APP ?? 'release/mac-arm64/Principia.app')
  const exe = given.endsWith('.app') ? join(given, 'Contents/MacOS/Principia') : given
  if (!existsSync(exe)) throw new Error(`No packaged app at ${exe}: run \`npm run pack:dir\` or set PRINCIPIA_APP`)
  return exe
}

test.describe.configure({ mode: 'serial' })

let app: ElectronApplication
let page: Page
let scratch: string
let exited: Promise<number | null>
const appLog: string[] = []
const pageErrors: string[] = []

test.beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'principia-smoke-'))
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  delete env.ELECTRON_RUN_AS_NODE
  Object.assign(env, { HIVE_USER_DATA: join(scratch, 'userData'), HIVE_NO_SCHEDULER: '1', HIVE_NO_UPDATES: '1' })
  // --use-mock-keychain: never the keychain item an installed Principia uses (docs/RELEASING.md §6)
  app = await electron.launch({ executablePath: executable(), args: ['--use-mock-keychain'], env, cwd: scratch, timeout: 60_000 })
  const proc = app.process()
  exited = new Promise((r) => proc.once('exit', (code) => r(code)))
  proc.stdout?.on('data', (d) => appLog.push(String(d)))
  proc.stderr?.on('data', (d) => appLog.push(String(d)))
  page = await app.firstWindow()
  page.on('pageerror', (e) => pageErrors.push(String(e.stack ?? e)))
  page.on('console', (m) => m.type() === 'error' && appLog.push(`[renderer console.error] ${m.text()}\n`))
})

// Playwright reads the fixtures a hook asks for from its first parameter, so it must be a destructuring pattern
// eslint-disable-next-line no-empty-pattern
test.afterAll(async ({}, info) => {
  if (info.status !== 'passed' && page && !page.isClosed()) await page.screenshot({ path: info.outputPath('last.png') }).catch(() => undefined)
  if (app && app.process().exitCode === null && app.process().signalCode === null) await app.close().catch(() => undefined)
  mkdirSync(info.outputDir, { recursive: true })
  writeFileSync(info.outputPath('app.log'), appLog.join(''))
  rmSync(scratch, { recursive: true, force: true })
})

test('the window opens from the packaged app', async () => {
  const info = await page.evaluate(() => window.hive.app.info())
  expect(info.isPackaged).toBe(true)
  expect(info.userDataDir).toBe(join(scratch, 'userData'))
  // context isolation: the renderer has the bridge, never Node
  expect(await page.evaluate(() => typeof (globalThis as { require?: unknown }).require)).toBe('undefined')
  expect(page.url()).toMatch(/^file:\/\//)
})

test('Home renders', async () => {
  // a fresh data folder opens the first-run flow; "I'll explore on my own" goes to Home
  await expect(page.locator('.shell--onboarding')).toBeVisible()
  await page.getByText("I'll explore on my own").click()
  await expect(page.locator('.shell--onboarding')).toHaveCount(0)
  await expect(page.locator('.sidebar')).toBeVisible()
  await expect(page.locator('main.main .home')).toBeVisible()
  await expect(page).toHaveTitle(/Home/)
  expect((await page.evaluate(() => window.hive.settings.get())).onboardingDone).toBe(true)
})

test('the database opens and a company can be created', async () => {
  // the bridge rejects with a plain { code, message } (src/preload): rethrown as an Error so a failure says why
  const created = await page.evaluate(() =>
    window.hive.company.create({ name: 'Smoke Test Co', color: '#3366ff' }).catch((e: { code: string; message: string }) => {
      throw new Error(`${e.code}: ${e.message}`)
    })
  )
  expect(created.name).toBe('Smoke Test Co')
  const listed = await page.evaluate(() => window.hive.company.list())
  expect(listed.map((c) => c.name)).toContain('Smoke Test Co')
  expect(existsSync(join(scratch, 'userData', 'hive.db'))).toBe(true)
  // read back through the UI: Home lists the new company
  await expect(page.locator('main.main')).toContainText('Smoke Test Co')
})

test('a shell terminal spawns and echoes', async () => {
  const cwd = join(scratch, 'work')
  mkdirSync(cwd)
  await page.evaluate(() => {
    const w = window as unknown as { __pty: Record<string, string> }
    w.__pty = {}
    window.hive.on('pty:data', (p) => (w.__pty[p.sessionId] = (w.__pty[p.sessionId] ?? '') + p.data))
  })
  const session = await page.evaluate(
    (dir) =>
      window.hive.sessions.create({ adapter: 'shell', cwd: dir, cols: 100, rows: 30 }).catch((e: { code: string; message: string }) => {
        throw new Error(`${e.code}: ${e.message}`)
      }),
    cwd
  )
  expect(session.status).toBe('running')
  const output = () => page.evaluate((id) => (window as unknown as { __pty: Record<string, string> }).__pty[id] ?? '', session.id)
  // the arithmetic only shows its result if the shell really ran it (the typed line itself says $((6*7)))
  await expect.poll(output).not.toBe('')
  await page.evaluate((id) => window.hive.send('sessions:write', { id, data: 'echo principia-smoke-$((6*7))\r' }), session.id)
  await expect.poll(output).toContain('principia-smoke-42')
  const killed = await page.evaluate((id) => window.hive.sessions.kill({ id }), session.id)
  expect(killed.status).not.toBe('running')
})

test('no uncaught errors in the window', () => {
  expect(pageErrors).toEqual([])
})

test('quits cleanly', async () => {
  await app.evaluate(({ app }) => app.quit())
  const code = await Promise.race([exited, new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 20_000))])
  expect(code).toBe(0)
})
