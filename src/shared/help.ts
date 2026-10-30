/**
 * Principia's own help (docs/CONTRACT.md "Principia help"): the curated knowledge base behind `principia_help`, so an
 * agent asked "how can I use Principia from my phone?" answers from it, with the principia:// link that opens the page,
 * instead of guessing. Pure data plus a deterministic search; bundled into main and both stdio MCP servers.
 *
 * Every entry says only what the current build does (the code and docs/*.md), never a plan. A PR that adds, renames,
 * moves or removes a user-facing feature updates its entry here (CONTRACT §10). Every link must parse with
 * shared/deepLink.ts parseDeepLink (help.test.ts checks them all, so the KB cannot rot silently).
 */

export interface HelpLink {
  /** what the link opens, in plain words */
  label: string
  /** a principia:// link (parseDeepLink accepts it) */
  href: string
}
export interface HelpEntry {
  id: string
  title: string
  /** a few plain sentences: how to do it, where it is, what it cannot do */
  how: string
  /** the words and phrases people ask it with (matched before the title and the text) */
  keywords: readonly string[]
  links: readonly HelpLink[]
}

const L = (label: string, href: string): HelpLink => ({ label, href })

export const HELP_ENTRIES: readonly HelpEntry[] = [
  {
    id: 'phone',
    title: 'Use Principia from your phone',
    how:
      'Settings › App › Phone. Turn Phone on, press "Share over the internet" (a private tunnel; it needs cloudflared: brew install cloudflared), then scan the QR code with the phone\'s camera. The code works once, for 5 minutes; "Copy link" gives the same pairing link to paste. The phone web app then shows what your agents are doing: answer what needs you, approve or send back drafts, read the board, continue a chat, message an agent, post in the team room, pause a company. Settings, keys, terminals, repositories, deleting and spending stay on the Mac. Paired phones stay paired across restarts (Revoke or "Sign out all phones" there). It works on any network while the Mac is awake and online, and reconnects by itself after Principia restarts. If the Mac\'s address changed (the Mac restarted, or Principia closed over a day), type the words shown under Paired phones into the phone. An iPhone app exists and is coming to TestFlight: there is no public link yet, so use the phone web app for now.',
    keywords: ['phone', 'iphone', 'mobile', 'android', 'cell', 'app store', 'testflight', 'ios', 'qr', 'qr code', 'pair', 'pairing', 'remote', 'away from my mac', 'on the go', 'from my phone', 'on my phone', 'with my phone', 'phone app', 'tunnel', 'cloudflared'],
    links: [L('Settings › Phone', 'principia://settings/phone')]
  },
  {
    id: 'conversation',
    title: 'Start a new conversation',
    how:
      'Press New conversation at the top of the sidebar (⌥⌘N), or type in the composer on Home. The To: menu picks who answers: "Principia picks" (it brings in the right agents from your words), "Everyone on the team", "Talk to one person" (a private one-on-one), or outside the team: plain Claude, or Claude in one of your repositories. The line under the composer says who will answer before you send. Typing @ in any composer adds people (@all for the whole team). Your last five conversations are under RECENT in the sidebar, and all of them in Chats (⌘4); ⌘K finds one by title, person or topic. Work an agent starts from a conversation shows there as a task card; when it needs you, the agent asks in the conversation itself, and your next reply (or Answer on the card) goes straight back to the task.',
    keywords: ['new chat', 'start a chat', 'new conversation', 'conversation', 'chat', 'talk', 'talk to', 'message', 'ask an agent', 'mention', '@', 'recent', 'to:', 'who answers', 'private', 'one on one', 'dm', 'continue a chat', 'thread'],
    links: [L('Chats', 'principia://chats'), L('Home', 'principia://home')]
  },
  {
    id: 'conversation-titles',
    title: 'Conversation titles, who answers, and new specialists',
    how:
      'Principia names each conversation in a few words ("Onboarding flow fixes") from your first message, and once more after the first answer; until then it shows your first words. Rename it by clicking the title in the conversation, or right-click it in the Chats list › Rename… (F2): your name is kept for good. With "Principia picks", Principia reads the request against each agent\'s role, department and instructions and brings in the best fit. When nobody on the team does that kind of work it suggests a new specialist in the conversation: Create & bring in (it joins and answers), Edit…, or Use <someone> instead. Nothing is hired without your click; agents can suggest one mid-conversation the same way.',
    keywords: ['title', 'rename', 'rename conversation', 'conversation name', 'name a chat', 'who answers', 'principia picks', 'routing', 'wrong agent', 'new specialist', 'create agent', 'hire from chat', 'nobody fits', 'suggest agent'],
    links: [L('Chats', 'principia://chats'), L('Settings › Team & autonomy', 'principia://settings/team')]
  },
  {
    id: 'task-chat',
    title: 'Watch a task work, and add a note',
    how:
      'A task an agent starts from a conversation belongs to that conversation: its row in the sidebar (RECENT, LIVE) and in Chats says "2 tasks working" or "1 needs you", and sorts first, so you know where to look; the working tasks are docked above its reply box. When one comes back, the row says "VO-16 finished · unread" with a dot until you open it, and the view opens on the new result. Watch on a task opens its own chat: the brief, what the agent says, its steps folded ("Ran 6 commands · read 3 files", click to see each), its questions, and a box to add a note: the agent gets it as soon as its current turn ends; with an open question, the note is the answer. From: goes back to the conversation. Tasks from autopilot or Run now are rows of their own. An agent\'s own chat is live only while it answers there.',
    keywords: ['watch', 'watch a task', 'task chat', 'live', 'working', 'what is it doing', 'add a note', 'comment on a task', 'tell the agent', 'unread', 'finished', 'result', 'subagent', 'progress', 'logs', 'steps'],
    links: [L('Chats › Live only', 'principia://chats'), L('The Board', 'principia://board')]
  },
  {
    id: 'navigation',
    title: 'Find your way around (shortcuts)',
    how:
      'The sidebar has five doors: Home ⌘1 (what needs you, what is running), Team ⌘2, Board ⌘3, Chats ⌘4, Knowledge ⌘5. Team unfolds (its chevron, or → on the row) into your departments, each with its open tasks, and each department into its dashboards. Everything else is under More (Automations, Add-ons, Files, Forum, Slack, Plans, Activity, Spend); right-click the sidebar for Customize Sidebar. ⌘K searches and runs any command, ⌘J jumps to the next thing that needs you, ⌘, opens Settings, ⌥⌘N starts a new conversation, ⌘N a new session, ⌘O adds a repository, ⇧⌘F opens the Forum, ⌘B hides the sidebar.',
    keywords: ['shortcut', 'keyboard', 'settings', 'preferences', 'hotkey', 'where is', 'find', 'navigate', 'sidebar', 'menu', 'command palette', '⌘k', 'cmd k', 'more', 'hidden', 'customize sidebar', 'needs you', 'home', 'team page'],
    links: [L('Home', 'principia://home')]
  },
  {
    id: 'companies',
    title: 'Companies, switching and Personal',
    how:
      'Each company has its own team, board, Knowledge, keys and connections. The rail on the left switches companies (⌃1 to ⌃9, All companies ⌃0, ⇧⌘O for the switcher) and its + makes a New company; ⌘K also offers "New Company…" and "Switch to …". Personal (Unassigned) holds anything not assigned to a company; it can be renamed but not archived. In All companies, Home shows the portfolio.',
    keywords: ['company', 'companies', 'switch company', 'new company', 'create a company', 'another business', 'personal', 'all companies', 'portfolio', 'rail', 'client'],
    links: [L('Home', 'principia://home'), L('Settings › General (this company)', 'principia://settings/company')]
  },
  {
    id: 'autopilot',
    title: 'Autopilot',
    how:
      'Autopilot is everything that runs without you pressing Start; the chip in the company header says whether it is on and what it does. Automations › Autopilot has three parts: On autopilot (playbooks such as Ads watch, Site watch, Social rhythm, Support triage, Revenue brief: each with a level, 1 Watch & report, 2 Propose changes, 3 Act within limits), Assigned work with the Auto-start switch (agents set to work on their own start the work assigned to them without waiting for Start; also on the Board and the company menu; on for new companies; an agent takes up to 3 tasks at once, and Run now never waits for a busy one), and Schedule packs (Marketing pack, Company pack: ordinary schedules you can edit). Needs you also offers "Put your ads on autopilot?" with Turn on / Not now / Never for this. A link only opens the card: you pick the level and press Turn on.',
    keywords: ['autopilot', 'auto pilot', 'auto-start', 'auto start', 'on its own', 'automatic', 'autonomous', 'run by itself', 'playbook', 'ads watch', 'site watch', 'schedule pack', 'marketing pack', 'company pack', 'level'],
    links: [L('Automations › Autopilot', 'principia://automations/autopilots'), L('Ads watch playbook', 'principia://automations/autopilots?add=ads-watch')]
  },
  {
    id: 'connections',
    title: 'Connect a tool or service',
    how:
      'Settings › Connections lists every service (Stripe, PostHog, Notion, GitHub, Instagram, Slack, Linear…). One service is one connection per company, whether it is an API key, an MCP server or a browser sign-in, and every agent and screen of that company uses it. A card\'s button says what to do: Connect, Sign in, Manage, How to set up or Fix; the sheet offers Paste a key or Sign in, "Also use in…" another company, and Disconnect. Each service has its own connect link that opens its card. Shopify, Google Business and Meta Ads are marked Coming soon.',
    keywords: ['connect', 'connection', 'integration', 'integrate', 'service', 'tool', 'stripe', 'posthog', 'notion', 'github', 'instagram', 'oauth', 'sign in', 'link my account', 'plug in'],
    links: [L('Settings › Connections', 'principia://settings/connections'), L('Connect Stripe (example)', 'principia://connect/stripe')]
  },
  {
    id: 'mcp',
    title: 'Add your own MCP server',
    how:
      'Settings › Connections › the Custom (MCP) card ("Any MCP server URL or command") › Add server. Give it a name, pick Remote server (a URL) or Local server (a command), and the authentication: Sign in with browser, API key / access token, or none; you can also paste a configuration from a setup guide. Each server then has Test, Edit and Remove. Its tools reach your agents through Principia (they list them with principia_list_tools), so you set it up once, not per harness.',
    keywords: ['mcp', 'mcp server', 'connect an mcp', 'add an mcp', 'own mcp', 'custom mcp', 'custom server', 'add server', 'model context protocol', 'gateway', 'custom tool', 'my own tool'],
    links: [L('Add your own MCP server', 'principia://connect/mcp')]
  },
  {
    id: 'slack',
    title: 'Slack',
    how:
      'Settings › Connections › Slack walks you through four steps: create the Slack app (Slack opens with the manifest filled in), make an app-level token (connections:write), install it to the workspace and paste the Bot User OAuth Token, press Connect, then DM the bot "hi" and answer Yes to send your alerts there. Join all public channels from there; private channels need /invite @hive. The Slack page (More › Slack, ⇧⌘L) mirrors the channels and threads; "Ask an agent about this thread" hands one to an agent. For agents to reply on their own, add a trigger in Automations › Slack triggers: Draft (recommended: you press Send on the draft card), Auto (only in channels you allow) or None. Alerts and "Also send Needs you to Slack" are in Settings › Notifications.',
    keywords: ['slack', 'connect slack', 'set up slack', 'slack bot', 'slack channel', 'slack alert', 'slack trigger', 'reply in slack', 'workspace', 'manifest'],
    links: [L('Connect Slack', 'principia://connect/slack'), L('Settings › Notifications', 'principia://settings/notifications')]
  },
  {
    id: 'linear',
    title: 'Linear',
    how:
      'Two separate things, both from Settings › Connections › Linear. "Let agents read and update Linear issues" is a browser sign-in for the agents. "Sync issues with the Board, both ways" keeps one Linear team in step with this company\'s Board (title, status, priority, labels, estimate, due date, parent, description): on the Board press ⋯ › Sync with Linear…, paste a personal API key (Linear › Settings › Security & access), Check Key, pick the team, choose Autosync (every minute) and Also send open tasks, then Connect. The same ⋯ menu has Sync Now and Disconnect (the tasks stay; nothing changes in Linear). One team per company; comments, attachments, cycles, projects and assignees do not sync.',
    keywords: ['linear', 'connect linear', 'sync with linear', 'linear sync', 'issues', 'issue tracker', 'sync tasks', 'tickets', 'jira'],
    links: [L('Connect Linear', 'principia://connect/linear'), L('The Board', 'principia://board')]
  },
  {
    id: 'browser',
    title: 'The company browser',
    how:
      'Every company has its own browser, with its own cookies and sign-ins, in a panel on the right of a chat or an agent\'s page: press Browser in the toolbar (Esc closes it). It has back, forward, reload, an address bar and tabs. Agents (Claude, Codex) drive it with their browser tools and it opens by itself when they start; you watch, or press Take over to drive it yourself while agents wait, then Hand back. Agents never type passwords or card numbers or pay without your yes.',
    keywords: ['browser', 'web browser', 'website', 'web page', 'browse', 'take over', 'chrome', 'look at a site', 'open a url', 'cookies'],
    links: [L('Open the browser', 'principia://browser')]
  },
  {
    id: 'routines',
    title: 'Routines, schedules and workflows',
    how:
      'More › Automations has tabs: Routines, Autopilot, Schedules, Workflows, Slack triggers. Routines are ready-made work on a schedule (Morning brief, Weekly company review, Support inbox triage, Social post drafts for your OK, Open pull requests digest, Code activity brief): Turn on, Run once now, Change time; what they make waits for your OK. Schedules (New Schedule) run a workflow or a single prompt at set times, with Run Now, Edit, Enable/Disable. Workflows (New Workflow) chain steps: Agent, Command (shell, Python, Node), a check, Notify. Schedules only run while Principia is open.',
    keywords: ['routine', 'automation', 'automate', 'schedule', 'scheduled', 'recurring', 'every day', 'every monday', 'cron', 'workflow', 'morning brief', 'weekly review', 'repeat', 'trigger', 'job'],
    links: [L('Automations › Routines', 'principia://automations/routines'), L('Add the Morning brief', 'principia://automations/routines?add=morning-brief'), L('Automations', 'principia://automations')]
  },
  {
    id: 'dashboards',
    title: 'Dashboards',
    how:
      'Dashboards live on each department\'s page, in its Dashboards card ("The numbers it watches", which its agents read), and are listed under Team in the sidebar: unfold Team, then a department, and click a dashboard (or Add a dashboard) to open the page right at it. Add one from "Recommended for …" (Add, or Add your keys) or Browse marketplace: SEO (Search Console), GEO (AI visibility), Plausible, PostHog, Revenue (Stripe, a restricted key only) and Engineering (GitHub). Check and add tests the key read-only before saving; each dashboard\'s ⋯ has Settings and keys…, Refresh now, Remove. Departments must be on (Settings › Experimental, or Turn on departments on Team or under it in the sidebar).',
    keywords: ['dashboard', 'metric', 'numbers', 'kpi', 'analytics', 'chart', 'stats', 'search console', 'seo', 'plausible', 'revenue'],
    links: [L('Connect PostHog for a dashboard', 'principia://connect/posthog?purpose=dashboard')]
  },
  {
    id: 'diagrams',
    title: 'Diagrams',
    how:
      'Agents can draw a diagram (a map of boxes and arrows, with an optional step-by-step walk through) that Principia lays out for them. It shows in a chat (a strip above the chat), task briefs and reports on the Board, Forum posts and Knowledge notes, with Fit, Open Full Window, Copy JSON and Walk Through. Ask with /visualize <what> in a Claude chat, ⌘K "Visualize…", or /visualize @agent <what> in the Forum. Only Claude chats get it today; there is no PNG or SVG export.',
    keywords: ['diagram', 'visualize', 'draw', 'graph', 'map', 'flowchart', 'architecture', 'chart of', 'picture'],
    links: [L('Chats', 'principia://chats')]
  },
  {
    id: 'voice',
    title: 'Voice and tone',
    how:
      'Principia has no voice input or speech in this build: you type to your agents. Its "voice" is the way it writes: Settings › App › General › Tone (Playful or Plain; Plain drops the jokes and Latin) and "Agent names and busts" (each agent gets a Roman name and a bust; off shows the role). Screen readers always get the plain wording.',
    keywords: ['voice', 'speak', 'speech', 'talk out loud', 'dictate', 'dictation', 'microphone', 'tone', 'playful', 'plain', 'latin', 'roman names', 'busts', 'persona'],
    links: [L('Settings › General', 'principia://settings/general')]
  },
  {
    id: 'cloud',
    title: 'Cloud: keep agents working while the Mac sleeps',
    how:
      'Settings › App › Cloud sync connects your own cloud (self-hosted; managed Principia Cloud is not available yet): Deploy on Render, or a one-file compose setup on a machine you own, then paste the connect link (Cloud URL and pairing code) and Connect. Then per company: Run in the cloud…, Run once now; the ⋯ menu has Pause company and Bring back to this Mac. Agent accounts are connected with Connect Claude and Sign in with ChatGPT in the browser. It is experimental and meant for one trusted operator.',
    keywords: ['cloud', 'cloud sync', 'server', 'mac sleeps', 'mac is off', 'always on', 'run in the cloud', 'self host', 'self-hosted', 'render', 'docker', 'worker', '24/7', 'telegram'],
    links: [L('Settings › Cloud sync', 'principia://settings/cloud')]
  },
  {
    id: 'updates',
    title: 'Update Principia',
    how:
      'Principia checks for updates 30 seconds after launch and every 4 hours, downloads in the background, and shows "Update ready" with Restart. It never restarts by itself, refuses while an agent or workflow is working, and also installs when you quit. Settings › App › About shows the version and Check for updates / Restart to install, and "Get beta updates". A build that cannot update itself says a new version is out and its Download button opens useprincipia.com.',
    keywords: ['update', 'upgrade', 'new version', 'latest version', 'version', 'release', 'beta', 'download', 'install', 'about'],
    links: [L('Settings › About', 'principia://settings/about')]
  },
  {
    id: 'privacy',
    title: 'Privacy: what stays on your Mac',
    how:
      'Principia runs on your Mac: your companies, Knowledge, tasks and chats are stored there, with no telemetry and no network listener unless you turn on Phone (and then only on 127.0.0.1, reached through a tunnel you start). Keys are encrypted with the macOS Keychain and never leave the Mac; agents get them as environment variables, and their output is redacted. What does go out: your agent CLIs talk to their own model providers, connected services are called when agents use them, Slack (if connected), the update check, and Cloud only if you set it up.',
    keywords: ['privacy', 'private', 'data', 'secure', 'security', 'safe', 'local', 'offline', 'telemetry', 'tracking', 'stays on my mac', 'who sees', 'leave my mac', 'upload', 'gdpr'],
    links: [L('Settings › About', 'principia://settings/about'), L('Settings › Storage', 'principia://settings/storage')]
  },
  {
    id: 'notifications',
    title: 'Notifications and sounds',
    how:
      'Settings › App › Notifications: macOS notifications for "Tell me when something needs me", failed jobs and missed schedules (always on), and "When a job finishes" (Scheduled only, Always, Never). Sounds have a master switch, Done / Needs you / Problem and a volume. With Slack connected, "Send my alerts to" a Slack DM or channel, Send test alert, and "Also send Needs you to Slack". Everything also waits in Needs you on Home.',
    keywords: ['notification', 'notify', 'alert', 'sound', 'ping', 'remind', 'tell me when', 'mute', 'quiet'],
    links: [L('Settings › Notifications', 'principia://settings/notifications')]
  },
  {
    id: 'addons',
    title: 'Add-ons (marketplace)',
    how:
      'More › Add-ons (⌘K "marketplace" finds it) lists ready-made workflows, skills, scripts and agents: inspect one, then Install or Add to Workflows. Workflows install as editable copies and never start a run; skills and subagents install for Claude Code. A community catalog URL goes in Settings › App › General › Marketplace URL.',
    keywords: ['add-on', 'addon', 'marketplace', 'skill', 'plugin', 'extension', 'template', 'catalog', 'install a workflow'],
    links: [L('Settings › General', 'principia://settings/general')]
  },
  {
    id: 'worktrees',
    title: 'Worktrees, branches and merging code tasks',
    how:
      'A code task on the Board has Start in its details: "Opens a new branch and worktree. Your checkout is not touched." Each task gets one worktree on a branch hive/<id>-<slug> from the default branch, and every turn of that task runs there. The task moves to In Progress when the worktree is made and In Review when its pull request is ready; "Changes requested" sends the agent back with your note. Its Work section has Open in Editor, Open PR, Merge… and Remove Worktree…: merging is yours (a squash merge through the GitHub CLI, gh), agents never merge, and a merged PR marks the task Done. Up to 3 run at once by default; the rest are queued. An agent works on several tasks at once: when another run already works in the checkout, Run now gives the task its own worktree by itself. There is no conflict-resolution screen.',
    keywords: ['worktree', 'branch', 'git', 'pull request', 'pr', 'merge', 'code review', 'repository', 'repo', 'checkout', 'github', 'commit', 'parallel tasks'],
    links: [L('The Board', 'principia://board'), L('Settings › Repositories', 'principia://settings/repos')]
  },
  {
    id: 'harness',
    title: 'Choose a harness: Claude Code, Codex, Cursor Agent, Gemini CLI',
    how:
      'Principia runs the agent CLIs installed on your Mac: Claude Code, Codex, Cursor Agent and Gemini CLI (sign in to each CLI yourself). Settings › App › AI providers lists them (Recheck, "not installed"), the Claude sign-in, model API keys, "Skip permission prompts…", and Profiles (New Profile: a CLI, model, permissions and keys). Each agent picks its profile under Runs on on its page (the side panel also has a one-click Claude | Codex switch); switching keeps its role, instructions and history and starts a fresh chat. Claude Code and Codex get the full toolset (memory, board, browser); Cursor and Gemini get a read-only brief, cannot resume a conversation, and their permission prompts do not reach Principia.',
    keywords: ['harness', 'claude', 'claude code', 'codex', 'cursor', 'cursor agent', 'gemini', 'gemini cli', 'model', 'cli', 'provider', 'ai provider', 'profile', 'switch model', 'gpt', 'openai', 'anthropic', 'runs on'],
    links: [L('Settings › AI providers', 'principia://settings/providers')]
  },
  {
    id: 'knowledge',
    title: 'Knowledge and memory (the Passport)',
    how:
      'Knowledge (⌘5) is what your agents know about the business: notes in an Obsidian-style folder per company, with Notes, Graph and Inbox, and New note. Agents read it before answering and suggest what to remember; nothing is written until you accept it in the Inbox (A accept, R reject, E edit). Notes open in Obsidian too ("Open in Obsidian"). Settings › App › General › "Memory for new sessions" sets Off, Read, or Read & write.',
    keywords: ['knowledge', 'memory', 'remember', 'passport', 'notes', 'note', 'vault', 'obsidian', 'what agents know', 'brand voice', 'forget', 'inbox', 'context'],
    links: [L('Knowledge', 'principia://knowledge')]
  },
  {
    id: 'departments',
    title: 'Departments and hiring agents',
    how:
      'Team (⌘2) shows one section per department and its agents. Hire adds a department from presets (Development, Marketing, Sales, Support, Ops, Finance); a department page has Add agent ("Add an agent to …": pick a profile, then role, instructions, autonomy and limits). Each agent card has Message; an agent\'s page has its chat plus Details, Queue, History, Instructions, Library, Computer. Agents can also propose a new department or agent in the Forum for your Approve or Reject, and in a conversation Principia suggests a new specialist when nobody on the team fits (Create & bring in). Departments are an Experimental switch (Settings › Experimental), or Turn on departments on Team.',
    keywords: ['department', 'hire', 'hiring', 'new agent', 'add agent', 'add an agent', 'team', 'employee', 'staff', 'role', 'agent instructions', 'org chart', 'marketing team', 'sales team'],
    links: [L('Settings › Team & autonomy', 'principia://settings/team'), L('Settings › Experimental', 'principia://settings/experimental')]
  },
  {
    id: 'board',
    title: 'The Board, tasks and approvals',
    how:
      'The Board (⌘3) holds every task. New task (or C) files one; a task\'s details have Run now, Open as session, Take over, Pause this task, Try again, Approve as done and Send back with note; dropping a card on Done marks it done too (the note is optional). Agents never mark a task done: you do. Needs you on Home (⌘J jumps to the next) collects approvals, questions and permission requests.',
    keywords: ['board', 'task', 'tasks', 'kanban', 'todo', 'ticket', 'approve', 'approval', 'review', 'send back', 'needs you', 'done', 'assign'],
    links: [L('The Board', 'principia://board'), L('New task (prefilled)', 'principia://board?new=Write%20the%20newsletter')]
  },
  {
    id: 'keys',
    title: 'API keys and secrets',
    how:
      'Settings › Keys & secrets: Add Key or Import .env…; each key is for This company or Shared (every company), and a company key overrides a shared one of the same name. Keys are encrypted with your macOS Keychain, never leave the Mac, and agents get them as environment variables; their values are hidden in logs. Model keys (Anthropic, OpenAI) live in Settings › AI providers. A service\'s key can also be pasted on its card in Connections. Never paste a key in a chat.',
    keywords: ['api key', 'key', 'secret', 'token', 'env', '.env', 'credential', 'password', 'environment variable', 'keychain', 'anthropic key', 'openai key'],
    links: [L('Settings › Keys & secrets', 'principia://settings/keys'), L('Settings › AI providers', 'principia://settings/providers')]
  },
  {
    id: 'forum',
    title: 'Forum (the team room) and invites',
    how:
      'The Forum (More › Forum, ⇧⌘F) is where a company\'s agents talk: #general, one channel per department and #proposals. A post that opens with @handle wakes that agent (an @ mid-sentence is only a mention). Agents propose departments and agents there for your Approve or Reject. Invite people makes a code (Member, Guest or Admin; shown once, Copy code / Copy link); today it is redeemed on this Mac only, not across machines.',
    keywords: ['forum', 'team room', 'channel', 'general channel', 'proposals', 'invite', 'invitation', 'join', 'cofounder', 'colleague', 'add a person', 'share with my team', 'collaborate'],
    links: [L('The Forum', 'principia://forum')]
  },
  {
    id: 'spend',
    title: 'Usage, costs and a monthly cap (Spend)',
    how:
      'More › Spend (⌘K "usage", "cost" or "billing") shows Week or Month by agent and by department, Show value in $, and Export CSV. On a Claude plan it says what is included; with an API key, that it is billed per use. A $ figure is what the CLI reported, ~ is estimated, — means no price is known (Codex, Gemini). "Set a cap" puts a monthly cap on a company (not Personal): it pauses when this month\'s pay-as-you-go value reaches it. Disk use is in Settings › Storage.',
    keywords: ['usage', 'cost', 'costs', 'spend', 'spending', 'money', 'billing', 'price', 'tokens', 'budget', 'cap', 'limit', 'how much', 'expensive', 'plan limit'],
    links: [L('Settings › Storage', 'principia://settings/storage')]
  },
  {
    id: 'setup',
    title: 'Get started: the setup checklist',
    how:
      'On a company\'s Home, "Get the most out of Principia" is a checklist checked from real state: logo, Knowledge, a repository, departments and agents, dashboards, socials, connections, a schedule, autopilot. Each item has one button that opens the right place; the next one is marked Next. It ends with the Marketing and Company schedule packs. A dismissed card comes back from ⌘K "Show Setup Checklist" or the company menu.',
    keywords: ['get started', 'getting started', 'setup', 'set up', 'onboarding', 'checklist', 'first steps', 'begin', 'start using', 'what can principia do', 'tour', 'new here'],
    links: [L('Home', 'principia://home')]
  },
  {
    id: 'pause',
    title: 'Pause or resume a company',
    how:
      'The company menu (and Team\'s toolbar) has Pause <company> and Resume <company>. Pause covers the whole company: its agents, schedules and autopilot stop until you resume; while paused, Autopilot is greyed out. You can also pause a company from the phone app.',
    keywords: ['pause', 'stop', 'resume', 'stop all agents', 'halt', 'freeze', 'turn off agents', 'emergency stop'],
    links: [L('Home', 'principia://home')]
  },
  {
    id: 'sessions',
    title: 'Coding sessions and repositories',
    how:
      'A session is an agent CLI (Claude Code, Codex…) in a terminal pane on one of your repositories. ⌘O adds a repository (Settings › Repositories lists them), ⌘N starts a New Session, and ⌘K "New … session in <repository>" picks where. With a team, "Claude in <repository>" is also a choice in New conversation\'s To: menu, and its sessions are listed under Chats › Claude. ⌘W closes a session.',
    keywords: ['session', 'terminal', 'repository', 'repo', 'code', 'coding', 'folder', 'project', 'add repository', 'open a project', 'pane', 'claude in'],
    links: [L('Settings › Repositories', 'principia://settings/repos'), L('Chats', 'principia://chats')]
  }
]

// ---------- search: keyword, alias and phrase scoring (IDF-weighted), deterministic ----------

const STOP = new Set(
  'a an and are as at be by can could do does doing for from get got have how i if in into is it its me my of on or our please principia principia\'s set should so that the their them there this to us use used using want way we what when where which who why will with would you your'.split(' ')
)
const norm = (s: string): string => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[’']/g, '')
/** Words of a text: lowercased, accents and stop words dropped, a plural `s` folded (chats → chat). */
export function helpTokens(s: string): string[] {
  return norm(s)
    .split(/[^a-z0-9⌘⌥]+/)
    .filter((t) => t.length > 1 && !STOP.has(t))
    .map((t) => (t.length > 3 && t.endsWith('s') && !t.endsWith('ss') ? t.slice(0, -1) : t))
}
/** One word means another: equal, or one is the other plus a short ending (connect → connection, scheduled → schedule). */
const same = (q: string, w: string): boolean => q === w || (Math.min(q.length, w.length) >= 4 && Math.abs(q.length - w.length) <= 3 && (w.startsWith(q) || q.startsWith(w)))

interface Indexed {
  e: HelpEntry
  key: string[]
  title: string[]
  text: string[]
  phrases: string[]
}
let INDEX: { docs: Indexed[]; idf: (t: string) => number } | null = null
function index(): NonNullable<typeof INDEX> {
  if (INDEX) return INDEX
  const docs = HELP_ENTRIES.map((e) => ({
    e,
    key: e.keywords.flatMap(helpTokens),
    title: helpTokens(e.title),
    text: helpTokens(e.how),
    phrases: e.keywords.filter((k) => k.includes(' ')).map((k) => ` ${helpTokens(k).join(' ')} `)
  }))
  const N = docs.length
  const idf = (t: string): number => {
    const df = docs.filter((d) => [...d.key, ...d.title].some((w) => same(t, w))).length
    return Math.log(1 + (N - df + 0.5) / (df + 0.5))
  }
  INDEX = { docs, idf }
  return INDEX
}

/**
 * The entries that best answer a question, best first (at most `limit`, default 3). Each question word scores its
 * best field (a keyword 3, the title 2, the text 0.5) times its IDF; a whole keyword phrase found in the question adds
 * 2 per word. Entries far behind the best (under 40% of its score) are left out. [] = nothing matched.
 */
export function searchHelp(question: string, limit = 3): HelpEntry[] {
  const q = [...new Set(helpTokens(question))]
  if (!q.length) return []
  const { docs, idf } = index()
  const full = ` ${helpTokens(question).join(' ')} `
  const scored = docs
    .map((d) => {
      let s = 0
      for (const t of q) {
        const w = d.key.some((x) => same(t, x)) ? 3 : d.title.some((x) => same(t, x)) ? 2 : d.text.some((x) => same(t, x)) ? 0.5 : 0
        s += w * idf(t)
      }
      for (const p of d.phrases) if (p.trim() && full.includes(p)) s += 2 * p.trim().split(' ').length
      return { e: d.e, s }
    })
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || HELP_ENTRIES.indexOf(a.e) - HELP_ENTRIES.indexOf(b.e))
  const best = scored[0]?.s ?? 0
  return scored.filter((x) => x.s >= best * 0.4).slice(0, Math.max(1, limit)).map((x) => x.e)
}

export const HELP_NOTE =
  "Principia's built-in help, about the current build. Answer from it in your own words and give the founder the principia:// link: it opens that page in Principia. If it does not cover the question, say what it does cover; never guess."

/** What `principia_help` returns: the best entries, or (nothing matched) every topic title to ask again with. */
export function helpAnswer(question: string): { entries: { title: string; how: string; links: HelpLink[] }[]; topics?: string[]; note: string } {
  const hits = searchHelp(question)
  if (!hits.length) return { entries: [], topics: HELP_ENTRIES.map((e) => e.title), note: 'No help entry matched. Ask again with words from one of these topics.' }
  return { entries: hits.map((e) => ({ title: e.title, how: e.how, links: [...e.links] })), note: HELP_NOTE }
}
