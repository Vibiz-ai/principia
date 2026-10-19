import { describe, expect, it } from 'vitest'
import { artifactsHint, claudeAdapter } from '../adapters'
import { childKeyNames } from '../env'
import { fakeCtx, profile } from './fakes'

describe('keys hint', () => {
  it('names the vault keys in the env, never their values', () => {
    const h = artifactsHint('/a', ['APIFY_API_KEY', 'FAL_KEY'])
    expect(h).toContain('$ARTIFACTS_DIR (/a)')
    expect(h).toContain('environment variables: APIFY_API_KEY, FAL_KEY')
    expect(artifactsHint('/a')).not.toContain('environment variables')
  })

  it('lists what buildChildEnv injects: profile selection, minus stripped auth vars', () => {
    const ctx = fakeCtx()
    ctx.secretValues = { APIFY_API_KEY: 'apify-secret', ANTHROPIC_API_KEY: 'sk-ant-x', FAL_KEY: 'fal-x' }
    expect(childKeyNames(ctx, claudeAdapter, profile('p', 'claude', { secretNames: ['*'] }))).toEqual(['APIFY_API_KEY', 'FAL_KEY'])
    expect(childKeyNames(ctx, claudeAdapter, profile('p', 'claude', { secretNames: ['FAL_KEY'] }))).toEqual(['FAL_KEY'])
    expect(childKeyNames(ctx, claudeAdapter, profile('p', 'claude', { secretNames: ['*'], useApiKeyAuth: true }))).toContain('ANTHROPIC_API_KEY')
    // a Slack trigger's allow-list wins over the profile's '*'
    expect(childKeyNames(ctx, claudeAdapter, profile('p', 'claude', { secretNames: ['*'] }), ['APIFY_API_KEY'])).toEqual(['APIFY_API_KEY'])
  })
})
