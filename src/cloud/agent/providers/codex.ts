/**
 * Codex credentials in a run (CLOUD.md §7.2). openai_api_key: `codex login --with-api-key` (key on stdin) into the
 * run's CODEX_HOME before the first codex step. codex_auth_json: the ChatGPT sign-in cache written to
 * `<CODEX_HOME>/auth.json` (0600) with `cli_auth_credentials_store = "file"`; after the run, a refreshed file is
 * handed back (ports.saveProviderCredential). codex_access_token is not in v1.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ProviderMaterial } from '../../contract'
import { notInV1 } from '../errors'
import { capture } from '../proc'
import type { RunSandbox } from '../sandbox'
import type { ProviderSetup } from './materialize'

export const OPENAI_API_KEY_RE = /^sk-[A-Za-z0-9_-]{20,}$/
/** Codex keeps its sign-in in a file (never the OS keyring, which a container has not got). */
export const CODEX_CONFIG = 'cli_auth_credentials_store = "file"\n'

export function codexAuthPath(box: RunSandbox): string {
  return join(box.codexHome, 'auth.json')
}

export function materializeCodex(box: RunSandbox, m: ProviderMaterial, codexBin: string): ProviderSetup {
  const config = { path: join(box.codexHome, 'config.toml'), content: CODEX_CONFIG }
  if (m.kind === 'codex_auth_json') {
    const original = m.value
    return {
      env: {},
      files: [config, { path: codexAuthPath(box), content: original }],
      readback: () => {
        let now: string
        try {
          now = readFileSync(codexAuthPath(box), 'utf8')
        } catch {
          return null
        }
        return now.trim() && authJsonChanged(original, now) ? now : null
      }
    }
  }
  if (m.kind === 'openai_api_key') {
    const key = m.value.trim()
    return {
      env: {},
      files: [config],
      before: async (env) => {
        const r = await capture(codexBin, ['login', '--with-api-key'], { env, stdin: `${key}\n`, timeoutMs: 30_000 })
        if (r.error || r.code !== 0) throw new Error('Codex could not sign in with the OpenAI API key')
      }
    }
  }
  if (m.kind === 'codex_access_token') throw notInV1('Codex access tokens')
  throw new Error(`Codex cannot use a ${m.kind} credential`)
}

/** Did the CLI rewrite the sign-in (token refresh)? Compared as JSON so whitespace never counts as a change. */
export function authJsonChanged(before: string, after: string): boolean {
  try {
    return JSON.stringify(JSON.parse(before)) !== JSON.stringify(JSON.parse(after))
  } catch {
    return before.trim() !== after.trim()
  }
}

export function codexShapeProblem(m: ProviderMaterial): string | null {
  if (m.kind === 'openai_api_key') return OPENAI_API_KEY_RE.test(m.value.trim()) ? null : "That doesn't look like an OpenAI API key (it starts with sk-)."
  if (m.kind === 'codex_auth_json') {
    try {
      const o = JSON.parse(m.value) as { tokens?: { access_token?: unknown; refresh_token?: unknown }; OPENAI_API_KEY?: unknown }
      if ((o.tokens && typeof o.tokens.refresh_token === 'string') || typeof o.OPENAI_API_KEY === 'string') return null
    } catch {
      /* below */
    }
    return 'Codex is signed out. Sign in with ChatGPT again.'
  }
  if (m.kind === 'codex_access_token') return 'Codex access tokens are not in this version of Principia Cloud.'
  return 'Codex uses a ChatGPT sign-in or an OpenAI API key.'
}
