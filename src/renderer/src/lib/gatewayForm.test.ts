import { describe, it, expect } from 'vitest'
import { connectionProblem, importGatewayConfig } from './gatewayForm'

describe('MCP setup configuration', () => {
  it('imports the remote mcpServers format copied from setup guides', () => {
    expect(importGatewayConfig(JSON.stringify({ mcpServers: { Mobbin: { url: 'https://api.mobbin.com/mcp', headers: { Authorization: 'Bearer example-only' } } } }))).toEqual({ name: 'Mobbin', transport: 'http', url: 'https://api.mobbin.com/mcp', command: undefined, args: undefined, credentials: { Authorization: 'Bearer example-only' } })
  })
  it('imports local argument arrays without shell splitting or evaluation', () => {
    const config = importGatewayConfig(JSON.stringify({ mcpServers: { local: { command: '/tools/server', args: ['--dir', '/project with spaces'], env: { SERVICE_KEY: 'example-only' } } } }))
    expect(config.transport).toBe('stdio')
    expect(config.args).toEqual(['--dir', '/project with spaces'])
    expect(config.credentials).toEqual({ SERVICE_KEY: 'example-only' })
  })
  it('rejects multi-server imports and malformed JSON without exposing pasted credentials', () => {
    expect(() => importGatewayConfig('{"secret":"example-only"')).toThrow('Paste a valid MCP configuration.')
    expect(() => importGatewayConfig('{"mcpServers":{"one":{},"two":{}}}')).toThrow('one MCP server')
    expect(() => importGatewayConfig('[]')).toThrow('must be an object')
  })
  it('requires a usable endpoint and project access before saving', () => {
    expect(connectionProblem('Mobbin', 'http', 'https://api.mobbin.com/mcp', ['/project'])).toBeNull()
    expect(connectionProblem('Local', 'http', 'http://127.0.0.1:3000/mcp', ['/project'])).toBeNull()
    expect(connectionProblem('Remote', 'http', 'http://example.com/mcp', ['/project'])).toMatch(/HTTPS/)
    expect(connectionProblem('Remote', 'http', 'https://user:password@example.com', ['/project'])).toMatch(/authentication fields/)
    expect(connectionProblem('Mobbin', 'http', 'https://api.mobbin.com/mcp', [])).toMatch(/project/)
    expect(connectionProblem('Local', 'stdio', '', ['/project'])).toMatch(/executable/)
  })
})
