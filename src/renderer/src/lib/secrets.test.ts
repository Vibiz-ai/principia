import { describe, expect, it } from 'vitest'
import type { AgentProfile, SecretMeta } from '@shared/types'
import { SECRET_NAME_RE, injectedNames, isLiveKey, looksLikeEnvBlob, profilesReferencing, subscriptionNote } from './secrets'

const prof = (p: Partial<AgentProfile>): AgentProfile => ({
  id: 'p',
  name: 'Claude',
  adapter: 'claude',
  model: null,
  extraArgs: [],
  permissionMode: 'bypass',
  secretNames: ['*'],
  useApiKeyAuth: false,
  createdAt: '',
  updatedAt: '',
  ...p
})
const sec = (name: string): SecretMeta => ({ name, label: name, masked: 'x', createdAt: '', updatedAt: '', lastUsedAt: null })
const vault = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'FAL_KEY'].map(sec)

describe('secrets (SPEC A6)', () => {
  it('claude never receives Anthropic auth vars unless opted in', () => {
    expect(injectedNames(prof({}), vault)).toEqual(['OPENAI_API_KEY', 'FAL_KEY'])
    expect(injectedNames(prof({ useApiKeyAuth: true }), vault)).toEqual(['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'FAL_KEY'])
    expect(injectedNames(prof({ adapter: 'codex' }), vault)).toEqual(['ANTHROPIC_API_KEY', 'FAL_KEY'])
    expect(injectedNames(prof({ adapter: 'shell' }), vault)).toHaveLength(3)
    expect(injectedNames(prof({ secretNames: ['FAL_KEY'] }), vault)).toEqual(['FAL_KEY'])
  })
  it('notes subscription logins on the key rows', () => {
    expect(subscriptionNote('ANTHROPIC_API_KEY', [prof({})])).toMatch(/Not given to Claude/)
    expect(subscriptionNote('ANTHROPIC_API_KEY', [prof({ useApiKeyAuth: true })])).toBeNull()
    expect(subscriptionNote('OPENAI_API_KEY', [])).toMatch(/Codex/)
    expect(subscriptionNote('FAL_KEY', [])).toBeNull()
  })
  it('helpers', () => {
    expect(SECRET_NAME_RE.test('MY_KEY')).toBe(true)
    expect(SECRET_NAME_RE.test('my-key')).toBe(false)
    expect(isLiveKey('sk_live…a1b2')).toBe(true)
    expect(isLiveKey('sk-…a1b2')).toBe(false)
    expect(looksLikeEnvBlob('A=1\nB=2\n# c')).toBe(true)
    expect(looksLikeEnvBlob('sk-abc123')).toBe(false)
    expect(profilesReferencing('FAL_KEY', [prof({}), prof({ id: 'q', secretNames: ['FAL_KEY'] })]).map((p) => p.id)).toEqual(['q'])
  })
})
