import Foundation

// Demo mode ("Try it without a Mac", docs/IOS.md): a sample company that lives only in this process. It stands in for
// the Mac behind the same seams the real app uses (`HTTPTransport` for the Phone API, `LiveConnector` for the live
// socket), so every screen runs the real code. Nothing here touches the network: no URLSession, no sockets, no DNS.
// Beta App Review and anyone without a Mac see a believable company; pairing a real Mac leaves it.

/// The sample company and its "Mac": answers the Phone API routes and pushes live messages (chat ops that stream a
/// reply, `changed` after an action, a room reply) to the open demo sockets.
final class DemoMac: @unchecked Sendable {
    /// a reserved name (RFC 2606 `.invalid` never resolves): even a bug that reached the network could not go anywhere
    static let address = "https://demo.principia.invalid"
    static let site = "https://demo.principia.invalid"
    static let token = "demo_token_never_sent_anywhere"
    static let companyId = "demo-northwind"
    static let personalId = "demo-personal"

    /// how long the scripted replies wait between pieces (seconds); tests set 0
    let pace: Double
    private let lock = NSLock()
    private let clock: () -> Date
    private var paused = false
    private var asks: [PhoneAsk] = []
    private var needTasks: [PhoneTaskNeed] = []
    private var board: [PhoneTaskRow] = []
    private var details: [String: String] = [:]
    private var chats: [String: DemoChat] = [:]
    private var chatOrder: [String] = []
    private var room: [PhoneRoomMessage] = []
    private var roomSeq = 0
    private var itemSeq = 0
    private var streamed: Set<String> = []
    private var sockets: [ObjectIdentifier: DemoLiveConnection] = [:]
    /// the scripted replies in flight (tests wait for them)
    private var scripts: [Task<Void, Never>] = []

    struct DemoChat {
        var title: String
        var who: PhoneWho
        var replica: ChatReplica
        var line: String
        var at: Date
        var live: Bool
    }

    init(pace: Double = 1, clock: @escaping () -> Date = Date.init) {
        self.pace = pace
        self.clock = clock
        seed()
    }

    // ---------- the cast ----------

    static let livia = PhoneWho(name: "Livia", role: "Chief of staff", bust: "Livia")
    static let marcus = PhoneWho(name: "Marcus", role: "Engineer", bust: "Marcus")
    static let cicero = PhoneWho(name: "Cicero", role: "Writer", bust: "Cicero")
    static let julia = PhoneWho(name: "Julia", role: "Designer", bust: "Julia")
    static let seneca = PhoneWho(name: "Seneca", role: "Researcher", bust: "Seneca")
    /// agent id → its chat (Needs you's "Open the conversation")
    private static let agentChat = ["agent-livia": "demo-plan", "agent-marcus": "demo-checkout", "agent-cicero": "demo-launch", "agent-seneca": "demo-research"]

    private func iso(_ minutesAgo: Double) -> String { Self.isoString(clock().addingTimeInterval(-minutesAgo * 60)) }
    static func isoString(_ d: Date) -> String {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.string(from: d)
    }

    private func seed() {
        asks = [PhoneAsk(
            id: "ask-deploy", title: "Marcus wants to run a command", heading: "Run a command?",
            question: "Deploy a preview of the new checkout so you can try Apple Pay on your phone.",
            detail: "npm run deploy -- --preview", who: Self.marcus,
            options: [.init(id: "allow", label: "Allow", kind: "allow"), .init(id: "deny", label: "Deny", kind: "deny")],
            text: false, at: iso(3), open: PhoneChatRef(kind: .session, id: "demo-checkout"))]
        needTasks = [
            PhoneTaskNeed(taskId: "task-pricing", kind: .review, title: "New pricing page copy",
                          text: "Three plans (Starter, Studio, Team), a shorter headline and a five-question FAQ. It goes live on the site once you approve.",
                          who: Self.cicero, agentId: "agent-cicero", at: iso(40), options: []),
            PhoneTaskNeed(taskId: "task-shipping", kind: .question, title: "Pick a shipping partner",
                          text: "Two quotes came in for the spring orders. Sendle is cheaper inside the country, ShipBob also stores stock. Which one should I set up first?",
                          who: Self.livia, agentId: "agent-livia", at: iso(18), options: ["Sendle", "ShipBob"])]
        board = [
            row("task-gift", "NW-18", "Holiday gift guide", "todo", .planned, Self.cicero, nil, 2, 300),
            row("task-popup", "NW-19", "Newsletter sign-up on the home page", "todo", .planned, Self.julia, "Waits for NW-12 (checkout) to ship", 3, 260),
            row("task-checkout", "NW-12", "Checkout page: Apple Pay button", "in_progress", .working, Self.marcus, "Waiting for your OK to deploy a preview", 1, 12),
            row("task-launch", "NW-15", "Launch post for the spring collection", "in_progress", .working, Self.cicero, "Drafting the second section", 2, 4),
            row("task-pricing", "NW-16", "New pricing page copy", "in_review", .needs, Self.cicero, "Waiting for your OK", 1, 40),
            row("task-shipping", "NW-17", "Pick a shipping partner", "blocked", .needs, Self.livia, "Asks which partner to set up first", 2, 18),
            row("task-metrics", "NW-11", "Weekly metrics summary", "done", .done, Self.seneca, "Visitors up 18% on last week; checkout conversion flat at 3.1%.", 3, 120),
            row("task-images", "NW-10", "Fix broken images on the About page", "done", .done, Self.julia, "Six images re-exported at 2x; all links checked.", 4, 1500)]
        details = [
            "task-gift": "Ten gifts under $60 from the winter range, one photo each, ready for the first week of December.",
            "task-popup": "A quiet sign-up row above the footer, no pop-up. One field, a thank-you line, double opt-in.",
            "task-checkout": "Add Apple Pay to the checkout page next to the card form. Keep the card form as it is; run the checkout tests; deploy a preview for review.",
            "task-launch": "A 600-word post for the spring collection: the story of the three new fabrics, two customer quotes, a link to each product.",
            "task-pricing": "Rewrite the pricing page: three plans, a one-line headline, a short FAQ (refunds, shipping, sizes, care, wholesale).",
            "task-shipping": "Compare shipping partners for the spring orders and set the chosen one up in the shop.",
            "task-metrics": "Every Monday: visitors, conversion, top pages and top products, compared with last week.",
            "task-images": "The About page shows four broken images and two blurry ones."]

        chatOrder = ["demo-plan", "demo-checkout", "demo-launch", "demo-research"]
        chats["demo-plan"] = DemoChat(title: "Plan this week", who: Self.livia, replica: ChatReplica(snapshot("demo-plan", turn: "working", activity: "Writing the plan", items: [
            user("What should we focus on this week?"),
            tool("Read", ["file_path": "notes/goals.md"]),
            tool("Read", ["file_path": "board/this-week.md"]),
            tool("Grep", ["pattern": "spring launch"]),
        ])), line: "Writing the plan", at: clock().addingTimeInterval(-60), live: true)
        chats["demo-checkout"] = DemoChat(title: "Checkout page: Apple Pay button", who: Self.marcus, replica: ChatReplica(snapshot("demo-checkout", turn: "needs", activity: nil, items: [
            user("Add an Apple Pay button to checkout. Keep the card form as it is."),
            tool("Read", ["file_path": "src/checkout/CheckoutForm.tsx"]),
            tool("Read", ["file_path": "src/checkout/payments.ts"]),
            tool("Edit", ["file_path": "src/checkout/CheckoutForm.tsx"]),
            tool("Write", ["file_path": "src/checkout/ApplePayButton.tsx"]),
            tool("Bash", ["command": "npm test -- checkout", "description": "Ran the checkout tests"]),
            text("The button is in, next to the card form, and all 42 checkout tests pass. I would like to deploy a preview so you can try it on your phone."),
            ["id": "c-perm", "kind": "permission", "requestId": "ask-deploy", "tool": "Bash", "state": "open",
             "input": ["command": "npm run deploy -- --preview"], "description": "npm run deploy -- --preview"],
        ])), line: "Waiting for your OK to deploy a preview", at: clock().addingTimeInterval(-180), live: true)
        chats["demo-launch"] = DemoChat(title: "Launch post for the spring collection", who: Self.cicero, replica: ChatReplica(snapshot("demo-launch", turn: "working", activity: "Drafting the second section", items: [
            user("Draft the launch post for the spring collection. Around 600 words, warm, no hype."),
            tool("TodoWrite", ["todos": [
                ["content": "Read the fabric notes", "status": "completed"],
                ["content": "Outline the post", "status": "completed"],
                ["content": "Draft the second section", "activeForm": "Drafting the second section", "status": "in_progress"],
                ["content": "Add the customer quotes", "status": "pending"],
            ]]),
            text("**Spring, woven slowly**\n\nThree new fabrics this season, each from a mill we have visited ourselves. The first is a washed linen that softens with every wear…"),
        ])), line: "Drafting the second section", at: clock().addingTimeInterval(-240), live: true)
        chats["demo-research"] = DemoChat(title: "Competitor price check", who: Self.seneca, replica: ChatReplica(snapshot("demo-research", turn: "idle", activity: nil, items: [
            user("How do our prices compare with the three closest shops?"),
            tool("WebSearch", ["query": "linen shirt price independent shops"]),
            tool("WebFetch", ["url": "https://example.com/shop/linen"]),
            tool("WebFetch", ["url": "https://example.org/collections/spring"]),
            text("We sit in the middle on shirts and at the top on trousers:\n\n| Item | Us | Average of three |\n|---|---|---|\n| Linen shirt | $78 | $74 |\n| Wide trousers | $112 | $96 |\n| Tote bag | $34 | $38 |\n\nThe trousers are the outlier. Our fabric is heavier, so the price holds if the page says why."),
            ["id": "c-end-r", "kind": "turnEnd", "ms": 74_000],
        ])), line: "We sit in the middle on shirts and at the top on trousers.", at: clock().addingTimeInterval(-3 * 3600), live: false)

        roomSeq = 0
        room = [
            roomMsg("u-livia", "Morning. The plan for the week is in my chat; two things wait for you in Needs you.", 50),
            roomMsg("u-marcus", "Apple Pay is working on the branch. Preview deploy as soon as it is approved.", 20),
            roomMsg("u-cicero", "First half of the launch post is drafted. Quotes come next.", 6),
        ]
    }

    private func row(_ id: String, _ ident: String, _ title: String, _ status: String, _ col: PhoneTaskRow.Column, _ who: PhoneWho, _ line: String?, _ prio: Int, _ minutesAgo: Double) -> PhoneTaskRow {
        PhoneTaskRow(id: id, identifier: ident, title: title, status: status, column: col, who: who, agentId: nil, line: line, priority: prio, at: iso(minutesAgo))
    }
    private func nextId(_ p: String) -> String { itemSeq += 1; return "\(p)-\(itemSeq)" }
    private func user(_ t: String) -> JSONValue { ["id": .string(nextId("u")), "kind": "user", "text": .string(t)] }
    private func text(_ md: String, streaming: Bool = false) -> JSONValue { ["id": .string(nextId("t")), "kind": "text", "md": .string(md), "streaming": .bool(streaming)] }
    private func tool(_ name: String, _ input: JSONValue, status: String = "ok") -> JSONValue {
        let id = nextId("tool")
        return ["id": .string(id), "kind": "tool", "name": .string(name), "status": .string(status), "toolUseId": .string("tu-\(id)"), "input": input]
    }
    private func snapshot(_ id: String, turn: String, activity: String?, items: [JSONValue]) -> ChatSnapshot {
        ChatSnapshot(sessionId: id, mode: "chat", available: true, turn: turn, activity: activity, turnStartedAt: nil, items: items, queue: [], seq: 1, note: nil)
    }
    private func roomMsg(_ author: String, _ text: String, _ minutesAgo: Double, channel: String = "general") -> PhoneRoomMessage {
        roomSeq += 1
        return PhoneRoomMessage(id: "m-\(roomSeq)", seq: roomSeq, channelId: channel, threadId: nil, authorId: author, kind: "text", text: text, at: iso(minutesAgo))
    }

    // ---------- the views ----------

    private var needsCount: Int { asks.count + needTasks.count }
    private var workingRows: [PhoneWorking] {
        var out: [PhoneWorking] = []
        if let c = chats["demo-checkout"], c.live {
            out.append(PhoneWorking(key: "w-checkout", who: Self.marcus, title: "Checkout page: Apple Pay button", activity: c.line, startedAt: iso(12), open: PhoneChatRef(kind: .session, id: "demo-checkout")))
        }
        out.append(PhoneWorking(key: "w-launch", who: Self.cicero, title: "Launch post for the spring collection", activity: "Drafting the second section", startedAt: iso(4), open: PhoneChatRef(kind: .session, id: "demo-launch")))
        return paused ? [] : out
    }

    private func me() -> PhoneMe {
        PhoneMe(device: .init(id: "demo-device", name: "This iPhone"), host: "Demo Mac", companies: [
            PhoneCompany(id: Self.companyId, name: "Northwind", personal: false, paused: paused, working: workingRows.count, needs: needsCount),
            PhoneCompany(id: Self.personalId, name: "Personal", personal: true, paused: false, working: 0, needs: 0)])
    }

    private func now(_ co: String) -> PhoneNow {
        guard co == Self.companyId else { return PhoneNow(companyId: co, name: "Personal", paused: false, needs: 0, working: [], done: []) }
        let done: [PhoneDone] = board.filter { $0.column == .done }.map {
            PhoneDone(key: "d-\($0.id)", title: $0.title, who: $0.who, at: $0.at, status: .done, summary: $0.line)
        } + (needTasks.contains { $0.taskId == "task-pricing" }
             ? [PhoneDone(key: "d-pricing", title: "New pricing page copy", who: Self.cicero, at: iso(40), status: .review, summary: "Three plans, a shorter headline and a FAQ.")] : [])
        return PhoneNow(companyId: co, name: "Northwind", paused: paused, needs: needsCount, working: workingRows, done: done.sorted { $0.at > $1.at })
    }

    private func needs(_ co: String) -> PhoneNeeds {
        co == Self.companyId ? PhoneNeeds(companyId: co, count: needsCount, asks: asks, tasks: needTasks) : PhoneNeeds(companyId: co, count: 0, asks: [], tasks: [])
    }

    private func chatList(_ co: String) -> PhoneChats {
        guard co == Self.companyId else { return PhoneChats(companyId: co, rows: [], team: []) }
        let rows = chatOrder.compactMap { id -> PhoneChatRow? in
            guard let c = chats[id] else { return nil }
            return PhoneChatRow(key: id, ref: PhoneChatRef(kind: .session, id: id), title: c.title, who: c.who, live: c.live, at: Self.isoString(c.at), line: c.line)
        }
        let team = Self.agentChat.sorted { $0.key < $1.key }.compactMap { aid, sid in chats[sid].map { PhoneTeamMember(id: aid, who: $0.who) } }
        return PhoneChats(companyId: co, rows: rows.sorted { $0.at > $1.at }, team: team)
    }

    private func session(_ id: String) -> PhoneSession? {
        guard let c = chats[id] else { return nil }
        let r = c.replica
        return PhoneSession(ref: PhoneChatRef(kind: .session, id: id), title: c.title, who: c.who,
                            chat: ChatSnapshot(sessionId: id, mode: "chat", available: true, turn: r.turn, activity: r.activity, turnStartedAt: nil, items: r.items, queue: r.queue, seq: r.seq, note: nil),
                            terminal: nil)
    }

    private func tasks(_ co: String) -> PhoneTasks {
        let mine = co == Self.companyId ? board : []
        return PhoneTasks(companyId: co, planned: mine.filter { $0.column == .planned }, working: mine.filter { $0.column == .working },
                          needs: mine.filter { $0.column == .needs }, done: mine.filter { $0.column == .done }, more: 0)
    }

    private func task(_ id: String) -> PhoneTaskDetail? {
        guard let t = board.first(where: { $0.id == id }) else { return nil }
        return PhoneTaskDetail(id: t.id, identifier: t.identifier, title: t.title, status: t.status, column: t.column, who: t.who, agentId: t.agentId,
                               line: t.line, priority: t.priority, at: t.at, description: details[id] ?? "", summary: t.column == .done ? t.line : nil,
                               doneNote: nil, createdAt: iso(60 * 26), updatedAt: t.at, need: needTasks.first { $0.taskId == id })
    }

    private func roomView(_ co: String, channel: String?) -> PhoneRoom {
        let ch = channel ?? "general"
        let members = [
            PhoneRoomMember(id: "u-me", handle: "you", name: "You", kind: "human", role: "Founder"),
            PhoneRoomMember(id: "u-livia", handle: "livia", name: "Livia", kind: "agent", role: "Chief of staff"),
            PhoneRoomMember(id: "u-marcus", handle: "marcus", name: "Marcus", kind: "agent", role: "Engineer"),
            PhoneRoomMember(id: "u-cicero", handle: "cicero", name: "Cicero", kind: "agent", role: "Writer"),
            PhoneRoomMember(id: "u-julia", handle: "julia", name: "Julia", kind: "agent", role: "Designer"),
            PhoneRoomMember(id: "u-seneca", handle: "seneca", name: "Seneca", kind: "agent", role: "Researcher")]
        return PhoneRoom(companyId: co, enabled: co == Self.companyId, message: co == Self.companyId ? nil : "The team room is for companies.", me: "u-me", channelId: ch,
                         channels: [.init(id: "general", label: "#general"), .init(id: "launch", label: "#launch")],
                         members: members, messages: room.filter { $0.channelId == ch }, answering: nil)
    }

    // ---------- the Phone API ----------

    /// One request, answered from memory (status, JSON body).
    func answer(_ req: URLRequest) -> (Int, Data) {
        lock.lock()
        defer { lock.unlock() }
        guard let url = req.url else { return Self.error(400, "Bad request") }
        let parts = url.path.split(separator: "/").map { String($0).removingPercentEncoding ?? String($0) }
        let body = (req.httpBody.flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any]) ?? [:]
        let query = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        let post = req.httpMethod == "POST"
        if parts == ["api", "me"] { return Self.ok(me()) }
        if parts == ["api", "sign-out"] { return Self.okJSON(["ok": true]) }
        if parts == ["api", "pair"] || parts == ["api", "hello"] { return Self.error(400, "This is the demo company. Pair a real Mac from the first screen.") }
        guard parts.count >= 4, parts[0] == "api", parts[1] == "c" else { return Self.error(404, "Not found") }
        let co = parts[2]
        let rest = Array(parts.dropFirst(3))
        switch (post, rest.first, rest.count) {
        case (false, "now", 1): return Self.ok(now(co))
        case (true, "pause", 1):
            paused = body["paused"] as? Bool ?? !paused
            return Self.ok(now(co))
        case (false, "needs", 1): return Self.ok(needs(co))
        case (false, "tasks", 1): return Self.ok(tasks(co))
        case (false, "tasks", 2):
            guard let t = task(rest[1]) else { return Self.error(404, "That task is not on the board any more.") }
            return Self.ok(t)
        case (true, "tasks", 3):
            let id = rest[1]
            switch rest[2] {
            case "approve": settle(id, to: .done, status: "done", line: "Approved from the phone; live on the site.")
            case "send-back": settle(id, to: .working, status: "in_progress", line: "Reworking: \(body["text"] as? String ?? "your notes")")
            case "answer": settle(id, to: .working, status: "in_progress", line: "Setting up \(body["text"] as? String ?? "your choice")")
            case "cancel": settle(id, to: nil, status: "canceled", line: nil)
            default: return Self.error(404, "Not found")
            }
            return Self.ok(needs(co))
        case (true, "asks", 3) where rest[2] == "answer":
            allow(rest[1], ok: (body["optionId"] as? String) != "deny")
            return Self.okJSON(["ok": true])
        case (false, "chats", 1): return Self.ok(chatList(co))
        case (true, "chats", 2) where rest[1] == "new":
            let words = ((body["text"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            guard !words.isEmpty else { return Self.error(400, "Write something first") }
            guard co == Self.companyId else { return Self.error(404, "Company not found") }
            if let aid = body["agentId"] as? String {
                guard let sid = Self.agentChat[aid], chats[sid] != nil else { return Self.error(404, "This agent is not in this company any more.") }
                reply(sid, to: words)
                return Self.okJSON(["sessionId": sid])
            }
            // Claude directly, as on the Mac: a new chat named after the first message
            let sid = nextId("demo-new")
            chats[sid] = DemoChat(title: String(words.prefix(80)), who: PhoneWho(name: "Claude", role: "", bust: nil),
                                  replica: ChatReplica(snapshot(sid, turn: "idle", activity: nil, items: [])), line: "", at: clock(), live: false)
            chatOrder.append(sid)
            reply(sid, to: words)
            return Self.okJSON(["sessionId": sid])
        case (false, "sessions", 2):
            guard let s = session(rest[1]) else { return Self.error(404, "This chat is not on your Mac any more.") }
            return Self.ok(s)
        case (true, "sessions", 3):
            let sid = rest[1]
            guard chats[sid] != nil else { return Self.error(404, "This chat is not on your Mac any more.") }
            switch rest[2] {
            case "send", "reply":
                reply(sid, to: (body["text"] as? String) ?? "")
                return Self.okJSON(["sessionId": NSNull()])
            case "stop":
                emit(sid, [["op": "state", "turn": "idle", "activity": .null]])
                return Self.okJSON(["ok": true])
            case "answer":
                let d = body["decision"] as? [String: Any]
                allow(body["requestId"] as? String ?? "", ok: (d?["kind"] as? String) != "deny")
                return Self.okJSON(["ok": true])
            case "continue": return Self.okJSON(["sessionId": NSNull()])
            default: return Self.error(404, "Not found")
            }
        case (false, "agents", 2):
            let aid = rest[1]
            guard let sid = Self.agentChat[aid], let c = chats[sid] else { return Self.error(404, "This agent is not in this company any more.") }
            return Self.ok(PhoneAgent(ref: PhoneChatRef(kind: .agent, id: aid), who: c.who, status: c.live ? "Working" : "Idle", items: [], chatSessionId: sid))
        case (true, "agents", 3) where rest[2] == "send":
            guard let sid = Self.agentChat[rest[1]], chats[sid] != nil else { return Self.error(404, "This agent is not in this company any more.") }
            reply(sid, to: (body["text"] as? String) ?? "")
            return Self.okJSON(["sessionId": sid])
        case (false, "room", 1):
            return Self.ok(roomView(co, channel: query.first { $0.name == "channelId" }?.value))
        case (true, "room", 2) where rest[1] == "post":
            let ch = body["channelId"] as? String ?? "general"
            let m = roomMsg("u-me", body["text"] as? String ?? "", 0, channel: ch)
            room.append(m)
            roomReply(channel: ch)
            return Self.ok(m)
        default:
            return Self.error(404, "Not found")
        }
    }

    private static func ok<T: Encodable>(_ v: T) -> (Int, Data) {
        ((try? JSONEncoder().encode(v)).map { (200, $0) }) ?? error(500, "The demo could not answer.")
    }
    private static func okJSON(_ v: [String: Any]) -> (Int, Data) {
        (200, (try? JSONSerialization.data(withJSONObject: v)) ?? Data("{}".utf8))
    }
    private static func error(_ status: Int, _ message: String) -> (Int, Data) {
        (status, (try? JSONSerialization.data(withJSONObject: ["message": message])) ?? Data())
    }

    // ---------- what an action does (lock held) ----------

    private func settle(_ taskId: String, to col: PhoneTaskRow.Column?, status: String, line: String?) {
        needTasks.removeAll { $0.taskId == taskId }
        if let i = board.firstIndex(where: { $0.id == taskId }) {
            if let col {
                board[i].column = col
                board[i].status = status
                board[i].line = line
                board[i].at = iso(0)
            } else {
                board.remove(at: i)
            }
        }
        changed(["now", "needs", "chats"])
    }

    /// The deploy permission (from Needs you or inside the chat): the chat carries on, streamed.
    private func allow(_ askId: String, ok: Bool) {
        guard asks.contains(where: { $0.id == askId }) else { return }
        asks.removeAll { $0.id == askId }
        let sid = "demo-checkout"
        emit(sid, [["op": "patch", "id": "c-perm", "set": ["state": .string(ok ? "allowed" : "denied")]]])
        changed(["now", "needs"])
        if ok {
            let toolId = nextId("tool")
            let words = "The preview is up. Open **preview.northwind.example/checkout** on your phone and pay with a test card: Apple Pay shows above the card form. I will merge it once you say it looks right."
            let run: JSONValue = ["id": .string(toolId), "kind": "tool", "name": "Bash", "status": "running", "toolUseId": .string("tu-\(toolId)"),
                                  "input": ["command": "npm run deploy -- --preview", "description": "Deploying a preview"]]
            let start: [JSONValue] = [["op": "state", "turn": "working", "activity": "Deploying a preview"], ["op": "add", "item": run]]
            let finish: [JSONValue] = [["op": "patch", "id": .string(toolId), "set": ["status": "ok"]]]
            script(sid, line: "Deploying a preview", [start, finish] + streamOps(words, ms: 52_000), done: "Preview is up; waiting for your look")
        } else {
            emit(sid, [["op": "add", "item": text("Understood, no preview deploy. The change stays on its branch until you decide.")], ["op": "state", "turn": "idle", "activity": .null]])
            chats[sid]?.live = false
            chats[sid]?.line = "Kept on its branch"
        }
    }

    /// Anything typed in a demo chat: an honest canned answer, streamed like a real one.
    private func reply(_ sid: String, to text: String) {
        let me = user(text)
        let words = "This is the demo company, so no agent reads this and nothing leaves your phone. Pair your Mac (Settings › Leave the demo) and your own agents answer here, live, from your Mac."
        let first: [JSONValue] = [["op": "add", "item": me], ["op": "state", "turn": "working", "activity": "Thinking"]]
        script(sid, line: "Answering", [first] + streamOps(words, ms: 3_000), done: "This is the demo company: pair your Mac for your own agents")
    }

    private func roomReply(channel: String) {
        let pace = pace
        let t = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(pace * 1.2 * 1_000_000_000))
            guard let self else { return }
            let m = self.lock.withLock {
                let m = self.roomMsg("u-livia", "Noted. (This is the demo company: pair your Mac and your own team answers here.)", 0, channel: channel)
                self.room.append(m)
                return m
            }
            if let d = try? JSONEncoder().encode(m), let v = try? JSONDecoder().decode(JSONValue.self, from: d) {
                self.broadcast(["t": "room", "message": v])
            }
        }
        scripts.append(t)
    }

    /// A reply streamed in pieces, then marked finished with its time.
    private func streamOps(_ words: String, ms: Double) -> [[JSONValue]] {
        let id = nextId("t")
        let pieces = Self.chunks(words, count: 8)
        var out: [[JSONValue]] = [[["op": "state", "turn": "working", "activity": "Writing"],
                                   ["op": "add", "item": ["id": .string(id), "kind": "text", "md": "", "streaming": true]]]]
        for p in pieces { out.append([["op": "append", "id": .string(id), "field": "md", "text": .string(p)]]) }
        out.append([["op": "patch", "id": .string(id), "set": ["streaming": false]],
                    ["op": "add", "item": ["id": .string(nextId("end")), "kind": "turnEnd", "ms": .number(ms)]],
                    ["op": "state", "turn": "idle", "activity": .null]])
        return out
    }

    static func chunks(_ s: String, count: Int) -> [String] {
        let words = s.split(separator: " ", omittingEmptySubsequences: false).map(String.init)
        let per = max(1, Int((Double(words.count) / Double(count)).rounded(.up)))
        return stride(from: 0, to: words.count, by: per).map { i in
            let part = words[i..<min(words.count, i + per)].joined(separator: " ")
            return i + per < words.count ? part + " " : part
        }
    }

    /// Batches of ops, one every so often (the first at once), on the chat's numbered stream.
    private func script(_ sid: String, line: String, _ batches: [[JSONValue]], done: String) {
        chats[sid]?.live = true
        chats[sid]?.line = line
        chats[sid]?.at = clock()
        let pace = pace
        let t = Task { [weak self] in
            for (n, b) in batches.enumerated() {
                if n > 0 { try? await Task.sleep(nanoseconds: UInt64(pace * 0.35 * 1_000_000_000)) }
                guard let self else { return }
                self.lock.withLock {
                    self.emit(sid, b)
                    if n == batches.count - 1 {
                        self.chats[sid]?.live = false
                        self.chats[sid]?.line = done
                        self.chats[sid]?.at = self.clock()
                        self.changed(["chats", "now"])
                    }
                }
            }
        }
        scripts.append(t)
    }

    /// The first time "Plan this week" is open, its reply streams in and finishes.
    private func subscribed(_ sid: String?) {
        guard let sid, sid == "demo-plan", !streamed.contains(sid) else { return }
        streamed.insert(sid)
        let words = "Here is the plan for this week:\n\n1. **Ship Apple Pay at checkout** (Marcus). The tests pass; it waits for your OK to deploy a preview.\n2. **Publish the new pricing page** (Cicero). The copy is in Needs you.\n3. **Spring launch post** (Cicero). First draft by Wednesday.\n4. **Pick a shipping partner** (me). Two quotes are in and I need your call.\n\nI will check in on Thursday with the numbers."
        let pace = pace
        let ops = streamOps(words, ms: 41_000)
        let t = Task { [weak self] in
            // a beat after the chat opens, so it reads as live
            try? await Task.sleep(nanoseconds: UInt64(pace * 0.6 * 1_000_000_000))
            guard let self else { return }
            self.lock.withLock { self.script(sid, line: "Writing the plan", ops, done: "Here is the plan for this week") }
        }
        scripts.append(t)
    }

    /// Waits for every scripted reply so far (tests).
    func settled() async {
        while true {
            let s = lock.withLock {
                let s = scripts
                scripts = []
                return s
            }
            if s.isEmpty { return }
            for t in s { await t.value }
        }
    }

    // ---------- the live socket (lock held unless noted) ----------

    private func emit(_ sid: String, _ ops: [JSONValue]) {
        guard var c = chats[sid] else { return }
        let seq = c.replica.seq + 1
        _ = c.replica.apply(seq: seq, ops: ops)
        chats[sid] = c
        broadcastLocked(["t": "chat", "sessionId": .string(sid), "seq": .number(Double(seq)), "ops": .array(ops)])
    }

    private func changed(_ what: [String]) {
        broadcastLocked(["t": "changed", "companyId": .string(Self.companyId), "what": .array(what.map { .string($0) })])
    }

    private func broadcast(_ m: JSONValue) {
        lock.lock()
        defer { lock.unlock() }
        broadcastLocked(m)
    }

    private func broadcastLocked(_ m: JSONValue) {
        guard let d = try? JSONEncoder().encode(m), let s = String(data: d, encoding: .utf8) else { return }
        for c in sockets.values where c.authed { c.deliver(s) }
    }

    fileprivate func attach(_ c: DemoLiveConnection) {
        lock.lock(); defer { lock.unlock() }
        sockets[ObjectIdentifier(c)] = c
    }
    fileprivate func detach(_ c: DemoLiveConnection) {
        lock.lock(); defer { lock.unlock() }
        sockets[ObjectIdentifier(c)] = nil
    }

    /// what a demo socket heard from the app (not locked: called from the connection)
    fileprivate func heard(_ text: String, from c: DemoLiveConnection) {
        guard let d = text.data(using: .utf8), let v = try? JSONDecoder().decode(JSONValue.self, from: d) else { return }
        lock.lock()
        defer { lock.unlock() }
        switch v["t"]?.string {
        case "auth":
            c.authed = true
            c.deliver(#"{"t":"hello"}"#)
        case "ping":
            c.deliver(#"{"t":"pong"}"#)
        case "sub":
            let sid = v["sessionId"]?.string
            let seq = sid.flatMap { chats[$0]?.replica.seq } ?? 0
            if let d = try? JSONEncoder().encode(["t": "subbed", "sessionId": sid.map { JSONValue.string($0) } ?? .null, "seq": .number(Double(seq))] as JSONValue),
               let s = String(data: d, encoding: .utf8) { c.deliver(s) }
            subscribed(sid)
        default:
            break
        }
    }
}

/// The Phone API, answered by the demo company.
struct DemoTransport: HTTPTransport {
    let mac: DemoMac
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let (status, data) = mac.answer(request)
        let url = request.url ?? URL(string: DemoMac.address)!
        return (data, HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!)
    }
}

/// The live socket, answered by the demo company.
final class DemoLiveConnector: LiveConnector {
    let mac: DemoMac
    init(mac: DemoMac) { self.mac = mac }
    func open(url: URL, origin: String) -> LiveConnection {
        let c = DemoLiveConnection(mac: mac)
        mac.attach(c)
        return c
    }
}

final class DemoLiveConnection: LiveConnection, @unchecked Sendable {
    private weak var mac: DemoMac?
    private let stream: AsyncStream<String>
    private let input: AsyncStream<String>.Continuation
    private var iterator: AsyncStream<String>.AsyncIterator
    private var isClosed = false
    /// it said who it is (`auth` first, as on the real socket): live messages reach it from then on
    var authed = false

    init(mac: DemoMac) {
        self.mac = mac
        (stream, input) = AsyncStream<String>.makeStream()
        iterator = stream.makeAsyncIterator()
    }

    func deliver(_ text: String) { input.yield(text) }

    func send(_ text: String) async throws {
        guard !isClosed else { throw URLError(.networkConnectionLost) }
        mac?.heard(text, from: self)
    }

    func receive() async throws -> String {
        if let s = await iterator.next() { return s }
        throw URLError(.networkConnectionLost)
    }

    func close() {
        isClosed = true
        input.finish()
        mac?.detach(self)
    }

    var closeCode: Int? { isClosed ? 1000 : nil }
}

// JSON written inline (the demo's chat items and ops)
extension JSONValue: ExpressibleByStringLiteral, ExpressibleByBooleanLiteral, ExpressibleByIntegerLiteral, ExpressibleByArrayLiteral, ExpressibleByDictionaryLiteral {
    init(stringLiteral value: String) { self = .string(value) }
    init(booleanLiteral value: Bool) { self = .bool(value) }
    init(integerLiteral value: Int) { self = .number(Double(value)) }
    init(arrayLiteral elements: JSONValue...) { self = .array(elements) }
    init(dictionaryLiteral elements: (String, JSONValue)...) { self = .object(Dictionary(elements, uniquingKeysWith: { _, b in b })) }
}
