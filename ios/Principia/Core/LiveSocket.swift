import Foundation

/// One WebSocket, so tests can stand in for it.
protocol LiveConnection: AnyObject {
    func send(_ text: String) async throws
    func receive() async throws -> String
    func close()
    /// once closed: the close code (4401 = the Mac does not know this token) and its reason
    var closeCode: Int? { get }
    /// the HTTP status of a refused upgrade (a dead quick tunnel: 530 from Cloudflare), if any
    var handshakeStatus: Int? { get }
}

extension LiveConnection {
    var handshakeStatus: Int? { nil }
}

protocol LiveConnector {
    func open(url: URL, origin: String) -> LiveConnection
}

/// The live socket (`/api/live`, docs/REMOTE.md RA6). Its first message is `{ t: 'auth', token }` (the token is never in
/// the URL); nothing else is sent before it. A ping every 25 s, reconnect with backoff, and at once when the app comes
/// back to the foreground. A close with 4401 and no `bye` before it means this token is unknown: signed out.
@MainActor
final class LiveSocket {
    struct Handlers {
        var onMessage: (PhoneServerMsg) -> Void
        var onState: (Bool) -> Void
        var onReconnect: () -> Void
        var onUnauthorized: () -> Void
        /// the Mac's address looks gone (Cloudflare refused the upgrade, no such name, refused, timed out) twice in a row:
        /// the app checks with a call and shows "Waiting for your Mac" if so (RA8)
        var onGone: () -> Void = {}
    }

    private let connector: LiveConnector
    private let url: URL
    private let origin: String
    private let token: () -> String?
    private let h: Handlers
    private var conn: LiveConnection?
    private var ready: LiveConnection?
    private var closed = false
    private var tries = 0
    private var byeSeen = false
    private var goneStreak = 0
    private var lastSub: String?
    private var retryTask: Task<Void, Never>?
    private var pingTask: Task<Void, Never>?
    private var deadlineTask: Task<Void, Never>?
    /// messages heard on the current socket (a ping waits for this to move)
    private var heard = 0
    private(set) var connected = false
    /// test hook: the backoff waits (seconds)
    var sleep: (Double) async -> Void = { s in try? await Task.sleep(nanoseconds: UInt64(s * 1_000_000_000)) }
    /// test hook: how long a ping waits for an answer before the socket counts as dead (seconds)
    var pongWait: (Double) async -> Void = { s in try? await Task.sleep(nanoseconds: UInt64(s * 1_000_000_000)) }
    static let pingEvery: Double = 25
    static let pongWithin: Double = 10
    static let pongWithinOnKick: Double = 5

    init(connector: LiveConnector, mac: String, origin: String, token: @escaping () -> String?, handlers: Handlers) {
        self.connector = connector
        let u = URLComponents(string: mac)
        let scheme = u?.scheme == "https" ? "wss" : "ws"
        let host = u?.host ?? "127.0.0.1"
        let port = u?.port.map { ":\($0)" } ?? ""
        self.url = URL(string: "\(scheme)://\(host)\(port)/api/live")!
        self.origin = origin
        self.token = token
        self.h = handlers
    }

    var address: URL { url }

    func start() {
        closed = false
        connect()
        pingTask?.cancel()
        pingTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: UInt64(Self.pingEvery * 1_000_000_000))
                self?.checkAlive(within: Self.pongWithin)
            }
        }
    }

    func stop() {
        closed = true
        retryTask?.cancel()
        pingTask?.cancel()
        deadlineTask?.cancel()
        conn?.close()
        conn = nil
        ready = nil
        setUp(false)
    }

    /// what this phone is looking at (sent again after every reconnect)
    func subscribe(companyId: String, sessionId: String? = nil, channelId: String? = nil) {
        var m: [String: Any] = ["t": "sub", "companyId": companyId]
        m["sessionId"] = sessionId ?? NSNull()
        m["channelId"] = channelId ?? NSNull()
        guard let d = try? JSONSerialization.data(withJSONObject: m, options: [.sortedKeys]), let s = String(data: d, encoding: .utf8) else { return }
        lastSub = s
        if let c = ready { Task { try? await c.send(s) } }
    }

    /// back in the foreground, or the network came back: reconnect now if the socket is gone. One that still looks open
    /// must answer a ping soon (a socket from before the phone slept is often dead without a close).
    func kick() {
        guard !closed else { return }
        if connected && conn != nil {
            checkAlive(within: Self.pongWithinOnKick)
            return
        }
        retryTask?.cancel()
        retryTask = nil
        tries = max(tries, 1)
        connect()
    }

    /// A ping, and the socket must say anything (its pong) in time, or it is dropped and opened again.
    private func checkAlive(within wait: Double) {
        guard !closed, let c = ready, deadlineTask == nil else { return }
        let before = heard
        Task { try? await c.send(#"{"t":"ping"}"#) }
        deadlineTask = Task { [weak self] in
            await self?.pongWait(wait)
            guard let self, !Task.isCancelled else { return }
            self.deadlineTask = nil
            if self.conn === c, self.heard == before { self.drop(c) }
        }
    }

    /// a half-open socket: close it and connect again now
    private func drop(_ c: LiveConnection) {
        guard conn === c else { return }
        conn = nil
        ready = nil
        c.close()
        setUp(false)
        retryTask?.cancel()
        retryTask = nil
        tries = max(tries, 1)
        connect()
    }

    static func authMessage(_ token: String) -> String {
        let d = try! JSONSerialization.data(withJSONObject: ["t": "auth", "token": token], options: [.sortedKeys])
        return String(data: d, encoding: .utf8)!
    }

    private func connect() {
        guard !closed else { return }
        conn?.close()
        let c = connector.open(url: url, origin: origin)
        conn = c
        ready = nil
        deadlineTask?.cancel()
        deadlineTask = nil
        Task { await run(c) }
    }

    private func run(_ c: LiveConnection) async {
        do {
            // RA6: who we are, first; nothing else goes before it
            if let t = token() { try await c.send(LiveSocket.authMessage(t)) }
            guard conn === c else { return }
            let sent = lastSub
            if let s = sent { try await c.send(s) }
            guard conn === c else { return }
            ready = c
            // a subscribe() while those were on their way found no ready socket: the newest one goes now
            if let s = lastSub, s != sent { try await c.send(s) }
            while true {
                let text = try await c.receive()
                guard conn === c else { return }
                heard += 1
                guard let m = PhoneServerMsg.decode(text) else { continue }
                if case .hello = m {
                    let again = tries > 0
                    tries = 0
                    goneStreak = 0
                    setUp(true)
                    if again { h.onReconnect() }
                }
                if case .bye = m { byeSeen = true }
                h.onMessage(m)
            }
        } catch {
            guard conn === c else { return }
            conn = nil
            ready = nil
            setUp(false)
            if c.closeCode == 4401 && !byeSeen {
                closed = true
                h.onUnauthorized()
                return
            }
            if Self.looksGone(error, status: c.handshakeStatus) {
                goneStreak += 1
                if goneStreak >= 2 { goneStreak = 0; h.onGone() }
            }
            // revoked / turned off said bye first: keep trying slowly in case it comes back
            retry(min: c.closeCode == 4401 ? 30 : nil)
        }
    }

    /// A failed socket that says the address is gone, not just a dropped connection.
    nonisolated static func looksGone(_ error: Error, status: Int?) -> Bool {
        if let status { return status == 530 || (500...599).contains(status) }
        return MacReach.isUnreachable(error)
    }

    private func retry(min: Double? = nil) {
        guard !closed, retryTask == nil else { return }
        tries += 1
        let wait = min ?? Swift.min(15, 0.5 * pow(2, Double(Swift.min(tries, 5))))
        retryTask = Task { [weak self] in
            await self?.sleep(wait)
            guard let self, !Task.isCancelled else { return }
            self.retryTask = nil
            self.connect()
        }
    }

    private func setUp(_ v: Bool) {
        guard connected != v else { return }
        connected = v
        h.onState(v)
    }
}

// ---------- URLSessionWebSocketTask ----------

final class URLSessionLiveConnector: LiveConnector {
    func open(url: URL, origin: String) -> LiveConnection {
        URLSessionLiveConnection(url: url, origin: origin)
    }
}

final class URLSessionLiveConnection: NSObject, LiveConnection, URLSessionWebSocketDelegate, @unchecked Sendable {
    private var session: URLSession!
    private var task: URLSessionWebSocketTask!
    private let lock = NSLock()
    private var code: Int?

    init(url: URL, origin: String) {
        super.init()
        let cfg = URLSessionConfiguration.ephemeral
        cfg.httpCookieAcceptPolicy = .never
        cfg.httpShouldSetCookies = false
        session = URLSession(configuration: cfg, delegate: self, delegateQueue: nil)
        var r = URLRequest(url: url)
        // the Mac lets a socket in from its configured phone site only (the token then comes in the first message)
        r.setValue(origin, forHTTPHeaderField: "Origin")
        task = session.webSocketTask(with: r)
        task.maximumMessageSize = 4 * 1024 * 1024
        task.resume()
    }

    func send(_ text: String) async throws {
        try await task.send(.string(text))
    }

    func receive() async throws -> String {
        switch try await task.receive() {
        case .string(let s): return s
        case .data(let d): return String(data: d, encoding: .utf8) ?? ""
        @unknown default: return ""
        }
    }

    func close() {
        task.cancel(with: .goingAway, reason: nil)
        session.invalidateAndCancel()
    }

    var handshakeStatus: Int? {
        guard let s = (task.response as? HTTPURLResponse)?.statusCode, s != 101 else { return nil }
        return s
    }

    var closeCode: Int? {
        lock.withLock {
            if let code { return code }
            let raw = task.closeCode.rawValue
            if raw != 0 { return raw }
            // a code outside the enum (4401) reads as .invalid: its reason says which
            if let r = task.closeReason.flatMap({ String(data: $0, encoding: .utf8) }), r == "unauthorized" || r == "revoked" { return 4401 }
            return nil
        }
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        let r = reason.flatMap { String(data: $0, encoding: .utf8) }
        lock.withLock {
            code = (r == "unauthorized" || r == "revoked") ? 4401 : (closeCode.rawValue != 0 ? closeCode.rawValue : nil)
        }
    }
}
