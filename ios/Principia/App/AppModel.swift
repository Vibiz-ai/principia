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
    var busy: Set<String> = []
    var toast: String?
    var pairBusy = false
    var pairError: String?
    var outError: String?
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
    let api: APIClient
    private let store: MacStore
    private let connector: LiveConnector
    private var live: LiveSocket?
    private var toastTask: Task<Void, Never>?
    var clock: () -> Date = Date.init

    init(api: APIClient = APIClient(), store: MacStore = KeychainMacStore(), connector: LiveConnector = URLSessionLiveConnector()) {
        self.api = api
        self.store = store
        self.connector = connector
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
        guard let p = paired, p.mac != link.mac else { return nil }
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

    func cancelPairing() {
        phase = paired == nil ? .out(.unpaired) : .boot
        if paired != nil { Task { await loadMe() } }
    }

    func retry() async {
        outError = nil
        if paired == nil { phase = .out(.unpaired); return }
        await loadMe()
    }

    /// Forget this Mac: its address and token leave this phone.
    func forget() {
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
        try? await api.signOut()
        forget()
    }

    private func signedOut(_ reason: OutReason) {
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
        online = false
    }

    private func loadMe() async {
        do {
            let m = try await api.me()
            me = m
            let last = UserDefaults.standard.string(forKey: Self.lastCompanyKey)
            if companyId == nil || !m.companies.contains(where: { $0.id == companyId }) {
                companyId = m.companies.first(where: { $0.id == last })?.id ?? m.companies.first(where: { !$0.personal })?.id ?? m.companies.first?.id
            }
            phase = .main
            startLive()
            await refresh([.now, .needs, .chats, .room])
        } catch {
            fail(error)
        }
    }

    /// What a failed call means for the app.
    func fail(_ error: Error) {
        switch error as? APIError {
        case .notPaired?: signedOut(.revoked)
        case .macGone?:
            if phase == .main { online = false; say("Your Mac is not answering") }
            signedOut(.gone)
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
            onUnauthorized: { [weak self] in self?.signedOut(.revoked) }
        ))
        live = ls
        ls.start()
        subscribe()
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
            if openRef?.kind == .agent { Task { await reloadOpen() } }
        case .chat(let sid, let seq, let ops):
            if Self.reloadsOnChat(sid, replica: replica, session: session) { Task { await reloadOpen() }; return }
            guard sid == replica?.sessionId, var r = replica else { return }
            switch r.apply(seq: seq, ops: ops) {
            case .ok: replica = r
            case .old: break
            case .gap: Task { await reloadOpen() }
            }
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
        UserDefaults.standard.set(id, forKey: Self.lastCompanyKey)
        now = nil; needs = nil; chats = nil; room = nil; chatPath = []; session = nil; replica = nil; agent = nil
        subscribe()
        Task { await refresh([.now, .needs, .chats, .room]) }
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
        await run("task:\(taskId)") { self.needs = try await self.api.approve(co, taskId: taskId); self.say("Approved"); await self.reloadAgentIfOpen() }
    }
    func sendBack(_ taskId: String, text: String) async {
        guard let co = companyId else { return }
        await run("task:\(taskId)") { self.needs = try await self.api.sendBack(co, taskId: taskId, text: text); self.say("Sent back"); await self.reloadAgentIfOpen() }
    }
    func answerTask(_ taskId: String, text: String) async {
        guard let co = companyId else { return }
        await run("task:\(taskId)") { self.needs = try await self.api.answerTask(co, taskId: taskId, text: text); self.say("Answered"); await self.reloadAgentIfOpen() }
    }
    func notNeeded(_ taskId: String) async {
        guard let co = companyId else { return }
        await run("task:\(taskId)") { self.needs = try await self.api.notNeeded(co, taskId: taskId); self.say("Canceled. Reopen it from the Board on your Mac.") }
    }

    // ---------- Chats ----------

    /// Opens a conversation (from Now, Needs you or the Chats list).
    func openChat(_ ref: PhoneChatRef) {
        tab = .chats
        // the conversation screen loads it (and subscribes) when it appears
        if chatPath.last != ref { chatPath = [ref] }
    }

    func load(_ ref: PhoneChatRef) async {
        guard let co = companyId else { return }
        do {
            switch ref.kind {
            case .session:
                if session?.ref.id != ref.id { session = nil; replica = nil }
                let s = try await api.session(co, ref.id)
                session = s
                replica = s.chat.map(ChatReplica.init)
            case .agent:
                if agent?.ref.id != ref.id { agent = nil }
                agent = try await api.agent(co, ref.id)
            }
            subscribe()
        } catch {
            fail(error)
        }
    }

    func closedChat() {
        session = nil; replica = nil; agent = nil
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

    func send(_ text: String) async -> Bool {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty, let co = companyId, let ref = openRef else { return false }
        var ok = false
        await run("send") {
            switch ref.kind {
            case .session:
                if let term = self.session?.terminal, term.canType != nil {
                    // a terminal on the Mac: typed in now, or read right after its current step
                    try await self.api.sessionSend(co, ref.id, text: t)
                    self.say(self.replica?.busy == true ? "Sent. It reads it right after this step." : "Sent")
                } else if self.replica != nil { try await self.api.sessionSend(co, ref.id, text: t) } else { try await self.api.sessionReply(co, ref.id, text: t); await self.reloadOpen() }
            case .agent:
                try await self.api.agentSend(co, ref.id, text: t)
                await self.reloadOpen()
            }
            ok = true
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

    /// A new message in place: a thread reply goes after its root's last reply; anything else at the end.
    nonisolated static func place(_ list: [PhoneRoomMessage], _ m: PhoneRoomMessage) -> [PhoneRoomMessage] {
        if list.contains(where: { $0.id == m.id }) { return list }
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
        if url.host == "pair" {
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
