/**
 * CHAT-UI.md §12: a company made in a conversation. The main chat passes a name and a brief, and this runs the same
 * services as the onboarding's From a prompt path (read the brief, plan, launch) with no screens. Autopilot stays off:
 * the company's tasks wait for Start until the founder says otherwise.
 * No Electron imports.
 */
import crypto from 'node:crypto'
import { BRIEF_MAX, EMPTY_ANSWERS, LaunchInputSchema, type BriefResult, type LaunchInput, type LaunchResult, type OnboardingAnswers, type PlanInput, type PlanResult } from '../../shared/onboarding'

export interface FromBriefDeps {
  readBrief(req: { requestId: string; brief: string }): Promise<BriefResult>
  plan(req: { requestId: string; input: PlanInput }): Promise<PlanResult>
  launch(req: { draftId: string; input: LaunchInput }): Promise<LaunchResult>
  /** Holds Autopilot off for the new company. */
  hold(journalId: string): Promise<unknown>
  tz: string
}

export interface FromBriefResult {
  company_id: string
  name: string
  autopilot: false
  departments: string[]
  agents: { name: string; department: string | null }[]
  first_tasks: string[]
}

export async function companyFromBrief(d: FromBriefDeps, req: { name: string; brief: string; website?: string | null }): Promise<FromBriefResult> {
  const id = `chat-${crypto.randomBytes(8).toString('hex')}`
  const brief = `${req.name}\n${req.brief}`.slice(0, BRIEF_MAX)
  const read = await d.readBrief({ requestId: `${id}-b`, brief })
  const answers: OnboardingAnswers = { ...EMPTY_ANSWERS, goals: [], ...read.answers, name: req.name, ...(req.website ? { siteUrl: req.website } : {}) }
  const planned = await d.plan({ requestId: `${id}-p`, input: { hasCode: false, answers, keys: { fal: false, openai: false }, departmentsOn: true, tz: d.tz, brief } })
  const input = LaunchInputSchema.parse({ mode: 'new', hasCode: false, answers, repos: [], key: null, plan: planned.plan, enableFlags: true, tz: d.tz, brief })
  const res = await d.launch({ draftId: id, input })
  if (res.status !== 'done' || !res.companyId) {
    const failed = res.steps.find((s) => s.status === 'failed')
    throw new Error(`Setting up ${req.name} stopped${failed ? ` at ${failed.name}` : ''}${failed?.error ? `: ${failed.error}` : ''}. Open Principia to retry it.`)
  }
  await d.hold(res.journalId)
  const p = planned.plan
  const departmentOf = (key: string | null | undefined): string | null => p.departments.find((x) => x.key === key)?.name ?? null
  return {
    company_id: res.companyId,
    name: req.name,
    autopilot: false,
    departments: p.departments.filter((x) => x.include).map((x) => x.name),
    agents: p.agents.filter((x) => x.include).map((x) => ({ name: x.name, department: departmentOf(x.departmentKey) })),
    first_tasks: p.tasks.filter((x) => x.include).map((x) => x.title)
  }
}
