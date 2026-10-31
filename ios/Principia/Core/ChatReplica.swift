import Foundation

/// One chat, kept in step with the Mac (the web app's ChatReplica): a snapshot, then numbered ops (the desktop's own
/// ChatOps). A gap means a batch was missed: take a fresh snapshot.
struct ChatReplica: Sendable {
    enum Applied: Equatable { case ok, old, gap }

    private(set) var items: [JSONValue]
    private var index: [String: Int] = [:]
    private(set) var seq: Int
    private(set) var turn: String
    private(set) var activity: String?
    private(set) var queue: [ChatQueued]
    /// what the CLI behind this chat offers under `/`
    private(set) var commands: [ChatCommand]
    let sessionId: String

    init(_ s: ChatSnapshot) {
        sessionId = s.sessionId
        items = s.items
        seq = s.seq
        turn = s.turn
        activity = s.activity
        queue = s.queue
        commands = ChatCommand.list(s.meta?["commands"])
        reindex()
    }

    /// working, starting or waiting on you: Stop is offered and new messages queue
    var busy: Bool { turn == "working" || turn == "starting" || turn == "needs" }

    private mutating func reindex() {
        index = [:]
        for (n, it) in items.enumerated() { if let id = it["id"]?.string { index[id] = n } }
    }

    mutating func apply(seq next: Int, ops: [JSONValue]) -> Applied {
        if next <= seq { return .old }
        if next != seq + 1 { return .gap }
        seq = next
        for op in ops { applyOp(op) }
        return .ok
    }

    private mutating func applyOp(_ op: JSONValue) {
        switch op["op"]?.string {
        case "reset":
            items = op["items"]?.array ?? []
            reindex()
        case "add":
            guard let item = op["item"], let id = item["id"]?.string, index[id] == nil else { return }
            index[id] = items.count
            items.append(item)
        case "patch":
            guard let id = op["id"]?.string, let n = index[id], case .object(var cur) = items[n], let set = op["set"]?.object else { return }
            for (k, v) in set { cur[k] = v }
            items[n] = .object(cur)
        case "append":
            guard let id = op["id"]?.string, let n = index[id], case .object(var cur) = items[n], let field = op["field"]?.string, let text = op["text"]?.string else { return }
            cur[field] = .string((cur[field]?.string ?? "") + text)
            items[n] = .object(cur)
        case "remove":
            guard let id = op["id"]?.string, index[id] != nil else { return }
            items.removeAll { $0["id"]?.string == id }
            reindex()
        case "state":
            if let t = op["turn"]?.string { turn = t }
            if let a = op["activity"] { activity = a.string }
        case "queue":
            if let q = op["queue"], let d = try? JSONEncoder().encode(q), let v = try? JSONDecoder().decode([ChatQueued].self, from: d) { queue = v }
        case "meta":
            // a meta op carries only what changed
            if let c = op["meta"]?["commands"] { commands = ChatCommand.list(c) }
        default:
            break
        }
    }

    /// "Working", "Waiting for you", "Your turn" for the chat's header
    var turnWords: String {
        switch turn {
        case "working", "starting": return activity ?? "Working"
        case "needs": return "Waiting for you"
        case "sleeping": return "Asleep: a message wakes it"
        case "ended": return "Ended"
        case "error": return "Something went wrong"
        default: return "Your turn"
        }
    }
}

/// What one chat row on the phone shows (model.ts ChatLine).
enum ChatLine: Identifiable, Equatable, Sendable {
    enum ToolState: Equatable, Sendable { case run, ok, err }
    struct Question: Equatable, Sendable { var question: String; var options: [String]; var multi: Bool }
    struct Todo: Equatable, Sendable { var text: String; var done: Bool; var now: Bool }

    case me(id: String, text: String, queued: Bool)
    case say(id: String, text: String, streaming: Bool)
    case tool(id: String, text: String, code: String, state: ToolState, sub: Int)
    case plan(id: String, done: Int, total: Int, items: [Todo])
    case thinking(id: String)
    case permission(id: String, requestId: String, title: String, detail: String?, open: Bool, outcome: String?)
    case question(id: String, requestId: String, questions: [Question], open: Bool, answers: [String: String]?)
    case planCard(id: String, requestId: String, plan: String, open: Bool, outcome: String?)
    case notice(id: String, tone: String, text: String)
    case end(id: String, text: String)

    var id: String {
        switch self {
        case .me(let id, _, _), .say(let id, _, _), .tool(let id, _, _, _, _), .plan(let id, _, _, _), .thinking(let id), .permission(let id, _, _, _, _, _), .question(let id, _, _, _, _), .planCard(let id, _, _, _, _), .notice(let id, _, _), .end(let id, _): return id
        }
    }
}

enum ChatLines {
    /// Dividers the Mac adds when a chat is rebuilt from its transcript: they mean nothing on the phone.
    static let replayNotices: Set<String> = ["From the terminal", "Back from the terminal", "Resumed this conversation"]
    static let readOnly: Set<String> = ["Read", "Grep", "Glob", "LS", "NotebookRead", "WebFetch", "WebSearch", "ToolSearch"]
    static let special: Set<String> = ["AskUserQuestion", "ExitPlanMode"]
    static let subagent: Set<String> = ["Task", "Agent"]

    static func build(_ items: [JSONValue]) -> [ChatLine] {
        let toolIds = Set(items.compactMap { $0["kind"]?.string == "tool" ? $0["toolUseId"]?.string : nil })
        let hidden = Set(items.compactMap { ($0["kind"]?.string == "question" || $0["kind"]?.string == "plan") ? $0["toolUseId"]?.string : nil })
        let lastTodo = items.last { $0["kind"]?.string == "tool" && $0["name"]?.string == "TodoWrite" }?["id"]?.string
        var byParent: [String: [JSONValue]] = [:]
        var top: [JSONValue] = []
        for it in items {
            if let p = it["parent"]?.string, toolIds.contains(p) { byParent[p, default: []].append(it) } else { top.append(it) }
        }
        func countTools(_ list: [JSONValue]) -> Int {
            list.reduce(0) { n, it in
                guard it["kind"]?.string == "tool" else { return n }
                let kids = it["toolUseId"]?.string.flatMap { byParent[$0] } ?? []
                return n + 1 + countTools(kids)
            }
        }
        var out: [ChatLine] = []
        var group: [JSONValue] = []
        func flush() {
            guard let first = group.first else { return }
            let running = group.contains { ["pending", "running"].contains($0["status"]?.string ?? "") }
            out.append(.tool(id: "g:\(first["id"]?.string ?? "")", text: groupSummary(group), code: "", state: running ? .run : .ok, sub: 0))
            group = []
        }
        for it in top {
            let kind = it["kind"]?.string ?? ""
            let id = it["id"]?.string ?? UUID().uuidString
            if kind == "tool" {
                let name = it["name"]?.string ?? ""
                let status = it["status"]?.string ?? ""
                if let tu = it["toolUseId"]?.string, hidden.contains(tu) { continue }
                if name == "TodoWrite" {
                    flush()
                    guard id == lastTodo else { continue }
                    let todos = (it["input"]?["todos"]?.array ?? []).map { t -> ChatLine.Todo in
                        let st = t["status"]?.string
                        let text = (st == "in_progress" ? t["activeForm"]?.string : nil) ?? t["content"]?.string ?? ""
                        return .init(text: text, done: st == "completed", now: st == "in_progress")
                    }
                    out.append(.plan(id: id, done: todos.filter(\.done).count, total: todos.count, items: todos))
                    continue
                }
                if special.contains(name) && (status == "pending" || status == "running") { continue }
                if readOnly.contains(name) && status != "error" {
                    group.append(it)
                    continue
                }
                flush()
                let l = toolLine(it)
                let kids = subagent.contains(name) ? (it["toolUseId"]?.string.flatMap { byParent[$0] } ?? []) : []
                out.append(.tool(id: id, text: l.text, code: l.code, state: toolState(status), sub: countTools(kids)))
                continue
            }
            if kind == "thinking" && !group.isEmpty { continue }
            flush()
            switch kind {
            case "user":
                let text = it["text"]?.string ?? ""
                let images = it["images"]?.int ?? 0
                out.append(.me(id: id, text: text.isEmpty && images > 0 ? "\(images) image\(images == 1 ? "" : "s")" : text, queued: it["state"]?.string == "queued"))
            case "text":
                let md = it["md"]?.string ?? ""
                let streaming = it["streaming"]?.bool ?? false
                if !md.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || streaming { out.append(.say(id: id, text: md, streaming: streaming)) }
            case "thinking":
                if it["streaming"]?.bool == true { out.append(.thinking(id: id)) }
            case "permission":
                let state = it["state"]?.string ?? ""
                let outcome = it["outcome"]?.string ?? (state == "allowed" ? "Allowed" : state == "denied" ? "Denied" : state == "expired" ? "Expired" : nil)
                let input = it["input"] ?? .object([:])
                out.append(.permission(id: id, requestId: it["requestId"]?.string ?? "", title: permissionTitle(it["tool"]?.string ?? "", input), detail: it["description"]?.string ?? commandOf(input), open: state == "open", outcome: outcome))
            case "question":
                let qs = (it["questions"]?.array ?? []).map { q in
                    ChatLine.Question(question: q["question"]?.string ?? "", options: (q["options"]?.array ?? []).compactMap { $0["label"]?.string }, multi: q["multiSelect"]?.bool ?? false)
                }
                var answers: [String: String]?
                if let a = it["answers"]?.object { answers = a.compactMapValues(\.string) }
                out.append(.question(id: id, requestId: it["requestId"]?.string ?? "", questions: qs, open: it["state"]?.string == "open", answers: answers))
            case "plan":
                let state = it["state"]?.string ?? ""
                out.append(.planCard(id: id, requestId: it["requestId"]?.string ?? "", plan: it["plan"]?.string ?? "", open: state == "open", outcome: state == "approved" ? "Plan approved" : state == "rejected" ? "Kept planning" : state == "expired" ? "Expired" : nil))
            case "notice":
                let text = it["text"]?.string ?? ""
                if replayNotices.contains(text) { continue }
                out.append(.notice(id: id, tone: it["tone"]?.string ?? "info", text: text))
            case "turnEnd":
                let files = it["files"]?.array?.count ?? 0
                let ms = it["ms"]?.number
                let f = files > 0 ? " · \(files) file\(files == 1 ? "" : "s") changed" : ""
                if let err = it["error"]?.string { out.append(.end(id: id, text: "Stopped: \(err)")) } else { out.append(.end(id: id, text: "Done\(ms.map { " in \(duration($0))" } ?? "")\(f)")) }
            default:
                break
            }
        }
        flush()
        return out
    }

    static func toolState(_ s: String) -> ChatLine.ToolState {
        s == "pending" || s == "running" ? .run : s == "ok" ? .ok : .err
    }

    /// "1m 12s", "6s", "0.4s"
    static func duration(_ ms: Double) -> String {
        if ms < 1000 { return String(format: "%.1fs", ms / 1000) }
        let s = Int((ms / 1000).rounded())
        return s < 60 ? "\(s)s" : "\(s / 60)m \(s % 60)s"
    }

    static func base(_ p: String?) -> String {
        guard let p, !p.isEmpty else { return "" }
        return p.split(separator: "/").last.map(String.init) ?? p
    }
    static func clip(_ s: String, _ n: Int) -> String { s.count > n ? String(s.prefix(n - 1)) + "…" : s }

    /// The desktop's toolLine words (toolVerbs.ts), the common tools.
    static func toolLine(_ t: JSONValue) -> (text: String, code: String) {
        let done = !["pending", "running"].contains(t["status"]?.string ?? "")
        let status = t["status"]?.string ?? ""
        let i = t["input"] ?? .object([:])
        func v(_ run: String, _ past: String) -> String { done ? past : run }
        let name = t["name"]?.string ?? "a tool"
        var line: (String, String)
        switch name {
        case "Read", "NotebookRead": line = (v("Reading", "Read"), base(i["file_path"]?.string ?? i["notebook_path"]?.string))
        case "Grep": line = (v("Searching for", "Searched for"), clip("“\(i["pattern"]?.string ?? "")”", 60))
        case "Glob": line = (v("Finding files", "Found files"), clip(i["pattern"]?.string ?? "", 60))
        case "LS": line = (v("Listing", "Listed"), base(i["path"]?.string))
        case "Edit", "MultiEdit", "NotebookEdit": line = (v("Editing", "Edited"), base(i["file_path"]?.string ?? i["notebook_path"]?.string))
        case "Write": line = (v("Creating", "Created"), base(i["file_path"]?.string))
        case "Bash":
            let cmd = i["command"]?.string ?? ""
            let desc = (i["description"]?.string ?? "").trimmingCharacters(in: .whitespaces)
            let verb = desc.isEmpty ? v("Running a command", "Ran a command") : desc
            line = (done && status == "error" ? "\(verb) · failed" : verb, clip(cmd.components(separatedBy: "\n").first ?? cmd, 80))
        case "WebSearch": line = (v("Searching the web for", "Searched the web for"), clip("“\(i["query"]?.string ?? "")”", 60))
        case "WebFetch": line = (v("Reading", "Read"), URLComponents(string: i["url"]?.string ?? "")?.host ?? "")
        case "Task", "Agent":
            let who = i["subagent_type"]?.string ?? "helper"
            line = (v("Asking the \(who) agent", "Asked the \(who) agent"), clip(i["description"]?.string ?? "", 80))
        case "Skill":
            let s = i["skill"]?.string ?? i["command"]?.string ?? "a"
            line = (v("Using the \(s) skill", "Used the \(s) skill"), "")
        default:
            let pretty = name.hasPrefix("mcp__") ? name.split(separator: "_").last.map(String.init) ?? name : name
            line = (v("Using \(pretty)", "Used \(pretty)"), "")
        }
        if status == "denied" { line.0 = name == "Bash" ? "Didn't run" : "Didn't use \(name)" }
        if status == "interrupted" { line.0 = "Stopped" }
        return line
    }

    static func groupSummary(_ tools: [JSONValue]) -> String {
        var files = 0, searches = 0, web = 0, other = 0
        for t in tools {
            switch t["name"]?.string ?? "" {
            case "Read", "NotebookRead", "LS": files += 1
            case "Grep", "Glob", "ToolSearch": searches += 1
            case "WebFetch", "WebSearch": web += 1
            default: other += 1
            }
        }
        var parts: [String] = []
        if files > 0 { parts.append("read \(files) file\(files == 1 ? "" : "s")") }
        if searches > 0 { parts.append("searched \(searches) time\(searches == 1 ? "" : "s")") }
        if web > 0 { parts.append("looked at \(web) page\(web == 1 ? "" : "s")") }
        if other > 0 { parts.append("\(other) more step\(other == 1 ? "" : "s")") }
        let s = parts.joined(separator: ", ")
        return s.prefix(1).uppercased() + s.dropFirst()
    }

    static func permissionTitle(_ tool: String, _ input: JSONValue) -> String {
        switch tool {
        case "Bash": return "Run a command?"
        case "Write": return "Create \(base(input["file_path"]?.string))?"
        case "Edit", "MultiEdit", "NotebookEdit": return "Change \(base(input["file_path"]?.string ?? input["notebook_path"]?.string))?"
        case "WebFetch": return "Open \(URLComponents(string: input["url"]?.string ?? "")?.host ?? "a page")?"
        case "Read": return "Read \(base(input["file_path"]?.string))?"
        default: return "Use \(tool)?"
        }
    }

    static func commandOf(_ input: JSONValue) -> String? {
        guard let c = input["command"]?.string ?? input["file_path"]?.string ?? input["url"]?.string else { return nil }
        return clip(c, 300)
    }
}

/// One line of the slash menu (the desktop's slashMatches, shared/chat.ts).
struct ChatCommand: Equatable, Sendable, Identifiable {
    let name: String
    let description: String
    var id: String { name }

    static func list(_ v: JSONValue?) -> [ChatCommand] {
        (v?.array ?? []).compactMap { c in
            guard let n = c["name"]?.string, !n.isEmpty else { return nil }
            return ChatCommand(name: n, description: c["description"]?.string ?? "")
        }
    }

    /// What was typed after `/` while the draft is only a command name so far; nil otherwise.
    static func query(_ draft: String) -> String? {
        guard draft.hasPrefix("/") else { return nil }
        let q = draft.dropFirst()
        let ok = q.unicodeScalars.allSatisfy { CharacterSet.alphanumerics.contains($0) || "_:.-".unicodeScalars.contains($0) }
        return ok ? String(q) : nil
    }

    /// The commands whose name holds the query, best first. Internal ones (`__name`) never show.
    static func matches(_ all: [ChatCommand], _ query: String, max: Int = 40) -> [ChatCommand] {
        let q = query.lowercased()
        let hits = all.filter { !$0.name.hasPrefix("__") && (q.isEmpty || $0.name.lowercased().contains(q)) }
        let rank = { (c: ChatCommand) in c.name.lowercased().hasPrefix(q) ? 0 : 1 }
        return Array(hits.enumerated().sorted {
            let a = (rank($0.element), $0.element.name.count, $0.offset)
            let b = (rank($1.element), $1.element.name.count, $1.offset)
            return a < b
        }.map(\.element).prefix(max))
    }
}
