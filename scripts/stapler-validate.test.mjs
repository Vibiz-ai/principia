import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { staplerValidate } from './stapler-validate.mjs'

const script = fileURLToPath(new URL('./stapler-validate.mjs', import.meta.url))
const quiet = { sleep: () => undefined, waitsMs: [1, 2, 3] }
// what post-release saw for v0.4.2 (run 40993165784): the ticket lookup lost its connection to CloudKit
const DROP = { ok: false, status: 68, out: 'error is Error Domain=NSURLErrorDomain Code=-1005 "The network connection was lost." NSErrorFailingURLKey=https://api.apple-cloudkit.com/database/1/com.apple.gk.ticket-delivery/production/public/records/lookup\nThe validate action failed! Error 68.' }
const WORKED = { ok: true, status: 0, out: 'Processing: Principia.app\nThe validate action worked!' }
const NO_TICKET = { ok: false, status: 65, out: 'Principia.app does not have a ticket stapled to it.' }

test('staplerValidate: runs xcrun stapler validate on the file, again after a dropped connection', () => {
  const calls = []
  const tries = [DROP, WORKED]
  const r = staplerValidate({ target: '/tmp/x/Principia.app', exec: (cmd, argv) => (calls.push([cmd, ...argv]), tries.shift()), ...quiet })
  assert.equal(r.ok, true)
  assert.deepEqual(calls, [['xcrun', 'stapler', 'validate', '/tmp/x/Principia.app'], ['xcrun', 'stapler', 'validate', '/tmp/x/Principia.app']])
})

test('staplerValidate: a missing ticket fails at once, a connection that never comes back fails after every try', () => {
  let n = 0
  assert.equal(staplerValidate({ target: 'a.dmg', exec: () => (n++, NO_TICKET), ...quiet }).ok, false)
  assert.equal(n, 1)
  n = 0
  assert.equal(staplerValidate({ target: 'a.dmg', exec: () => (n++, DROP), ...quiet }).ok, false)
  assert.equal(n, 4)
})

test('stapler-validate.mjs CLI: exit 0 on a valid ticket, 1 on a missing one, 2 without a file', { skip: process.platform === 'win32' }, () => {
  // a fake xcrun on PATH: prints and exits with what FAKE_STAPLER says
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'stapler-validate-'))
  fs.writeFileSync(path.join(bin, 'xcrun'), '#!/bin/sh\n[ "$1 $2" = "stapler validate" ] || exit 9\nif [ "$FAKE_STAPLER" = ok ]; then echo "The validate action worked!"; exit 0; fi\necho "$3 does not have a ticket stapled to it."; exit 65\n', { mode: 0o755 })
  const run = (args, FAKE_STAPLER) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, FAKE_STAPLER } })
  const ok = run(['Principia.app'], 'ok')
  assert.equal(ok.status, 0, ok.stderr)
  assert.match(ok.stdout, /validate action worked/)
  const missing = run(['Principia.app'], 'missing')
  assert.equal(missing.status, 1)
  assert.match(missing.stdout, /does not have a ticket/)
  assert.equal(run([], 'ok').status, 2)
})
