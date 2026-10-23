import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ProviderMaterial } from '../../contract'
import { ProcessSandbox } from '../sandbox'
import { materializeProviders } from '../providers/materialize'
import { authJsonChanged } from '../providers/codex'
import { classifyProviderOutput, cliVersions, testProvider, type Bins } from '../providers/test'
import { Redactor } from '../redact'
import { CloudRuntimeError } from '../errors'
import { FAKE_BINS, tmp } from './fakes'

const bins: Bins = { ...FAKE_BINS, git: 'git' }
const sandbox = () => {
  const root = tmp()
  return new ProcessSandbox({ runtimeDir: join(root, 'runtime'), workspaceDir: join(root, 'workspace'), hostEnv: { PATH: process.env.PATH, SHELL: '/bin/sh' } })
}
const mat = (adapter: ProviderMaterial['adapter'], kind: ProviderMaterial['kind'], value: string): ProviderMaterial => ({ credentialId: `cred_${kind}`, adapter, kind, value })
const AUTH_JSON = JSON.stringify({ tokens: { id_token: 'id.token.value.0123456789', access_token: 'access-token-0123456789abc', refresh_token: 'refresh-token-0123456789abc', account_id: 'acct' }, last_refresh: '2026-10-20T10:00:00Z' })
const SA = JSON.stringify({ type: 'service_account', project_id: 'acme-vertex', client_email: 'agent@acme-vertex.iam.gserviceaccount.com', private_key: '-----BEGIN PRIVATE KEY-----\nMIIabc\n-----END PRIVATE KEY-----\n' })
const mode = (p: string) => statSync(p).mode & 0o777

describe('provider materialization (every v1 credential kind)', () => {
  it('claude_oauth_token -> CLAUDE_CODE_OAUTH_TOKEN; anthropic_api_key -> ANTHROPIC_API_KEY', () => {
    const sb = sandbox()
    const box = sb.prepare('crun_claude')
    const a = materializeProviders(box, [mat('claude', 'claude_oauth_token', 'sk-ant-oat01-aaaaaaaaaaaaaaaaaaaaaaaa')], ['claude'], { codex: bins.codex })
    expect(a.env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-aaaaaaaaaaaaaaaaaaaaaaaa' })
    const b = materializeProviders(box, [mat('claude', 'anthropic_api_key', 'sk-ant-api03-bbbbbbbbbbbbbbbbbbbbbbbb')], ['claude'], { codex: bins.codex })
    expect(b.env).toEqual({ ANTHROPIC_API_KEY: 'sk-ant-api03-bbbbbbbbbbbbbbbbbbbbbbbb' })
    expect(b.readback()).toEqual([])
  })

  it('only the adapters the run uses are materialized; a missing one is reported', () => {
    const sb = sandbox()
    const box = sb.prepare('crun_only')
    const m = materializeProviders(box, [mat('claude', 'claude_oauth_token', 'sk-ant-oat01-aaaaaaaaaaaaaaaaaaaaaaaa'), mat('gemini', 'gemini_api_key', 'AIza'.padEnd(39, 'x'))], ['codex', 'claude'], { codex: bins.codex })
    expect(Object.keys(m.env)).toEqual(['CLAUDE_CODE_OAUTH_TOKEN'])
    expect(m.missing).toEqual(['codex'])
  })

  it('codex_auth_json: auth.json 0600 with the file store, write-back only when the CLI refreshed it, gone after cleanup', () => {
    const sb = sandbox()
    const box = sb.prepare('crun_codex')
    const m = materializeProviders(box, [mat('codex', 'codex_auth_json', AUTH_JSON)], ['codex'], { codex: bins.codex })
    const auth = join(box.codexHome, 'auth.json')
    expect(readFileSync(auth, 'utf8')).toBe(AUTH_JSON)
    expect(mode(auth)).toBe(0o600)
    expect(readFileSync(join(box.codexHome, 'config.toml'), 'utf8')).toContain('cli_auth_credentials_store = "file"')
    expect(m.env).toEqual({})
    // unchanged (whitespace only) = nothing to save
    writeFileSync(auth, JSON.stringify(JSON.parse(AUTH_JSON), null, 2))
    expect(m.readback()).toEqual([])
    const refreshed = JSON.stringify({ ...JSON.parse(AUTH_JSON), tokens: { ...JSON.parse(AUTH_JSON).tokens, access_token: 'new-access-token-0123456789' } })
    writeFileSync(auth, refreshed)
    expect(m.readback()).toEqual([{ credentialId: 'cred_codex_auth_json', adapter: 'codex', kind: 'codex_auth_json', value: refreshed }])
    sb.cleanup(box)
    expect(existsSync(auth)).toBe(false)
    expect(authJsonChanged('{"a":1}', '{ "a": 1 }')).toBe(false)
  })

  it('openai_api_key: codex login --with-api-key reads the key on stdin into the run CODEX_HOME', async () => {
    const sb = sandbox()
    const box = sb.prepare('crun_openai')
    const key = 'sk-proj-cccccccccccccccccccccccc'
    const m = materializeProviders(box, [mat('codex', 'openai_api_key', key)], ['codex'], { codex: bins.codex })
    expect(m.env).toEqual({})
    await m.before(sb.buildEnv(box, m.env))
    expect(JSON.parse(readFileSync(join(box.codexHome, 'auth.json'), 'utf8'))).toEqual({ OPENAI_API_KEY: key })
    const bad = materializeProviders(sb.prepare('crun_openai_bad'), [mat('codex', 'openai_api_key', 'sk-bad-dddddddddddddddddddd')], ['codex'], { codex: bins.codex })
    await expect(bad.before(sb.buildEnv(sb.prepare('crun_openai_bad'), {}))).rejects.toThrow(/could not sign in/)
  })

  it('codex_access_token is not in v1', () => {
    const sb = sandbox()
    let err: unknown
    try {
      materializeProviders(sb.prepare('crun_at'), [mat('codex', 'codex_access_token', 'at-token-0123456789')], ['codex'], { codex: bins.codex })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(CloudRuntimeError)
    expect((err as CloudRuntimeError).error).toBe('not_in_v1')
  })

  it('gemini_api_key and google_service_account', () => {
    const sb = sandbox()
    const box = sb.prepare('crun_gemini')
    const a = materializeProviders(box, [mat('gemini', 'gemini_api_key', 'AIzaSyD-0123456789abcdefghijklmnopqrstu')], ['gemini'], { codex: bins.codex })
    expect(a.env).toEqual({ GEMINI_API_KEY: 'AIzaSyD-0123456789abcdefghijklmnopqrstu' })
    expect(JSON.parse(readFileSync(join(box.geminiDir, 'settings.json'), 'utf8')).security.auth.selectedType).toBe('gemini-api-key')
    const b = materializeProviders(box, [mat('gemini', 'google_service_account', SA)], ['gemini'], { codex: bins.codex })
    const file = join(box.geminiDir, 'service-account.json')
    expect(b.env).toMatchObject({ GOOGLE_APPLICATION_CREDENTIALS: file, GOOGLE_GENAI_USE_VERTEXAI: 'true', GOOGLE_CLOUD_PROJECT: 'acme-vertex' })
    expect(readFileSync(file, 'utf8')).toBe(SA)
    expect(mode(file)).toBe(0o600)
    sb.cleanup(box)
    expect(existsSync(file)).toBe(false)
  })
})

describe('providers.test', () => {
  const deps = () => ({ sandbox: sandbox(), bins, now: () => new Date('2026-10-21T10:00:00Z'), redactor: new Redactor() })

  it('maps CLI output to founder-readable, redacted details', () => {
    const now = new Date('2026-10-21T10:00:00Z')
    const r = (text: string, code = 1) => classifyProviderOutput({ adapter: 'claude', kind: 'claude_oauth_token' }, { code, timedOut: false, error: null, text }, '2.1.290', now, (s) => s.replaceAll('sk-ant-oat01-secret', '[REDACTED]'))
    expect(r('OAuth token has expired. Please obtain a new token')).toEqual({ ok: false, detail: 'Claude token expired. Connect Claude again.' })
    expect(r('API Error: 401 {"type":"error","error":{"type":"authentication_error"}}')).toEqual({ ok: false, detail: 'Claude token expired. Connect Claude again.' })
    expect(r("You've hit your session limit · resets 3pm (UTC)").detail).toMatch(/^Claude Code hit its usage limit\./)
    expect(r('boom sk-ant-oat01-secret').detail).toBe('Claude Code failed: boom [REDACTED]')
    expect(r('{"result":"OK"}', 0)).toEqual({ ok: true, detail: 'claude 2.1.290 · subscription token accepted' })
    expect(classifyProviderOutput({ adapter: 'codex', kind: 'codex_auth_json' }, { code: 1, timedOut: false, error: null, text: 'Not logged in' }, null, now, (s) => s).detail).toBe('Codex is signed out. Sign in with ChatGPT again.')
    expect(classifyProviderOutput({ adapter: 'gemini', kind: 'gemini_api_key' }, { code: 1, timedOut: false, error: null, text: 'API key not valid. Please pass a valid API key.' }, null, now, (s) => s).detail).toBe('Google rejected the Gemini API key.')
    expect(classifyProviderOutput({ adapter: 'codex', kind: 'openai_api_key' }, { code: null, timedOut: true, error: null, text: '' }, null, now, (s) => s).detail).toBe('Codex did not answer within a minute.')
  })

  it('checks the CLI and the shape without spending a request; live asks for one word', async () => {
    const d = deps()
    expect(await testProvider(mat('claude', 'claude_oauth_token', 'not-a-token'), { live: false }, d)).toEqual({ ok: false, detail: expect.stringMatching(/doesn't look like a Claude token/) })
    expect(await testProvider(mat('claude', 'claude_oauth_token', 'sk-ant-oat01-aaaaaaaaaaaaaaaaaaaaaaaa'), { live: false }, d)).toEqual({ ok: true, detail: 'claude 2.1.290 · subscription token saved (not checked live)' })
    expect(await testProvider(mat('claude', 'claude_oauth_token', 'sk-ant-oat01-expiredaaaaaaaaaaaaaaaaaaa'), { live: true }, d)).toEqual({ ok: false, detail: 'Claude token expired. Connect Claude again.' })
    expect(await testProvider(mat('codex', 'codex_auth_json', AUTH_JSON), { live: false }, d)).toEqual({ ok: true, detail: 'codex 0.120.0 · signed in with ChatGPT' })
    const revoked = JSON.stringify({ tokens: { refresh_token: 'revoked-refresh-token-0000' } })
    expect(await testProvider(mat('codex', 'codex_auth_json', revoked), { live: false }, d)).toEqual({ ok: false, detail: 'Codex is signed out. Sign in with ChatGPT again.' })
    expect(await testProvider(mat('codex', 'openai_api_key', 'sk-bad-0000000000000000000000'), { live: false }, d)).toEqual({ ok: false, detail: 'OpenAI rejected the API key.' })
    expect(await testProvider(mat('gemini', 'gemini_api_key', 'AIzaSyD-0123456789abcdefghijklmnopqrstu'), { live: true }, d)).toEqual({ ok: true, detail: 'gemini 0.9.0 · API key accepted' })
    expect(await testProvider(mat('gemini', 'google_service_account', '{"type":"user"}'), { live: false }, d)).toMatchObject({ ok: false })
    const missing = { ...d, bins: { ...bins, claude: '/nonexistent/claude' } }
    expect(await testProvider(mat('claude', 'anthropic_api_key', 'sk-ant-api03-bbbbbbbbbbbbbbbbbbbbbbbb'), { live: false }, missing)).toEqual({ ok: false, detail: 'Claude Code is not installed in this cloud.' })
    // throwaway homes are removed
    expect(existsSync(join(d.sandbox.runtimeDir, 'runs')) ? readdirSync(join(d.sandbox.runtimeDir, 'runs')) : []).toEqual([])
  })

  it('cliVersions reads each CLI', async () => {
    expect(await cliVersions({ sandbox: sandbox(), bins })).toEqual({ claude: '2.1.290', codex: '0.120.0', gemini: '0.9.0' })
  })
})
