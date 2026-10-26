import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EDGE_KINDS, NODE_KINDS, parseDiagram } from '../../shared/diagram'
import { DIAGRAM_HINT } from './prompt'
import { VISUALIZE_SKILL, installVisualizeSkill, resetVisualizeSkill, visualizeSkillArgs } from './visualizeSkill'
import { artifactsHint, claudeAdapter } from '../engine/adapters'
import { clipDetail, DETAIL_MAX } from '../engine/live/summary'
import { FIELD_CAP, shrinkPayload } from '../live/hook'
import type { AgentProfile } from '../../shared/types'

afterEach(() => resetVisualizeSkill())

describe('DIAGRAM_HINT', () => {
  it('is short, names every kind and carries a valid example', () => {
    expect(DIAGRAM_HINT.length).toBeLessThan(700)
    for (const k of [...NODE_KINDS, ...EDGE_KINDS]) expect(DIAGRAM_HINT).toContain(k)
    expect(DIAGRAM_HINT).toContain('```principia-graph')
    expect(DIAGRAM_HINT).toMatch(/Not for every answer/)
    const example = /E\.g\. (\{.*\}\]\})\./.exec(DIAGRAM_HINT)![1]!
    expect(parseDiagram(example).ok).toBe(true)
  })
  it('rides the artifacts hint once', () => {
    expect(artifactsHint('/a').split('principia-graph').length).toBe(2)
  })
})

const profile = { id: 'p', name: 'Claude', adapter: 'claude', model: null, extraArgs: [], permissionMode: 'bypass' } as unknown as AgentProfile
const req = { profile, artifactsDir: '/art', resumeId: null as string | null, sessionId: 's1' }

describe('/visualize skill', () => {
  it('writes a user-invoked skill under userData and is idempotent', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dgm-'))
    const root = installVisualizeSkill(dir)!
    expect(root).toBe(path.join(dir, 'claude-skills'))
    const file = path.join(root, '.claude', 'skills', 'visualize', 'SKILL.md')
    expect(fs.readFileSync(file, 'utf8')).toBe(VISUALIZE_SKILL)
    expect(VISUALIZE_SKILL).toMatch(/^---\nname: visualize\n/)
    expect(VISUALIZE_SKILL).toContain('disable-model-invocation: true')
    expect(VISUALIZE_SKILL).toContain('Draw $ARGUMENTS as a principia-graph.')
    const before = fs.statSync(file).mtimeMs
    installVisualizeSkill(dir)
    expect(fs.statSync(file).mtimeMs).toBe(before)
    expect(visualizeSkillArgs()).toEqual(['--add-dir', root])
  })

  it('claude chats add the skill folder before --session-id; nothing when not installed', () => {
    expect(claudeAdapter.interactive(req).args).not.toContain('--add-dir')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dgm-'))
    const root = installVisualizeSkill(dir)!
    const a = claudeAdapter.interactive(req).args
    const i = a.indexOf(root)
    expect(a[i - 1]).toBe('--add-dir')
    expect(i).toBeLessThan(a.indexOf('--session-id'))
    expect(a[a.indexOf('--append-system-prompt') + 1]).toContain('principia-graph')
    // PROACTIVE.md §4: an interactive pane re-passes its system text on resume (claude's snapshot holds it; a compaction rebuilds from it)
    const resumed = claudeAdapter.interactive({ ...req, resumeId: 'u1' }).args
    expect(resumed[resumed.indexOf('--append-system-prompt') + 1]).toContain('principia-graph')
    expect(resumed).toContain(root)
  })
})

describe('hook payload', () => {
  it('keeps a Stop answer with a diagram whole, still trims plain answers', () => {
    const body = JSON.stringify({ nodes: Array.from({ length: 80 }, (_, i) => ({ id: `n${i}`, kind: 'service', label: `Service ${i}` })) })
    const answer = `Here:\n\`\`\`principia-graph\n${body}\n\`\`\``
    expect((shrinkPayload({ last_assistant_message: answer }) as { last_assistant_message: string }).last_assistant_message).toBe(answer)
    const plain = (shrinkPayload({ last_assistant_message: 'x'.repeat(5000) }) as { last_assistant_message: string }).last_assistant_message
    expect(plain.length).toBe(FIELD_CAP + 1)
  })
})

describe('clipDetail', () => {
  it('keeps an answer with a diagram whole, still clips plain text', () => {
    const body = JSON.stringify({ nodes: Array.from({ length: 80 }, (_, i) => ({ id: `n${i}`, kind: 'service', label: `Service ${i}` })) })
    const text = `Here:\n\`\`\`principia-graph\n${body}\n\`\`\``
    expect(text.length).toBeGreaterThan(DETAIL_MAX)
    expect(clipDetail(text)).toBe(text)
    expect(clipDetail('x'.repeat(DETAIL_MAX + 10))!.length).toBe(DETAIL_MAX)
  })
})

describe('the format notes list the task statuses', () => {
  it('names all five in the hint and the /visualize skill', async () => {
    const { TASK_STATUSES } = await import('../../shared/diagram')
    for (const st of TASK_STATUSES) {
      expect(DIAGRAM_HINT).toContain(st)
      expect(VISUALIZE_SKILL).toContain(st)
    }
    expect(VISUALIZE_SKILL).not.toContain('${')
  })
})
