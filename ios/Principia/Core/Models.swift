import Foundation

// The Phone API's view shapes (src/shared/remote.ts). Only what the phone shows; unknown fields are ignored.

struct PhoneWho: Codable, Hashable, Sendable {
    var name: String
    var role: String
    var bust: String?
}

struct PhoneChatRef: Codable, Hashable, Sendable {
    enum Kind: String, Codable, Sendable { case session, agent }
    var kind: Kind
    var id: String
}

struct PhoneCompany: Codable, Hashable, Identifiable, Sendable {
    var id: String
    var name: String
    var personal: Bool
    var paused: Bool
    var working: Int
    var needs: Int
}

struct PhoneMe: Codable, Sendable {
    struct Device: Codable, Sendable { var id: String; var name: String }
    var device: Device
    var host: String?
    var companies: [PhoneCompany]
}

struct PhoneWorking: Codable, Hashable, Identifiable, Sendable {
    var key: String
    var who: PhoneWho?
    var title: String
    var activity: String?
    var startedAt: String
    var open: PhoneChatRef?
    var id: String { key }
}

struct PhoneDone: Codable, Hashable, Identifiable, Sendable {
    enum Status: String, Codable, Sendable { case done, review, failed }
    var key: String
    var title: String
    var who: PhoneWho?
    var at: String
    var status: Status
    var summary: String?
    var id: String { key }
}

struct PhoneNow: Codable, Sendable {
    var companyId: String
    var name: String
    var paused: Bool
    var needs: Int
    var working: [PhoneWorking]
    var done: [PhoneDone]
}

struct PhoneAsk: Codable, Hashable, Identifiable, Sendable {
    struct Option: Codable, Hashable, Identifiable, Sendable {
        var id: String
        var label: String
        /// allow | allow_step | deny | choice
        var kind: String
    }
    var id: String
    var title: String
    var question: String?
    var detail: String?
    var who: PhoneWho?
    var options: [Option]
    var text: Bool
    var at: String
    var open: PhoneChatRef?
}

struct PhoneTaskNeed: Codable, Hashable, Identifiable, Sendable {
    enum Kind: String, Codable, Sendable { case review, question, stuck, idea }
    var taskId: String
    var kind: Kind
    var title: String
    var text: String
    var who: PhoneWho?
    var agentId: String?
    var at: String
    var options: [String]
    var id: String { "\(kind.rawValue):\(taskId)" }
}

struct PhoneNeeds: Codable, Sendable {
    var companyId: String
    var count: Int
    var asks: [PhoneAsk]
    var tasks: [PhoneTaskNeed]
}

struct PhoneChatRow: Codable, Hashable, Identifiable, Sendable {
    var key: String
    var ref: PhoneChatRef
    var title: String
    var who: PhoneWho?
    var live: Bool
    var at: String
    var line: String?
    var id: String { key }
}

struct PhoneChats: Codable, Sendable {
    var companyId: String
    var rows: [PhoneChatRow]
}

struct ChatQueued: Codable, Hashable, Identifiable, Sendable {
    var id: String
    var text: String
    var images: Int?
}

struct ChatSnapshot: Codable, Sendable {
    var sessionId: String
    var mode: String
    var available: Bool?
    var turn: String
    var activity: String?
    var turnStartedAt: Double?
    var items: [JSONValue]
    var queue: [ChatQueued]
    var seq: Int
    var note: String?
}

struct PhoneSession: Codable, Sendable {
    /// A session that runs in a terminal on the Mac. Newer Macs also send its transcript as `chat` (live, mode
    /// "terminal") and say what the phone may do; older ones send only the first three.
    struct Terminal: Codable, Sendable {
        var activity: String?
        var canReply: Bool
        var ended: Bool
        /// a message can be typed into it now (nil: an older Mac)
        var canType: Bool?
        /// why it cannot take a message now
        var held: String?
        /// "transcript" (the chat holds it), "screen" (`screen` holds it) or nil (nothing to show yet)
        var source: String?
        /// the terminal's last lines, when it has no transcript yet
        var screen: String?
        /// what it asks right now (answered like Needs you)
        var asks: [PhoneAsk]?
        /// ended: Continue opens it again on the Mac, same conversation
        var canContinue: Bool?

        /// Its message box (a newer Mac): none once it ended or for a shell; while it cannot take a message (it asks
        /// something, shows a choice) the reason is the placeholder and Send is off.
        func composer(name: String) -> (placeholder: String, held: Bool)? {
            if ended { return nil }
            if canType == true || canReply { return ("Message \(name)", false) }
            if let held { return (held, true) }
            return nil
        }
    }
    var ref: PhoneChatRef
    var title: String
    var who: PhoneWho?
    var chat: ChatSnapshot?
    var terminal: Terminal?
}

struct PhoneThreadItem: Codable, Hashable, Identifiable, Sendable {
    /// me | agent | task | note
    var kind: String
    var id: String
    var at: String
    var text: String
    var taskId: String
    /// review | ask | blocked (agent items)
    var card: String?
}

struct PhoneAgent: Codable, Sendable {
    var ref: PhoneChatRef
    var who: PhoneWho
    var status: String
    var items: [PhoneThreadItem]
}

struct PhoneRoomMember: Codable, Hashable, Identifiable, Sendable {
    var id: String
    var handle: String
    var name: String
    /// human | agent | guest
    var kind: String
    var role: String?
}

struct PhoneRoomMessage: Codable, Hashable, Identifiable, Sendable {
    var id: String
    var seq: Int
    var channelId: String
    var threadId: String?
    var authorId: String
    /// text | ask | proposal | system
    var kind: String
    var text: String
    var at: String
}

struct PhoneRoom: Codable, Sendable {
    struct Channel: Codable, Hashable, Identifiable, Sendable { var id: String; var label: String }
    var companyId: String
    var enabled: Bool
    var message: String?
    var me: String?
    var channelId: String?
    var channels: [Channel]
    var members: [PhoneRoomMember]
    var messages: [PhoneRoomMessage]
    var answering: [String]?
}

/// POST …/sessions/:id/continue: the session that carries the conversation on
struct ContinueResponse: Codable, Sendable {
    var sessionId: String?
}

struct PhonePairResponse: Codable, Sendable {
    struct Device: Codable, Sendable { var id: String; var name: String }
    var device: Device
    var token: String?
}

/// What the live socket says (PhoneServerMsg).
enum PhoneServerMsg: Sendable, Equatable {
    case hello
    case pong
    case changed(companyId: String?, what: [String])
    case chat(sessionId: String, seq: Int, ops: [JSONValue])
    /// a terminal session's last lines (no transcript to show as a chat yet)
    case screen(sessionId: String, text: String)
    case room(PhoneRoomMessage)
    case bye(reason: String)
    case unknown

    static func decode(_ text: String) -> PhoneServerMsg? {
        guard let data = text.data(using: .utf8), let v = try? JSONDecoder().decode(JSONValue.self, from: data), let t = v["t"]?.string else { return nil }
        switch t {
        case "hello": return .hello
        case "pong": return .pong
        case "changed":
            return .changed(companyId: v["companyId"]?.string, what: (v["what"]?.array ?? []).compactMap(\.string))
        case "chat":
            guard let sid = v["sessionId"]?.string, let seq = v["seq"]?.int else { return nil }
            return .chat(sessionId: sid, seq: seq, ops: v["ops"]?.array ?? [])
        case "screen":
            guard let sid = v["sessionId"]?.string, let text = v["text"]?.string else { return nil }
            return .screen(sessionId: sid, text: text)
        case "room":
            guard let m = v["message"], let d = try? JSONEncoder().encode(m), let msg = try? JSONDecoder().decode(PhoneRoomMessage.self, from: d) else { return nil }
            return .room(msg)
        case "bye": return .bye(reason: v["reason"]?.string ?? "off")
        default: return .unknown
        }
    }
}

/// How a chat card is answered from the phone (no "always allow": RA3).
enum PhoneChatDecision: Sendable, Equatable {
    case allow
    case deny(message: String?)
    case answer([String: String])
    case skip
    case approvePlan
    case rejectPlan(message: String?)

    var json: [String: Any] {
        switch self {
        case .allow: return ["kind": "allow"]
        case .deny(let m): return m.map { ["kind": "deny", "message": $0] } ?? ["kind": "deny"]
        case .answer(let a): return ["kind": "answer", "answers": a]
        case .skip: return ["kind": "skip"]
        case .approvePlan: return ["kind": "approvePlan"]
        case .rejectPlan(let m): return m.map { ["kind": "rejectPlan", "message": $0] } ?? ["kind": "rejectPlan"]
        }
    }
}
