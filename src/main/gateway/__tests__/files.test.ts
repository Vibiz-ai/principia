import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readPrivateJson, writePrivateJson } from '../files'

describe('gateway message files', () => {
  it('rejects symlink reads and oversized or nonregular messages', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'principia-files-'))
    try {
      const file = path.join(dir, 'message')
      fs.writeFileSync(file, '{"ok":true}')
      fs.symlinkSync(file, path.join(dir, 'link'))
      expect(readPrivateJson(file, 100)).toEqual({ ok: true })
      expect(() => readPrivateJson(path.join(dir, 'link'), 100)).toThrow()
      expect(() => readPrivateJson(file, 2)).toThrow()
      expect(() => readPrivateJson(dir, 100)).toThrow()
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })
  it('atomically replaces a planted destination symlink without modifying its target', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'principia-files-'))
    try {
      const outside = path.join(dir, 'preserve'), answer = path.join(dir, 'answer')
      fs.writeFileSync(outside, 'preserve')
      fs.symlinkSync(outside, answer)
      fs.symlinkSync(outside, answer + '.tmp')
      writePrivateJson(answer, { ok: true })
      expect(fs.readFileSync(outside, 'utf8')).toBe('preserve')
      expect(readPrivateJson(answer, 100)).toEqual({ ok: true })
      expect(fs.statSync(answer).mode & 0o777).toBe(0o600)
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })
})
