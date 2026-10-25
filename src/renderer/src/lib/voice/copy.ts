/**
 * VOICE.md §2, §3: the only place flavored user-facing strings live. Every entry has a `plain` form (the meaning, and
 * what screen readers hear); `playful` is optional and falls back to `plain`; `latin` is rendered by <LatinLine> next
 * to the text, only in playful. Interpolation: `{var}`, and `{var|roman}` for a year shown as a numeral.
 *
 * Rules (voice.test.ts): playful vars and numbers match plain; plain has no Latin, no Roman numerals and no metaphor
 * words (seal, decree, charter, forum, empire, legion); playful is at most 30 characters longer; no `err.*` playful.
 */
import type { LatinKey } from './latin'

export interface Entry {
  /** required; the meaning, also used for screen readers */
  plain: string
  /** optional; falls back to plain */
  playful?: string
  /** optional; rendered by <LatinLine> only in playful */
  latin?: LatinKey
}

export const COPY = {
  // §3.1 Onboarding chrome
  'ob.progress': { plain: 'Step {n} of {total}' },
  'ob.rail.hint': { plain: 'The passport updates as you answer.', playful: 'Your passport is drawn as you answer.' },
  'ob.resume': { plain: 'Pick up where you left off? {name} · step {n} of {total}', playful: 'Welcome back. Pick up {name} at step {n} of {total}?' },
  'ob.close.sr': { plain: 'Save and close' },

  // §3.2 Onboarding steps
  'ob.start.title.first': { plain: 'Welcome to Principia' },
  'ob.start.title.new': { plain: 'New business' },
  'ob.start.sub': { plain: "Let's set up your business. About two minutes." },
  'ob.start.q': { plain: 'Do you already have code for this business?', playful: 'Already have code, or are we laying the first stone?' },
  'ob.start.yes': { plain: 'Yes, connect it' },
  'ob.start.yes.desc': { plain: 'A folder on this Mac or a GitHub repo' },
  'ob.start.no': { plain: "Not yet, it's an idea" },
  'ob.start.no.desc': { plain: "We'll start with a name" },
  'ob.start.explore': { plain: "I'll explore on my own" },
  'ob.start.quick': { plain: 'Quick create (just a name)' },
  'ob.start.how': { plain: 'How do you want to start?' },
  // five doors step 5 (design §6.1): one question, three answers
  'ob.start.where': { plain: 'Where does your business live today?' },
  'ob.lives.running': { plain: 'I have a business running' },
  'ob.lives.running.desc': { plain: 'A store, a website or socials: Shopify, Instagram…' },
  'ob.lives.code': { plain: 'I have code' },
  'ob.lives.code.desc': { plain: 'A folder on this Mac or a GitHub repo' },
  'ob.lives.idea': { plain: "It's an idea" },
  'ob.lives.idea.desc': { plain: "We'll start with a name" },
  'ob.start.prompt.link': { plain: 'Or describe it in a few lines' },
  'ob.start.guided': { plain: 'Guided' },
  'ob.start.guided.desc': { plain: 'A few short questions' },
  'ob.start.prompt': { plain: 'From a prompt' },
  'ob.start.prompt.desc': { plain: 'Paste a description or brief' },
  'ob.start.repo': { plain: 'From a repo' },
  'ob.start.repo.desc': { plain: 'A folder on this Mac or a GitHub repo' },
  'ob.brief.title': { plain: 'Describe your business' },
  'ob.brief.sub': { plain: 'Paste a description, a brief or a pitch. Long is fine. We turn it into a team and a first week of work.' },
  'ob.brief.reading': { plain: 'Reading your brief…' },
  'ob.connect.title': { plain: 'Connect your code' },
  'ob.connect.sub': { plain: "We read your files. We don't change them." },
  'ob.name.title': { plain: 'Give your business a name.', playful: 'Every empire starts with a name.' },
  'ob.name.sub': { plain: 'Only the name is required. The rest can wait.' },
  'ob.about.title': { plain: 'What do you sell, and to whom?' },
  'ob.about.hint': { plain: "Filled in from your README and package.json. Fix anything that's off." },
  'ob.voice.title': { plain: 'How should it sound?' },
  'ob.voice.sub': { plain: 'Pick a voice. Agents write in it.', playful: 'Orator or poet? Pick a voice. Agents write in it.' },
  'ob.goals.title': { plain: 'What should happen in the next 30 days?' },
  'ob.goals.sub': { plain: "Pick up to 3. We'll build the team around them.", playful: "Rome wasn't built in a day. Pick up to 3; we'll build the team around them." },
  'ob.goals.four': { plain: 'Three keeps the first week focused.' },
  'ob.content.title': { plain: 'Want to start posting already?' },
  'ob.content.sub': {
    plain: 'Agents can draft posts and make on-brand images. Nothing is published, sent or paid without you.',
    playful: 'Agents can draft posts and make on-brand images. Nothing is published, sent or paid without your seal.'
  },
  'ob.plan.kicker': { plain: 'Your plan', playful: 'The founding charter' },
  'ob.plan.title': { plain: "Here's your team for the first week", playful: 'Meet your team' },
  'ob.plan.tailoring': { plain: 'Tailoring with Claude…', latin: 'festina' },
  'ob.plan.tailored': { plain: 'Tailored by Claude ✓' },
  'ob.plan.team.sr': { plain: 'Your team: {count} agents' },
  'ob.plan.agent.rename': { plain: 'Rename {persona}' },
  'ob.plan.agent.firstTask': { plain: 'First task: {task}' },
  'ob.plan.primary': { plain: 'Create {name}' },
  'ob.launch.title': { plain: 'Setting up {name}…', latin: 'abovo' },
  'ob.launch.step.company': { plain: 'Company' },
  'ob.launch.step.code': { plain: 'Code' },
  'ob.launch.step.keys': { plain: 'Keys' },
  'ob.launch.step.passport': { plain: 'Passport' },
  'ob.launch.step.workflows': { plain: 'Workflows' },
  'ob.launch.step.team': { plain: 'Team' },
  'ob.launch.step.tasks': { plain: 'Tasks' },
  'ob.launch.step.schedules': { plain: 'Schedules' },
  'err.launch.company': { plain: "Couldn't create the company: {reason}" },
  'err.launch.code': { plain: "Couldn't connect the code: {reason}" },
  'err.launch.keys': { plain: "Couldn't save the keys: {reason}" },
  'err.launch.passport': { plain: "Couldn't write the passport: {reason}" },
  'err.launch.workflows': { plain: "Couldn't create the workflows: {reason}" },
  'err.launch.team': { plain: "Couldn't create the team: {reason}" },
  'err.launch.tasks': { plain: "Couldn't create the tasks: {reason}" },
  'err.launch.schedules': { plain: "Couldn't create the schedules: {reason}" },
  'ob.ready.title': { plain: '{name} is ready.', playful: '{name} is ready. Signed and sealed.' },
  'ob.ready.q': { plain: 'Start now?' },
  // five doors step 5: Ready opens the company; Home asks "Start the first week?"
  'ob.ready.next': { plain: 'Next, Home asks whether to start the first week.' },
  'ob.ready.open': { plain: 'Open {name}' },
  'ob.ready.start': { plain: 'Start now' },
  'ob.ready.review': { plain: "I'll review first" },
  'ob.ready.team': { plain: 'Your team' },

  // §3.3 Launch ceremony (playful only; plain is what screen readers hear)
  'cer.title': { plain: 'Your team is set up.', latin: 'alea' },
  'cer.sub': { plain: 'Your team is assembled.', playful: 'The die is cast. Your team is assembled.' },
  // the launch created no agents (beta off, or the team step skipped): no team to speak of
  'cer.title.none': { plain: '{name} is set up.' },
  'cer.sub.none': { plain: '{name} is set up.', playful: 'The die is cast. {name} is set up.' },
  'cer.agent': { plain: '{persona}, {role}. First task: {task}.', playful: '{persona} · {role}, first task: {task}' },
  'cer.agent.none': { plain: '{persona}, {role}. No task yet.', playful: '{persona} · {role}, ready when you are' },
  'cer.autopilot': { plain: 'Autopilot is on. {count} agents will start on their own.' },
  'cer.cta': { plain: 'Go to {name}' },
  'cer.skip': { plain: 'Skip' },

  // §3.4 Business Passport tablet (the inscription itself comes from inscription() in @shared/roman)
  'pp.label': { plain: 'BUSINESS PASSPORT' },
  'pp.empty': { plain: 'Your business' },
  'pp.founded': { plain: 'FOUNDED {year}', playful: 'FOUNDED · {year|roman}' },
  'pp.seal.sr.open': { plain: 'Not launched yet' },
  'pp.seal.sr.done': { plain: 'Launched' },

  // §3.5 Home
  'home.digest.title': { plain: 'Overnight', playful: 'The Senate briefing' },
  'home.digest.sub': { plain: 'Since you were last here' },
  'home.digest.empty': { plain: 'Nothing new since you were last here.', playful: 'Nothing since you left.', latin: 'quidnovi' },
  'home.greet.morning': { plain: 'Good morning' },
  'home.greet.afternoon': { plain: 'Good afternoon' },
  'home.greet.evening': { plain: 'Good evening' },
  'home.milestones': { plain: 'Milestones' },

  // §3.6 Needs you (only the top item may use the playful ny.ask)
  'ny.ask': { plain: '{persona} needs your answer', playful: 'Ave! {persona} awaits your decree' },
  'ny.review': { plain: '{persona} needs your review' },
  'ny.parked': { plain: '{persona} is stuck: {reason}' },
  'ny.unassigned': { plain: 'No one is assigned to this task' },
  'ny.empty': { plain: 'Nothing needs you.', latin: 'otium' },
  'ny.item.sr': { plain: '{persona}, {role}, needs you: {task}' },

  // §3.7 Board, departments, agents
  'board.empty': { plain: "No tasks yet. Add one, or start your agents and they'll propose some.", latin: 'acta' },
  'board.empty.cta': { plain: 'New task' },
  'dept.empty.agents': { plain: 'No agents in {dept} yet.' },
  'dept.add.cta': { plain: 'Add agent' },
  'dept.add.joined': { plain: '{persona} joined {dept} as {role}.' },
  'agent.header': { plain: '{persona} · {role}' },
  'agent.rename': { plain: 'Rename' },
  'agent.bio.label': { plain: 'About' },
  'agent.idle': { plain: 'Idle' },
  // the Latin goes on the first task-done toast of the day only (the caller decides)
  'toast.task.done': { plain: '{persona} finished “{task}”.', latin: 'bene' },

  // §3.8 Rail, Portfolio, Settings
  'rail.laurel.sr': { plain: 'All agents healthy' },
  'portfolio.empty': { plain: 'Run agents for each of your businesses, each with its own keys, repos and Passport.' },
  'portfolio.empty.cta': { plain: 'Set up your first business' },
  'settings.tone.label': { plain: 'Tone' },
  'settings.tone.desc': {
    plain: 'Playful adds warm copy, Latin with translations and a short launch ceremony. Plain keeps it straightforward. The drawings and busts stay either way.'
  },
  'settings.tone.playful': { plain: 'Playful' },
  'settings.tone.plain': { plain: 'Plain' },
  'settings.personas.label': { plain: 'Agent names and busts' },
  'settings.personas.desc': { plain: 'Give each agent a Roman name and a bust. The role is always shown.' },

  // §3.9 Loading lines (Latin pools live in index.ts)
  'load.plan': { plain: 'Tailoring with Claude…' },
  'load.launch': { plain: 'Setting up {name}…' },
  'load.scan': { plain: 'Reading {repo}…' },
  'load.site': { plain: 'Reading {host}…' },
  'load.run': { plain: 'Working…' },
  'load.generic': { plain: 'Loading…' }
} as const satisfies Record<string, Entry>

export type CopyKey = keyof typeof COPY

export type MilestoneKey = 'launched' | 'firstTask' | 'firstPost' | 'firstAnswer' | 'firstWeek' | 'fullTeam' | 'calmWeek' | 'hundred'
export type MilestoneGlyph = 'column' | 'scroll' | 'quill' | 'seal' | 'sun' | 'laurel' | 'dove' | 'coin'
export interface MilestoneCopy {
  /** plain name, also the screen-reader name ("First post approved") */
  plain: string
  /** playful badge name; the Latin (when `latin` is set) is the badge, with the translation beside it */
  playful: string
  latin?: LatinKey
  glyph: MilestoneGlyph
  /** lowercase plain meaning for the toast: "Milestone: first post approved." */
  meaning: string
  /** the rule, for docs and tests */
  rule: string
}

/** VOICE.md §7. Plain keeps the coins and plain names, with no Latin. */
export const MILESTONE_COPY: Readonly<Record<MilestoneKey, MilestoneCopy>> = {
  launched: { meaning: 'company launched', plain: 'Company launched', playful: 'Primus lapis', latin: 'primus', glyph: 'column', rule: 'the company was created through onboarding' },
  firstTask: { meaning: 'first task done', plain: 'First task done', playful: 'Labor omnia vincit', latin: 'labor', glyph: 'scroll', rule: 'first task in done' },
  firstPost: { meaning: 'first post approved', plain: 'First post approved', playful: 'Veni, vidi, vici', latin: 'veni', glyph: 'quill', rule: 'first task done by a Marketing agent or a content-role persona' },
  firstAnswer: { meaning: 'first answer', plain: 'First answer', playful: 'Your first decree', glyph: 'seal', rule: 'first ask answered by you' },
  firstWeek: { meaning: 'first week', plain: 'First week', playful: 'Nulla dies sine linea', latin: 'nulla', glyph: 'sun', rule: 'company at least 7 days old and at least 3 tasks done' },
  fullTeam: { meaning: 'full team', plain: 'Full team', playful: 'Concordia', latin: 'concordia', glyph: 'laurel', rule: 'every active agent has finished at least 1 task' },
  calmWeek: { meaning: 'calm week', plain: 'Calm week', playful: 'Pax', latin: 'pax', glyph: 'dove', rule: '7 days with no failed run and at least 1 task done' },
  hundred: { meaning: '100 tasks done', plain: '100 tasks', playful: 'Centuria', latin: 'centuria', glyph: 'coin', rule: '100 tasks done' }
}
