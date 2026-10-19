import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

/** Must run before app 'ready'. HIVE_USER_DATA overrides the data dir (tests / parallel dev instances). */
export function applyUserDataOverride(): void {
  const override = process.env.HIVE_USER_DATA
  if (override) {
    const abs = path.resolve(override)
    fs.mkdirSync(abs, { recursive: true })
    app.setPath('userData', abs)
    process.env.HIVE_USER_DATA = abs
  }
}

export interface HivePaths {
  userData: string
  dbPath: string
  artifactsRoot: string
  thumbsDir: string
  logsDir: string
  sessionLogsDir: string
  runLogsDir: string
  scratchDir: string
  mainLog: string
}

export function buildPaths(userData: string): HivePaths {
  return {
    userData,
    dbPath: path.join(userData, 'hive.db'),
    artifactsRoot: path.join(userData, 'artifacts'),
    thumbsDir: path.join(userData, 'thumbs'),
    logsDir: path.join(userData, 'logs'),
    sessionLogsDir: path.join(userData, 'logs', 'sessions'),
    runLogsDir: path.join(userData, 'logs', 'runs'),
    scratchDir: path.join(userData, 'scratch'),
    mainLog: path.join(userData, 'logs', 'main.log')
  }
}

export function ensurePaths(p: HivePaths): HivePaths {
  for (const dir of [p.userData, p.artifactsRoot, p.thumbsDir, p.logsDir, p.sessionLogsDir, p.runLogsDir, p.scratchDir]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  }
  return p
}

export function resolvePaths(): HivePaths {
  return ensurePaths(buildPaths(app.getPath('userData')))
}
