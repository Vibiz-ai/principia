/**
 * Entry of out/main/hive-hook.js (third electron-vite main entry, docs/LIVE.md §5). Run by agent CLI hooks with
 * ELECTRON_RUN_AS_NODE=1. stdout carries only the gate decision JSON (or nothing); always exits 0.
 */
import { runHook } from './hook'

void runHook(process.argv.slice(2), { stdin: process.stdin, stdout: process.stdout })
  .catch(() => 0)
  .then(() => process.exit(0))
