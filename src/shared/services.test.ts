import { describe, expect, it } from 'vitest'
import type { GatewayConnection } from './gateway'
import { CONNECTION_CATALOG, presetForUrl } from './connectionCatalog'
import { DASHBOARD_CATALOG } from './dashboards'
import { SOCIAL_CHANNELS } from './socials'
import { CONNECT_TOOL_IDS, connectLink, parseDeepLink } from './deepLink'
import {
  PURPOSES,
  SERVICE_REGISTRY,
  capabilityLink,
  foldAliases,
  keyAliases,
  keyForms,
  mcpForm,
  serviceById,
  serviceForConnection,
  suggestServiceForConnection,
  serviceForKey,
  serviceForUrl,
  serviceStatus,
  withAliases,
  type CompanyHoldings,
  type KeyPresence
} from './services'

const CO = 'co_acme'
const hold = (p: Partial<CompanyHoldings> = {}): CompanyHoldings => ({ companyId: CO, keys: [], connections: [], slack: 'none', linear: { connected: false, problem: null }, ...p })
const key = (name: string, source: KeyPresence['source'] = 'company'): KeyPresence => ({ name, source, masked: '••••ab12' })
const conn = (p: Partial<GatewayConnection>): GatewayConnection => ({ id: 'c1', name: 'X', transport: 'http', enabled: true, roots: [], scope: 'global', companyIds: [CO], authentication: 'oauth', authStatus: 'connected', hasCredentials: false, ...p })
const status = (id: string, h: CompanyHoldings) => serviceStatus(serviceById(id)!, h)

describe('service registry (data)', () => {
  it('has unique ids, https URLs, UPPER_SNAKE key names and capabilities its forms can serve', () => {
    expect(new Set(SERVICE_REGISTRY.map((s) => s.id)).size).toBe(SERVICE_REGISTRY.length)
    const allKeys: string[] = []
    for (const s of SERVICE_REGISTRY) {
      expect(s.id).toMatch(/^[a-z0-9][a-z0-9-]{0,40}$/)
      expect(s.checked).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      for (const f of s.forms) {
        if (f.kind === 'mcp') {
          expect(new URL(f.url).protocol, s.id).toBe('https:')
          if (f.bearerFromKey) {
            // the bearer key is one of the service's own key fields, and the fact carries when it was checked
            expect(keyForms(s).flatMap((k) => k.keys.map((x) => x.name)), s.id).toContain(f.bearerFromKey.key)
            expect(f.bearerFromKey.checked).toMatch(/^\d{4}-\d{2}-\d{2}$/)
            if (f.bearerFromKey.url) expect(new URL(f.bearerFromKey.url).protocol).toBe('https:')
          }
        }
        if (f.kind === 'key') for (const k of f.keys) {
          expect(k.name).toMatch(/^[A-Z][A-Z0-9_]*$/)
          expect(k.link).toMatch(/^https:\/\//)
          allKeys.push(k.name)
        }
      }
      const kinds = new Set(s.forms.map((f) => f.kind))
      for (const c of s.capabilities) {
        expect(PURPOSES).toContain(c.purpose)
        expect(c.via.some((v) => kinds.has(v)), `${s.id}.${c.purpose}`).toBe(true)
      }
      for (const u of [...(s.match?.urls ?? []), ...s.forms.flatMap((f) => (f.kind === 'mcp' ? [f.url] : []))]) expect(serviceForUrl(u)?.id, u).toBe(s.id)
    }
    // one key name belongs to one service
    expect(new Set(allKeys).size).toBe(allKeys.length)
  })

  it('maps keys, aliases, URLs and connections back to their service', () => {
    expect(serviceForKey('POSTHOG_PERSONAL_API_KEY')?.id).toBe('posthog')
    expect(serviceForKey('POSTHOG_API_KEY')?.id).toBe('posthog')
    expect(serviceForKey('STRIPE_RESTRICTED_KEY')?.id).toBe('stripe')
    expect(serviceForKey('STRIPE_SECRET_KEY')?.id).toBe('stripe')
    expect(serviceForKey('NOPE_KEY')).toBeUndefined()
    expect(keyAliases('POSTHOG_PERSONAL_API_KEY')).toEqual(['POSTHOG_API_KEY'])
    expect(withAliases(['POSTHOG_PERSONAL_API_KEY'])).toEqual(['POSTHOG_PERSONAL_API_KEY', 'POSTHOG_API_KEY'])
    expect(foldAliases(['POSTHOG_PERSONAL_API_KEY'], { POSTHOG_API_KEY: 'v1' })).toEqual({ POSTHOG_PERSONAL_API_KEY: 'v1' })
    expect(foldAliases(['POSTHOG_PERSONAL_API_KEY'], { POSTHOG_API_KEY: 'old', POSTHOG_PERSONAL_API_KEY: 'new' })).toEqual({ POSTHOG_PERSONAL_API_KEY: 'new' })
    expect(serviceForUrl('https://mcp.supabase.com/mcp?project_ref=x')?.id).toBe('supabase')
    expect(serviceForUrl('https://mcp.posthog.com/sse')?.id).toBe('posthog')
    expect(serviceForUrl('https://mcp.firecrawl.dev/v2/mcp')?.id).toBe('firecrawl')
    expect(serviceForUrl('https://mcp.posthog.com.attacker.test/mcp')).toBeUndefined()
    // SEC-1: a name is never identity; it only suggests ("looks like PostHog?")
    expect(serviceForConnection({ url: 'https://example.com/mcp' })).toBeUndefined()
    expect(serviceForConnection({ url: 'http://mcp.posthog.com/mcp' })).toBeUndefined()
    expect(serviceForConnection({ url: 'https://mcp.posthog.com/mcp' })?.id).toBe('posthog')
    expect(suggestServiceForConnection({ id: 'x', name: 'my posthog', url: 'https://example.com/mcp' })?.id).toBe('posthog')
    expect(suggestServiceForConnection({ id: 'x', name: 'Their CRM', url: 'https://crm.example.com/mcp' })).toBeUndefined()
  })

  it('keeps the old catalogs: MCP presets, dashboard key names and social keys are unchanged', () => {
    expect(CONNECTION_CATALOG.slice(0, 6).map((p) => p.id)).toEqual(['vibiz', 'granola', 'notion', 'linear', 'github', 'stripe'])
    expect(CONNECTION_CATALOG.map((p) => p.id)).toEqual(expect.arrayContaining(['posthog', 'mobbin', 'supabase', 'neon', 'sentry', 'firecrawl', 'tavily', 'figma', 'hubspot', 'asana']))
    expect(presetForUrl('https://api.githubcopilot.com/mcp')?.auth).toBe('token')
    expect(Object.fromEntries(DASHBOARD_CATALOG.map((d) => [d.id, d.keys.map((k) => `${k.name}${k.required ? '' : '?'}`)]))).toEqual({
      gsc: ['GSC_SERVICE_ACCOUNT_JSON', 'PAGESPEED_API_KEY?'],
      geo: ['OPENAI_API_KEY?', 'PERPLEXITY_API_KEY?'],
      plausible: ['PLAUSIBLE_API_KEY'],
      posthog: ['POSTHOG_PERSONAL_API_KEY'],
      activation: ['POSTHOG_PERSONAL_API_KEY'],
      stripe: ['STRIPE_RESTRICTED_KEY'],
      github: ['GITHUB_TOKEN?']
    })
    for (const d of DASHBOARD_CATALOG) for (const sid of d.services) expect(serviceById(sid), d.id).toBeTruthy()
    expect(Object.fromEntries(SOCIAL_CHANNELS.map((c) => [c.id, c.keys.map((k) => k.name)]))).toEqual({
      x: ['X_API_KEY', 'X_API_SECRET', 'X_ACCESS_TOKEN', 'X_ACCESS_TOKEN_SECRET'],
      linkedin: ['LINKEDIN_ACCESS_TOKEN'],
      instagram: ['INSTAGRAM_ACCESS_TOKEN', 'INSTAGRAM_USER_ID'],
      tiktok: ['TIKTOK_ACCESS_TOKEN'],
      youtube: ['YOUTUBE_API_KEY']
    })
    expect(SOCIAL_CHANNELS.find((c) => c.id === 'x')!.mcpMatch).toEqual(['twitter'])
  })

  it('every service has a principia://connect link, with an optional purpose', () => {
    for (const s of SERVICE_REGISTRY) expect(CONNECT_TOOL_IDS).toContain(s.id)
    expect(connectLink('posthog', CO, 'dashboard')).toBe(`principia://connect/posthog?purpose=dashboard&company=${CO}`)
    expect(parseDeepLink(`principia://connect/posthog?purpose=dashboard&company=${CO}`)).toEqual({ kind: 'connect', tool: 'posthog', purpose: 'dashboard', companyId: CO })
    expect(parseDeepLink('principia://connect/gsc')).toEqual({ kind: 'connect', tool: 'google-search-console' })
    expect(parseDeepLink('principia://connect/posthog?purpose=steal')).toBeNull()
  })
})

describe('service status (one connection, any form)', () => {
  it('a key alone connects the service: dashboard, agent tools and the vendor MCP from the key', () => {
    const st = status('posthog', hold({ keys: [key('POSTHOG_PERSONAL_API_KEY')] }))
    expect(st.state).toBe('connected')
    expect(st.chip).toBe('Connected · key')
    expect(st.purposes.dashboard).toMatchObject({ ok: true, via: 'key' })
    expect(st.purposes.agentTools).toMatchObject({ ok: true, via: 'mcp' })
    expect(st.purposes.sessionReplay?.ok).toBe(true)
    expect(st.forms.find((f) => f.virtual)).toMatchObject({ kind: 'mcp', connectionId: 'svc:posthog' })
  })

  it('an older key name counts (POSTHOG_API_KEY), and so does a Shared key', () => {
    expect(status('posthog', hold({ keys: [key('POSTHOG_API_KEY')] })).state).toBe('connected')
    const shared = status('plausible', hold({ keys: [key('PLAUSIBLE_API_KEY', 'shared')] }))
    expect(shared.state).toBe('connected')
    expect(shared.forms[0].detail).toContain('Shared')
  })

  it('a browser sign-in alone connects agents but cannot fill a REST dashboard, and says what fixes it', () => {
    const st = status('stripe', hold({ connections: [conn({ url: 'https://mcp.stripe.com' })] }))
    expect(st.state).toBe('connected')
    expect(st.purposes.agentTools?.ok).toBe(true)
    expect(st.purposes.dashboard).toMatchObject({ ok: false, fix: 'key' })
    expect(st.purposes.dashboard?.why).toBe('The revenue dashboard needs a read-only restricted key (rk_…). Your sign-in can’t be used for it.')
    expect(st.purposes.dashboard?.fixKey).toBe('STRIPE_RESTRICTED_KEY')
    expect(st.forms.some((f) => f.virtual)).toBe(false)
  })

  it('PostHog: a sign-in alone fills its dashboard too (it reads through the MCP sign-in), and sessions and questions', () => {
    const st = status('posthog', hold({ connections: [conn({ url: 'https://mcp.posthog.com/mcp' })] }))
    expect(st.state).toBe('connected')
    expect(st.purposes.dashboard).toMatchObject({ ok: true, via: 'mcp' })
    expect(st.purposes.askData?.ok).toBe(true)
    expect(st.purposes.sessionReplay?.ok).toBe(true)
  })

  it('both forms: the real sign-in serves agents, no key-backed duplicate', () => {
    const st = status('posthog', hold({ keys: [key('POSTHOG_PERSONAL_API_KEY')], connections: [conn({ url: 'https://mcp.posthog.com/mcp' })] }))
    expect(st.chip).toBe('Connected · key + signed in')
    expect(st.forms.filter((f) => f.kind === 'mcp')).toHaveLength(1)
  })

  it('a key a check turned down needs attention (a PostHog project key, a dashboard’s invalid_key)', () => {
    const st = status('posthog', hold({ keys: [key('POSTHOG_PERSONAL_API_KEY')], keyProblems: { POSTHOG_PERSONAL_API_KEY: 'That is a project key' } }))
    expect(st.state).toBe('attention')
    expect(st.forms[0].problem).toBe('That is a project key')
    // no working form, so agents get no key-backed MCP either
    expect(st.forms.some((f) => f.virtual)).toBe(false)
  })

  it('another company’s connection never counts; a turned-off one is off; Vibiz never signed in is not connected', () => {
    expect(status('notion', hold({ connections: [conn({ url: 'https://mcp.notion.com/mcp', companyIds: ['co_other'] })] })).state).toBe('notConnected')
    expect(status('notion', hold({ connections: [conn({ url: 'https://mcp.notion.com/mcp', companyIds: undefined })] })).state).toBe('connected')
    expect(status('notion', hold({ connections: [conn({ url: 'https://mcp.notion.com/mcp', enabled: false })] })).state).toBe('off')
    expect(status('vibiz', hold({ connections: [conn({ id: 'vibiz', url: 'https://www.vibiz.ai/api/mcp', authStatus: 'disconnected', companyIds: undefined })] })).state).toBe('notConnected')
  })

  it('Stripe: the restricted key fills the dashboard; the secret key reaches agents but no dashboard; an agent key gives MCP tools', () => {
    const restricted = status('stripe', hold({ keys: [key('STRIPE_RESTRICTED_KEY')] }))
    expect(restricted.purposes.dashboard?.ok).toBe(true)
    expect(restricted.forms.some((f) => f.virtual)).toBe(false)
    const secret = status('stripe', hold({ keys: [key('STRIPE_API_KEY')] }))
    expect(secret.state).toBe('connected')
    expect(secret.purposes.dashboard?.ok).toBe(false)
    expect(secret.purposes.agentTools).toMatchObject({ ok: true, via: 'key' })
    const agent = status('stripe', hold({ keys: [key('STRIPE_AGENT_API_KEY')] }))
    expect(agent.purposes.agentTools).toMatchObject({ ok: true, via: 'mcp' })
  })

  it('accounts and Principia’s connectors count: GitHub by gh, Linear sync, Slack', () => {
    const gh = status('github', hold({ accounts: { github: { handle: 'diego', connectedAt: '2026-10-01' } }, gh: 'ok' }))
    expect(gh.state).toBe('connected')
    expect(gh.purposes.dashboard?.ok).toBe(true)
    expect(status('github', hold({ accounts: { github: { handle: 'diego', connectedAt: '2026-10-01' } }, gh: 'signedOut' })).state).toBe('attention')
    const lin = status('linear', hold({ linear: { connected: true, problem: null }, keys: [key('LINEAR_API_KEY')] }))
    expect(lin.purposes.sync?.ok).toBe(true)
    expect(lin.purposes.agentTools?.ok).toBe(true)
    expect(status('slack', hold({ slack: 'connected' })).state).toBe('connected')
    expect(status('slack', hold({ slack: 'set-up' })).state).toBe('attention')
  })

  it('reuse: another company’s key counts, marked as reused', () => {
    const src = hold({ companyId: 'co_src', keys: [key('POSTHOG_PERSONAL_API_KEY')] })
    const st = serviceStatus(serviceById('posthog')!, hold(), { sourceCompany: { companyId: 'co_src', name: 'Northwind' } }, src)
    expect(st.state).toBe('connected')
    expect(st.sharedFrom).toEqual({ companyId: 'co_src', name: 'Northwind' })
    expect(st.forms[0].keyNames?.[0].source).toBe('reused')
  })

  it('soon and setup services say so honestly', () => {
    expect(status('shopify', hold()).state).toBe('soon')
    expect(status('figma', hold()).state).toBe('setup')
    expect(status('meta-ads', hold()).chip).toBe('Coming soon')
  })

  it('never carries a key value (only names and masks)', () => {
    const st = status('posthog', hold({ keys: [key('POSTHOG_PERSONAL_API_KEY')] }))
    expect(JSON.stringify(st)).not.toMatch(/phx_|secret/i)
  })

  it('fills a capability link from non-secret settings (https only)', () => {
    const open = mcpForm(serviceById('posthog')!) && serviceById('posthog')!.capabilities.find((c) => c.purpose === 'sessionReplay')!.open
    expect(capabilityLink(open, { host: 'https://eu.posthog.com', projectId: '42' })).toBe('https://eu.posthog.com/project/42/replay/home')
    expect(capabilityLink(open, { projectId: '42' })).toBeNull()
    expect(capabilityLink(open, { host: 'javascript:alert(1)//', projectId: '42' })).toBeNull()
  })
})
