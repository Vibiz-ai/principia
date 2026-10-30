import Foundation
import LocalAuthentication
import Observation
import UIKit

enum AppTab: String, Hashable, CaseIterable { case now, needs, chats, room }

/// The whole app's state and actions (the web app's app.ts). Live over one socket: the Mac says what changed and the
/// phone refetches what is on screen; an open chat follows the Mac's own chat ops.
@MainActor
@Observable
final class AppModel {
    enum OutReason: Equatable { case unpaired, off, revoked, gone }
    enum Phase: Equatable { case boot, pair(PairLink), out(OutReason), main }

    // ---------- state ----------
    var phase: Phase = .boot
    private(set) var paired: PairedMac?
    var me: PhoneMe?
    var companyId: String?
    var tab: AppTab = .now
    var online = false
    var now: PhoneNow?
    var needs: PhoneNeeds?
    var chats: PhoneChats?
    var room: PhoneRoom?
    /// the Chats tab's navigation (an open conversation)
    var chatPath: [PhoneChatRef] = []
    var session: PhoneSession?
    var replica: ChatReplica?
    var agent: PhoneAgent?
    /// the open conversation could not be read (gone, a timeout): the screen says so with Try again, never an endless
    /// skeleton
    var loadFailed: PhoneChatRef?
    var loadFailure: String?
    /// bumped when you send into the open conversation: it goes back to the newest message
    var sentTick = 0
    /// bumped each time a snapshot of the open chat lands (opened, back from the background, after a gap): its rows
    /// lay out again, and a reader at the bottom is put back at the newest message once they did
    var snapshotTick = 0
    /// the board (read only, from Now) and the task open on it
    var board: PhoneTasks?
    var boardTask: PhoneTaskDetail?
    /// board screens on the stack (the list, a task): while any shows, live changes refresh it
    var boardViews = 0
    var boardOpen: Bool { boardViews > 0 }
    var busy: Set<String> = []
    var toast: String?
    var pairBusy = false
    var pairError: String?
    var outError: String?
    /// "Waiting for your Mac" (RA8): checking a new address, what came of it, a retry of the last one in flight
    var moveBusy = false
    var moveError: String?
    var retrying = false
    /// the last try failed because this phone has no internet
    var phoneOffline = false
    var deviceName: String = UIDevice.current.model
    /// Face ID before the app shows anything (Settings, off by default)
    var lockEnabled: Bool {
        didSet { UserDefaults.standard.set(lockEnabled, forKey: Self.lockKey) }
    }
    var locked = false
    /// the Settings sheet
    var showSettings = false

    static let lockKey = "principia.lock"
    static let lastCompanyKey = "principia.lastCompany"

    // ---------- plumbing ----------
    /// the Mac's API and live socket; in demo mode the demo company's (no network), else the real ones
    private(set) var api: APIClient
    private let store: MacStore
    private var connector: LiveConnector
    private let realAPI: APIClient
    private let realConnector: LiveConnector
    /// demo mode ("Try it without a Mac"): the sample company in this process; nil when paired with a real Mac or not
    private(set) var demo: DemoMac?
    var inDemo: Bool { demo != nil }
    private var live: LiveSocket?
    private var toastTask: Task<Void, Never>?
    let chatLoader = ChatLoader()
    var clock: () -> Date = Date.init

    init(api: APIClient = APIClient(), store: MacStore = KeychainMacStore(), connector: LiveConnector = URLSessionLiveConnector()) {
        self.api = api
        self.store = store
        self.connector = connector
        self.realAPI = api
        self.realConnector = connector
        self.lockEnabled = UserDefaults.standard.bool(forKey: Self.lockKey)
        self.locked = lockEnabled
    }

    var company: PhoneCompany? { me?.companies.first { $0.id == companyId } }
    var macHost: String { PairLink.host(paired?.mac) }
    var openRef: PhoneChatRef? { tab == .chats ? chatPath.last : nil }

    // ---------- boot, pairing, signed out ----------

    func boot() async {
        paired = store.load()
        guard let p = paired else {
            if case .pair = phase { return }
            phase = .out(.unpaired)
            return
        }
        api.target = APITarget(mac: p.mac, site: p.site, token: p.token)
        PushManager.shared.mac = p.mac
        await loadMe()
    }

    /// A scanned, pasted or opened pairing link.
    func open(link: PairLink) {
        pairError = nil
        phase = .pair(link)
    }

    /// "paired with another Mac (<host>)" before pairing replaces it
    func replaces(_ link: PairLink) -> String? {
        guard !inDemo, let p = paired, p.mac != link.mac else { return nil }
        return PairLink.host(p.mac)
    }

    func pair(_ link: PairLink) async {
        pairBusy = true
        pairError = nil
        defer { pairBusy = false }
        let pairing = APIClient(transport: URLSessionTransport(), target: APITarget(mac: link.mac, site: link.site, token: nil))
        do {
            let r = try await pairing.pair(code: link.code, name: deviceName.trimmingCharacters(in: .whitespaces).isEmpty ? "iPhone" : deviceName)
            guard let token = r.token else {
                pairError = "Your Mac paired but kept the key to itself. On your Mac, check Settings › App › Phone › Phone app address."
                return
            }
            let p = PairedMac(mac: link.mac, site: link.site, token: token, deviceId: r.device.id, deviceName: r.device.name, pairedAt: clock())
            if inDemo { leaveDemo() }
            store.save(p)
            paired = p
            api.target = APITarget(mac: p.mac, site: p.site, token: p.token)
            PushManager.shared.mac = p.mac
            await loadMe()
        } catch APIError.macGone {
            pairError = "Your Mac did not answer at \(PairLink.host(link.mac)). Is Phone still on there?"
        } catch {
            pairError = (error as? APIError)?.errorDescription ?? error.localizedDescription
        }
    }

    // ---------- demo mode ----------

    /// "Try it without a Mac": the sample company, offline, behind the same API and socket seams as a real Mac. Nothing
    /// is saved (no Keychain entry, no last company) and nothing goes over the network.
    func startDemo(pace: Double = 1) async {
        guard paired == nil || inDemo else { return }
        let d = DemoMac(pace: pace, clock: clock)
        demo = d
        api = APIClient(transport: DemoTransport(mac: d), target: APITarget(mac: DemoMac.address, site: DemoMac.site, token: DemoMac.token))
        connector = DemoLiveConnector(mac: d)
        paired = PairedMac(mac: DemoMac.address, site: DemoMac.site, token: DemoMac.token, deviceId: "demo-device", deviceName: "This iPhone", pairedAt: clock())
        companyId = nil
        tab = .now
        await loadMe()
    }

    /// Leave the demo: back to the real API and the pairing screen.
    func exitDemo() {
        guard inDemo else { return }
        leaveDemo()
        phase = .out(.unpaired)
    }

    /// the demo's state goes; the real plumbing comes back
    private func leaveDemo() {
        live?.stop()
        live = nil
        demo = nil
        api = realAPI
        connector = realConnector
        paired = store.load()
        companyId = nil
        tab = .now
        showSettings = false
        clearViews()
    }

    func cancelPairing() {
        phase = paired == nil ? .out(.unpaired) : .boot
        if paired != nil { Task { await loadMe() } }
    }

    /// Try again (the button, the foreground, and every 20 s while waiting): the Mac's last address, in case it restarted
    /// with the same one or Phone is on again.
    func retry() async {
        outError = nil
        if paired == nil { phase = .out(.unpaired); return }
        guard !retrying, !moveBusy else { return }
        retrying = true
        defer { retrying = false }
        await loadMe()
        guard case .out(.gone) = phase, let p = paired else { return }
        // still gone: after a reboot the Mac has a new address, and leaves it sealed on the phone site
        if let mac = await MacFinder.find(transport: api.transport, paired: p), paired == p { await settle(p, at: mac) }
    }

    // ---------- RA8: the Mac's new address ----------

    /// What was typed, pasted, scanned or opened on "Waiting for your Mac": the tunnel's words, the Mac's move link
    /// (`<site>/#move=…`), its address, or a fresh pairing link (which pairs as usual).
    func move(_ text: String) async {
        moveError = nil
        guard let p = paired else {
            if let link = PairLink.parse(text) { open(link: link) } else { outError = "Pair this phone first: scan the code on your Mac." }
            return
        }
        if let mac = MacMove.macFromTyped(text, site: p.site) {
            await moveTo(mac)
        } else if let link = PairLink.parse(text) {
            open(link: link)
        } else {
            moveError = "Type the words your Mac shows under Paired phones, or paste its link."
        }
    }

    /// The new address must prove it is this phone's Mac (a fresh nonce signed with the token's hash, bound to that
    /// address) before the token goes there. Only then is it kept and the app reconnects.
    func moveTo(_ mac: String) async {
        guard let p = paired, !moveBusy else { return }
        if mac == p.mac { await retry(); return }
        moveBusy = true
        moveError = nil
        defer { moveBusy = false }
        let r = await MacMove.check(transport: api.transport, mac: mac, site: p.site, deviceId: p.deviceId, token: p.token)
        switch r {
        case .ok:
            await settle(p, at: mac)
        case .unknown:
            forget()
            outError = "That Mac does not know this phone any more. Scan a new code on your Mac."
        case .gone:
            moveError = "Nothing answers at that address. On your Mac, check that Phone is on and shared, then try again."
        case .wrong:
            moveError = "That address is not your Mac. Check the words in Settings › App › Phone on your Mac."
        }
    }

    /// The Mac at `mac` has proved itself: keep the address and reconnect.
    private func settle(_ p: PairedMac, at mac: String) async {
        var n = p
        n.mac = mac
        store.save(n)
        paired = n
        live?.stop()
        live = nil
        api.target = APITarget(mac: n.mac, site: n.site, token: n.token)
        PushManager.shared.mac = n.mac
        await loadMe()
        if phase == .main { say("Connected to your Mac at its new address") }
    }

    /// Forget this Mac: its address and token leave this phone.
    func forget() {
        if inDemo { exitDemo(); return }
        live?.stop()
        live = nil
        store.forget()
        paired = nil
        api.target = nil
        clearViews()
        phase = .out(.unpaired)
        Task { await PushManager.shared.registration.unregister() }
    }

    /// Sign out here and on the Mac (it removes this device).
    func signOut() async {
        if inDemo { exitDemo(); return }
        try? await api.signOut()
        forget()
    }

    private func signedOut(_ reason: OutReason) {
        if inDemo { exitDemo(); return }
        live?.stop()
        live = nil
        if reason != .gone {
            store.forget()
            paired = nil
            api.target = nil
        }
        clearViews()
        phase = .out(reason)
    }

    private func clearViews() {
        me = nil; now = nil; needs = nil; chats = nil; room = nil; session = nil; replica = nil; agent = nil; chatPath = []
        board = nil; boardTask = nil
        online = false
    }

    private func loadMe() async {
        do {
            let m = try await api.me()
            me = m
            let last = inDemo ? nil : UserDefaults.standard.string(forKey: Self.lastCompanyKey)
            if companyId == nil || !m.companies.contains(where: { $0.id == companyId }) {
                companyId = m.companies.first(where: { $0.id == last })?.id ?? m.companies.first(where: { !$0.personal })?.id ?? m.companies.first?.id
            }
            phase = .main
            phoneOffline = false
            moveError = nil
            startLive()
            await refresh([.now, .needs, .chats, .room])
        } catch {
            fail(error)
        }
    }

    /// What a failed call means for the app.
    func fail(_ error: Error) {
        if error is CancellationError { return }
        switch error as? APIError {
        case .notPaired?: signedOut(.revoked)
        case .macGone?:
            phoneOffline = false
            if phase == .main { online = false; say("Your Mac is not answering") }
            signedOut(.gone)
        case .noInternet?:
            phoneOffline = true
            online = false
            if phase == .main { say("This phone is offline") } else { signedOut(.gone) }
        case .server(_, let m)?: say(m)
        default: say((error as? LocalizedError)?.errorDescription ?? "Something went wrong")
        }
    }

    func say(_ text: String) {
        toast = text
        toastTask?.cancel()
        toastTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 2_600_000_000)
            guard !Task.isCancelled else { return }
            self?.toast = nil
        }
    }

    // ---------- live ----------

    private func startLive() {
        guard let p = paired else { return }
        live?.stop()
        let ls = LiveSocket(connector: connector, mac: p.mac, origin: p.site, token: { [weak self] in self?.paired?.token }, handlers: .init(
            onMessage: { [weak self] m in self?.onLive(m) },
            onState: { [weak self] up in self?.online = up },
            onReconnect: { [weak self] in Task { await self?.refresh([.now, .needs, .chats, .room]); await self?.reloadOpen() } },
            onUnauthorized: { [weak self] in self?.signedOut(.revoked) },
            onGone: { [weak self] in Task { await self?.probe() } }
        ))
        live = ls
        ls.start()
        subscribe()
    }

    /// The socket says the address looks gone: one call decides (a gone Mac shows "Waiting for your Mac").
    private func probe() async {
        guard phase == .main else { return }
        do { _ = try await api.me() } catch { fail(error) }
    }

    func subscribe() {
        guard let co = companyId else { return }
        let sid = openRef?.kind == .session ? openRef?.id : nil
        live?.subscribe(companyId: co, sessionId: sid, channelId: tab == .room ? room?.channelId : nil)
    }

    private func onLive(_ m: PhoneServerMsg) {
        switch m {
        case .changed(let co, let what):
            if co != nil && co != companyId && !what.contains("companies") { return }
            var views: Set<View> = []
            for w in what {
                switch w {
                case "now": views.insert(.now)
                case "needs": views.insert(.needs)
                case "chats": views.insert(.chats)
                case "room": views.insert(.room)
                case "companies": views.insert(.companies)
                default: break
                }
            }
            Task { await refresh(views) }
            if boardOpen && (views.contains(.now) || views.contains(.needs)) { Task { await reloadBoard() } }
            if openRef?.kind == .agent { Task { await reloadOpen() } }
        case .chat(let sid, let seq, let ops):
            // its snapshot is on the way: these go on top of it
            if chatPath.last == PhoneChatRef(kind: .session, id: sid), chatLoader.hold(sid, seq: seq, ops: ops) { return }
            if Self.reloadsOnChat(sid, replica: replica, session: session) { Task { await reloadOpen() }; return }
            guard sid == replica?.sessionId, var r = replica else { return }
            switch r.apply(seq: seq, ops: ops) {
            case .ok: replica = r
            case .old: break
            case .gap: Task { await reloadOpen() }
            }
        case .subbed(let sid, let seq):
            // the Mac numbers this chat up to seq: a replica behind it missed ops before the subscription took effect
            guard let sid, chatPath.last == PhoneChatRef(kind: .session, id: sid) else { return }
            if chatLoader.acked(sid, seq: seq) { return }
            if let r = replica, r.sessionId == sid, seq > r.seq { Task { await reloadOpen() } }
        case .screen(let sid, let text):
            // a terminal with no transcript yet: its last lines, live
            guard var s = session, s.ref.id == sid, var t = s.terminal else { return }
            t.screen = text
            t.source = "screen"
            s.terminal = t
            session = s
        case .room(let msg):
            guard var r = room, msg.channelId == r.channelId else { return }
            r.messages = Self.place(r.messages, msg)
            room = r
        case .bye(let reason):
            signedOut(reason == "revoked" ? .revoked : .off)
        default:
            break
        }
    }

    /// back in the foreground: reconnect at once and fetch what is on screen
    func foreground() async {
        guard phase == .main else {
            if case .out(.gone) = phase { await retry() }
            return
        }
        live?.kick()
        await refresh([.now, .needs, .chats, .room, .companies])
        await reloadOpen()
    }

    // ---------- views ----------

    enum View: Hashable { case now, needs, chats, room, companies }

    func refresh(_ views: Set<View>) async {
        guard let co = companyId, phase == .main else { return }
        do {
            if views.contains(.companies) { me = try await api.me() }
            if views.contains(.now) { now = try await api.now(co) }
            if views.contains(.needs) { needs = try await api.needs(co) }
            if views.contains(.chats) { chats = try await api.chats(co) }
            if views.contains(.room) { room = try await api.room(co, channelId: room?.companyId == co ? room?.channelId : nil) }
        } catch {
            fail(error)
        }
    }

    func selectCompany(_ id: String) {
        guard id != companyId else { return }
        companyId = id
        if !inDemo { UserDefaults.standard.set(id, forKey: Self.lastCompanyKey) }
        now = nil; needs = nil; chats = nil; room = nil; chatPath = []; session = nil; replica = nil; agent = nil
        board = nil; boardTask = nil
        subscribe()
        Task { await refresh([.now, .needs, .chats, .room]); await reloadBoard() }
    }

    func selectTab(_ t: AppTab) {
        tab = t
        subscribe()
    }

    // ---------- Now ----------

    func setPaused(_ paused: Bool) async {
        guard let co = companyId else { return }
        await run("pause") {
            self.now = try await self.api.setPaused(co, paused)
            if var m = self.me, let i = m.companies.firstIndex(where: { $0.id == co }) {
                m.companies[i].paused = paused
                self.me = m
            }
            self.say(paused ? "Paused. Agents start nothing new." : "Running again")
        }
    }

    // ---------- the board (read only) ----------

    func loadBoard() async {
        guard let co = companyId, phase == .main else { return }
        do { board = try await api.tasks(co) } catch { fail(error) }
    }
    func loadBoardTask(_ id: String) async {
        guard let co = companyId, phase == .main else { return }
        if boardTask?.id != id { boardTask = nil }
        do { boardTask = try await api.task(co, id) } catch APIError.server(404, _) {
            boardTask = nil
            say("That task is not on the board any more")
        } catch { fail(error) }
    }
    /// after an action or a live change: the list, and the task open on it
    func reloadBoard() async {
        guard boardOpen else { return }
        await loadBoard()
        if let id = boardTask?.id { await loadBoardTask(id) }
    }

    // ---------- Needs you ----------

    func answerAsk(_ ask: PhoneAsk, optionId: String?, text: String?) async {
        guard let co = companyId else { return }
        await run("ask:\(ask.id)") {
            try await self.api.answerAsk(co, askId: ask.id, optionId: optionId, text: text)
            self.say("Sent")
            await self.refresh([.needs, .now])
            // answered inside a terminal's conversation: its card goes and the composer comes back
            if self.openRef?.kind == .session, self.session?.terminal != nil { await self.reloadOpen() }
        }
    }
    func approve(_ taskId: String) async {
        guard let co = companyId else { return }
        await run("task:\(taskId)") { self.needs = try await self.api.approve(co, taskId: taskId); self.say("Approved"); await self.reloadAgentIfOpen(); await self.reloadBoard() }
    }
    func sendBack(_ taskId: String, text: String) async {
        guard let co = companyId else { return }
        await run("task:\(taskId)") { self.needs = try await self.api.sendBack(co, taskId: taskId, text: text); self.say("Sent back"); await self.reloadAgentIfOpen(); await self.reloadBoard() }
    }
    func answerTask(_ taskId: String, text: String) async {
        guard let co = companyId else { return }
        await run("task:\(taskId)") { self.needs = try await self.api.answerTask(co, taskId: taskId, text: text); self.say("Answered"); await self.reloadAgentIfOpen(); await self.reloadBoard() }
    }
    func notNeeded(_ taskId: String) async {
        guard let co = companyId else { return }
        await run("task:\(taskId)") { self.needs = try await self.api.notNeeded(co, taskId: taskId); self.say("Canceled. Reopen it from the Board on your Mac."); await self.reloadBoard() }
    }

    // ---------- Chats ----------

    /// Opens a conversation (from Now, Needs you or the Chats list).
    func openChat(_ ref: PhoneChatRef) {
        tab = .chats
        // the conversation screen loads it (and subscribes) when it appears
        if chatPath.last != ref { chatPath = [ref] }
    }

    /// New chat (Chats' compose button): with the agent when one is picked, else Claude directly; then it opens.
    func newChat(_ text: String, agentId: String?) async -> Bool {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty, let co = companyId else { return false }
        var ok = false
        await run("newChat") {
            let sid = try await self.api.newChat(co, text: t, agentId: agentId)
            ok = true
            guard self.companyId == co else { return }
            self.openChat(PhoneChatRef(kind: .session, id: sid))
            await self.refresh([.chats])
        }
        return ok
    }

    func load(_ ref: PhoneChatRef) async {
        guard let co = companyId else { return }
        if loadFailed == ref { loadFailed = nil; loadFailure = nil }
        do {
            switch ref.kind {
            case .session:
                if session?.ref.id != ref.id { session = nil; replica = nil }
                // subscribed first: ops from here on reach this phone and wait for the snapshot; none fall between
                subscribe()
                try await chatLoader.run(ref.id, fetch: { [weak self] in
                    guard let self else { return .stale }
                    let s = try await self.api.session(co, ref.id)
                    guard self.chatPath.last == ref, self.companyId == co else { return .stale }
                    self.session = s
                    guard let c = s.chat else { self.replica = nil; return .noChat }
                    return .chat(ChatReplica(c))
                }, put: { [weak self] r in
                    self?.replica = r
                    self?.snapshotTick += 1
                })
            case .agent:
                if agent?.ref.id != ref.id { agent = nil }
                let g = try await api.agent(co, ref.id)
                guard chatPath.last == ref else { return }
                // AGENT CHAT: the agent's conversation is its own chat; its screen becomes that chat (Back: the list)
                if let sid = g.chatSessionId {
                    chatPath = [PhoneChatRef(kind: .session, id: sid)]
                    return
                }
                agent = g
            }
            subscribe()
        } catch {
            if error is CancellationError { return }
            if case .server(404, _)? = error as? APIError, await openElsewhere(ref) { return }
            guard chatPath.last == ref else { return }
            switch error as? APIError {
            case .server(404, _)?:
                loadFailed = ref
                loadFailure = ref.kind == .agent ? "This agent is not in this company any more." : "This chat is not on your Mac any more."
            case .server(_, let m)?:
                loadFailed = ref
                loadFailure = m
            default:
                loadFailed = ref
                loadFailure = "It did not load. Check that your Mac is on, then try again."
                fail(error)
            }
        }
    }

    /// A chat link names no company (a notification, a link from another company's screen): find the company that has
    /// it and go there.
    private func openElsewhere(_ ref: PhoneChatRef) async -> Bool {
        guard let me, let here = companyId else { return false }
        for c in me.companies where c.id != here {
            let found: Bool
            switch ref.kind {
            case .session: found = (try? await api.session(c.id, ref.id)) != nil
            case .agent: found = (try? await api.agent(c.id, ref.id)) != nil
            }
            guard found else { continue }
            guard chatPath.last == ref, companyId == here else { return true }
            selectCompany(c.id)
            openChat(ref)
            say("In \(c.name)")
            // the same screen stays open (same chat): it loads again here, in its company
            await load(ref)
            return true
        }
        return false
    }

    func closedChat() {
        session = nil; replica = nil; agent = nil; loadFailed = nil; loadFailure = nil
        subscribe()
    }

    /// A terminal opened before its transcript existed has no replica: the Mac's empty chat ops then say "read it
    /// again" (its transcript appeared, it ended, it asks something).
    static func reloadsOnChat(_ sid: String, replica: ChatReplica?, session: PhoneSession?) -> Bool {
        replica == nil && session?.ref.id == sid && session?.terminal != nil
    }

    func reloadOpen() async {
        if let r = openRef { await load(r) }
    }
    private func reloadAgentIfOpen() async {
        if openRef?.kind == .agent { await reloadOpen() }
    }

    /// images: only where a chat takes them (a chat on the Mac or an agent, never a terminal)
    func send(_ text: String, images: [ChatAttachment] = []) async -> Bool {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty || !images.isEmpty, let co = companyId, let ref = openRef else { return false }
        var ok = false
        await run("send") {
            switch ref.kind {
            case .session:
                if let term = self.session?.terminal, term.canType != nil {
                    // a terminal on the Mac: typed in now, or read right after its current step
                    try await self.api.sessionSend(co, ref.id, text: t)
                    self.say(self.replica?.busy == true ? "Sent. It reads it right after this step." : "Sent")
                } else if self.replica != nil {
                    // an agent's ended chat reopens in a new session (same conversation): follow it there
                    if let next = try await self.api.sessionSend(co, ref.id, text: t, images: images), next != ref.id, self.chatPath.last == ref {
                        self.chatPath = [PhoneChatRef(kind: .session, id: next)]
                    } else if self.replica?.turn == "ended" {
                        await self.reloadOpen()
                    }
                } else { try await self.api.sessionReply(co, ref.id, text: t); await self.reloadOpen() }
            case .agent:
                // it answers in its own chat: follow it there
                if let sid = try await self.api.agentSend(co, ref.id, text: t, images: images), self.chatPath.last == ref {
                    self.chatPath = [PhoneChatRef(kind: .session, id: sid)]
                } else {
                    await self.reloadOpen()
                }
            }
            ok = true
            self.sentTick += 1
        }
        return ok
    }

    func stop(sendNow: Bool = false) async {
        guard let co = companyId, let ref = openRef, ref.kind == .session else { return }
        await run(sendNow ? "sendNow" : "stop") { try await self.api.sessionStop(co, ref.id, sendNow: sendNow) }
    }

    /// An ended terminal session opens again on the Mac, in the same conversation; the phone follows it there.
    func continueSession() async {
        guard let co = companyId, let ref = openRef, ref.kind == .session else { return }
        await run("continue") {
            let next = try await self.api.sessionContinue(co, ref.id)
            self.say("Continuing on your Mac")
            if let n = next, n != ref.id { self.chatPath = [PhoneChatRef(kind: .session, id: n)] } else { await self.reloadOpen() }
        }
    }

    func chatAnswer(_ requestId: String, _ d: PhoneChatDecision) async {
        guard let co = companyId, let ref = openRef, ref.kind == .session else { return }
        await run("req:\(requestId)") { try await self.api.sessionAnswer(co, ref.id, requestId: requestId, decision: d) }
    }

    // ---------- Team room ----------

    func setChannel(_ id: String) async {
        guard let co = companyId else { return }
        do {
            room = try await api.room(co, channelId: id)
            subscribe()
        } catch { fail(error) }
    }

    func post(_ text: String) async -> Bool {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty, let co = companyId, let ch = room?.channelId else { return false }
        var ok = false
        await run("post") {
            let m = try await self.api.roomPost(co, channelId: ch, text: t)
            if var r = self.room, r.channelId == m.channelId {
                r.messages = Self.place(r.messages, m)
                self.room = r
            }
            ok = true
        }
        return ok
    }

    /// A new message in place: a thread reply goes after its root's last reply; anything else at the end. A message
    /// already there is replaced where it is (a task card the Mac patched: CHAT-UI.md §8).
    nonisolated static func place(_ list: [PhoneRoomMessage], _ m: PhoneRoomMessage) -> [PhoneRoomMessage] {
        if let i = list.firstIndex(where: { $0.id == m.id }) {
            var out = list
            out[i] = m
            return out
        }
        guard let t = m.threadId else { return list + [m] }
        guard let at = list.lastIndex(where: { $0.id == t || $0.threadId == t }) else { return list + [m] }
        var out = list
        out.insert(m, at: at + 1)
        return out
    }

    // ---------- links into the app ----------

    /// `principia://pair?site=…#mac=…&code=…` pairs; `principia://tab/needs` and `principia://chat/session/<id>` open a
    /// screen (what a notification will open once the push relay exists).
    func handle(url: URL) {
        guard url.scheme?.lowercased() == "principia" else { return }
        if url.host == "pair" || url.host == "move" {
            // principia://pair?site=<site>#move=<the Mac's new address> (RA8): check it, then go there
            if url.fragment?.contains("move=") == true { Task { await move(url.absoluteString) }; return }
            if let link = PairLink.parse(url.absoluteString) { open(link: link) } else { say("That is not a pairing link.") }
            return
        }
        guard phase == .main else { return }
        let parts = url.pathComponents.filter { $0 != "/" }
        switch url.host {
        case "tab":
            if let t = parts.first.flatMap(AppTab.init(rawValue:)) { chatPath = []; selectTab(t) }
        case "settings":
            showSettings = true
        case "chat":
            if parts.count == 2, let k = PhoneChatRef.Kind(rawValue: parts[0]) { openChat(PhoneChatRef(kind: k, id: parts[1])) }
        default:
            break
        }
    }

    // ---------- lock ----------

    func unlock() async {
        let ctx = LAContext()
        var err: NSError?
        guard ctx.canEvaluatePolicy(.deviceOwnerAuthentication, error: &err) else { locked = false; return }
        if (try? await ctx.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: "Open Principia")) == true { locked = false }
    }

    func background() {
        if lockEnabled { locked = true }
    }

    // ---------- helpers ----------

    private func run(_ key: String, _ body: @escaping () async throws -> Void) async {
        guard !busy.contains(key) else { return }
        busy.insert(key)
        defer { busy.remove(key) }
        do { try await body() } catch { fail(error) }
    }
}

// ---------- words ----------

enum Words {
    private static let iso: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    private static let isoPlain = ISO8601DateFormatter()
    static func date(_ s: String?) -> Date? {
        guard let s else { return nil }
        return iso.date(from: s) ?? isoPlain.date(from: s)
    }
    /// "now", "4m", "2h", "3d"
    static func ago(_ s: String?, now: Date = Date()) -> String {
        guard let d = date(s) else { return "" }
        let sec = max(0, Int(now.timeIntervalSince(d).rounded()))
        if sec < 45 { return "now" }
        if sec < 3600 { return "\(max(1, Int((Double(sec) / 60).rounded())))m" }
        if sec < 86400 { return "\(Int((Double(sec) / 3600).rounded()))h" }
        return "\(Int((Double(sec) / 86400).rounded()))d"
    }
    /// "2 working · 1 needs you", "Paused", "Quiet right now"
    static func headline(working: Int, needs: Int, paused: Bool) -> String {
        let n = needs > 0 ? "\(needs) need\(needs == 1 ? "s" : "") you" : ""
        if paused { return n.isEmpty ? "Paused" : "Paused · \(n)" }
        let parts = [working > 0 ? "\(working) working" : "", n].filter { !$0.isEmpty }
        return parts.isEmpty ? "Quiet right now" : parts.joined(separator: " · ")
    }
    /// members whose handle or name starts with the query, agents first, at most five
    static func mentionMatches(_ members: [PhoneRoomMember], query: String, me: String?) -> [PhoneRoomMember] {
        let q = query.lowercased()
        return members
            .filter { m in m.id != me && (m.handle.hasPrefix(q) || m.name.lowercased().hasPrefix(q) || m.name.lowercased().split(separator: " ").contains { $0.hasPrefix(q) }) }
            .sorted { a, b in (a.kind == "agent") != (b.kind == "agent") ? a.kind == "agent" : a.handle < b.handle }
            .prefix(5).map { $0 }
    }
    /// the @word being typed at the end of the text
    static func mentionQuery(_ text: String) -> String? {
        guard let r = text.range(of: #"(^|\s)@([a-zA-Z0-9._-]{0,32})$"#, options: .regularExpression) else { return nil }
        let w = text[r].trimmingCharacters(in: .whitespaces)
        return String(w.dropFirst()).lowercased()
    }
    static func insertMention(_ text: String, handle: String) -> String {
        guard let r = text.range(of: #"@[a-zA-Z0-9._-]{0,32}$"#, options: .regularExpression) else { return text + "@\(handle) " }
        return text.replacingCharacters(in: r, with: "@\(handle) ")
    }
}
