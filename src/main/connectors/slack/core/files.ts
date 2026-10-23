/**
 * Thread images (SLACK.md §9.6). Pure: the thread comes from the store (refreshed through sync), bytes come from
 * HttpPort.download and land through an ImageSink, so nothing here touches node:fs. URLs and tokens never leave this
 * module: logs carry the Slack file id only.
 */
import type { SlackFile, SlackMessage } from '../../../../shared/slack'
import { tsCmp } from './format'
import type { Clock, HttpDownload, Logger, SlackStore } from './ports'

export const MAX_THREAD_IMAGES = 5
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024
export const THREAD_REFRESH_MS = 3_000

const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }

/** Where downloaded bytes go. Desktop: a 0600 file in the run's artifacts; returns its path. */
export interface ImageSink {
  write(name: string, bytes: Uint8Array): Promise<string>
}

export interface PickedImage {
  messageTs: string
  file: SlackFile & { urlPrivate: string }
}

/**
 * Image files a HUMAN shared (parent + replies), newest message first, at most `max`. Bot posts, Hive's own posts and
 * deleted messages are skipped, so "look at this screenshot" targets what a person shared.
 */
export function pickThreadImages(msgs: SlackMessage[], isBotUser: (userId: string) => boolean, max = MAX_THREAD_IMAGES): PickedImage[] {
  const out: PickedImage[] = []
  for (const m of [...msgs].sort((a, b) => tsCmp(b.ts, a.ts))) {
    if (m.deleted || m.fromHive || m.botId || m.subtype === 'bot_message' || !m.userId || isBotUser(m.userId)) continue
    for (const f of m.files ?? []) {
      if (!f.urlPrivate || !(f.mimetype ?? '').toLowerCase().startsWith('image/')) continue
      out.push({ messageTs: m.ts, file: { ...f, urlPrivate: f.urlPrivate } })
      if (out.length >= max) return out
    }
  }
  return out
}

/** `<n>-<safe base>.<ext from the real content type>`: unique per run, no path separators, no dotfiles. */
export function imageFileName(index: number, name: string, contentType: string): string {
  const base =
    name
      .replace(/\.[A-Za-z0-9]{1,5}$/, '')
      .replace(/[^A-Za-z0-9._-]+/g, '_')
      .replace(/^[._-]+/, '')
      .slice(0, 60) || 'image'
  return `${index + 1}-${base}.${EXT[contentType] ?? 'img'}`
}

export interface ThreadImageDeps {
  store: Pick<SlackStore, 'getThread' | 'getMessages'>
  teamId: string
  token: string
  download: (req: { url: string; token: string; maxBytes: number; signal?: AbortSignal }) => Promise<HttpDownload>
  /** Refresh the thread from Slack (sync.fetchThread). Raced against `refreshMs`; the mirror is used either way. */
  fetchThread?: () => Promise<void>
  isBotUser: (userId: string) => boolean
  /** The channel is a DM / group DM (a flat DM uses its recent messages, like the transcript). */
  isDm?: boolean
  clock: Clock
  log: Logger
  refreshMs?: number
  max?: number
  signal?: AbortSignal
}

/** Downloads the thread's human images through `sink`. Best effort: a failed file is logged (id only) and skipped. */
export async function downloadThreadImages(d: ThreadImageDeps, channelId: string, threadTs: string, sink: ImageSink): Promise<string[]> {
  const isDmKey = threadTs.startsWith('dm:')
  if (d.fetchThread && !isDmKey) {
    let timer: unknown = null
    const refresh = d.fetchThread().catch((e) => d.log.warn('slack images: thread refresh failed', { channelId, error: e instanceof Error ? e.message : String(e) }))
    const wait = new Promise<void>((resolve) => {
      timer = d.clock.setTimeout(resolve, d.refreshMs ?? THREAD_REFRESH_MS)
    })
    await Promise.race([refresh, wait])
    d.clock.clearTimeout(timer)
  }
  const thread = isDmKey ? [] : await d.store.getThread({ teamId: d.teamId, channelId, threadTs, limit: 200 })
  // a flat DM conversation (like {{trigger.thread}}): the recent messages, not just the one that fired
  const flatDm = (d.isDm || isDmKey) && !thread.some((m) => m.replyCount > 0)
  const msgs = flatDm ? await d.store.getMessages({ teamId: d.teamId, channelId, limit: 20 }) : thread
  const picked = pickThreadImages(msgs, d.isBotUser, d.max ?? MAX_THREAD_IMAGES)
  const paths: string[] = []
  for (const [i, p] of picked.entries()) {
    if (d.signal?.aborted) break
    const fileId = p.file.id ?? 'unknown'
    try {
      const got = await d.download({ url: p.file.urlPrivate, token: d.token, maxBytes: MAX_IMAGE_BYTES, signal: d.signal })
      paths.push(await sink.write(imageFileName(i, p.file.name, got.contentType), got.bytes))
    } catch (e) {
      const msg = (e instanceof Error ? e.message : String(e)).split(d.token).join('[token]').split(p.file.urlPrivate).join('[url]')
      d.log.warn('slack images: download skipped', { fileId, error: msg })
    }
  }
  if (picked.length) d.log.info('slack images: downloaded', { channelId, picked: picked.length, saved: paths.length })
  return paths
}
