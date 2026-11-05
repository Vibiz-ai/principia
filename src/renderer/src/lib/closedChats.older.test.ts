import { describe, expect, it } from 'vitest'
import { isOlder, OLDER_DAYS } from './closedChats'

describe('Older: quiet chats fold away', () => {
  const now = Date.parse('2026-11-05T12:00:00Z')
  const daysAgo = (d: number): string => new Date(now - d * 86_400_000).toISOString()
  it(`a quiet chat with nothing for ${OLDER_DAYS} days folds`, () => {
    expect(isOlder({ at: daysAgo(OLDER_DAYS + 1) }, 0, now)).toBe(true)
    expect(isOlder({ at: daysAgo(1) }, 0, now)).toBe(false)
  })
  it('a turn that finished since counts as activity', () => {
    expect(isOlder({ at: daysAgo(10), turnAt: daysAgo(1) }, 0, now)).toBe(false)
  })
  it('never what is live, waiting on you or unread', () => {
    for (const rank of [1, 2, 3]) expect(isOlder({ at: daysAgo(30) }, rank, now)).toBe(false)
  })
})
