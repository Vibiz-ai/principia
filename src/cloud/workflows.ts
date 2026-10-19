/** Headless reuse of the desktop workflow engine. No Electron imports. */
import { mkdirSync, realpathSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { openDatabase } from '../main/db'
import { Store } from '../main/db/store'
import { createEngineStore } from '../main/db/engineStore'
import { claudeAdapter } from '../main/engine/adapters'
import { createEngineWith } from '../main/engine'
import { createCloudGateway } from './gateway'
import { workflowFile } from '../main/ipcSchemas'
import type { WorkflowDraft } from '../shared/types'

export async function createCloudWorkflows({ dataDir, workspace, redact }: { dataDir: string; workspace: string; redact: (s: string) => string }) {
  const root = realpathSync(workspace)
  const paths = { userData: dataDir, artifactsRoot: resolve(dataDir, 'artifacts'), runLogsDir: resolve(dataDir, 'logs/runs'), scratchDir: root }
  for (const path of Object.values(paths)) mkdirSync(path, { recursive: true })
  const redactions: string[] = []
  const scrub = (text: string) => { let value = redact(text); for (const secret of redactions) value = value.split(secret).join('[REDACTED]'); return value }
  const baseEnv = () => ({ ...Object.fromEntries(Object.entries(process.env).filter(([name, v]) => v !== undefined && !/^(PRINCIPIA_|TELEGRAM_|PORT$|HOST$|CLAUDECODE$|CLAUDE_CODE_ENTRYPOINT$|CODEX_CI$|NODE_OPTIONS$)/.test(name))), SHELL: process.env.SHELL || '/bin/sh' }) as Record<string, string>
  const gateway = createCloudGateway(dataDir, root, baseEnv, value => { if (value.length >= 4) redactions.push(value) })
  const db = openDatabase(resolve(dataDir, 'workflows.db')); const store = new Store(db)
  const engineStore = createEngineStore(db, { describe: () => () => '', redact: scrub })
  for (const adapter of ['claude', 'codex'] as const) if (!store.listProfiles().some(p => p.adapter === adapter)) store.createProfile({ name: adapter, adapter, secretNames: [], permissionMode: 'default', useApiKeyAuth: adapter === 'codex' ? !!process.env.OPENAI_API_KEY : !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) })
  const engine = createEngineWith({ paths, store: engineStore, baseEnv, gateway, secrets: { resolve: () => ({}), redact: scrub }, getSettings: () => store.getSettings(), getProfile: id => store.getProfile(id), getRepo: id => store.getRepo(id), getWorkflow: id => store.getWorkflow(id), emit: () => {}, log: { info: () => {}, warn: msg => console.warn(redact(msg)), error: msg => console.error(redact(msg)) } }, { adapters: { claude: { ...claudeAdapter, headless: request => {
    const invocation = claudeAdapter.headless(request)
    const permission = invocation.args.indexOf('--permission-prompt-tool')
    if (permission >= 0) invocation.args.splice(permission, 2)
    const mode = invocation.args.indexOf('--permission-mode')
    if (mode >= 0 && invocation.args[mode + 1] === 'default') invocation.args[mode + 1] = 'dontAsk'
    return invocation
  } } } })
  await engine.init()
  function importWorkflow(raw: unknown) {
    const parsed = workflowFile.parse(raw)
    const draft = parsed.workflow as WorkflowDraft
    const profiles = store.listProfiles()
    const profile = (id: string) => { const match = profiles.find(p => p.id === id || `prof_${p.adapter}` === id); if (!match) throw new Error(`Unknown profile ${id}; use prof_codex or prof_claude in exported cloud workflows`); return match.id }
    draft.nodes = draft.nodes.map(node => {
      if (node.cwd) { if (node.cwd.includes('{{')) throw new Error('Cloud workflow cwd templates are unsupported; use a literal path inside workspace'); const cwd = realpathSync(resolve(root, node.cwd)); if (cwd !== root && !cwd.startsWith(root + sep)) throw new Error('Workflow cwd escapes workspace'); node.cwd = cwd }
      if (node.type === 'agent') return { ...node, profileId: profile(node.profileId) }
      if (node.type === 'check') return { ...node, profileId: node.profileId ? profile(node.profileId) : null }
      if (node.type === 'room') return { ...node, participants: node.participants.map(p => ({ ...p, profileId: profile(p.profileId) })) }
      return node
    })
    if (draft.worktree) throw new Error('Cloud worktree execution is not available; use a dedicated workspace')
    const errors = engine.workflows.validate(draft); if (errors.length) throw new Error(errors.map(e => `${e.path}: ${e.message}`).join('; '))
    return store.createWorkflow(draft)
  }
  return {
    attachment: (cwd: string) => gateway?.attachment(cwd) ?? null,
    redact: scrub,
    import: importWorkflow,
    list: () => store.listWorkflows(),
    start: (workflowId: string, inputs: Record<string, string> = {}) => engine.runs.start({ kind: 'workflow', workflowId, inputs }, { trigger: 'manual' }),
    runs: () => store.listRuns(),
    get: (id: string) => engineStore.getRunDetail(id),
    cancel: (id: string) => engine.runs.cancel(id),
    close: async () => { await engine.shutdown(); gateway?.close(); db.close() }
  }
}
