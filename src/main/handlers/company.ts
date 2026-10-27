import type { BoardTask, CompanyAgentSaveInput, CompanyTaskInput, DepartmentPresetKey, DepartmentSaveInput } from '../../shared/company'
import { HiveError } from '../../shared/errors'
import { assertDepartmentsEnabled, DepartmentStore } from '../company/departments'
import { previewGithubIssue } from '../company/github'
import { baseChildEnv } from '../loginEnv'
import type { Hive } from '../hive'
import { emit, handle } from '../ipc'
import { connectionsChanged } from '../connections/events'
import { registerPassportStubs } from './passportStubs'
import { BrowserWindow, dialog, nativeImage } from 'electron'
import type { CompanyPassport } from '../../shared/company'
import { CompanyLogoStore, type Shrink } from '../company/logoStore'
import { planBoardStart } from '../company/planBoard'
import { setCompanyPaused } from '../company/pauseCompany'
import { newCompanyAutopilotOn } from '../company/newCompany'
import { log } from '../log'
import { notify } from '../notify'
import { usageSummary } from '../usage/summary'
import { capReached } from '../../shared/spend'
/** The departments store the handlers write through (one per Hive; stateless over the same db as h.company). */
const deptStores=new WeakMap<Hive,DepartmentStore>()
export function departmentStoreFor(h: Hive): DepartmentStore {
  let d=deptStores.get(h)
  if(!d){d=new DepartmentStore(h.store,h.company);deptStores.set(h,d)}
  return d
}
/** DEPARTMENTS.md §0.8: departments/companyAgents writes refuse unless experimental.companies and .departments are on. */
const departmentsGate=(h: Hive)=>assertDepartmentsEnabled(h.settings().experimental)
/** PASSPORT.md / DEPARTMENTS.md §7: a new department gets its passport note right away (no-op when it exists; never throws). */
export function departmentNoteFor(h: Hive, companyId: string, depId: string): void { try { h.memory?.ensureDepartmentNote(companyId,depId) } catch { /* created on its first run instead */ } }
/**
 * The departments/companyAgents create and archive paths behind their IPC channels (also used by onboarding launch):
 * the same gate, store rules and department notes. Callers emit data:changed.
 */
export function departmentActions(h: Hive) {
  const d=departmentStoreFor(h)
  return {
    save:(input:DepartmentSaveInput)=>{departmentsGate(h);const dep=d.save(input);departmentNoteFor(h,dep.companyId,dep.id);return dep},
    archive:(id:string,archived=true)=>{departmentsGate(h);return d.archive(id,archived)},
    createPresets:(companyId:string,keys?:DepartmentPresetKey[])=>{departmentsGate(h);const list=d.createPresets(companyId,keys);for(const dep of list)departmentNoteFor(h,companyId,dep.id);return list},
    saveAgent:(input:CompanyAgentSaveInput)=>{departmentsGate(h);return d.saveAgent(input)},
    archiveAgent:(id:string,archived=true)=>{departmentsGate(h);return d.archiveAgent(id,archived)}
  }
}
/** tasks:create (also used by onboarding launch): with departments off, tasks stay company-level exactly as before. */
export function createTaskGuarded(h: Hive, task: CompanyTaskInput): BoardTask {
  const boardOff=(()=>{ try { departmentsGate(h); return false } catch { return true } })()
  if(boardOff&&(task.departmentId||task.agentId)) throw new HiveError('forbidden','Departments are experimental. Turn on Companies and Departments under Settings → Experimental to assign tasks to them.')
  if(!boardOff) departmentStoreFor(h).assertTaskCreate(task)
  return h.company.createTask(task)
}
/** Electron's decoder for the big rasters (png/jpeg); anything it cannot read is stored as it is. */
const shrinkImage: Shrink = (buf, _ext, max) => {
  const img = nativeImage.createFromBuffer(buf)
  if (img.isEmpty()) return null
  const { width, height } = img.getSize()
  if (Math.max(width, height) <= max) return null
  const small = width >= height ? img.resize({ width: max, quality: 'best' }) : img.resize({ height: max, quality: 'best' })
  return { buf: small.toPNG(), ext: 'png' }
}
const logoStores=new WeakMap<Hive,CompanyLogoStore>()
/** The company logos (rail coin, sidebar chips): copies in `<userData>/companies/<slug>/logo/`. */
export function logoStoreFor(h: Hive): CompanyLogoStore {
  let s=logoStores.get(h)
  if(!s){
    s=new CompanyLogoStore(h.company.scope.companiesRoot,{
      reposOf:(c)=>c.repoIds.map(id=>h.store.getRepo(id)).filter(r=>!!r&&r.exists).map(r=>({name:r!.name,path:r!.path})),
      shrink:shrinkImage
    })
    logoStores.set(h,s)
  }
  return s
}
export function registerCompanyHandlers(h: Hive): void {
  const c=h.company
  const changed=(domain:'company'|'tasks'|'departments')=>emit('data:changed',{domain})
  // DEPARTMENTS.md §0.8: every departments/companyAgents channel refuses unless experimental.companies and .departments are on
  const gate=()=>departmentsGate(h)
  const boardOff=()=>{ try { gate(); return false } catch { return true } }
  // with departments off, tasks stay company-level exactly as before
  const noBoardFields=(t:{departmentId?:string|null;agentId?:string|null})=>{ if(boardOff()&&(t.departmentId||t.agentId)) throw new HiveError('forbidden','Departments are experimental. Turn on Companies and Departments under Settings → Experimental to assign tasks to them.') }
  const d=departmentStoreFor(h)
  const actions=departmentActions(h)
  // these change repo ownership: the sidebar re-reads repo.companyId
  const reposChanged=()=>emit('data:changed',{domain:'repos'})
  c.reconcile()
  h.runHooks.push(run=>{ if(c.syncRun(run))changed('tasks') })
  handle('company:list',q=>c.listPassports({includeArchived:!!q?.includeArchived}))
  handle('company:save',({id,passport})=>{const p=c.savePassport(passport,id);changed('company');reposChanged();return p})
  // COMPANY.md §7
  // AUTOPILOT.md §7: a new company starts with Autopilot on (it has no work yet, so nothing starts by itself; the
  // limits stay: tasks at once, the monthly cap, Pause). Existing companies keep their switch.
  handle('company:create',input=>{const p=newCompanyAutopilotOn(c,c.create(input));changed('company');reposChanged();return p})
  handle('company:update',({id,patch})=>{const p=c.update(id,patch);changed('company');if(patch.account!==undefined)connectionsChanged(id);return p})
  handle('company:archive',({id,archived})=>{const p=c.archive(id,archived??true);if(archived??true){for(const other of h.safe(()=>h.connections?.companyArchived(id)??[],[]))connectionsChanged(other)};changed('company');return p})
  handle('company:reorder',({ids})=>{const list=c.reorder(ids);changed('company');return list})
  handle('company:assignRepo',({repoId,companyId})=>{const p=c.assignRepo(repoId,companyId);changed('company');emit('data:changed',{domain:'repos'});return p})
  handle('company:overview',()=>c.overview())
  // five doors A4: one company only. The starter is the same human start as tasks:start (dispatcher, else the engine)
  const pauseOne=async(id:string,paused:boolean)=>{
    const res=await setCompanyPaused({
      company:c,
      cancelRun:(runId)=>h.engine.runs.cancel(runId),
      startTask:(taskId)=>{ if(h.dispatcher) h.dispatcher.runNow(taskId); else c.startTask(taskId,undefined,(target,companyId,link)=>h.engine.runs.start(target.kind==='prompt'?{...target,prompt:h.vault.redact(target.prompt)}:target,{trigger:'task',companyId,taskId:link.taskId,agentId:link.agentId,resumeSessionId:link.resumeSessionId})) },
      schedules:(companyId)=>h.store.listSchedules(companyId).filter(s=>s.enabled).length,
      log
    },id,paused)
    changed('company');changed('departments');changed('tasks');h.statusChanged()
    // the resumed company's queue may move again (autopilot), and nothing else's
    if(!paused) void h.dispatcher?.pump(id)
    return res
  }
  handle('company:pause',({id,paused})=>pauseOne(id,paused))
  // five doors §4.8: a company that reaches its monthly cap pauses (this company only), checked when a run ends
  h.runHooks.push(run=>{
    if(!run.companyId||!['passed','failed','canceled'].includes(run.status)) return
    const co=c.listPassports().find(x=>x.id===run.companyId)
    if(!co?.monthlyCap||co.pausedAt) return
    const month=usageSummary({db:h.db,companyName:(id)=>c.listPassports({includeArchived:true}).find(x=>x.id===id)?.name??id},{range:'month',companyId:co.id})
    if(!capReached(month.total.usd,co.monthlyCap)) return
    void pauseOne(co.id,true).then(()=>{
      log.info('company paused at its monthly cap',{companyId:co.id,cap:co.monthlyCap,usd:month.total.usd})
      notify({title:`${co.name} paused at its monthly cap`,body:`This month's pay-as-you-go value reached $${co.monthlyCap}. Other companies keep running. Raise the cap or resume in Spend.`,sound:false})
    },(e)=>log.warn('cap pause failed',{companyId:co.id,error:String(e)}))
  })
  const logos=logoStoreFor(h)
  handle('company:logos',()=>logos.list(c.listPassports()))
  handle('company:logoCandidates',({id})=>logos.candidates(c.passport(id)))
  handle('company:setLogo',async({id,pick},sender)=>{
    const co:CompanyPassport=c.passport(id)
    let out
    if(pick.kind==='candidate') out=logos.setCandidate(co,pick.path)
    else if(pick.kind==='none') out=logos.setNone(co)
    else if(pick.kind==='auto') out=logos.setAuto(co)
    else if(pick.kind==='emblem') out=logos.setEmblem(co,pick.variant,pick.keepDetected===true)
    else {
      const win=BrowserWindow.fromWebContents(sender)
      const opts:Electron.OpenDialogOptions={title:`Logo for ${co.name}`,buttonLabel:'Use as Logo',properties:['openFile'],filters:[{name:'Images',extensions:['svg','png','webp','jpg','jpeg','gif','ico']}]}
      const r=win?await dialog.showOpenDialog(win,opts):await dialog.showOpenDialog(opts)
      if(r.canceled||!r.filePaths[0]) return null
      out=logos.setFile(co,r.filePaths[0])
    }
    changed('company')
    return out
  })
  registerPassportStubs()
  handle('company:export',({id})=>JSON.parse(h.vault.redact(JSON.stringify(c.exportPassport(id)))))
  handle('company:previewImport',({json})=>c.previewImport(json))
  handle('company:import',({json,repoIds})=>{const p=c.importPassport(json,repoIds);changed('company');reposChanged();return p})
  handle('tasks:previewGithub', async ({url})=>{ const preview=await previewGithubIssue(url,baseChildEnv());return {...preview,title:h.vault.redact(preview.title),description:h.vault.redact(preview.description)} })
  handle('tasks:list',q=>c.listTasks(q?.companyId))
  handle('tasks:create',({task})=>{const t=createTaskGuarded(h,task);changed('tasks');return t})
  handle('tasks:update',({id,patch})=>{noBoardFields(patch);if(!boardOff())d.assertTaskPatch(c.task(id),patch);const t=c.updateTask(id,patch);changed('tasks');return t})
  handle('tasks:get',({id})=>c.detail(id))
  // §3.4: a board Run goes through the dispatcher (task link, seat, time cap, task tools, session capture, wake reset)
  handle('tasks:start',async({id,profileId})=>{if(c.task(id).plan){const pt=await planBoardStart(id);changed('tasks');h.statusChanged();return pt};const t=h.dispatcher?h.dispatcher.runNow(id,profileId):c.startTask(id,profileId,(target,companyId,link)=>h.engine.runs.start(target.kind==='prompt'?{...target,prompt:h.vault.redact(target.prompt)}:target,{trigger:'task',companyId,taskId:link.taskId,agentId:link.agentId,resumeSessionId:link.resumeSessionId}));changed('tasks');h.statusChanged();return t})
  // a human comment: by 'human' so its wake resets the guard (§3.5)
  handle('tasks:comment',({id,message,by})=>{const a=c.activity(id,'comment',h.vault.redact(message),by??'human');changed('tasks');return a})
  // DEPARTMENTS.md §10: departments and agent seats. tasks:assign … board:autopilot are registered by the board handlers.
  handle('departments:list',q=>{gate();return d.list(q?.companyId,{includeArchived:!!q?.includeArchived})})
  handle('departments:save',input=>{const dep=actions.save(input);changed('departments');return dep})
  handle('departments:archive',({id,archived})=>{const dep=actions.archive(id,archived??true);changed('departments');return dep})
  handle('departments:reorder',({companyId,ids})=>{gate();const list=d.reorder(companyId,ids);changed('departments');return list})
  handle('departments:createPresets',({companyId,keys})=>{const list=actions.createPresets(companyId,keys);changed('departments');return list})
  handle('companyAgents:list',q=>{gate();return d.listAgents({companyId:q?.companyId,departmentId:q?.departmentId,includeArchived:!!q?.includeArchived})})
  handle('companyAgents:save',input=>{const a=actions.saveAgent(input);changed('departments');return a})
  handle('companyAgents:archive',({id,archived})=>{const a=actions.archiveAgent(id,archived??true);changed('departments');return a})
  handle('companyAgents:pause',({id})=>{gate();const a=d.pauseAgent(id);changed('departments');return a})
  handle('companyAgents:resume',({id})=>{gate();const a=d.resumeAgent(id);changed('departments');return a})
}

