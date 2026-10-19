#!/usr/bin/env node
/* SLACK.md §2.4 / §14.1: the production bundle must not contain the fake Slack, and the only Slack API base is https://slack.com/api/. */
const fs = require('node:fs')
const path = require('node:path')
const root = path.join(__dirname, '..', 'out', 'main')
const files = []
const walk = (d) => {
  for (const f of fs.readdirSync(d)) {
    const p = path.join(d, f)
    if (fs.statSync(p).isDirectory()) walk(p)
    else if (/\.(c?js|mjs)$/.test(f)) files.push(p)
  }
}
if (!fs.existsSync(root)) {
  console.error('verify-no-fake-slack: out/main not found; run electron-vite build first')
  process.exit(1)
}
walk(root)
let bad = 0
for (const f of files) {
  const s = fs.readFileSync(f, 'utf8')
  if (s.includes('HIVE_FAKE_SLACK_MARKER')) {
    console.error(`verify-no-fake-slack: fake Slack marker found in ${path.relative(root, f)}`)
    bad++
  }
  for (const m of s.matchAll(/https?:\/\/[a-z0-9.-]*slack\.com\/api\/?/g)) {
    if (m[0] !== 'https://slack.com/api/') {
      console.error(`verify-no-fake-slack: unexpected Slack API base ${m[0]} in ${path.relative(root, f)}`)
      bad++
    }
  }
}
if (bad) process.exit(1)
console.log(`verify-no-fake-slack: ok (${files.length} files)`)
