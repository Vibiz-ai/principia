/**
 * Headless claude stdin protocol (LIVE.md §3.1, verified on 2.1.301):
 * `claude -p --input-format stream-json --permission-prompt-tool stdio`. Each stdin line is one JSON message.
 * Also: per-provider decision payloads for hook gates (gemini/cursor, written into answers/<gateId>.json). Pure.
 */
import type { AdapterId } from '../../../shared/types'

const line = (o: unknown): string => `${JSON.stringify(o)}\n`

/** First stdin line: the SDK initialize handshake. */
export const claudeInitialize = (): string => line({ type: 'control_request', request_id: 'init1', request: { subtype: 'initialize' } })

/** Second stdin line: the prompt as a stream-json user message. */
export const claudeUserMessage = (prompt: string): string =>
  line({ type: 'user', message: { role: 'user', content: prompt }, parent_tool_use_id: null, session_id: '' })

export type ClaudeDecision = { behavior: 'allow'; updatedInput: unknown } | { behavior: 'deny'; message: string }

/** Answer to a `control_request can_use_tool`. */
export const claudeControlResponse = (requestId: string, decision: ClaudeDecision): string =>
  line({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response: decision } })

/** Answer to a control request Hive does not support. */
export const claudeControlError = (requestId: string, error = 'unsupported'): string =>
  line({ type: 'control_response', response: { subtype: 'error', request_id: requestId, error } })

export const allowDecision = (input: unknown): ClaudeDecision => ({ behavior: 'allow', updatedInput: input && typeof input === 'object' ? input : {} })
export const denyDecision = (message?: string | null): ClaudeDecision => ({ behavior: 'deny', message: message?.trim() || 'Denied in Hive' })

/**
 * Built-in AskUserQuestion routed through can_use_tool (best effort, unverified): allow with the answer carried in
 * updatedInput.answers keyed by question text.
 */
export function askUserQuestionAllow(input: unknown, answer: string): ClaudeDecision {
  const i = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  const qs = Array.isArray(i.questions) ? (i.questions as Record<string, unknown>[]) : []
  const q = typeof qs[0]?.question === 'string' ? (qs[0].question as string) : 'answer'
  return { behavior: 'allow', updatedInput: { ...i, answers: { ...(i.answers as object | undefined), [q]: answer } } }
}

/**
 * The decision JSON a blocking hook gate prints for its CLI (LIVE.md §3.3, §3.4). Main's hook script copies the
 * answer file's content to stdout verbatim, so the engine writes exactly this.
 */
export function gateDecision(provider: AdapterId, allow: boolean, message?: string | null): Record<string, unknown> {
  const msg = message?.trim() || (allow ? '' : 'Denied in Hive')
  if (provider === 'cursor') return allow ? { permission: 'allow' } : { permission: 'deny', agent_message: msg }
  // gemini: {} allows; decision deny blocks with a reason the model sees
  return allow ? {} : { decision: 'deny', reason: msg }
}
