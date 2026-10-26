/**
 * Seeded workflows (SPEC 7.3 + A4). Main calls `seedWorkflows(defaultProfiles)` on first launch and inserts each
 * draft with its `seedKey` (deleted seeds stay deleted). Profile ids are the seeded default profile per adapter.
 */
import type { Id, WorkflowDraft } from '../../shared/types'
import { morningBriefDraft } from '../../shared/morningBrief'

export interface SeedProfiles {
  claude: Id | null
  codex: Id | null
}
export interface SeedWorkflow {
  seedKey: string
  draft: WorkflowDraft
}

// LIVE.md §7 (D9): new workflows default to memory read-write within the repo (agent reviewers: read). Seeds are
// inserted once on a fresh install; existing workflows keep their nodes (absent = off).
const REPO_INPUT = { name: 'repo', label: 'Repository', type: 'repo' as const }
const TASK_INPUT = { name: 'task', label: 'Task', type: 'multiline' as const }

export function seedWorkflows(p: SeedProfiles): SeedWorkflow[] {
  if (!p.claude) return [] // every seed needs at least one agent CLI
  const claude = p.claude
  const out: SeedWorkflow[] = []

  out.push({
    seedKey: 'build-until-tests-pass',
    draft: {
      name: 'Build until tests pass',
      description: 'Claude implements the task; `npm test` (or your command) reviews it; failures go back to Claude with the test output, up to 3 times.',
      inputs: [REPO_INPUT, TASK_INPUT, { name: 'test_command', label: 'Test command', type: 'text', default: 'npm test' }],
      nodes: [
        {
          id: 'build',
          type: 'agent',
          label: 'Build',
          after: [],
          cwd: '{{inputs.repo}}',
          timeoutMin: 30,
          profileId: claude,
          prompt: '{{inputs.task}}\n\nWhen you are done, make sure `{{inputs.test_command}}` passes.',
          memory: 'read-write'
        },
        {
          id: 'tests',
          type: 'check',
          label: 'Tests',
          after: ['build'],
          cwd: '{{inputs.repo}}',
          timeoutMin: 15,
          profileId: null,
          command: '{{inputs.test_command}}',
          target: 'build',
          criteria: '',
          maxRetries: 3
        }
      ]
    }
  })

  const codexReviewer = p.codex !== null
  out.push({
    seedKey: 'build-codex-review',
    draft: {
      name: 'Build + Codex review loop',
      description: codexReviewer
        ? 'Claude builds, Codex reviews the change; rejected work goes back to Claude with the review, up to 3 times.'
        : 'Claude builds, a second Claude reviews (Codex not installed); rejected work goes back with the review, up to 3 times.',
      inputs: [REPO_INPUT, TASK_INPUT],
      nodes: [
        {
          id: 'build',
          type: 'agent',
          label: 'Build',
          after: [],
          cwd: '{{inputs.repo}}',
          timeoutMin: 30,
          profileId: claude,
          prompt: '{{inputs.task}}',
          memory: 'read-write'
        },
        {
          id: 'review',
          type: 'check',
          label: codexReviewer ? 'Codex review' : 'Review (Claude, Codex not installed)',
          after: ['build'],
          cwd: '{{inputs.repo}}',
          timeoutMin: 20,
          profileId: p.codex ?? claude,
          command: null,
          target: 'build',
          criteria:
            'The task below is fully and correctly implemented in the working tree (look at `git diff`). No bugs, no unfinished parts, no unrelated changes.\n\nTask:\n{{inputs.task}}',
          maxRetries: 3,
          memory: 'read'
        }
      ]
    }
  })

  out.push({
    seedKey: 'debate-a-decision',
    draft: {
      name: 'Debate a decision',
      description: 'A Builder and a Skeptic argue for 3 rounds; the Builder writes the conclusion and next actions.',
      inputs: [{ name: 'question', label: 'Decision to debate', type: 'multiline' }],
      nodes: [
        {
          id: 'debate',
          type: 'room',
          label: 'Debate',
          after: [],
          cwd: null,
          timeoutMin: 10,
          participants: [
            { profileId: claude, label: 'Builder' },
            { profileId: p.codex ?? claude, label: 'Skeptic' }
          ],
          topic:
            'Decision: {{inputs.question}}\n\nBuilder argues for the most practical path. Skeptic attacks its weakest assumptions. Be concrete and brief.',
          rounds: 3,
          final: 'summary',
          memory: 'read-write'
        }
      ]
    }
  })

  out.push({ seedKey: 'morning-brief', draft: morningBriefDraft(claude) })

  return out
}
