/**
 * The Slack app manifest (SLACK.md §3.1, PO-S1, PO-S2). Single source; docs/slack-app-manifest.json is a copy and a
 * unit test asserts they are equal. `createUrl` pre-fills api.slack.com's "Create from manifest" dialog.
 */
import { SLACK_BOT_EVENTS, SLACK_REQUIRED_SCOPES } from '../../../../shared/slack'

export const REQUIRED_SCOPES: readonly string[] = SLACK_REQUIRED_SCOPES
export const BOT_EVENTS: readonly string[] = SLACK_BOT_EVENTS
export const MAX_APP_NAME = 35

export interface SlackManifest {
  json: Record<string, unknown>
  /** JSON text (pretty) for Copy manifest. */
  jsonText: string
  yaml: string
  createUrl: string
}

export function manifestObject(name = 'Hive'): Record<string, unknown> {
  const n = name.trim().slice(0, MAX_APP_NAME) || 'Hive'
  return {
    _metadata: { major_version: 2, minor_version: 1 },
    display_information: {
      name: n,
      description: 'Hive on your Mac: read your Slack threads, draft replies with agents, and get your Hive alerts here.',
      long_description:
        'Hive is a native Mac cockpit for coding agents. This app connects your workspace to Hive over Socket Mode (an outbound connection from your Mac; nothing is hosted publicly). Hive reads the channels you invite it to, direct messages with the bot, and messages that mention it, keeps a local copy for search, and lets agents draft replies that you approve in Hive before they are sent. Workflows can also be triggered by Slack messages, and Hive sends your workflow alerts to you as direct messages. Beyond reading channels, DMs and mentions, it asks for three permissions so you never need to reinstall: channels:join (join a public channel only when you click Join in Hive), mpim:read with message.mpim (group DMs the bot is added to) and member_joined_channel (notice when the bot is invited, to load that channel). Remove the bot from a channel at any time to stop Hive from reading it.',
      background_color: '#1a1a1a'
    },
    features: {
      app_home: { home_tab_enabled: false, messages_tab_enabled: true, messages_tab_read_only_enabled: false },
      bot_user: { display_name: 'hive', always_online: false }
    },
    oauth_config: { scopes: { bot: [...REQUIRED_SCOPES] } },
    settings: {
      event_subscriptions: { bot_events: [...BOT_EVENTS] },
      interactivity: { is_enabled: false },
      org_deploy_enabled: false,
      socket_mode_enabled: true,
      token_rotation_enabled: false
    }
  }
}

/** Tiny YAML emitter for the manifest shape (objects, arrays of scalars, strings, numbers, booleans). */
export function toYaml(v: unknown, indent = 0): string {
  const pad = '  '.repeat(indent)
  const scalar = (x: unknown): string => {
    if (typeof x === 'string') return /^[A-Za-z0-9_.:/#-]+$/.test(x) && !/^(true|false|null|yes|no|on|off|\d.*)$/i.test(x) ? x : JSON.stringify(x)
    if (x === null || x === undefined) return 'null'
    return String(x)
  }
  if (Array.isArray(v)) return v.map((x) => `${pad}- ${scalar(x)}`).join('\n')
  if (v && typeof v === 'object') {
    return Object.entries(v as Record<string, unknown>)
      .map(([k, x]) => {
        if (Array.isArray(x)) return x.length ? `${pad}${k}:\n${toYaml(x, indent + 1)}` : `${pad}${k}: []`
        if (x && typeof x === 'object') return `${pad}${k}:\n${toYaml(x, indent + 1)}`
        return `${pad}${k}: ${scalar(x)}`
      })
      .join('\n')
  }
  return `${pad}${scalar(v)}`
}

export function buildManifest(opts: { name?: string } = {}): SlackManifest {
  const json = manifestObject(opts.name)
  return {
    json,
    jsonText: JSON.stringify(json, null, 2),
    yaml: `${toYaml(json)}\n`,
    createUrl: `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(JSON.stringify(json))}`
  }
}
