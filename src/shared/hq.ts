/**
 * CHAT-UI.md §11: the main chat. A chat in Personal, the founder's own space, sees every company's headlines and starts
 * work inside one: a Claude chat, or an agent's. The work runs in that company with its own keys, memory and tools; only
 * the headlines and the chat's answer come back. Nothing here reaches a company's keys, memory or connections.
 * Shared and pure: tool names, schemas and the server's instructions.
 */
export const HQ_TOOLS = ['hq_overview', 'hq_start_chat', 'hq_chat_result'] as const
export type HqTool = (typeof HQ_TOOLS)[number]
export const isHqTool = (name: string): name is HqTool => (HQ_TOOLS as readonly string[]).includes(name)

export const HQ_MAX_WAIT_S = 600
export const HQ_LIMITS = { company: 120, agent: 120, prompt: 8000, sessionId: 64 } as const

export const HQ_SERVER_INSTRUCTIONS =
  'You are the main chat of Principia, above all the companies. hq_overview shows what each company has working and what needs the founder. ' +
  'To act on a company, hq_start_chat starts a chat inside it (pass `agent` only when the founder names one), and hq_chat_result brings back its answer. ' +
  'That chat does the work with the company\'s own tools; you never see its keys or memory. Tell the founder which company you started it in.'

export const HQ_TOOL_DEFS = {
  hq_overview: {
    name: 'hq_overview',
    description: 'Every company at a glance: what is working, what needs a decision from the founder (with the question), and how much finished work waits for review.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true }
  },
  hq_start_chat: {
    name: 'hq_start_chat',
    description: 'Starts a chat inside one company with this prompt and returns its session_id. It runs with that company\'s own tools and memory. Write the prompt so it stands alone: that chat cannot see this one.',
    inputSchema: {
      type: 'object',
      properties: {
        company: { type: 'string', minLength: 1, maxLength: HQ_LIMITS.company, description: 'The company, by name or id (hq_overview lists them).' },
        prompt: { type: 'string', minLength: 1, maxLength: HQ_LIMITS.prompt, description: 'What to do, in full.' },
        agent: { type: 'string', maxLength: HQ_LIMITS.agent, description: 'Only when the founder named an agent: its name. Omit for a Claude chat.' }
      },
      required: ['company', 'prompt'],
      additionalProperties: false
    }
  },
  hq_chat_result: {
    name: 'hq_chat_result',
    description: 'How a chat started with hq_start_chat is doing, and its latest answer. Status: working, needs_you (it waits for the founder inside that chat) or done.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', minLength: 1, maxLength: HQ_LIMITS.sessionId },
        wait_s: { type: 'number', minimum: 0, maximum: HQ_MAX_WAIT_S, description: 'Wait this long for it to finish before answering. Default 0.' }
      },
      required: ['session_id'],
      additionalProperties: false
    },
    annotations: { readOnlyHint: true }
  }
} as const
