import { describe, expect, it, vi } from 'vitest'
import { REQUEST_SCHEMAS } from '../../ipcSchemas'
import { connectionsChanged, flush, onConnectionsChanged, setConnectionsSender } from '../events'

const CO = 'co_aaaaaaaaaaaa'

describe('connections:* requests', () => {
  it('refuse unknown services, purposes, oversized settings and bad key names', () => {
    const ok = (c: keyof typeof REQUEST_SCHEMAS, v: unknown): boolean => REQUEST_SCHEMAS[c].safeParse(v).success
    expect(ok('connections:get', { companyId: CO, serviceId: 'posthog' })).toBe(true)
    expect(ok('connections:get', { companyId: CO, serviceId: 'nope' })).toBe(false)
    expect(ok('connections:connectKey', { companyId: CO, serviceId: 'posthog', keys: { POSTHOG_PERSONAL_API_KEY: 'phx_1' }, settings: { projectId: '42' }, purpose: 'dashboard' })).toBe(true)
    expect(ok('connections:connectKey', { companyId: CO, serviceId: 'posthog', keys: {} })).toBe(false)
    expect(ok('connections:connectKey', { companyId: CO, serviceId: 'posthog', keys: { 'bad-name': 'x' } })).toBe(false)
    expect(ok('connections:connectKey', { companyId: CO, serviceId: 'posthog', keys: { POSTHOG_PERSONAL_API_KEY: 'x' }, purpose: 'steal' })).toBe(false)
    expect(ok('connections:settings', { companyId: CO, serviceId: 'posthog', settings: { projectId: 'x'.repeat(301) } })).toBe(false)
    expect(ok('connections:settings', { companyId: CO, serviceId: 'posthog', settings: Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`k${String.fromCharCode(97 + i)}`, 'v'])) })).toBe(false)
    expect(ok('connections:reuse', { companyId: CO, serviceId: 'notion', from: null })).toBe(true)
    expect(ok('connections:disconnect', { companyId: CO, serviceId: 'stripe', forms: ['key', 'mcp'] })).toBe(true)
    expect(ok('connections:disconnect', { companyId: CO, serviceId: 'stripe', forms: [] })).toBe(false)
    expect(ok('connections:choose', { companyId: CO, serviceId: 'stripe', purpose: 'agentTools', keyName: 'STRIPE_AGENT_API_KEY' })).toBe(true)
  })
})

describe('connections:changed', () => {
  it('coalesces per company, and a null company means every company', () => {
    vi.useFakeTimers()
    const sent: unknown[] = []
    const heard: (string | null)[] = []
    setConnectionsSender((p) => sent.push(p))
    const off = onConnectionsChanged((c) => heard.push(c))
    connectionsChanged(CO, 'posthog')
    connectionsChanged(CO, 'posthog')
    connectionsChanged('co_other', null)
    vi.advanceTimersByTime(200)
    expect(sent).toEqual([{ companyId: CO, serviceId: 'posthog' }, { companyId: 'co_other', serviceId: null }])
    sent.length = 0
    connectionsChanged(CO, 'posthog')
    connectionsChanged(CO, 'stripe')
    connectionsChanged(null)
    flush()
    expect(sent).toEqual([{ companyId: null, serviceId: null }])
    expect(heard).toEqual([CO, 'co_other', null])
    off()
    setConnectionsSender(null)
    vi.useRealTimers()
  })
})
