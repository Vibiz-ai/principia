/**
 * PR-48: Home's Answer on a task question opens the task's chat (brief, the agent's messages and the question in
 * view, the composer focused to answer) instead of an inline box that hides what is being asked.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const home = readFileSync(new URL('./HomeView.tsx', import.meta.url), 'utf8')
const chat = readFileSync(new URL('../components/chats/TaskLiveView.tsx', import.meta.url), 'utf8')

describe("Home: Answer opens the task's chat", () => {
  it('the Answer button opens the task chat, not an inline form', () => {
    expect(home).toMatch(/data-home="answer-in-chat"[^>]*onClick=\{\(\) => openTaskLive\(task\.id, task\.companyId\)\}/)
    expect(home).not.toContain('<AskForm')
    expect(home).not.toContain("{open ? 'Close' : 'Answer'}")
  })
  it('the task chat shows the open question and answers it from its composer, focused on arrival', () => {
    expect(chat).toContain("data-chatux': 'task-chat-question'")
    expect(chat).toContain('answers={!!question}')
    expect(chat).toMatch(/if \(answers\) input\.current\?\.focus\(\)/)
  })
})
