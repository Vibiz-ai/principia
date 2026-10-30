/**
 * Hive main process. Native macOS app: window via loadFile, Electron IPC only, zero network listeners.
 * Startup order (CONTRACT §8): userData override -> single-instance lock -> ready -> paths -> login env -> db ->
 * boot recovery + seeds -> engine -> IPC -> artifacts indexer -> tray + menu -> window -> scheduler.
 */
import { GatewayService } from './gateway/service'
import { app, BrowserWindow, crashReporter, nativeTheme, powerMonitor, safeStorage } from 'electron'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as pty from 'node-pty'
import { Reaper, StallMonitor, createEngine, stallThresholdMs } from './engine'
import { applyUserDataOverride, resolvePaths } from './paths'
import { installVisualizeSkill } from './diagrams/visualizeSkill'
import { baseChildEnv, resolveLoginEnv } from './loginEnv'
import { openDatabase } from './db'
import { Store } from './db/store'
import { createEngineStore } from './db/engineStore'
import { Vault } from './vault'
import { SessionManager } from './sessions'
import { ArtifactIndexer } from './artifacts'
import { removeThumbs } from './thumbnails'
import { WindowManager } from './windowManager'
import { HiveTray } from './tray'
import { buildAppMenu } from './menu'
import { Hive } from './hive'
import { createGuardedExit } from './exitGuard'
import { emit, setEventTargets, setTrustedSender } from './ipc'
import { registerAllHandlers } from './handlers'
import { importWorkflowFromDialog } from './handlers/workflows'
import { closeLog, initLog, log, setLogRedactor } from './log'
import { offerMoveToApplicationsNow } from './appLocation'
import { claudeConversationExists, claudeDataDir, trustFolderForClaude } from './claudeTrust'
import { historyRoots } from './history'
import { MemoryService, resolveServerScript } from './memory/service'
import { createMigrator } from './memory/vault/migrate'
import { LLM_CLI_KEYS, LLM_CLI_ORDER, installSuggestions, type LlmCli } from './memory/vault/suggest'
import { pickCli, strippedChildEnv } from './oneshot'
import { LiveStore } from './db/liveStore'
import { createLiveBridge, resolveHookScript, sweepLiveDirs } from './live/bridge'
import { SessionLiveHub } from './live/sessionLive'
import { chatLink, createChatHub } from './chat/wire'
import { AgentChats } from './chat/agentChat'
import { createRemote } from './remote/wire'
import { terminalHost } from './remote/terminalHost'
import { createBrowser } from './browser/wire'
import { bootAuthoring, wireAuthoring } from './author/wire'
import { wireForum } from './forum/wire'
import { wireDashboards } from './dashboards/wire'
import { backfillConnections, connectionsChanged, wireConnections } from './connections/wire'
import { wireTaskWork } from './company/taskWorkWire'
import { wireLinearSync } from './company/sync/wire'
import { startOrchestrator } from './orchestrator/wire'
import { SlackService } from './connectors/slack/service'
import { DeepLinkInbox, PROTOCOL, deepLinkFromArgv, shouldRegisterProtocol } from './deepLinks'
import { UpdateService, appCannotSelfUpdate, type Updater } from './updates'
import { updatesOffReason } from '../shared/updates'

/** a quit during startup waits this long for it to finish, then exits */
const BOOT_QUIT_CAP_MS = 20_000

applyUserDataOverride()
// BROWSER.md §2: agents drive the company browser while Principia sits behind other windows. An occluded window must
// keep rendering: clicks are hit-tested against rendered frames and screenshots need one.
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
app.setName('Hive')
// Local minidumps only (<userData>/Crashpad), never uploaded: lets us see why a renderer or GPU process died.
crashReporter.start({ uploadToServer: false })

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  let hive: Hive | null = null
  let pendingShow = false
  // principia:// links (deepLinks.ts): checked here, navigated by the renderer
  const links = new DeepLinkInbox()

  app.on('second-instance', (_e, argv) => {
    const url = deepLinkFromArgv(argv)
    if (url) links.receive(url)
    if (hive?.windows) hive.windows.show()
    else pendingShow = true
  })
  // macOS: also on a cold launch from a link, before ready
  app.on('open-url', (e, url) => {
    e.preventDefault()
    if (links.receive(url) && !hive) pendingShow = true
  })
  app.on('activate', () => hive?.windows?.show())

  // A quit that arrives while the app is still starting (Cmd+Q, Dock Quit, logout while engine.init or provider
  // detection is awaited) waits for startup to finish and then takes the normal path: quitting half-way would let the
  // rest of startup create windows and start the scheduler after the shutdown. If startup never finishes, exit anyway.
  let booted = false
  let quitAfterBoot = false
  let bootWatchdog: ReturnType<typeof setTimeout> | null = null
  const quitHive = (): void => {
    if (!hive) return
    if (!booted) {
      if (quitAfterBoot) return
      quitAfterBoot = true
      log.info('quit requested during startup; quitting once it finishes')
      bootWatchdog = setTimeout(() => {
        if (booted) return
        log.warn('startup did not finish; exiting')
        guardedExit(0)
      }, BOOT_QUIT_CAP_MS)
      return
    }
    hive.requestQuit().catch((e: unknown) => log.error('quit failed', { e: String(e) }))
  }
  app.on('before-quit', (e) => {
    if (!hive || hive.shutdownDone) return
    e.preventDefault()
    quitHive()
  })
  app.on('window-all-closed', () => {
    // Hive keeps running in the menu bar; quit only via Cmd+Q / tray / app:quit.
  })
  app.on('will-quit', () => {
    // Last point where native modules may be touched: ptys are already gone (requestQuit / guarded exit).
    try {
      hive?.db.close()
    } catch {
      /* already closed */
    }
    closeLog()
  })

  // Every exit (including app.exit() from tooling such as Playwright) waits for live ptys to be killed and their
  // exit callbacks delivered first, reaps what this Hive tagged, and hard-kills the process if Electron's exit does
  // not end it (exitGuard.ts).
  const realExit = app.exit.bind(app)
  const guardedExit = createGuardedExit({
    sessions: () => hive?.sessions,
    // CONTRACT §13: every exit path reaps what this Hive tagged (dev servers, watchers)
    reap: () => void hive?.reaper?.reapAllSync(),
    realExit: (code) => realExit(code),
    log
  })
  try {
    ;(app as { exit: (code?: number) => void }).exit = guardedExit
  } catch {
    /* non-writable in some Electron build: requestQuit still stops ptys before quitting */
  }

  // SIGTERM/SIGINT (kill, launchctl, dev tooling): same graceful path as Cmd+Q minus the confirm dialog, so agent
  // process groups are killed instead of orphaned. Registered after 'ready' on purpose: Chromium installs its own
  // SIGTERM/SIGINT handlers during startup (they call app.quit(), which the hide-to-tray/before-quit path swallowed),
  // and libuv only installs its sigaction when the first JS listener for a signal is added — so a listener added at
  // module load is silently overridden. Hard exit after 3.5 s if graceful shutdown hangs; a second signal exits now.
  let signaled = false
  const onSignal = (sig: NodeJS.Signals): void => {
    log.info('received signal, shutting down', { sig })
    if (signaled || !hive) return guardedExit(signaled ? 1 : 0)
    signaled = true
    hive.forceQuit = true
    setTimeout(() => {
      log.warn('graceful shutdown timed out; forcing exit', { sig })
      guardedExit(0)
    }, 3500)
    if (hive.shutdownDone) app.quit()
    else quitHive()
  }
  const installSignalHandlers = (): void => {
    for (const sig of ['SIGTERM', 'SIGINT'] as const) {
      process.removeListener(sig, onSignal)
      process.on(sig, onSignal)
    }
  }
  app.on('web-contents-created', (_e, wc) => {
    wc.on('will-attach-webview', (ev) => ev.preventDefault())
    wc.setWindowOpenHandler(() => ({ action: 'deny' }))
  })

  void app.whenReady().then(async () => {
    installSignalHandlers()
    nativeTheme.themeSource = 'dark'
    const paths = resolvePaths()
    initLog(paths.mainLog)
    installVisualizeSkill(paths.userData) // DIAGRAMS.md §6: /visualize in the Claude chats Principia starts
    log.info('Hive starting', { version: app.getVersion(), userData: paths.userData, packaged: app.isPackaged })
    // Connect configs hold this app's path: outside /Applications ask to move it (it relaunches from there)
    if (await offerMoveToApplicationsNow(paths.userData)) return
    const envState = await resolveLoginEnv()
    if (!envState.ok) log.warn('login shell env resolution failed; using fallback PATH', { shell: envState.shell })

    const db = openDatabase(paths.dbPath)
    const store = new Store(db)
    const cipher = {
      available: () => safeStorage.isEncryptionAvailable(),
      encrypt: (s: string) => safeStorage.encryptString(s),
      decrypt: (b: Buffer) => safeStorage.decryptString(b)
    }
    const vault = new Vault(db, {
      ...cipher
    })
    setLogRedactor((s) => vault.redact(s))

    const h = new Hive(db, store, vault, paths)
    hive = h
    // COMPANY.md §6: a connection limited to some companies reaches only their spawns
    h.gateway = new GatewayService({ userData: paths.userData, mainDir: __dirname, cipher, vault, baseEnv: () => baseChildEnv(), seedDefaults: true,
      companies: { forCwd: (cwd) => h.company.companyForCwd(cwd).id, enforced: () => store.companyGuardsEnforced(), warn: (m, meta) => log.warn(m, meta) },
      // AUTOPILOT.md §6: an autopilot's run is checked call by call against its level, before each call is made
      guard: (c) => h.playbooks?.gatewayCall(c) ?? null,
      // CONNECTIONS.md §3.3: a saved key the vendor's MCP takes as a bearer gives agents its tools; reuse across companies
      virtuals: (companyId) => h.connections?.virtuals(companyId) ?? [],
      reuses: (connectionId, companyId) => h.connections?.reusedConnectionReaches(connectionId, companyId) ?? false,
      // CONN-QA-01: an agent's call the vendor turned down marks the key on every surface
      onVirtualRejected: (companyId, serviceId) => {
        const r = h.connections
        if (!r) return
        const k = h.safe(() => r.virtuals(companyId).find((v) => v.serviceId === serviceId)?.keyNames[0] ?? null, null)
        if (!k) return
        r.recordKeyProblem(companyId, serviceId, k, 'The service turned down the key when an agent used it. Paste a new key.')
        connectionsChanged(companyId, serviceId)
      },
      onChange: () => connectionsChanged(null) })
    app.on('will-quit', () => h.gateway?.close())
    // CONNECTIONS.md: the per-company connection index and resolver; failure = surfaces fall back to their own checks
    try {
      h.connections = wireConnections(h, cipher)
    } catch (e) {
      log.error('connections unavailable', { e: String(e) })
    }

    // shared memory (MEMORY.md): separate memory.db, opened + migrated by main only. Failure = memory off, Hive runs.
    try {
      const memory = new MemoryService({
        userData: paths.userData,
        serverScript: resolveServerScript(__dirname),
        execPath: process.execPath,
        listRepos: () => store.listRepos(),
        // AUTHORING.md §6.3: a Hive worktree's cwd maps back to its source repo (project memory still applies)
        mapCwd: (cwd) => hive?.worktrees?.sourceRepoFor(cwd) ?? null,
        redact: (t) => vault.redact(t),
        secretValues: () => vault.secretValues(),
        emit: (e) => emit('memory:changed', e),
        log
      })
      memory.start()
      vault.setChangeListener(() => memory.refreshFingerprints())
      h.memory = memory
      // PASSPORT.md §9: v1 memory.db + legacy Passports -> vault, behind memory:vault migrate (h.memory.migrate)
      memory.setMigrator(createMigrator({ userData: paths.userData, companies: h.company, listRepos: () => store.listRepos(), runtime: () => memory.passport(), log }))
      // PASSPORT.md §12: link suggestions, the harvester on step output, and the opt-in AI tier
      const suggest = installSuggestions(memory, {
        redact: (t) => vault.redact(t),
        log,
        stepOutputHooks: h.stepOutputHooks,
        llm: {
          enabled: () => store.getSettings().experimental?.vaultAI === true,
          cli: () => pickCli(h.safe(() => h.engine.providers.cached(), []), LLM_CLI_ORDER),
          // §12 billing stays in the company: only that company's own provider key, never a shared or other provider key
          env: (companyId: string, cli: LlmCli) => strippedChildEnv(vault.resolveCompanyOnly(LLM_CLI_KEYS[cli], companyId))
        }
      })
      h.memorySuggest = suggest
      app.on('will-quit', () => suggest.stop())
      // §6.3: window focus rescans every watched vault (edits made in Obsidian while Principia was in the background)
      app.on('browser-window-focus', () => {
        if (memory.vaultMode()) h.safe(() => memory.passport().rescanAll(), undefined)
      })
    } catch (e) {
      log.error('memory.db unavailable; shared memory is off', { e: String(e) })
    }

    // boot recovery (CONTRACT §3): no zombie sessions
    const recovered = store.recoverSessions()
    if (recovered.length) log.info('marked interrupted sessions exited', { count: recovered.length })

    // live agents (LIVE.md §1.2, §2, §5): live agents -> failed "Hive quit", open asks -> canceled, live dirs swept
    const live = new LiveStore(db, (t) => vault.redact(t))
    h.live = live
    try {
      const rec = live.bootRecover()
      const ret = live.retention()
      const swept = sweepLiveDirs(paths.userData)
      if (rec.agents || rec.asks || ret.agents || swept) log.info('live boot recovery', { ...rec, retention: ret, swept })
    } catch (e) {
      log.warn('live boot recovery failed', { e: String(e) })
    }
    const liveBridge = createLiveBridge({
      userData: paths.userData,
      execPath: process.execPath,
      hookScript: resolveHookScript(__dirname),
      log,
      // AUTHORING.md §1.2: `hive` tool calls arrive in the caller's own live dir; identity = that channel's owner
      onAuthor: (owner, line, writeAnswer) => {
        if (!h.author) return writeAnswer(String(line.call_id ?? ''), { ok: false, error: 'Hive authoring is not available' })
        if (line.hive === 'author_cancelled') h.author.handleCancel(owner, line)
        else h.author.handleCall(owner, line, writeAnswer)
      }
    })
    h.initLive()
    // CONTRACT §13: one reaper for sessions, steps, quit and leftovers; tags carry this userData so other Hives are safe
    const reaper = new Reaper({ userData: paths.userData, log })
    h.reaper = reaper
    // AUTHORING.md: broker, worktrees, notify nodes, Claude history (failure = authoring off, Hive runs)
    try {
      wireAuthoring(h, { mainDir: __dirname, reaper })
    } catch (e) {
      log.error('authoring unavailable', { e: String(e) })
    }
    // FORUM.md §3: the company Forum (store, agent endpoint, harvest); failure = no Forum, Principia runs
    try {
      h.forum = wireForum(h, { mainDir: __dirname })
    } catch (e) {
      log.error('forum unavailable', { e: String(e) })
    }
    // BROWSER.md: the company browser (views, sessions, the agents' 127.0.0.1 endpoint); failure = no browser
    try {
      h.browser = createBrowser(h, { mainDir: __dirname })
    } catch (e) {
      log.error('company browser unavailable', { e: String(e) })
    }
    // REMOTE.md: Phone (built idle: no listener until the user turns it on)
    try {
      // a terminal session reads on the phone as a chat: its CLI's transcript (or screen), and messages typed into it
      const terminal = terminalHost({
        live: (sid) => h.sessionLive?.get(sid) ?? null,
        claudeFile: (conv) => h.chats?.transcriptFile(conv) ?? null,
        claudeRoots: () => [...historyRoots(baseChildEnv()), path.join(claudeDataDir(baseChildEnv()), 'projects')],
        codexHome: () => baseChildEnv().CODEX_HOME?.trim() || path.join(os.homedir(), '.codex'),
        // every recent Codex session, so a rollout goes to its own session whichever one a phone opens first
        codexSessions: () => h.store.listSessions('all', new Date(Date.now() - 2 * 86_400_000).toISOString()).filter((s) => s.adapter === 'codex'),
        redact: (t) => h.vault.redact(t),
        log
      })
      h.remote = createRemote({ mainDir: __dirname, envPath: () => baseChildEnv().PATH, dataDir: app.getPath('userData'), siteSetting: () => h.settings().phoneSiteUrl, db: h.db, autoStartSetting: () => h.settings().phoneAutoStart, terminal })
      // RA8: paired phones find this Mac again after a restart (when the founder wants it, by default once one is paired)
      void h.remote.autoStartIfWanted().catch((e) => log.warn('phone did not start at launch', { e: String(e) }))
    } catch (e) {
      log.error('phone unavailable', { e: String(e) })
    }
    // DASHBOARDS.md: department dashboards (fetch and refresh in main); failure = no dashboards, Principia runs
    try {
      h.dashboards = wireDashboards(h, cipher)
    } catch (e) {
      log.error('dashboards unavailable', { e: String(e) })
    }
    // LINEAR.md: optional Linear sync (no connected company = no request); failure = no sync, Principia runs
    try {
      h.linear = wireLinearSync(h, cipher)
    } catch (e) {
      log.error('linear sync unavailable', { e: String(e) })
    }
    // SLACK.md §2.3: the Slack connector (no tokens = zero outbound requests). The dev-only fake transport exists only
    // in a build made with HIVE_BUILD_FAKE_SLACK=1 (the define removes this branch from every normal build).
    try {
      let transport: ConstructorParameters<typeof SlackService>[1]['transport'] = null
      if (__HIVE_FAKE_SLACK__ && !app.isPackaged && process.env.HIVE_FAKE_SLACK) {
        const { createDevFakeTransport } = await import('./connectors/slack/devFake')
        transport = createDevFakeTransport(process.env.HIVE_FAKE_SLACK)
      }
      h.slack = new SlackService(h, { cipher, mainDir: __dirname, transport })
    } catch (e) {
      log.error('slack unavailable', { e: String(e) })
    }
    backfillConnections(h)
    const sessionStall = new StallMonitor({ thresholdMs: () => stallThresholdMs(store.getSettings().stallMinutes) })
    sessionStall.startTimer(15_000)
    h.sessionLive = new SessionLiveHub({
      store: live,
      emit: (e) => h.onLiveEvent(e),
      writePty: (sid, data) => {
        h.sessions.writeKeys(sid, data)
      },
      isVisible: (sid) => h.sessionVisible(sid),
      onIdle: (root, turnMs) => h.notifier.idle(root, turnMs),
      onNeedsChanged: () => h.statusChanged(),
      stall: sessionStall,
      onLimit: (root, hit) => h.onSessionLimit(root, hit),
      onLimitCleared: (sid) => h.onSessionLimitCleared(sid),
      log
    })

    const engineStore = createEngineStore(db, { describe: () => (w) => h.engine.scheduler.describe(w), live, slackTriggers: h.slack?.triggers })
    // CLOUD.md §8: schedules placed in the cloud fire there only, never from this Mac's scheduler
    h.safe(() => h.cloud.link.guardSchedules(engineStore), engineStore)
    h.engine = createEngine({
      paths: {
        userData: paths.userData,
        artifactsRoot: paths.artifactsRoot,
        runLogsDir: paths.runLogsDir,
        scratchDir: paths.scratchDir
      },
      store: engineStore,
      baseEnv: () => baseChildEnv(),
      // COMPANY.md §4: a run's company keys overlay the shared ones
      secrets: { resolve: (names, companyId) => vault.resolve(names, companyId), redact: (t) => vault.redact(t), names: (n, companyId) => vault.names(n, companyId) },
      getSettings: () => store.getSettings(),
      getProfile: (id) => store.getProfile(id),
      getRepo: (id) => store.getRepo(id, (rid) => h.sessions?.liveCountForRepo(rid) ?? 0),
      listRepos: () => store.listRepos(),
      passportContext: (cwd, companyId, departmentId) => h.passportContext(cwd, companyId, departmentId),
      company: h.companyBridge(),
      onStepOutput: (e) => h.onStepOutput(e),
      // ORCHESTRATOR.md §1.1: Principia's context and report contract for every company step (wired after the dispatcher)
      orchestrator: { stepContext: (req) => h.orchestrator?.stepContext(req) ?? null },
      getWorkflow: (id) => store.getWorkflow(id),
      emit: (e) => h.onEngineEvent(e),
      log,
      gateway: h.gateway ?? undefined,
      browser: h.browser?.service ?? undefined,
      autopilot: { strictMcp: (runId) => h.playbooks?.strictMcpFor(runId) ?? false },
      memory: h.memory ?? undefined,
      live: liveBridge,
      reaper,
      worktrees: h.worktrees ?? undefined,
      notifier: h.notifyNode ?? undefined,
      slack: h.slack?.bridge(),
      forum: h.forum ?? undefined
    })
    store.setDescribe((w) => h.engine.scheduler.describe(w))

    // CHAT-UI.md §3: Claude panes go through the chat hub (chat or terminal inside); every other pane is a plain pty
    h.chats = createChatHub(h, {
      userData: paths.userData,
      emit: (sessionId, seq, ops) => emit('chat:ops', { sessionId, seq, ops }),
      redact: (t) => vault.redact(t),
      killGroup: (pid, sig) => {
        try {
          process.kill(-pid, sig)
          return true
        } catch {
          return false
        }
      },
      log,
      baseEnv: () => baseChildEnv()
    })
    const plainPty = (file: string, args: string[], opts: { name: string; cols: number; rows: number; cwd: string; env: Record<string, string> }) => pty.spawn(file, args, opts)
    h.sessions = new SessionManager({
      store,
      paths,
      spawnPty: (file, args, opts, host) => (h.chats ? h.chats.spawn(file, args, opts, host, plainPty) : plainPty(file, args, opts)),
      interactiveSpawn: (profile, opts) => h.engine.providers.interactiveSpawn(profile, opts),
      baseEnv: () => baseChildEnv(),
      secrets: { resolve: (n, companyId) => vault.resolve(n, companyId), redact: (t) => vault.redact(t), names: (n, companyId) => vault.names(n, companyId) },
      company: h.companyBridge(),
      chat: (req) => h.safe(() => h.chatContext(req), null),
      agentChat: (agentId) => h.safe(() => h.agentChats?.spawnOptions(agentId) ?? null, null),
      worktreeGuard: (cwd, p) => h.worktrees?.guardEnvForPath(cwd, p) ?? null,
      trustFolder: (cwd, env) => {
        if (!trustFolderForClaude(cwd, env)) log.warn('could not pre-accept Claude folder trust', { cwd })
      },
      conversationExists: (adapter, id) => (adapter === 'claude' ? claudeConversationExists(id, baseChildEnv()) : true),
      memory: h.memory
        ? {
            grant: (req) => h.memory?.grant(req) ?? null,
            release: (gid) => h.memory?.release(gid),
            transportFor: (adapter) => h.safe(() => h.engine.providers.cached().find((p) => p.id === adapter)?.memory ?? null, null),
            lastMode: (sid) => {
              const g = h.memory?.listGrants({ sessionId: sid }).pop()
              return g ? g.mode : null
            }
          }
        : undefined,
      live: {
        open: (sid, adapter) => (adapter === 'shell' ? null : liveBridge.open({ sessionId: sid })),
        start: (s, channel) => {
          const sl = h.sessionLive.open(s, channel)
          // CHAT-UI.md §3.2: a chat owns its asks from the first moment (before any hook line arrives)
          if (sl && h.chats?.get(s.id)) sl.chat = chatLink(h, h.chats, s.id)
        },
        data: (sid, data) => h.sessionLive.get(sid)?.onPtyData(data),
        input: (sid, data, typed) => h.sessionLive.get(sid)?.onUserInput(data, typed),
        exit: (sid, code, byHive) => h.sessionLive.exited(sid, code, byHive)
      },
      author: h.authorAttach ?? undefined,
      emitData: (sessionId, data) => emit('pty:data', { sessionId, data }),
      emitExit: (sessionId, exitCode, signal) => emit('pty:exit', { sessionId, exitCode, signal }),
      emitUpdated: (s) => {
        emit('session:updated', s)
        h.statusChanged()
      },
      onExited: (s) => {
        h.safe(() => h.indexer.rescan(s.artifactsDir.replace(/\/$/, '')), undefined)
        h.safe(() => h.slack?.sessionExited(s.id), undefined)
        h.statusChanged()
      },
      reaper
    })
    // AGENT CHAT: each company agent's standing chat (its brief, its folder, resumed across restarts)
    h.agentChats = new AgentChats({
      getAgent: (id) => h.company.departments.getAgent(id),
      agentsOf: (companyId) => h.company.departments.listAgents({ companyId }),
      departmentsOf: (companyId) => h.company.departments.list(companyId, { includeArchived: true }),
      companyName: (companyId) => h.safe(() => h.company.passport(companyId).name, 'the company'),
      profileAdapter: (profileId) => store.getProfile(profileId)?.adapter ?? null,
      repoPath: (repoId) => {
        const r = store.getRepo(repoId)
        return r?.exists ? r.path : null
      },
      workspaceDir: (companyId) => h.safe(() => h.company.workspaceDir(companyId), null),
      isCode: (companyId) => h.safe(() => h.company.passport(companyId).repoIds.length > 0, false),
      personasOn: () => store.getSettings().personas !== false,
      teamContext: (companyId, agentId) => h.orchestrator?.chatContext(companyId, agentId) ?? null,
      sessionsOf: (agentId, companyId) => store.listSessions('all', undefined, companyId).filter((s) => s.companyAgentId === agentId),
      sessions: () => h.sessions,
      redact: (t) => vault.redact(t)
    })
    // Hive's scratch dir (New chat, no repo) is Hive's own: pre-accept Claude's folder-trust prompt for it.
    try {
      fs.mkdirSync(paths.scratchDir, { recursive: true })
      trustFolderForClaude(paths.scratchDir, baseChildEnv())
    } catch {
      /* best effort; sessions retry on spawn */
    }
    const pruned = h.sessions.pruneOld(7)
    if (pruned) log.info('pruned old exited sessions', { count: pruned })
    // agent trees of sessions pruneOld just deleted (LIVE.md §2 retention)
    if (pruned) h.safe(() => live.retention(), undefined)

    try {
      await h.engine.init()
    } catch (e) {
      log.error('engine.init failed', { e: String(e) })
    }
    h.safe(() => h.engine.scheduler.setPaused(store.getSettings().schedulesPaused), undefined)
    // seeds: profiles per available adapter + three workflows (first launch; deleted seeds stay deleted)
    try {
      await h.engine.providers.list()
    } catch (e) {
      log.warn('provider detection failed', { e: String(e) })
    }
    h.ensureSeeds()
    if (!store.getMeta('seeded')) store.setMeta('seeded', '1')
    bootAuthoring(h)

    // window (created before handlers so senders can be trusted)
    h.windows = new WindowManager({
      loadBounds: () => {
        try {
          return JSON.parse(store.getMeta('window_bounds') ?? 'null')
        } catch {
          return null
        }
      },
      saveBounds: (b) => store.setMeta('window_bounds', JSON.stringify(b)),
      onState: (s) => {
        emit('window:state', s)
        h.setVisibleOwner(null) // focus changed: a visible idle session becomes seen (A3)
      },
      onFocus: () => {
        h.clearUnseen()
        // PO9: Claude history refreshes on window focus (stat pass + lazy queue), never on a timer
        h.safe(() => h.history?.refresh(), undefined)
        // WORKTREE.md: worktrees and open PRs are checked on focus too (at most every 10 s)
        h.safe(() => void h.taskWork?.focus().catch(() => undefined), undefined)
      },
      sendCommand: (cmd) => emit('ui:command', cmd),
      onReadyToShow: process.env.HIVE_SMOKE === '1' ? runSmoke : undefined
    })
    setEventTargets(() => {
      const w = h.windows.get()
      return w ? [w.webContents] : []
    })
    setTrustedSender((wc) => {
      const w = h.windows.get()
      return !!w && wc.id === w.webContents.id
    })
    // WORKTREE.md: a code task's own worktree, branch and PR (failure = no Start, Principia runs)
    h.taskWork = h.safe(() => wireTaskWork(h), null)
    // RELEASING.md §4: app updates, packaged builds only (electron-updater is not even loaded otherwise)
    h.updates = new UpdateService({
      current: app.getVersion(),
      offReason: updatesOffReason({ packaged: app.isPackaged, platform: process.platform, env: process.env }),
      work: () => {
        const s = h.status()
        return { runningSessions: s.runningSessions, runningRuns: s.runningRuns, queuedRuns: s.queuedRuns }
      },
      emit: (s) => emit('updates:changed', s),
      log,
      quit: (install) => h.requestQuit(install),
      beta: () => store.getSettings().betaUpdates === true,
      // an ad-hoc signed preview cannot install updates (Squirrel.Mac wants the same Developer ID): announce only
      manualInstall: () => appCannotSelfUpdate(process.execPath),
      load: async () => {
        // the getter-defined `autoUpdater` export is only on the CommonJS default when the bundle keeps import()
        const m = (await import('electron-updater')) as unknown as { autoUpdater?: Updater; default?: { autoUpdater?: Updater } }
        const u = m.autoUpdater ?? m.default?.autoUpdater
        if (!u) throw new Error('electron-updater has no autoUpdater')
        return u
      }
    })
    app.on('will-quit', () => h.updates?.stop())
    registerAllHandlers(h)
    // DEPARTMENTS.md §3: the board dispatcher starts after registerCompanyHandlers ran CompanyStore.reconcile()
    try {
      h.startDispatcher()
    } catch (e) {
      log.error('dispatcher start failed', { e: String(e) })
    }
    // ORCHESTRATOR.md: after the Forum, authoring and the dispatcher (its run hook is the last one); failure = off
    try {
      h.orchestrator = startOrchestrator(h)
    } catch (e) {
      log.error('orchestrator unavailable', { e: String(e) })
    }
    // after engine.init (it failed the runs the quit left) and the orchestrator (an ask closed here resumes its task):
    // every owed reply gets its turn
    h.safe(() => h.forum?.recoverReplies?.(), undefined)
    h.safe(() => h.taskWork?.start(), undefined)

    // artifacts indexer
    h.indexer = new ArtifactIndexer(
      paths.artifactsRoot,
      store,
      { added: (a) => emit('artifact:added', a), removed: (id) => emit('artifact:removed', { id }) },
      (a) => removeThumbs(paths.thumbsDir, a.id)
    )
    setTimeout(() => {
      try {
        const r = h.indexer.rescan()
        if (r.added || r.removed) log.info('artifacts rescan', r)
      } catch (e) {
        log.warn('artifacts rescan failed', { e: String(e) })
      }
      h.indexer.start()
    }, 500)

    // tray + menu
    h.tray = new HiveTray(
      () => h.trayInput(),
      (a) => h.onTrayAction(a)
    )
    h.tray.create()
    h.rebuildMenu = () =>
      buildAppMenu({
        ui: (cmd) => h.ui(cmd),
        hideWindow: () => h.windows.hide(),
        importWorkflow: () => {
          importWorkflowFromDialog(h, h.windows.get())
            .then((wf) => wf && h.ui({ kind: 'navigate', view: 'workflows' }))
            .catch((e) => log.warn('import workflow failed', { e: String(e) }))
        },
        togglePause: () => h.updateSettings({ schedulesPaused: !store.getSettings().schedulesPaused }),
        paused: () => store.getSettings().schedulesPaused,
        dataDir: paths.userData,
        logsDir: paths.logsDir
      })
    h.rebuildMenu()

    // power: catch up missed fires after sleep (SPEC 8.2); never block OS shutdown with a confirm
    powerMonitor.on('resume', () => {
      h.safe(() => h.engine.scheduler.catchUp('resume'), undefined)
      // SLACK.md §4.6: the socket is probably half-open after sleep: reconnect at once, then gap-fill
      h.slack?.resume('wake')
      h.statusChanged()
    })
    powerMonitor.on('suspend', () => h.slack?.pause())
    powerMonitor.on('shutdown', () => {
      h.forceQuit = true
    })

    // window: hidden when launched at login (SPEC A13)
    const hidden = h.launchedAtLogin() && process.env.HIVE_SMOKE !== '1'
    // a cold launch from a link (Windows / Linux argv, or HIVE_DEEP_LINK in dev) shows the window like a click would
    const launchLink = deepLinkFromArgv(process.argv) ?? process.env.HIVE_DEEP_LINK ?? null
    if (launchLink && links.receive(launchLink)) pendingShow = true
    h.windows.create(!hidden || pendingShow)
    if (hidden) log.info('launched at login: starting hidden in the menu bar')
    links.attach({ deliver: (url) => h.windows.command({ kind: 'openLink', url }), log })
    if (shouldRegisterProtocol({ packaged: app.isPackaged, env: process.env })) {
      try {
        if (!app.isDefaultProtocolClient(PROTOCOL)) app.setAsDefaultProtocolClient(PROTOCOL)
      } catch (e) {
        log.warn('could not register principia:// links', { e: String(e) })
      }
    }

    if (process.env.HIVE_NO_SCHEDULER !== '1') {
      h.safe(() => h.engine.scheduler.start(), undefined)
      // SLACK.md §9: Slack triggers start with the scheduler (schedulesPaused is read live by the engine)
      h.safe(() => h.engine.slackTriggers?.start(), undefined)
    }
    // connects only when both tokens exist
    void h.slack?.start().catch((e) => log.error('slack start failed', { e: String(e) }))
    h.statusChanged()
    // CONTRACT §13: list (never kill) processes an earlier Hive run left behind
    setTimeout(() => void h.scanLeftovers(), 1500)
    h.updates.start()
  }).finally(() => {
    booted = true
    // startup settled: the deferred quit now takes the normal path, whose confirm Cancel must stand
    if (bootWatchdog) clearTimeout(bootWatchdog)
    bootWatchdog = null
    if (quitAfterBoot) quitHive()
  })
}

/** HIVE_SMOKE=1: prove renderer -> preload -> main IPC works through the real bridge, print, exit. */
function runSmoke(win: BrowserWindow): void {
  const go = async () => {
    try {
      const r = await win.webContents.executeJavaScript(
        `Promise.all([window.hive.app.info(), window.hive.app.status(), window.hive.settings.get(), window.hive.repos.list(), window.hive.profiles.list(), window.hive.workflows.list()]).then(([info, status, settings, repos, profiles, workflows]) => JSON.stringify({ ok: true, hive: typeof window.hive, require: typeof require, info, status, settings, repos: repos.length, profiles: profiles.length, workflows: workflows.length }))`
      )
      console.log(`HIVE_SMOKE ${r}`)
      app.exit(0)
    } catch (e) {
      console.log(`HIVE_SMOKE FAIL ${String(e)}`)
      app.exit(1)
    }
  }
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', go)
  else void go()
}
