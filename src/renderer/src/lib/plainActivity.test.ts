import { describe, expect, it } from 'vitest'
import { plainActivity } from './plainActivity'

describe('plainActivity: LIVE says what the agent does in words, never a raw tool line', () => {
  it('a shell command never shows its path or arguments', () => {
    expect(plainActivity('Bash cd "/private/tmp/claude-501/-Users-x/abc" && npm test')).toBe('Running a command')
  })
  it('file tools name the file, not the path', () => {
    expect(plainActivity('Read /Users/x/repo/src/rounding.ts')).toBe('Reading rounding.ts')
    expect(plainActivity('Edit "/Users/x/repo/README.md"')).toBe('Editing README.md')
    expect(plainActivity('Write')).toBe('Writing a file')
  })
  it('search, web, helpers and MCP read as plain words', () => {
    expect(plainActivity('Grep rounding')).toBe('Searching the files')
    expect(plainActivity('WebSearch best coffee 2026')).toBe('Searching the web')
    expect(plainActivity('Task Research competitors')).toBe('Working with a helper')
    expect(plainActivity('mcp__google_drive__search q')).toBe('Using google drive')
  })
  it('a sentence stays as it is, on one line', () => {
    expect(plainActivity('Waiting for you: Approve the posts')).toBe('Waiting for you: Approve the posts')
    expect(plainActivity('Drafting the\nweek’s posts')).toBe('Drafting the week’s posts')
    expect(plainActivity(null)).toBeNull()
    expect(plainActivity('  ')).toBeNull()
  })

  it('a company with no code never reads "command" (C7)', () => {
    expect(plainActivity('Bash npm test', { code: false })).toBe('Working on it')
    expect(plainActivity('Grep vat', { code: false })).toBe('Looking through its notes')
    expect(plainActivity('Bash npm test', { code: true })).toBe('Running a command')
    expect(plainActivity('Bash npm test')).toBe('Running a command')
  })
})
