/**
 * `principia-cloud` (out-cloud/control.mjs). Subcommands:
 *   (none) | serve        run the control plane and the agent runtime in this process
 *   init                  write missing generated secrets into PRINCIPIA_SECRETS_DIR (compose's init service)
 *   pair                  print a fresh connect link (`<publicUrl>/pair#XXXX-XXXX`, 10 minutes)
 *   print-env-template    print the .env template (overrides only)
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { lookup } from 'node:dns/promises'
import { chmodSync, chownSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { formatConnectLink } from '../../shared/cloud'
import { createCloudRuntime } from '../agent/index'
import { mintPairingCode } from './auth'
import { ENV_TEMPLATE, initSecrets, loadConfig, secretsDir, type LoadedConfig } from './config'
import { openControlDb } from './db'
import { createDevRuntime } from './devRuntime'
import { createControlApp, ensureWorkspace } from './server'

const here = dirname(fileURLToPath(import.meta.url))

export interface Ids { uid: number; gid: number }
const idsFrom = (env: NodeJS.ProcessEnv, prefix: string, uid: number): Ids => ({ uid: Number(env[`${prefix}_UID`] || uid), gid: Number(env[`${prefix}_GID`] || env[`${prefix}_UID`] || uid) })

/**
 * CLOUD.md §7.8: when the control plane runs as root (the image's default, with only the capabilities compose grants),
 * every agent process starts as PRINCIPIA_AGENT_UID (1001) and cannot read /secrets or control.db. Anything else
 * (tests, a developer's Mac, an old compose file that runs as node) keeps one user, with a warning in a container.
 */
export function agentUserFor(env: NodeJS.ProcessEnv, uid: number | null): Ids | null {
  if (uid !== 0 || env.PRINCIPIA_AGENT_UID === 'off') return null
  const ids = idsFrom(env, 'PRINCIPIA_AGENT', 1001)
  if (!Number.isInteger(ids.uid) || ids.uid <= 0 || !Number.isInteger(ids.gid) || ids.gid <= 0) throw new Error('PRINCIPIA_AGENT_UID and PRINCIPIA_AGENT_GID must be positive numbers (not root).')
  return ids
}

/**
 * The one plain line printed under a connect link only this machine can open (CLOUD.md §12.1): the tunnel command, or
 * the setting. null when the link already works where it is used (a public URL, or Docker Desktop on the Mac itself).
 */
export function connectHint(l: Pick<LoadedConfig, 'publicSource' | 'port'>, onDesktop: boolean): string | null {
  if (l.publicSource !== 'local' || onDesktop) return null
  return `This link works only on this machine. From your Mac: ssh -N -L ${l.port}:127.0.0.1:${l.port} you@this-server, then paste it. Or set PRINCIPIA_PUBLIC_URL to an address your Mac reaches.`
}

/** Docker Desktop (the Mac or PC itself) answers host.docker.internal; a Linux server does not. */
async function onDesktop(): Promise<boolean> {
  if (process.platform === 'darwin') return true
  try {
    await lookup('host.docker.internal')
    return true
  } catch {
    return false
  }
}

/** Only the control plane's user reads its secrets and databases; agents pass through /data to their own folders. */
function lockDown(dataDir: string, workspaceDir: string, secrets: string): void {
  const own = (p: string, mode: number) => {
    if (!existsSync(p)) return
    try { chownSync(p, 0, 0); chmodSync(p, mode) } catch { /* not ours to change (read-only mount) */ }
  }
  mkdirSync(dataDir, { recursive: true })
  own(dataDir, 0o711)
  for (const f of ['control.db', 'control.db-wal', 'control.db-shm']) own(join(dataDir, f), 0o600)
  const rt = join(dataDir, 'runtime')
  own(rt, 0o711)
  for (const f of ['engine.db', 'engine.db-wal', 'engine.db-shm', 'forum.db', 'forum.db-wal', 'forum.db-shm']) own(join(rt, f), 0o600)
  own(join(rt, 'home'), 0o700)
  own(join(dataDir, 'home'), 0o700)
  mkdirSync(workspaceDir, { recursive: true })
  own(workspaceDir, 0o711)
  own(secrets, 0o700)
  for (const f of ['master.key', 'passport-admin']) own(join(secrets, f), 0o600)
}

/** PRINCIPIA_PASSPORT=embedded: the unchanged Open Passport host as a child process on 127.0.0.1, restarted if it dies. */
function startEmbeddedPassport(l: LoadedConfig, user: Ids | null, log: (m: string) => void): { stop(): void; ready(): Promise<boolean> } {
  const ep = l.embeddedPassport!
  const main = join(ep.src, 'packages/server/src/main.ts')
  if (!existsSync(main)) throw new Error(`PRINCIPIA_PASSPORT=embedded needs the Open Passport host at ${ep.src} (PRINCIPIA_PASSPORT_SRC).`)
  mkdirSync(ep.dataDir, { recursive: true, mode: 0o700 })
  if (user) { chownSync(ep.dataDir, user.uid, user.gid); chmodSync(ep.dataDir, 0o700) }
  const pub = l.config.passport!.publicUrl
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    NODE_ENV: 'production',
    HOST: '127.0.0.1',
    PORT: String(ep.port),
    DATA_DIR: ep.dataDir,
    HOME: ep.dataDir,
    OPEN_PASSPORT_ADMIN_TOKEN: l.config.passport!.adminToken,
    // the host refuses a public URL that is not https; behind the cloud's proxy the forwarded origin is the right one
    ...(/^https:\/\//.test(pub) ? { OPEN_PASSPORT_PUBLIC_URL: pub } : { OPEN_PASSPORT_TRUST_PROXY: '1' })
  }
  let child: ChildProcess | null = null
  let stopping = false
  let restarts = 0
  const run = () => {
    child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', main], { env, cwd: ep.src, stdio: ['ignore', 'inherit', 'inherit'], ...(user ? { uid: user.uid, gid: user.gid } : {}) })
    child.on('exit', (code) => {
      if (stopping) return
      restarts++
      log(`the embedded passport host exited (code ${code}); restarting`)
      setTimeout(run, Math.min(30_000, 1000 * restarts)).unref()
    })
  }
  run()
  return {
    stop() { stopping = true; child?.kill('SIGTERM') },
    async ready() {
      const end = Date.now() + 15_000
      while (Date.now() < end) {
        try { if ((await fetch(`http://127.0.0.1:${ep.port}/healthz`)).ok) return true } catch { /* starting */ }
        await new Promise(r => setTimeout(r, 200))
      }
      return false
    }
  }
}

export async function main(argv: string[], env: NodeJS.ProcessEnv): Promise<number> {
  const cmd = argv[0] ?? 'serve'
  const uid = typeof process.getuid === 'function' ? process.getuid() : null
  if (cmd === 'print-env-template') { process.stdout.write(ENV_TEMPLATE); return 0 }
  if (cmd === 'init') {
    const dir = secretsDir(env)
    const root = uid === 0
    const created = initSecrets(dir, { passportDir: env.PRINCIPIA_PASSPORT_SECRETS_DIR || undefined, owner: root ? { uid: 0, gid: 0 } : null, passportOwner: root ? idsFrom(env, 'PRINCIPIA_PASSPORT_SECRETS', 1000) : null })
    process.stdout.write(created.length ? `principia-cloud init: created ${created.join(', ')} in ${dir}\n` : `principia-cloud init: secrets already present in ${dir}\n`)
    return 0
  }
  // one container (Render, Fly, docker run): no init service ran, so serve generates what is missing itself. A value
  // given in the environment (Render's generated master key) is never written to the disk.
  const missing = [...(env.PRINCIPIA_MASTER_KEY ? [] : ['master.key']), ...(env.OPEN_PASSPORT_ADMIN_TOKEN ? [] : ['passport-admin'])]
  if (cmd === 'serve' && missing.length && env.PRINCIPIA_AUTO_INIT !== '0') {
    try { initSecrets(secretsDir(env), { owner: uid === 0 ? { uid: 0, gid: 0 } : null, only: missing }) } catch { /* read-only secrets mount: compose's init service owns them */ }
  }
  const loaded = loadConfig(env, { consoleDir: join(here, 'console') })
  const { config } = loaded
  const hint = connectHint(loaded, await onDesktop())
  if (cmd === 'pair') {
    const db = openControlDb(join(config.dataDir, 'control.db'))
    try {
      const ws = ensureWorkspace(db, loaded.masterKey, config.workspaceName, new Date())
      const code = mintPairingCode({ db, now: () => new Date(), workspaceId: ws.id })
      process.stdout.write(`Connect link: ${formatConnectLink(config.publicUrl, code.code)} (10 min)\n${hint ? `${hint}\n` : ''}`)
    } finally { db.close() }
    return 0
  }
  if (cmd !== 'serve') { process.stderr.write(`Unknown command ${cmd}. Use serve, init, pair or print-env-template.\n`); return 2 }

  const agentUser = agentUserFor(env, uid)
  if (agentUser) {
    // files this process creates are its own; agent folders are handed over explicitly (CLOUD.md §7.8)
    process.umask(0o077)
    lockDown(config.dataDir, config.workspaceDir, secretsDir(env))
  }
  if (loaded.embeddedPassport && !config.passport) process.stderr.write('principia-cloud: PRINCIPIA_PASSPORT=embedded but no passport admin token was found; starting without a passport host.\n')
  const passport = loaded.embeddedPassport && config.passport ? startEmbeddedPassport(loaded, agentUser ? idsFrom(env, 'PRINCIPIA_PASSPORT', 1002) : null, m => process.stderr.write(`principia-cloud: ${m}\n`)) : null
  const app = createControlApp({
    config: { ...config, connectHint: hint },
    masterKey: loaded.masterKey,
    createRuntime: ports => loaded.runtime === 'fake'
      ? createDevRuntime(ports, { autoComplete: true })
      : createCloudRuntime({ dataDir: config.dataDir, workspaceDir: config.workspaceDir, ports, agentUser })
  })
  for (const w of loaded.warnings) app.ctx.log.warn(w)
  if (loaded.runtime === 'fake') app.ctx.log.warn('PRINCIPIA_RUNTIME=fake: runs complete without running any agent (tests and smoke only).')
  if (!agentUser && existsSync('/.dockerenv')) app.ctx.log.warn('Agents run as the control plane\'s user, so they could read its secrets. Run the container as root with the capabilities in cloud/compose.yml (agents then run as their own user).')
  if (passport && !(await passport.ready())) app.ctx.log.warn('The embedded passport host did not answer yet. Companies move without a passport until it does.')
  await app.start()
  const server = app.server()
  await new Promise<void>((ok, fail) => { server.once('error', fail); server.listen(loaded.port, loaded.host, () => ok()) })
  app.ctx.log.info('Principia Cloud listening', { host: loaded.host, port: loaded.port, publicUrl: config.publicUrl, runtime: app.ctx.runtime.version, passport: app.host ? app.host.publicUrl : null, agents: agentUser ? `uid ${agentUser.uid}` : 'same user' })
  let stopping = false
  const stop = (signal: string) => {
    if (stopping) return
    stopping = true
    app.ctx.log.info('stopping', { signal })
    const force = setTimeout(() => process.exit(1), 15_000)
    force.unref()
    passport?.stop()
    app.close().then(() => process.exit(0), () => process.exit(1))
  }
  process.once('SIGTERM', () => stop('SIGTERM'))
  process.once('SIGINT', () => stop('SIGINT'))
  return -1
}

const entry = process.argv[1] ? resolve(process.argv[1]) : ''
if (entry && (entry === fileURLToPath(import.meta.url) || /control\.mjs$/.test(entry))) {
  main(process.argv.slice(2), process.env).then(
    code => { if (code >= 0) process.exitCode = code },
    e => { process.stderr.write(`principia-cloud: ${(e as Error).message}\n`); process.exitCode = 1 }
  )
}
