import { describe, expect, it } from 'vitest'
import type { CloudRouteName } from '../../../shared/cloud'
import { HiveError } from '../../../shared/errors'
import { CloudAccountsSync, type CloudAccountsDeps } from '../accounts'
import type { CloudClient } from '../client'
import { ghToken, type GhExec } from '../../onboarding/github'

const GH = 'gho_MACgithubTOKENvalue0123456789abcdef'

/** A fake cloud: the accounts routes over an in-memory workspace. */
function setup(o: { linked?: boolean; vault?: Record<string, string>; cloudKeys?: string[]; remote?: string[]; gh?: { token: string; login: string | null } | null } = {}) {
  const vault = { ...(o.vault ?? {}) }
  let cloudKeys = [...(o.cloudKeys ?? [])]
  const remote = new Map<string, string>((o.remote ?? []).map((n) => [n, 'theirs']))
  let github: { token: string; login: string | null } | null = null
  const calls: { route: CloudRouteName; params?: Record<string, string>; body?: unknown }[] = []
  const client = {
    async call(route: CloudRouteName, c: { params?: Record<string, string>; body?: unknown } = {}) {
      calls.push({ route, ...c })
      if (route === 'accounts') return { github: github ? { login: github.login, createdAt: 'now', lastUsedAt: null } : null, secrets: [...remote.keys()].sort().map((name) => ({ name, createdAt: 'now', updatedAt: 'now', lastUsedAt: null })) }
      if (route === 'sharedSecretPut') return remote.set(c.params!.name!, (c.body as { value: string }).value)
      if (route === 'sharedSecretDelete') {
        if (!remote.delete(c.params!.name!)) throw new HiveError('not_found', 'No such key.')
        return { ok: true }
      }
      if (route === 'githubAccountPut') return (github = c.body as { token: string; login: string | null })
      if (route === 'githubAccountDelete') return (github = null)
      throw new Error(`unexpected ${route}`)
    }
  } as unknown as CloudClient
  const deps: CloudAccountsDeps = {
    call: (f) => f(client),
    linked: () => o.linked ?? true,
    ghToken: async () => (o.gh === undefined ? { token: GH, login: 'octo' } : o.gh),
    sharedKeyNames: () => Object.keys(vault),
    revealShared: (n) => vault[n]!,
    cloudKeys: () => cloudKeys,
    setCloudKeys: (n) => (cloudKeys = n)
  }
  return { sync: new CloudAccountsSync(deps), vault, remote, calls, cloudKeys: () => cloudKeys, github: () => github }
}

describe('CloudAccountsSync (docs/ACCOUNTS.md)', () => {
  it('marks a Shared key for the cloud and pushes its value; unmarking deletes it there', async () => {
    const t = setup({ vault: { OPENAI_API_KEY: 'sk-one', FAL_KEY: 'fal-one' } })
    const v = await t.sync.setKey('OPENAI_API_KEY', true)
    expect(t.remote.get('OPENAI_API_KEY')).toBe('sk-one')
    expect(t.remote.has('FAL_KEY')).toBe(false)
    expect(v).toMatchObject({ linked: true, inCloud: ['OPENAI_API_KEY'], cloudKeys: ['OPENAI_API_KEY'] })
    const off = await t.sync.setKey('OPENAI_API_KEY', false)
    expect(t.remote.has('OPENAI_API_KEY')).toBe(false)
    expect(off.cloudKeys).toEqual([])
  })

  it('a changed value follows; a key deleted on this Mac is deleted there and forgotten', async () => {
    const t = setup({ vault: { A_KEY: 'v1', B_KEY: 'b' }, cloudKeys: ['A_KEY', 'B_KEY'] })
    await t.sync.sync()
    t.vault.A_KEY = 'v2'
    delete t.vault.B_KEY
    const v = await t.sync.sync()
    expect(t.remote.get('A_KEY')).toBe('v2')
    expect(t.remote.has('B_KEY')).toBe(false)
    expect(v.cloudKeys).toEqual(['A_KEY'])
  })

  it('leaves keys another Mac put in the cloud alone', async () => {
    const t = setup({ vault: { A_KEY: 'mine' }, cloudKeys: ['A_KEY'], remote: ['OTHER_MAC_KEY'] })
    const v = await t.sync.sync()
    expect(v.inCloud).toEqual(['A_KEY', 'OTHER_MAC_KEY'])
  })

  it('only Shared keys can go to the cloud', async () => {
    const t = setup({ vault: {} })
    await expect(t.sync.setKey('COMPANY_ONLY', true)).rejects.toMatchObject({ code: 'not_found' })
  })

  it('without a cloud it only remembers the choice', async () => {
    const t = setup({ linked: false, vault: { A_KEY: 'x' } })
    expect(await t.sync.setKey('A_KEY', true)).toEqual({ linked: false, github: null, inCloud: [], cloudKeys: ['A_KEY'] })
    expect(t.calls).toEqual([])
    t.sync.keysChanged()
    expect(t.calls).toEqual([])
    await expect(t.sync.connectGithub({})).rejects.toMatchObject({ code: 'conflict' })
  })

  it('GitHub from this Mac’s gh sign-in, or a pasted token; never a malformed one', async () => {
    const t = setup()
    const v = await t.sync.connectGithub({})
    expect(t.github()).toEqual({ token: GH, login: 'octo' })
    expect(v.github?.login).toBe('octo')
    await t.sync.connectGithub({ token: '  github_pat_PASTEDtoken0123456789abcdefghij ' })
    expect(t.github()).toEqual({ token: 'github_pat_PASTEDtoken0123456789abcdefghij' })
    await expect(t.sync.connectGithub({ token: 'hunter2' })).rejects.toMatchObject({ code: 'validation' })
    expect((await t.sync.removeGithub()).github).toBeNull()
  })

  it('says how to sign in when gh is not signed in', async () => {
    const t = setup({ gh: null })
    await expect(t.sync.connectGithub({})).rejects.toThrow(/gh auth login/)
  })

  it('overlapping syncs coalesce into one more pass', async () => {
    const t = setup({ vault: { A_KEY: 'x' }, cloudKeys: ['A_KEY'] })
    const [a, b] = await Promise.all([t.sync.sync(), t.sync.sync()])
    expect(a).toEqual(b)
    expect(t.calls.filter((c) => c.route === 'sharedSecretPut')).toHaveLength(2)
  })
})

describe('ghToken', () => {
  const exec = (out: Record<string, { code: number; stdout: string }>): GhExec => (_f, args) => {
    const r = out[args.slice(0, 2).join(' ')] ?? { code: 1, stdout: '' }
    return { promise: Promise.resolve({ ...r, stderr: '', timedOut: false }), kill: async () => undefined }
  }
  it('reads the token and the login', async () => {
    expect(await ghToken({ env: {}, exec: exec({ 'auth token': { code: 0, stdout: `${GH}\n` }, 'api user': { code: 0, stdout: 'octo\n' } }) })).toEqual({ token: GH, login: 'octo' })
  })
  it('is null when gh is signed out or prints something that is not a token', async () => {
    expect(await ghToken({ env: {}, exec: exec({ 'auth token': { code: 1, stdout: '' } }) })).toBeNull()
    expect(await ghToken({ env: {}, exec: exec({ 'auth token': { code: 0, stdout: 'no oauth token found' } }) })).toBeNull()
  })
  it('keeps the token when the login cannot be read', async () => {
    expect(await ghToken({ env: {}, exec: exec({ 'auth token': { code: 0, stdout: GH } }) })).toEqual({ token: GH, login: null })
  })
})
