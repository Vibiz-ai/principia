/**
 * DEV-ONLY fake Slack wiring (SLACK.md §13.3). Imported only behind `if (__HIVE_FAKE_SLACK__ && !app.isPackaged)`;
 * the define is false in every normal build, so the bundler drops this module. scripts/verify-no-fake-slack.cjs fails
 * the dist build if the marker below ever reaches out/main.
 */
import fs from 'node:fs'
import type { HttpPort, SocketPort } from './core/ports'
import { FakeSlack, HIVE_FAKE_SLACK_MARKER, globalClock, type FakeSlackOptions } from './testing/fakeSlack'

export const DEV_FAKE_MARKER = HIVE_FAKE_SLACK_MARKER

let instance: FakeSlack | null = null
/** The running fake (for a debug menu: post as Dana, mention @hive, disconnect warning, drop socket, …). */
export function devFake(): FakeSlack | null {
  return instance
}

export function createDevFakeTransport(fixturePath: string): { http: HttpPort; socket: SocketPort; fake: true; marker: string } {
  const raw = JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as Omit<FakeSlackOptions, 'clock'>
  instance = new FakeSlack({ ...raw, clock: globalClock, enforceTiers: true })
  // dev/e2e only: scripts/e2e-slack.cjs drives the fake from the main process (post as a human, read chat.postMessage)
  ;(globalThis as { __hiveFakeSlack?: FakeSlack }).__hiveFakeSlack = instance
  // the marker string travels with the fake so verify-no-fake-slack.cjs can prove a normal build never contains it
  return { http: instance.http, socket: instance.socket, fake: true, marker: DEV_FAKE_MARKER }
}
