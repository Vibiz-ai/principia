import { describe, expect, it } from 'vitest'
import { DeepLinkInbox, deepLinkFromArgv, shouldRegisterProtocol } from './deepLinks'

describe('principia:// links in main', () => {
  it('finds the link in a launch argv (last one wins)', () => {
    expect(deepLinkFromArgv(['/Applications/Principia.app/Contents/MacOS/Principia', '--flag', 'principia://connect/stripe'])).toBe('principia://connect/stripe')
    expect(deepLinkFromArgv(['electron', '.', 'principia://home', 'principia://board'])).toBe('principia://board')
    expect(deepLinkFromArgv(['electron', '.'])).toBeNull()
  })

  it('registers the scheme only in a packaged build on the real profile', () => {
    expect(shouldRegisterProtocol({ packaged: true, env: {} })).toBe(true)
    expect(shouldRegisterProtocol({ packaged: false, env: {} })).toBe(false)
    expect(shouldRegisterProtocol({ packaged: true, env: { HIVE_USER_DATA: '/x' } })).toBe(false)
    expect(shouldRegisterProtocol({ packaged: true, env: { HIVE_NO_PROTOCOL: '1' } })).toBe(false)
  })

  it('queues links until the window is there, drops unknown ones, and forwards the canonical text', () => {
    const got: string[] = []
    const warned: unknown[] = []
    const inbox = new DeepLinkInbox()
    expect(inbox.receive('PRINCIPIA://Connect/IG')).toBe('principia://connect/instagram')
    expect(inbox.receive('principia://delete/everything')).toBeNull()
    expect(inbox.receive('https://example.com')).toBeNull()
    inbox.attach({ deliver: (u) => got.push(u), log: { info: () => undefined, warn: (_m, meta) => warned.push(meta) } })
    expect(got).toEqual(['principia://connect/instagram'])
    inbox.receive('principia://board?new=Call%20the%20roaster')
    expect(got[1]).toBe('principia://board?new=Call+the+roaster')
    inbox.receive('principia://nope')
    expect(warned).toEqual([{ length: 16 }])
  })
})
