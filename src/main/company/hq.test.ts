import { describe, expect, it } from 'vitest'
import type { CompanyAgent, CompanyPassport, CompanyTask } from '../../shared/company'
import type { ChatItem, ChatTurn } from '../../shared/chat'
import { Hq, type HqDeps } from './hq'

const T = '2026-11-02T00:00:00.000Z'
const co = (id: string, name: string, x: Partial<CompanyPassport> = {}): CompanyPassport => ({ id, name, ...x }) as CompanyPassport
const task = (id: string, x: Partial<CompanyTask>): CompanyTask => ({ id, identifier: id.toUpperCase(), companyId: 'co_a', title: id, status: 'todo', createdAt: T, updatedAt: T, agentId: 'agt_a', ...x }) as CompanyTask
const agent = (id: string, name: string, companyId: string): CompanyAgent => ({ id, name, companyId, kind: 'profile', refId: 'p', data: {} }) as unknown as CompanyAgent
const signal = () => new AbortController().signal

function hq(over: Partial<HqDeps> = {}) {
  const calls: unknown[][] = []
  const deps: HqDeps = {
    companies: () => [co('co_personal', 'Personal', { system: 'personal' } as Partial<CompanyPassport>), co('co_a', 'Oddsfile'), co('co_b', 'Oddly Good'), co('co_c', 'Gone', { archivedAt: T })],
    tasks: () => [task('q1', { status: 'blocked', blockReason: 'needs_input', ask: { kind: 'choice', prompt: 'Refund?' } as CompanyTask['ask'] }), task('r1', { status: 'in_review' }), task('w1', { status: 'in_progress', runId: 'run_1', companyId: 'co_b' })],
    asks: () => ({}),
    agents: () => [agent('agt_a', 'Marcus', 'co_a'), agent('agt_b', 'Marcus', 'co_b')],
    startChat: (c, p, t) => (calls.push(['chat', c, p, t]), { id: 's_1' }),
    startAgentChat: async (a, p) => (calls.push(['agent', a, p]), { id: 's_2' }),
    chat: () => ({ turn: 'idle', items: [] }),
    ...over
  }
  return { hq: new Hq(deps), calls }
}

describe('the main chat', () => {
  it('overview: headlines per company, decisions apart from finished work, never Personal or archived', () => {
    const out = hq().hq.overview() as { companies: { name: string; needs_decision: number; finished_for_review: number; decisions: { question?: string }[] }[] }
    expect(out.companies.map((c) => c.name)).toEqual(['Oddsfile', 'Oddly Good'])
    expect(out.companies[0]).toMatchObject({ needs_decision: 1, finished_for_review: 1 })
    expect(out.companies[0]!.decisions[0]!.question).toBe('Refund?')
  })
  it('starts a Claude chat inside the named company, by name or part of it', async () => {
    const h = hq()
    expect(await h.hq.call('hq_start_chat', { company: 'oddsfile', prompt: 'Fix the funnel\nthen report' }, signal())).toMatchObject({ session_id: 's_1', company: 'Oddsfile' })
    expect(h.calls[0]).toEqual(['chat', 'co_a', 'Fix the funnel\nthen report', 'Fix the funnel'])
  })
  it("an agent only of that company; an unclear or unknown company is refused", async () => {
    const h = hq()
    await h.hq.call('hq_start_chat', { company: 'Oddly Good', prompt: 'Post', agent: 'marcus' }, signal())
    expect(h.calls[0]).toEqual(['agent', 'agt_b', 'Post'])
    await expect(h.hq.call('hq_start_chat', { company: 'Odd', prompt: 'x' }, signal())).rejects.toThrow('name one')
    await expect(h.hq.call('hq_start_chat', { company: 'Nope', prompt: 'x' }, signal())).rejects.toThrow('No company')
    await expect(h.hq.call('hq_start_chat', { company: 'Personal', prompt: 'x' }, signal())).rejects.toThrow('No company')
    await expect(h.hq.call('hq_start_chat', { company: 'Oddsfile', prompt: 'x', agent: 'Nobody' }, signal())).rejects.toThrow('no agent')
  })
  it('reads the answer of a chat it started, waits while it works, and no other chat', async () => {
    let turn: ChatTurn = 'working'
    const items: ChatItem[] = [{ id: 't', parent: null, kind: 'text', md: 'Fixed.', streaming: false }]
    let clock = 0
    const h = hq({ chat: () => ({ turn, items }), now: () => clock, sleep: async () => { clock += 1000; turn = 'idle' } })
    const { session_id } = (await h.hq.call('hq_start_chat', { company: 'Oddsfile', prompt: 'Fix' }, signal())) as { session_id: string }
    expect(await h.hq.call('hq_chat_result', { session_id, wait_s: 5 }, signal())).toMatchObject({ status: 'done', answer: 'Fixed.', company: 'Oddsfile' })
    await expect(h.hq.call('hq_chat_result', { session_id: 's_other' }, signal())).rejects.toThrow('Not a chat')
  })
  it('says when the chat waits for the founder', async () => {
    const h = hq({ chat: () => ({ turn: 'needs', items: [] }) })
    await h.hq.call('hq_start_chat', { company: 'Oddsfile', prompt: 'Fix' }, signal())
    expect(await h.hq.call('hq_chat_result', { session_id: 's_1' }, signal())).toMatchObject({ status: 'needs_you', answer: null })
  })
})
