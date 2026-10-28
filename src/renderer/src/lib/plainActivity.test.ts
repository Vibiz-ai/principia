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
    expect(plainActivity('mcp__google_drive__search q')).toBe('Searching Google Drive')
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

  it('a connector call reads as what it does, never its raw arguments', () => {
    const raw = 'posthog.exec call execute-sql {"query": "SELECT distinct_id FROM events WHERE properties.email = \'maria@example.com\'"}'
    expect(plainActivity(raw)).toBe('Running a SQL query in PostHog')
    expect(plainActivity(raw, { code: false })).toBe('Looking up data in PostHog')
    expect(plainActivity('mcp__posthog__exec')).toBe('Using PostHog')
    expect(plainActivity('posthog.exec call feature-flag-get-all')).toBe('Reading from PostHog')
    expect(plainActivity('mcp:linear.create_issue Fix the login')).toBe('Adding to Linear')
    expect(plainActivity('mcp__slack__send_message #general')).toBe('Posting to Slack')
    expect(plainActivity('github.update_pull_request 42')).toBe('Updating GitHub')
    expect(plainActivity('mcp__google_calendar__list_events')).toBe('Reading from Google Calendar')
    expect(plainActivity('acme_crm.do_thing')).toBe('Using Acme Crm')
  })
  it("Principia's own tools and memory read as what they are", () => {
    expect(plainActivity('hive.company_file_task Check the posts')).toBe('Filing a task')
    expect(plainActivity('mcp__hive__task_comment')).toBe('Commenting on a task')
    expect(plainActivity('[memory] search "acme"')).toBe('Checking memory')
    expect(plainActivity('[memory] write Stripe (2 facts)')).toBe('Saving to memory')
  })
  it('a file name or an abbreviation is not a connector call', () => {
    expect(plainActivity('notes.md')).toBe('notes.md')
    expect(plainActivity('index.ts is next')).toBe('index.ts is next')
    expect(plainActivity('e.g. the funnel')).toBe('e.g. the funnel')
  })
})
