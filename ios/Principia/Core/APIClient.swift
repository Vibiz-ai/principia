import Foundation

/// The Phone API routes (REMOTE_ROUTES in src/shared/remote.ts).
enum Route: Sendable, Equatable {
    case pair, me, signOut
    case now(String), pause(String), needs(String)
    case answerAsk(String, askId: String)
    case approveTask(String, taskId: String), sendBackTask(String, taskId: String), answerTask(String, taskId: String), cancelTask(String, taskId: String)
    case chats(String), session(String, sessionId: String)
    case sessionSend(String, sessionId: String), sessionStop(String, sessionId: String), sessionAnswer(String, sessionId: String), sessionReply(String, sessionId: String)
    case sessionContinue(String, sessionId: String)
    case agent(String, agentId: String), agentSend(String, agentId: String)
    case room(String, channelId: String?), roomPost(String)

    var method: String {
        switch self {
        case .me, .now, .needs, .chats, .session, .agent, .room: return "GET"
        default: return "POST"
        }
    }

    /// the path, every id percent-encoded as one segment
    var path: String {
        func e(_ s: String) -> String { s.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: "-._~"))) ?? s }
        func c(_ id: String) -> String { "/api/c/\(e(id))" }
        switch self {
        case .pair: return "/api/pair"
        case .me: return "/api/me"
        case .signOut: return "/api/sign-out"
        case .now(let co): return "\(c(co))/now"
        case .pause(let co): return "\(c(co))/pause"
        case .needs(let co): return "\(c(co))/needs"
        case .answerAsk(let co, let id): return "\(c(co))/asks/\(e(id))/answer"
        case .approveTask(let co, let id): return "\(c(co))/tasks/\(e(id))/approve"
        case .sendBackTask(let co, let id): return "\(c(co))/tasks/\(e(id))/send-back"
        case .answerTask(let co, let id): return "\(c(co))/tasks/\(e(id))/answer"
        case .cancelTask(let co, let id): return "\(c(co))/tasks/\(e(id))/cancel"
        case .chats(let co): return "\(c(co))/chats"
        case .session(let co, let id): return "\(c(co))/sessions/\(e(id))"
        case .sessionSend(let co, let id): return "\(c(co))/sessions/\(e(id))/send"
        case .sessionStop(let co, let id): return "\(c(co))/sessions/\(e(id))/stop"
        case .sessionAnswer(let co, let id): return "\(c(co))/sessions/\(e(id))/answer"
        case .sessionReply(let co, let id): return "\(c(co))/sessions/\(e(id))/reply"
        case .sessionContinue(let co, let id): return "\(c(co))/sessions/\(e(id))/continue"
        case .agent(let co, let id): return "\(c(co))/agents/\(e(id))"
        case .agentSend(let co, let id): return "\(c(co))/agents/\(e(id))/send"
        case .room(let co, let ch):
            return "\(c(co))/room" + (ch.map { "?channelId=\(e($0))" } ?? "")
        case .roomPost(let co): return "\(c(co))/room/post"
        }
    }
}

enum APIError: Error, Equatable, LocalizedError {
    /// 401: this phone is not paired, or the Mac signed it out
    case notPaired
    /// the Mac's address did not answer at all (the quick tunnel stopped or changed)
    case macGone
    /// the Mac said no, in words
    case server(status: Int, message: String)
    case badResponse

    var errorDescription: String? {
        switch self {
        case .notPaired: return "Open the pairing link from Principia on your Mac."
        case .macGone: return "Your Mac is not reachable at its last address."
        case .server(_, let m): return m
        case .badResponse: return "The Mac sent something this app does not understand."
        }
    }
}

/// The network, so tests can stand in for it.
protocol HTTPTransport: Sendable {
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse)
}

struct URLSessionTransport: HTTPTransport {
    let session: URLSession
    init(session: URLSession = .init(configuration: URLSessionTransport.config)) { self.session = session }
    static var config: URLSessionConfiguration {
        let c = URLSessionConfiguration.ephemeral
        c.httpCookieAcceptPolicy = .never
        c.httpShouldSetCookies = false
        c.requestCachePolicy = .reloadIgnoringLocalCacheData
        c.timeoutIntervalForRequest = 20
        c.waitsForConnectivity = false
        return c
    }
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let (d, r) = try await session.data(for: request)
        guard let h = r as? HTTPURLResponse else { throw APIError.badResponse }
        return (d, h)
    }
}

/// Where the API is: the Mac's origin, the site the app pairs as (sent as Origin, so the Mac answers in hosted mode:
/// the token in the body, a bearer on every call, no cookies), and the token once paired.
struct APITarget: Sendable, Equatable {
    var mac: String
    var site: String
    var token: String?
}

/// The Phone API client (docs/REMOTE.md RA6, hosted mode). The token rides only in the Authorization header, never in a
/// URL; no cookie is ever stored or sent.
final class APIClient: @unchecked Sendable {
    private let transport: HTTPTransport
    private let lock = NSLock()
    private var _target: APITarget?

    init(transport: HTTPTransport = URLSessionTransport(), target: APITarget? = nil) {
        self.transport = transport
        self._target = target
    }

    var target: APITarget? {
        get { lock.withLock { _target } }
        set { lock.withLock { _target = newValue } }
    }

    func request(_ route: Route, body: [String: Any]? = nil) throws -> URLRequest {
        guard let t = target, let url = URL(string: t.mac + route.path) else { throw APIError.notPaired }
        var r = URLRequest(url: url)
        r.httpMethod = route.method
        r.cachePolicy = .reloadIgnoringLocalCacheData
        r.httpShouldHandleCookies = false
        r.setValue("application/json", forHTTPHeaderField: "Accept")
        // the Mac answers a hosted caller only for its configured site (CORS-style exact match)
        r.setValue(t.site, forHTTPHeaderField: "Origin")
        if route != .pair, let token = t.token {
            r.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        if route.method == "POST" {
            r.setValue("application/json", forHTTPHeaderField: "Content-Type")
            r.httpBody = try JSONSerialization.data(withJSONObject: body ?? [:])
        }
        return r
    }

    func call<T: Decodable>(_ route: Route, body: [String: Any]? = nil, as: T.Type = T.self) async throws -> T {
        let data = try await raw(route, body: body)
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw APIError.badResponse
        }
    }

    /// For writes whose answer the screen does not need.
    func send(_ route: Route, body: [String: Any]? = nil) async throws {
        _ = try await raw(route, body: body)
    }

    func raw(_ route: Route, body: [String: Any]? = nil) async throws -> Data {
        let req = try request(route, body: body)
        let data: Data
        let res: HTTPURLResponse
        do {
            (data, res) = try await transport.send(req)
        } catch let e as APIError {
            throw e
        } catch {
            throw APIError.macGone
        }
        if res.statusCode == 401 { throw APIError.notPaired }
        let json = try? JSONSerialization.jsonObject(with: data)
        // a quick tunnel that is gone answers from Cloudflare's edge (HTML, 5xx): the Mac is not there
        if res.statusCode >= 500, !(json is [String: Any]) { throw APIError.macGone }
        if !(200..<300).contains(res.statusCode) {
            let msg = (json as? [String: Any])?["message"] as? String ?? "The Mac answered \(res.statusCode)."
            throw APIError.server(status: res.statusCode, message: msg)
        }
        return data
    }

    // ---------- the calls ----------

    func pair(code: String, name: String) async throws -> PhonePairResponse {
        try await call(.pair, body: ["code": code, "name": String(name.prefix(60))])
    }
    func me() async throws -> PhoneMe { try await call(.me) }
    func signOut() async throws { try await send(.signOut) }
    func now(_ co: String) async throws -> PhoneNow { try await call(.now(co)) }
    func setPaused(_ co: String, _ paused: Bool) async throws -> PhoneNow { try await call(.pause(co), body: ["paused": paused]) }
    func needs(_ co: String) async throws -> PhoneNeeds { try await call(.needs(co)) }
    func answerAsk(_ co: String, askId: String, optionId: String?, text: String?) async throws {
        var b: [String: Any] = [:]
        if let optionId { b["optionId"] = optionId }
        if let text { b["text"] = text }
        try await send(.answerAsk(co, askId: askId), body: b)
    }
    func approve(_ co: String, taskId: String) async throws -> PhoneNeeds { try await call(.approveTask(co, taskId: taskId), body: [:]) }
    func sendBack(_ co: String, taskId: String, text: String) async throws -> PhoneNeeds { try await call(.sendBackTask(co, taskId: taskId), body: ["text": text]) }
    func answerTask(_ co: String, taskId: String, text: String) async throws -> PhoneNeeds { try await call(.answerTask(co, taskId: taskId), body: ["text": text]) }
    func notNeeded(_ co: String, taskId: String) async throws -> PhoneNeeds { try await call(.cancelTask(co, taskId: taskId), body: [:]) }
    func chats(_ co: String) async throws -> PhoneChats { try await call(.chats(co)) }
    func session(_ co: String, _ id: String) async throws -> PhoneSession { try await call(.session(co, sessionId: id)) }
    func sessionSend(_ co: String, _ id: String, text: String) async throws { try await send(.sessionSend(co, sessionId: id), body: ["text": text]) }
    func sessionStop(_ co: String, _ id: String, sendNow: Bool = false) async throws { try await send(.sessionStop(co, sessionId: id), body: sendNow ? ["sendNow": true] : [:]) }
    func sessionAnswer(_ co: String, _ id: String, requestId: String, decision: PhoneChatDecision) async throws {
        try await send(.sessionAnswer(co, sessionId: id), body: ["requestId": requestId, "decision": decision.json])
    }
    func sessionReply(_ co: String, _ id: String, text: String) async throws { try await send(.sessionReply(co, sessionId: id), body: ["text": text]) }
    /// an ended terminal session opens again on the Mac (same conversation): the session to follow
    func sessionContinue(_ co: String, _ id: String) async throws -> String? {
        let out: ContinueResponse = try await call(.sessionContinue(co, sessionId: id), body: [:])
        return out.sessionId
    }
    func agent(_ co: String, _ id: String) async throws -> PhoneAgent { try await call(.agent(co, agentId: id)) }
    func agentSend(_ co: String, _ id: String, text: String) async throws { try await send(.agentSend(co, agentId: id), body: ["text": text]) }
    func room(_ co: String, channelId: String?) async throws -> PhoneRoom { try await call(.room(co, channelId: channelId)) }
    func roomPost(_ co: String, channelId: String, text: String) async throws -> PhoneRoomMessage { try await call(.roomPost(co), body: ["channelId": channelId, "text": text]) }
}
