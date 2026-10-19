import { useState } from 'react'
import { Network, Plug, ArrowUpRight } from 'lucide-react'

const views = [
  { id: 'agents', label: 'Agent canvas', icon: Network, image: '/principia-agents.png', alt: 'Principia’s current agent canvas, with a launch coordinator and nested teams for a website, customer research, and content. Example workspace with sample data.', detail: 'See who’s doing what, all the way down to each subagent.' },
  { id: 'connections', label: 'Company connections', icon: Plug, image: '/principia-connections.png', alt: 'Principia’s searchable connection catalog with Granola, Notion, Linear, GitHub, Stripe, Mobbin, and other business services.', detail: 'Find a tool, connect your account, and choose which projects can use it.' },
]
export function ProductPreview() {
  const [active, setActive] = useState(0)
  const view = views[active]
  return <figure id="workspace" className="mt-14 scroll-mt-28 text-left">
    <div className="mb-5 flex flex-wrap items-center justify-between gap-4">
      <div className="inline-flex gap-1 rounded-xl border border-white/[.07] bg-panel p-1" role="group" aria-label="Explore the workspace">
        {views.map((item, index) => <button key={item.id} type="button" aria-pressed={active === index} onClick={() => setActive(index)} className={`inline-flex items-center gap-2 rounded-lg px-3 py-2.5 text-[12px] transition-colors sm:px-4 ${active === index ? 'bg-raised text-ink' : 'text-muted hover:text-ink'}`}><item.icon size={14} aria-hidden="true"/>{item.label}</button>)}
      </div>
      <a href={view.image} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-[11px] text-muted hover:text-ink" aria-label={`Open full-size ${view.label} screenshot`}>View full size <ArrowUpRight size={13}/></a>
    </div>
    <div className="screenshot-frame"><img key={view.id} className="block aspect-[1500/950] w-full" src={view.image} alt={view.alt} width={1500} height={950} fetchPriority={active === 0 ? 'high' : 'auto'}/></div>
    <figcaption className="mt-4 flex flex-wrap justify-between gap-2 text-[11px] text-muted"><span>{view.detail}</span><span>Current interface · example workspace</span></figcaption>
  </figure>
}
