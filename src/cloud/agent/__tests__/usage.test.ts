import { describe, expect, it } from 'vitest'
import { usageFromLog } from '../usage'

const claude = [
  '$ claude -p',
  '# cwd: /x',
  '',
  JSON.stringify({ type: 'system', subtype: 'init', session_id: 's', model: 'claude' }),
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 10, output_tokens: 2 } } }),
  JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'hi', total_cost_usd: 0.0123, usage: { input_tokens: 120, output_tokens: 30 } })
].join('\n')
const codex = [JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 200, output_tokens: 40 } }), JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 50, output_tokens: 10 } })].join('\n')
const gemini = [JSON.stringify({ type: 'init', session_id: 'g' }), JSON.stringify({ type: 'result', status: 'success', stats: { input_tokens: 50, output_tokens: 7 } })].join('\n')

describe('usage from step logs', () => {
  it('claude: result usage and cost; dollars only for API keys', () => {
    expect(usageFromLog('claude', claude, 'anthropic_api_key')).toEqual({ inputTokens: 120, outputTokens: 30, usd: 0.0123 })
    expect(usageFromLog('claude', claude, 'claude_oauth_token')).toEqual({ inputTokens: 120, outputTokens: 30, usd: null })
  })
  it('codex: turn token counts summed, never dollars', () => {
    expect(usageFromLog('codex', codex, 'openai_api_key')).toEqual({ inputTokens: 250, outputTokens: 50, usd: null })
    expect(usageFromLog('codex', codex, 'codex_auth_json')).toEqual({ inputTokens: 250, outputTokens: 50, usd: null })
  })
  it('gemini: stats', () => {
    expect(usageFromLog('gemini', gemini, 'gemini_api_key')).toEqual({ inputTokens: 50, outputTokens: 7, usd: null })
  })
  it('no usage for shell or a log without a result', () => {
    expect(usageFromLog('shell', 'hello', null)).toBeNull()
    expect(usageFromLog('claude', 'not json\n', null)).toBeNull()
  })
})
