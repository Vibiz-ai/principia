import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { claudeConfigPath, claudeConversationExists, trustFolderForClaude, withTrustedFolders } from '../claudeTrust'

describe('claudeTrust', () => {
  it('locates the config via CLAUDE_CONFIG_DIR, else HOME', () => {
    expect(claudeConfigPath({ CLAUDE_CONFIG_DIR: '/c', HOME: '/h' })).toBe('/c/.claude.json')
    expect(claudeConfigPath({ HOME: '/h' })).toBe('/h/.claude.json')
  })

  it('merges only hasTrustDialogAccepted and keeps everything else', () => {
    const cfg = { numStartups: 3, projects: { '/a': { allowedTools: ['x'] }, '/b': { hasTrustDialogAccepted: true } } }
    const next = withTrustedFolders(cfg, ['/a', '/c']) as { numStartups: number; projects: Record<string, unknown> }
    expect(next.numStartups).toBe(3)
    expect(next.projects['/a']).toEqual({ allowedTools: ['x'], hasTrustDialogAccepted: true })
    expect(next.projects['/b']).toEqual({ hasTrustDialogAccepted: true })
    expect(next.projects['/c']).toEqual({ hasTrustDialogAccepted: true })
    expect(withTrustedFolders(cfg, ['/b'])).toBeNull() // already trusted: no write
    expect(withTrustedFolders([], ['/a'])).toBeNull()
  })

  it('writes the file atomically, preserves mode, and never creates or corrupts one', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-trust-'))
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-trust-f-'))
    const file = path.join(home, '.claude.json')
    expect(trustFolderForClaude(folder, { HOME: home })).toBe(false)
    expect(fs.existsSync(file)).toBe(false)

    fs.writeFileSync(file, '{ not json', { mode: 0o600 })
    expect(trustFolderForClaude(folder, { HOME: home })).toBe(false)
    expect(fs.readFileSync(file, 'utf8')).toBe('{ not json')

    fs.writeFileSync(file, JSON.stringify({ userID: 'u', projects: {} }), { mode: 0o600 })
    expect(trustFolderForClaude(folder, { HOME: home })).toBe(true)
    const out = JSON.parse(fs.readFileSync(file, 'utf8'))
    expect(out.userID).toBe('u')
    expect(out.projects[path.resolve(folder)].hasTrustDialogAccepted).toBe(true)
    expect(out.projects[fs.realpathSync(folder)].hasTrustDialogAccepted).toBe(true)
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    expect(fs.readdirSync(home)).toEqual(['.claude.json'])
    expect(trustFolderForClaude(folder, { HOME: home })).toBe(true) // idempotent
  })
})

describe('claudeConversationExists', () => {
  it('finds <id>.jsonl in any project folder; missing projects dir = no conversation', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-conv-'))
    try {
      const env = { CLAUDE_CONFIG_DIR: dir }
      expect(claudeConversationExists('11111111-2222-3333-4444-555555555555', env)).toBe(false)
      fs.mkdirSync(path.join(dir, 'projects', '-x-y'), { recursive: true })
      expect(claudeConversationExists('11111111-2222-3333-4444-555555555555', env)).toBe(false)
      fs.writeFileSync(path.join(dir, 'projects', '-x-y', '11111111-2222-3333-4444-555555555555.jsonl'), '{}\n')
      expect(claudeConversationExists('11111111-2222-3333-4444-555555555555', env)).toBe(true)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
