import { describe, expect, it } from 'vitest'
import { collapseExited, firstLine, promptTitle, runTitle, sessionEndLabel, sessionPlace, stripLogHeader, tildify } from './format'

describe('format', () => {
  it('titles prompts from the first line, collapsing whitespace and literal \\n', () => {
    expect(firstLine('cd "$ARTIFACTS_DIR"; printf "# Report\\n\\nHello"')).toBe('cd "$ARTIFACTS_DIR"; printf "# Report')
    expect(firstLine('\n\n  Summarise   open PRs  \nthen post')).toBe('Summarise open PRs')
    expect(firstLine('x'.repeat(60), 40)).toHaveLength(40)
    expect(firstLine('x'.repeat(60), 40).endsWith('…')).toBe(true)
  })
  it('prompt titles drop shell noise', () => {
    expect(promptTitle('cd "$ARTIFACTS_DIR"; printf "# Weekly report\\n\\nbody" > report.md')).toBe('Weekly report')
    expect(promptTitle('cd "$ARTIFACTS_DIR" && echo "hello world" > a.txt')).toBe('hello world')
    expect(promptTitle('npm test > out.log')).toBe('npm test')
    expect(promptTitle('## Fix the login bug; then run tests')).toBe('Fix the login bug; then run tests')
    expect(promptTitle('Summarize the repo')).toBe('Summarize the repo')
    // board task turns: the task title, never the raw role frame
    const turn = '<principia-role department="Marketing" agent="Copywriter">\nWrite posts.\n</principia-role>\n\n<principia-task id="ACM-1" company="co_1">\nTitle: Draft 3 launch posts\nSource: manual\n</principia-task>'
    expect(promptTitle(turn)).toBe('Draft 3 launch posts')
    expect(promptTitle('<principia-wake>\nYou were answered.\n</principia-wake>\n\nRules: …')).toBe('Task follow-up')
  })
  it('a task follow-up run reads its row title (PRN-n · Title), as the runs list does (QA)', () => {
    const wake = '<principia-wake>\nChanges requested.\n</principia-wake>\n\nRules: …'
    const run = (title: string) => ({ kind: 'prompt' as const, title, target: { kind: 'prompt' as const, prompt: wake } }) as Parameters<typeof runTitle>[0]
    expect(runTitle(run('PRN-1 · Add a subtract function'), 50)).toBe('PRN-1 · Add a subtract function')
    // an older row titled by the raw frame keeps the fallback
    expect(runTitle(run('<principia-wake> Changes requested.'), 50)).toBe('Task follow-up')
  })
  it('natural-language prompt titles keep the first sentence, drop "Step 1:" and cut at a word', () => {
    expect(promptTitle('Step 1: use the Agent tool to map src. Then report back.', 60)).toBe('Use the Agent tool to map src')
    const t = promptTitle('Step 1: use the Agent/Task tool to launch ONE general-purpose subagent that runs ls', 40)
    expect(t.endsWith('…')).toBe(true)
    expect(t).toBe('Use the Agent/Task tool to launch ONE…')
    expect(promptTitle('Fix e.g. the bug')).toBe('Fix e.g. the bug')
  })
  it('paths read ~/… and the scratch folder reads Chat', () => {
    expect(tildify('/Users/me/code/x')).toBe('~/code/x')
    expect(sessionPlace({ repoId: null, cwd: '/private/tmp/x/userData/scratch' })).toBe('Chat')
    expect(sessionPlace({ repoId: 'r', cwd: '/Users/me/code/x' })).toBe('~/code/x')
    // DEPARTMENTS.md §9: a department chat names its department (even when it runs in a repo folder)
    expect(sessionPlace({ repoId: null, cwd: '/Users/me/code/x', departmentId: 'dep_m' }, 'Marketing')).toBe('Marketing')
    expect(sessionPlace({ repoId: null, cwd: '/Users/me/code/x', departmentId: 'dep_m' }, null)).toBe('Chat')
  })
  it('killed sessions read stopped, not an exit code', () => {
    expect(sessionEndLabel({ status: 'exited', exitCode: 129 })).toBe('stopped')
    expect(sessionEndLabel({ status: 'exited', exitCode: null })).toBe('stopped')
    expect(sessionEndLabel({ status: 'exited', exitCode: 0 })).toBe('ended')
    expect(sessionEndLabel({ status: 'exited', exitCode: 1 })).toBe('exited 1')
  })
  it('keeps running sessions and the newest exited one per repo', () => {
    type S = { id: string; repoId: string | null; status: 'running' | 'exited'; startedAt: string }
    const r = collapseExited<S>([
      { id: 'a', repoId: 'x', status: 'exited', startedAt: '1' },
      { id: 'b', repoId: 'x', status: 'exited', startedAt: '2' },
      { id: 'c', repoId: 'x', status: 'running', startedAt: '0' },
      { id: 'd', repoId: null, status: 'exited', startedAt: '1' }
    ])
    expect(r.shown.map((s) => s.id)).toEqual(['b', 'c', 'd'])
    expect(r.hidden).toBe(1)
  })
  it('readable logs drop a wrapped command header before # cwd', () => {
    expect(stripLogHeader('If yo…\n# cwd: /x/acme\n→ Bash\ndone')).toBe('→ Bash\ndone')
    expect(stripLogHeader('→ Bash\n# cwd: /x\nok')).toBe('→ Bash\n# cwd: /x\nok')
    expect(stripLogHeader('Hello')).toBe('Hello')
  })
})
