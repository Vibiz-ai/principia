/**
 * Claude Code asks "Do you trust the files in this folder?" the first time it opens a folder, with "No, exit"
 * preselected. For folders the user explicitly added to Hive (folder picker / drop = the trust decision) and for
 * Hive's own scratch dir, Hive records the answer in Claude's config before spawning, exactly where Claude itself
 * would: <config>/.claude.json -> projects[<abs path>].hasTrustDialogAccepted = true.
 *
 * Safety: read-modify-write merge that only touches that one key, written to a temp file + atomic rename, file mode
 * preserved. If the file is missing, unreadable or not valid JSON (e.g. a concurrent Claude write), nothing is
 * written: Claude would then just show its own prompt.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Claude stores its global config in $CLAUDE_CONFIG_DIR/.claude.json, else ~/.claude.json. */
export function claudeConfigPath(env: Record<string, string | undefined>): string {
  const dir = env.CLAUDE_CONFIG_DIR?.trim()
  if (dir) return path.join(dir, '.claude.json')
  return path.join(env.HOME?.trim() || os.homedir(), '.claude.json')
}

/** Pure: returns the updated config, or null when every key is already trusted (or the shape is unexpected). */
export function withTrustedFolders(config: unknown, folders: string[]): Record<string, unknown> | null {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return null
  const cfg = config as Record<string, unknown>
  const projects = cfg.projects ?? {}
  if (!projects || typeof projects !== 'object' || Array.isArray(projects)) return null
  const next: Record<string, unknown> = { ...(projects as Record<string, unknown>) }
  let changed = false
  for (const f of folders) {
    const cur = next[f]
    if (cur !== undefined && (!cur || typeof cur !== 'object' || Array.isArray(cur))) continue
    const entry = (cur ?? {}) as Record<string, unknown>
    if (entry.hasTrustDialogAccepted === true) continue
    next[f] = { ...entry, hasTrustDialogAccepted: true }
    changed = true
  }
  return changed ? { ...cfg, projects: next } : null
}

/** Folder keys Claude may look up: the absolute path and, if different, its realpath (/tmp -> /private/tmp). */
export function trustKeys(folder: string): string[] {
  const abs = path.resolve(folder)
  const keys = [abs]
  try {
    const real = fs.realpathSync(abs)
    if (real !== abs) keys.push(real)
  } catch {
    /* missing folder: keep abs */
  }
  return keys
}

/** Marks `folder` trusted for Claude Code. Returns true when the config now trusts it. Never throws. */
export function trustFolderForClaude(folder: string, env: Record<string, string | undefined>): boolean {
  const file = claudeConfigPath(env)
  const keys = trustKeys(folder)
  for (let attempt = 0; attempt < 3; attempt++) {
    let raw: string
    let mode = 0o600
    try {
      raw = fs.readFileSync(file, 'utf8')
      mode = fs.statSync(file).mode & 0o777
    } catch {
      return false // no Claude config yet (Claude not set up): leave it to Claude
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      continue // probably caught a concurrent write mid-way; re-read
    }
    const next = withTrustedFolders(parsed, keys)
    if (!next) return isTrusted(parsed, keys)
    const tmp = `${file}.hive-${process.pid}-${Date.now()}.tmp`
    try {
      fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { mode })
      // Last-moment check: if Claude rewrote the file since we read it, merge again instead of clobbering.
      if (fs.readFileSync(file, 'utf8') !== raw) {
        fs.rmSync(tmp, { force: true })
        continue
      }
      fs.renameSync(tmp, file)
      return true
    } catch {
      try {
        fs.rmSync(tmp, { force: true })
      } catch {
        /* ignore */
      }
      return false
    }
  }
  return false
}

function isTrusted(config: unknown, keys: string[]): boolean {
  const projects = (config as { projects?: Record<string, { hasTrustDialogAccepted?: unknown }> } | null)?.projects
  return !!projects && keys.every((k) => projects[k]?.hasTrustDialogAccepted === true)
}

/** Claude's data dir: $CLAUDE_CONFIG_DIR, else ~/.claude. Conversations live in <dir>/projects/<encoded cwd>/<id>.jsonl. */
export function claudeDataDir(env: Record<string, string | undefined>): string {
  const dir = env.CLAUDE_CONFIG_DIR?.trim()
  if (dir) return dir
  return path.join(env.HOME?.trim() || os.homedir(), '.claude')
}

/**
 * True when Claude has stored conversation `id` (any project folder: the cwd encoding is Claude's business).
 * Errs on the side of "exists" when the projects folder can't be read, so Restart keeps its old behavior.
 */
export function claudeConversationExists(id: string, env: Record<string, string | undefined>): boolean {
  if (!/^[A-Za-z0-9-]+$/.test(id)) return true
  const projects = path.join(claudeDataDir(env), 'projects')
  let dirs: string[]
  try {
    dirs = fs.readdirSync(projects)
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code !== 'ENOENT'
  }
  for (const d of dirs) {
    try {
      if (fs.statSync(path.join(projects, d, `${id}.jsonl`)).isFile()) return true
    } catch {
      /* not here */
    }
  }
  return false
}
