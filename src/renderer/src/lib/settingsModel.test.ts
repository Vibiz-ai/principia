import { describe, expect, it } from 'vitest'
import { APP_SECTIONS, companySections, normalizeSection, pickTarget, prefixHint, resolveSection, taskPrefixProblem } from './settingsModel'

describe('Settings in two scopes (design §2.4)', () => {
  it('This company and App list the sections the step asks for', () => {
    expect(companySections({ personal: false, code: true }).map((s) => s.label)).toEqual(['General', 'Team & autonomy', 'Connections', 'Repositories', 'Keys & secrets', 'Danger zone'])
    // no code: no Repositories (Diego's page stays out of Maya's way)
    expect(companySections({ personal: false, code: false }).map((s) => s.id)).not.toContain('repos')
    expect(companySections({ personal: true, code: false }).map((s) => s.id)).toEqual(['company', 'connections', 'repos', 'keys'])
    expect(APP_SECTIONS.map((s) => s.label)).toEqual(['General', 'AI providers', 'Notifications', 'Cloud sync', 'Storage', 'Experimental', 'About'])
  })
  it('old names still open: Agents → AI providers, Data → Storage', () => {
    expect(normalizeSection('agents')).toBe('providers')
    expect(normalizeSection('data')).toBe('storage')
  })
  it('a company page in All companies asks which company first, so keys never list across clients', () => {
    const all = { inCompany: false, personal: false, code: false }
    expect(resolveSection('keys', all)).toBe('pick')
    expect(resolveSection('connections', all)).toBe('pick')
    expect(resolveSection(undefined, all)).toBe('general')
    expect(resolveSection('providers', all)).toBe('providers')
    const nw = { inCompany: true, personal: false, code: false }
    expect(resolveSection(undefined, nw)).toBe('company')
    expect(resolveSection('repos', nw)).toBe('company')
    expect(resolveSection('keys', nw)).toBe('keys')
  })
  it('the task prefix rule is said before saving', () => {
    const cos = [
      { id: 'co_nw', name: 'Northwind Coffee', taskPrefix: 'NC' },
      { id: 'co_la', name: 'Ledgerly App', taskPrefix: 'LA' },
      { id: 'co_personal', name: 'Personal', taskPrefix: 'PRN', system: 'personal' }
    ]
    expect(taskPrefixProblem('NW', 'co_nw', cos)).toBeNull()
    expect(taskPrefixProblem('nw', 'co_nw', cos)).toBeNull()
    expect(taskPrefixProblem('LA', 'co_nw', cos)).toBe('Ledgerly App already uses LA. Choose another prefix.')
    expect(taskPrefixProblem('PRN', 'co_nw', cos)).toMatch(/Personal/)
    expect(taskPrefixProblem('1X', 'co_nw', cos)).toMatch(/starting with a letter/)
    expect(taskPrefixProblem('TOOLONG', 'co_nw', cos)).toMatch(/2 to 5/)
    expect(taskPrefixProblem('', 'co_nw', cos)).toBeNull()
  })
})

describe('Pick a company keeps the section asked for', () => {
  it('⌘K Keys & secrets in All companies opens Keys in the company picked, not Connections', () => {
    expect(pickTarget('keys')).toBe('keys')
    expect(pickTarget('team')).toBe('team')
    expect(pickTarget('providers')).toBe('company')
    expect(pickTarget(undefined)).toBe('company')
  })
})

describe('the task prefix example names the company itself', () => {
  it('Ledgerly App reads LA, never Northwind’s NW', () => {
    expect(prefixHint('Ledgerly App')).toBe('LA')
    expect(prefixHint('Harbor Dental Group')).toBe('HDG')
    expect(prefixHint('Acme')).toBe('ACM')
    expect(prefixHint('42')).toBe('CO')
  })
})
