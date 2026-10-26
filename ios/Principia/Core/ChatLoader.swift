import Foundation

/// Loading the open chat's snapshot without losing or rewinding anything (the web app's ChatLoad):
/// - one fetch at a time per chat; asking again while one is out runs it once more after, so the snapshot on screen is
///   always the newest one asked for (an older answer never lands last);
/// - ops that arrive while it is out are held, then applied on top of the snapshot (those it already has are skipped);
/// - the socket's ack ("subbed": the Mac's last op number when the subscription took effect) ahead of the snapshot
///   means ops fell between the two: one more fetch.
@MainActor
final class ChatLoader {
    enum Fetched {
        /// another chat opened meanwhile: nothing to put on screen
        case stale
        /// it has no chat to replicate (a terminal showing its screen)
        case noChat
        case chat(ChatReplica)
    }

    private(set) var id: String?
    private var running: Task<Void, Error>?
    private var again = false
    private var held: [(seq: Int, ops: [JSONValue])] = []
    private var ack: Int?
    private var token = 0

    var loading: String? { running == nil ? nil : id }

    /// `fetch` gets the snapshot (and may set what goes with it); `put` shows the replica, held ops applied.
    func run(_ id: String, fetch: @escaping () async throws -> Fetched, put: @escaping (ChatReplica) -> Void) async throws {
        if let r = running, self.id == id {
            again = true
            try await r.value
            return
        }
        self.id = id
        held = []
        ack = nil
        token += 1
        let my = token
        let t = Task { @MainActor in
            defer {
                if self.token == my {
                    self.running = nil
                    self.held = []
                    self.ack = nil
                }
            }
            repeat {
                again = false
                held = []
                let f = try await fetch()
                guard self.id == id else { break }
                switch f {
                case .stale:
                    return
                case .noChat:
                    // a terminal with no transcript: any op meanwhile means "read it again"
                    if !held.isEmpty { again = true }
                case .chat(var r):
                    for h in held.sorted(by: { $0.seq < $1.seq }) where r.apply(seq: h.seq, ops: h.ops) == .gap { again = true }
                    if let a = ack, a > r.seq { again = true }
                    put(r)
                }
                held = []
                ack = nil
            } while again && self.id == id
        }
        running = t
        try await t.value
    }

    /// ops for a chat whose snapshot is on the way: kept for it (true), or nothing loading (false: apply them as usual)
    func hold(_ id: String, seq: Int, ops: [JSONValue]) -> Bool {
        guard running != nil, self.id == id else { return false }
        held.append((seq, ops))
        return true
    }

    /// the socket's ack while loading: checked once the snapshot is in (true), or nothing loading (false)
    func acked(_ id: String, seq: Int) -> Bool {
        guard running != nil, self.id == id else { return false }
        ack = max(ack ?? 0, seq)
        return true
    }
}
