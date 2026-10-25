import { Database, Image, Globe, Plug, Phone, Mail, Fingerprint, BookOpen, History, KeyRound, ArrowUpRight } from 'lucide-react'

const tools = [
  { name: 'Databases', description: 'A place for your company’s data, ready for agents to work with.', icon: Database },
  { name: 'Image generation', description: 'Create product visuals, campaign assets, and brand content.', icon: Image },
  { name: 'Web research & scraping', description: 'Gather information, monitor changes, and bring findings into the workspace.', icon: Globe },
  { name: 'Connections', description: 'Bring the software you already use into the same company context.', icon: Plug },
  { name: 'Phone', description: 'Make calls and handle conversations as part of your company’s workflows.', icon: Phone },
  { name: 'Email', description: 'Read, draft, send, and follow up with the context of the work behind each message.', icon: Mail },
]

export function CompanyPlatform() {
  return <section className="shell section-space" id="company">
    <div className="grid items-end gap-8 md:grid-cols-2">
      <div><span className="pill">The ambition</span><h2 className="section-title mt-[18px]">One company.<br/>Or a thousand.</h2></div>
      <div className="max-w-[490px] space-y-4 text-[15px] leading-[1.75] text-muted"><p>Principia is being built to run entire companies: give agents the goals, tools, and context to carry work from start to finish, with you setting the direction.</p><p>The vision is one workspace for every company you operate, each with its own memory, connections, and permissions. Start with one process. Build toward autonomous operations.</p><p className="text-xs text-[#aeb8bc]">We’re building toward this. Today’s preview starts with agents, workflows, shared connections, and project memory.</p></div>
    </div>
    <figure className="plate mt-10 sm:mt-6">
      <img className="engraving" src="/art/aqueduct.webp" alt="Engraving of a Roman aqueduct whose arches repeat across a valley to the horizon." loading="lazy" decoding="async" width={1600} height={893}/>
      <figcaption className="roman-tag rule">One arch, then a thousand</figcaption>
    </figure>
    <div className="mt-12 border-t border-white/[.07] pt-8">
      <div className="mb-7 flex flex-wrap items-end justify-between gap-4"><h3 className="display text-[clamp(22px,2.4vw,28px)]">The tools to do the whole job.</h3><span className="roman-tag text-muted">Toolbox roadmap</span></div>
      <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2 lg:grid-cols-3">{tools.map(({ name, description, icon: Icon }) => <article key={name} className="rounded-[18px] bg-panel p-6"><Icon size={21} strokeWidth={1.3} aria-hidden="true" className="mb-7 text-[#aeb8bc]"/><h4 className="font-serif text-[24px] tracking-[-.025em]">{name}</h4><p className="mt-2 text-[13.5px] leading-relaxed text-muted">{description}</p></article>)}</div>
      <p className="mt-5 max-w-[760px] text-[13px] leading-relaxed text-muted">Available today: shared MCP connections. Dedicated setup for these tool categories is on the roadmap.</p>
    </div>
  </section>
}

const passportContents = [
  { title: 'Company identity', detail: 'What you do, who you serve, and how you work.', icon: Fingerprint },
  { title: 'Shared knowledge', detail: 'Goals, brand guidance, documents, and working context.', icon: BookOpen },
  { title: 'Decisions & history', detail: 'What was learned, what was decided, and why.', icon: History },
  { title: 'Access & permissions', detail: 'Which context a connected service is allowed to use.', icon: KeyRound },
]

export function CompanyPassport() {
  return <section className="shell section-space" id="passport">
    <figure className="plate mb-[-56px] sm:mb-[-120px]"><img className="engraving" src="/art/scribe.webp" alt="Engraving of a bearded Roman scribe in a toga writing on a scroll with a quill, Corinthian columns behind him and the city seen through an arched window." loading="lazy" decoding="async" width={1600} height={893}/></figure>
    <div className="relative grid items-center gap-12 rounded-[22px] border border-white/[.07] bg-panel/90 p-7 backdrop-blur-sm sm:p-12 md:grid-cols-2">
      <div><span className="pill">Introducing Passport · planned</span><h2 className="section-title mt-6">Your company’s memory.<br/>Ready to travel.</h2><p className="mt-6 text-[15px] leading-[1.75] text-muted">Passport is the name for the portable company memory we’re building toward. Your identity, knowledge, decisions, and context, kept together so the next agent or tool can pick up the work.</p><p className="mt-4 text-[15px] leading-[1.75] text-muted">Import a Passport into a workspace. Alongside a compatible service’s usual sign-in, choose the company context you want to share. The service gets the background it needs, with access you control.</p><p className="mt-5 text-xs leading-relaxed text-[#aeb8bc]">Project memory is available today. Passport import, export, and context sharing during sign-in are planned.</p><a className="mt-6 inline-flex items-center gap-2 border-b border-white/15 pb-1 text-sm text-soft" href="https://github.com/Vibiz-ai/principia/discussions">Help shape Passport <ArrowUpRight size={14} aria-hidden="true"/></a></div>
      <div className="min-w-0 rounded-2xl border border-white/[.1] bg-[#101416] p-6 sm:p-8" aria-label="Passport concept: proposed company memory contents"><div className="mb-8 flex items-center justify-between gap-4 border-b border-white/10 pb-5"><span className="display text-[24px]">Passport</span><span className="roman-tag text-[10px]! text-[#aeb8bc]">Concept preview</span></div><div className="space-y-6">{passportContents.map(({title,detail,icon:Icon})=><div className="flex gap-4" key={title}><Icon size={18} strokeWidth={1.3} className="mt-0.5 shrink-0 text-silver" aria-hidden="true"/><div><h3 className="text-sm text-soft">{title}</h3><p className="mt-1 text-[13px] leading-relaxed text-muted">{detail}</p></div></div>)}</div><p className="mt-8 border-t border-white/10 pt-5 font-mono text-[10px] leading-relaxed tracking-[.08em] text-muted">ONE COMPANY’S CONTEXT. SHARED ON ITS TERMS.</p></div>
    </div>
  </section>
}
