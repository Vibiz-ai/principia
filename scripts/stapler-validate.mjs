#!/usr/bin/env node
/**
 * node scripts/stapler-validate.mjs <file>
 *
 * `xcrun stapler validate <file>`, tried again while Apple's ticket service cannot be reached (the same waits and
 * wording as stapling, scripts/mac-sign.mjs). Post-release verification (.github/workflows/post-release.yml) uses it:
 * a dropped connection to CloudKit made it report v0.2.0, v0.4.0 and v0.4.2 as having no stapled ticket when their
 * tickets were fine. A missing ticket or a bad file still fails on the first try. Exit 0 when the ticket is valid.
 */
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { defaultExec, retryStapler } from './mac-sign.mjs'

/** Validates the stapled ticket of `target`, retrying on connection errors. Returns {ok, out, status} of the last try. */
export function staplerValidate({ target, exec = defaultExec, ...waits }) {
  return retryStapler({ what: `stapler validate ${path.basename(target)}`, attempt: () => exec('xcrun', ['stapler', 'validate', target]), ...waits })
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const target = process.argv[2]
  if (!target) {
    console.error('usage: node scripts/stapler-validate.mjs <file>')
    process.exit(2)
  }
  const r = staplerValidate({ target })
  if (r.out) console.log(r.out)
  process.exit(r.ok ? 0 : 1)
}
