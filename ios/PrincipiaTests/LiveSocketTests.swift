import XCTest
@testable import Principia

/// A socket that records what is sent and plays back what the Mac says. Its async calls run off the main actor while
/// a test delivers from it, so the lock keeps "nothing yet, wait" and "here it is" from missing each other.
final class FakeConnection: LiveConnection {
    private let lock = NSLock()
    private var outbox: [String] = []
    private var inbox: [String] = []
    private var code: Int?
    private var waiters: [CheckedContinuation<String, Error>] = []
    private var closed = false

    var sent: [String] { lock.withLock { outbox } }
    var closeCode: Int? { lock.withLock { code } }

    func send(_ text: String) async throws {
        try lock.withLock {
            if closed { throw URLError(.networkConnectionLost) }
            outbox.append(text)
        }
    }
    func receive() async throws -> String {
        try await withCheckedThrowingContinuation { w in
            lock.withLock {
                if !inbox.isEmpty { w.resume(returning: inbox.removeFirst()) } else if closed { w.resume(throwing: URLError(.networkConnectionLost)) } else { waiters.append(w) }
            }
        }
    }
    func deliver(_ text: String) {
        lock.withLock {
            if let w = waiters.first { waiters.removeFirst(); w.resume(returning: text) } else { inbox.append(text) }
        }
    }
    func serverClose(_ code: Int) {
        lock.withLock {
            self.code = code
            closed = true
            waiters.forEach { $0.resume(throwing: URLError(.networkConnectionLost)) }
            waiters = []
        }
    }
    func close() { serverClose(closeCode ?? 1000) }
}

final class FakeConnector: LiveConnector {
    var opened: [(URL, String, FakeConnection)] = []
    func open(url: URL, origin: String) -> LiveConnection {
        let c = FakeConnection()
        opened.append((url, origin, c))
        return c
    }
}

@MainActor
final class LiveSocketTests: XCTestCase {
    func make(_ connector: FakeConnector, events: @escaping (String) -> Void) -> LiveSocket {
        let s = LiveSocket(connector: connector, mac: "https://quiet-tree-42.trycloudflare.com", origin: "https://principia-phone.vibiz.dev", token: { "tok_abcdefghijklmnop" }, handlers: .init(
            onMessage: { m in events("msg:\(m)") },
            onState: { up in events("up:\(up)") },
            onReconnect: { events("reconnect") },
            onUnauthorized: { events("unauthorized") }
        ))
        s.sleep = { _ in }
        return s
    }

    struct TimedOut: Error {}

    /// Waits for what the last step set off. No fixed number of yields is enough: the fake's calls run off the main
    /// actor, and on a busy machine they finish late. A timeout ends the test, so a missing socket fails it, not the run.
    func until(_ what: @autoclosure () -> String, file: StaticString = #filePath, line: UInt = #line, _ done: () -> Bool) async throws {
        let deadline = Date().addingTimeInterval(10)
        while !done() {
            if Date() > deadline {
                XCTFail("timed out waiting for: \(what())", file: file, line: line)
                throw TimedOut()
            }
            try await Task.sleep(nanoseconds: 1_000_000)
        }
    }

    func testAuthGoesFirstThenTheSubscription() async throws {
        let k = FakeConnector()
        var events: [String] = []
        let s = make(k) { events.append($0) }
        s.subscribe(companyId: "co_a", sessionId: "se_1")
        s.start()
        let (url, origin, c) = try XCTUnwrap(k.opened.first)
        try await until("auth and subscription, sent: \(c.sent)") { c.sent.count == 2 }
        XCTAssertEqual(url.absoluteString, "wss://quiet-tree-42.trycloudflare.com/api/live")
        XCTAssertEqual(origin, "https://principia-phone.vibiz.dev")
        XCTAssertFalse(url.absoluteString.contains("tok_"), "the token is never in the URL")
        XCTAssertEqual(c.sent.first, #"{"t":"auth","token":"tok_abcdefghijklmnop"}"#)
        XCTAssertEqual(c.sent.count, 2)
        XCTAssertTrue(c.sent[1].contains(#""t":"sub""#) && c.sent[1].contains("co_a") && c.sent[1].contains("se_1"))
        c.deliver(#"{"t":"hello"}"#)
        try await until("connected") { s.connected }
        XCTAssertTrue(events.contains("up:true"))
        XCTAssertTrue(s.connected)
        s.stop()
    }

    func test4401WithoutByeSignsOut() async throws {
        let k = FakeConnector()
        var events: [String] = []
        let s = make(k) { events.append($0) }
        s.start()
        let c = k.opened[0].2
        try await until("auth") { c.sent.count == 1 }
        c.serverClose(4401)
        try await until("unauthorized, events: \(events)") { events.contains("unauthorized") }
        XCTAssertEqual(k.opened.count, 1, "no reconnect after a refused token")
    }

    func testDropReconnectsAndAuthsAgain() async throws {
        let k = FakeConnector()
        var events: [String] = []
        let s = make(k) { events.append($0) }
        s.start()
        k.opened[0].2.deliver(#"{"t":"hello"}"#)
        try await until("connected") { s.connected }
        k.opened[0].2.serverClose(1006)
        try await until("a second socket") { k.opened.count == 2 }
        let again = k.opened[1].2
        try await until("auth on the second socket") { !again.sent.isEmpty }
        XCTAssertEqual(again.sent.first, #"{"t":"auth","token":"tok_abcdefghijklmnop"}"#)
        again.deliver(#"{"t":"hello"}"#)
        try await until("reconnect, events: \(events)") { events.contains("reconnect") }
        XCTAssertFalse(events.contains("unauthorized"))
        s.stop()
    }

    func testByeThenCloseIsNotUnauthorized() async throws {
        let k = FakeConnector()
        var events: [String] = []
        let s = make(k) { events.append($0) }
        s.start()
        let c = k.opened[0].2
        c.deliver(#"{"t":"bye","reason":"revoked"}"#)
        try await until("bye, events: \(events)") { events.contains { $0.contains("bye") } }
        c.serverClose(4401)
        // the next socket is the proof the close was handled: a signed-out phone would not open one
        try await until("a slow retry") { k.opened.count == 2 }
        XCTAssertFalse(events.contains("unauthorized"))
        s.stop()
    }

    func testASubscribeWhileTheFirstOnesAreOnTheirWayIsSentOnceReady() async throws {
        // QA PQ-10: a chat opened right as the socket connects must not keep the older subscription
        let k = FakeConnector()
        let s = make(k) { _ in }
        s.subscribe(companyId: "co_a")
        s.start()
        s.subscribe(companyId: "co_a", sessionId: "se_9")
        let c = k.opened[0].2
        try await until("the newest subscription, sent: \(c.sent)") { c.sent.last?.contains("se_9") == true }
        s.stop()
    }

    func testASocketThatDoesNotAnswerAPingIsDroppedAndOpenedAgain() async throws {
        // QA PQ-09: back from the background, a socket that still looks open must prove it
        let k = FakeConnector()
        var events: [String] = []
        let s = make(k) { events.append($0) }
        var release: CheckedContinuation<Void, Never>?
        s.pongWait = { _ in await withCheckedContinuation { release = $0 } }
        let ping = #"{"t":"ping"}"#
        s.start()
        k.opened[0].2.deliver(#"{"t":"hello"}"#)
        try await until("connected") { s.connected }
        s.kick()
        try await until("a ping and its deadline") { k.opened[0].2.sent.contains(ping) && release != nil }
        release?.resume()
        release = nil
        try await until("no pong: a new socket") { k.opened.count == 2 }
        XCTAssertTrue(events.contains("up:false"))
        // one that answers stays
        let second = k.opened[1].2
        second.deliver(#"{"t":"hello"}"#)
        try await until("connected again") { s.connected }
        s.kick()
        try await until("a ping and its deadline") { second.sent.contains(ping) && release != nil }
        second.deliver(#"{"t":"pong"}"#)
        try await until("the pong, events: \(events)") { events.contains { $0.contains("pong") } }
        release?.resume()
        release = nil
        // a later kick only pings once that deadline has passed, on the same socket if it was kept
        try await until("another ping on the same socket") {
            s.kick()
            return second.sent.filter { $0 == ping }.count == 2 && release != nil
        }
        XCTAssertEqual(k.opened.count, 2)
        s.stop()
        release?.resume()
    }

    func testServerMessagesDecode() {
        XCTAssertEqual(PhoneServerMsg.decode(#"{"t":"changed","companyId":null,"what":["now","needs"]}"#), .changed(companyId: nil, what: ["now", "needs"]))
        XCTAssertEqual(PhoneServerMsg.decode(#"{"t":"bye","reason":"off"}"#), .bye(reason: "off"))
        XCTAssertEqual(PhoneServerMsg.decode(#"{"t":"screen","sessionId":"se_1","text":"Reading footer.html"}"#), .screen(sessionId: "se_1", text: "Reading footer.html"))
        XCTAssertNil(PhoneServerMsg.decode("not json"))
        if case .chat(let sid, let seq, let ops)? = PhoneServerMsg.decode(#"{"t":"chat","sessionId":"se_1","seq":4,"ops":[{"op":"state","turn":"working"}]}"#) {
            XCTAssertEqual(sid, "se_1"); XCTAssertEqual(seq, 4); XCTAssertEqual(ops.count, 1)
        } else { XCTFail() }
    }
}
