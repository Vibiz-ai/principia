import XCTest
@testable import Principia

/// A socket that records what is sent and plays back what the Mac says.
final class FakeConnection: LiveConnection {
    var sent: [String] = []
    var inbox: [String] = []
    var closeCode: Int?
    private var waiters: [CheckedContinuation<String, Error>] = []
    private var closed = false

    func send(_ text: String) async throws {
        if closed { throw URLError(.networkConnectionLost) }
        sent.append(text)
    }
    func receive() async throws -> String {
        if !inbox.isEmpty { return inbox.removeFirst() }
        if closed { throw URLError(.networkConnectionLost) }
        return try await withCheckedThrowingContinuation { waiters.append($0) }
    }
    func deliver(_ text: String) {
        if let w = waiters.first { waiters.removeFirst(); w.resume(returning: text) } else { inbox.append(text) }
    }
    func serverClose(_ code: Int) {
        closeCode = code
        closed = true
        let w = waiters
        waiters = []
        w.forEach { $0.resume(throwing: URLError(.networkConnectionLost)) }
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

    func settle() async { for _ in 0..<20 { await Task.yield() } }

    func testAuthGoesFirstThenTheSubscription() async throws {
        let k = FakeConnector()
        var events: [String] = []
        let s = make(k) { events.append($0) }
        s.subscribe(companyId: "co_a", sessionId: "se_1")
        s.start()
        await settle()
        let (url, origin, c) = try XCTUnwrap(k.opened.first)
        XCTAssertEqual(url.absoluteString, "wss://quiet-tree-42.trycloudflare.com/api/live")
        XCTAssertEqual(origin, "https://principia-phone.vibiz.dev")
        XCTAssertFalse(url.absoluteString.contains("tok_"), "the token is never in the URL")
        XCTAssertEqual(c.sent.first, #"{"t":"auth","token":"tok_abcdefghijklmnop"}"#)
        XCTAssertEqual(c.sent.count, 2)
        XCTAssertTrue(c.sent[1].contains(#""t":"sub""#) && c.sent[1].contains("co_a") && c.sent[1].contains("se_1"))
        c.deliver(#"{"t":"hello"}"#)
        await settle()
        XCTAssertTrue(events.contains("up:true"))
        XCTAssertTrue(s.connected)
        s.stop()
    }

    func test4401WithoutByeSignsOut() async throws {
        let k = FakeConnector()
        var events: [String] = []
        let s = make(k) { events.append($0) }
        s.start()
        await settle()
        k.opened[0].2.serverClose(4401)
        await settle()
        XCTAssertTrue(events.contains("unauthorized"))
        XCTAssertEqual(k.opened.count, 1, "no reconnect after a refused token")
    }

    func testDropReconnectsAndAuthsAgain() async throws {
        let k = FakeConnector()
        var events: [String] = []
        let s = make(k) { events.append($0) }
        s.start()
        await settle()
        k.opened[0].2.deliver(#"{"t":"hello"}"#)
        await settle()
        k.opened[0].2.serverClose(1006)
        await settle()
        XCTAssertEqual(k.opened.count, 2)
        let again = k.opened[1].2
        XCTAssertEqual(again.sent.first, #"{"t":"auth","token":"tok_abcdefghijklmnop"}"#)
        again.deliver(#"{"t":"hello"}"#)
        await settle()
        XCTAssertTrue(events.contains("reconnect"))
        XCTAssertFalse(events.contains("unauthorized"))
        s.stop()
    }

    func testByeThenCloseIsNotUnauthorized() async throws {
        let k = FakeConnector()
        var events: [String] = []
        let s = make(k) { events.append($0) }
        s.start()
        await settle()
        let c = k.opened[0].2
        c.deliver(#"{"t":"bye","reason":"revoked"}"#)
        await settle()
        c.serverClose(4401)
        await settle()
        XCTAssertTrue(events.contains { $0.contains("bye") })
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
        await settle()
        let c = k.opened[0].2
        XCTAssertTrue(c.sent.last?.contains("se_9") == true, "sent: \(c.sent)")
        s.stop()
    }

    func testASocketThatDoesNotAnswerAPingIsDroppedAndOpenedAgain() async throws {
        // QA PQ-09: back from the background, a socket that still looks open must prove it
        let k = FakeConnector()
        var events: [String] = []
        let s = make(k) { events.append($0) }
        var release: CheckedContinuation<Void, Never>?
        s.pongWait = { _ in await withCheckedContinuation { release = $0 } }
        s.start()
        await settle()
        k.opened[0].2.deliver(#"{"t":"hello"}"#)
        await settle()
        s.kick()
        await settle()
        XCTAssertTrue(k.opened[0].2.sent.contains(#"{"t":"ping"}"#))
        release?.resume()
        await settle()
        XCTAssertEqual(k.opened.count, 2, "no pong: a new socket")
        XCTAssertTrue(events.contains("up:false"))
        // one that answers stays
        k.opened[1].2.deliver(#"{"t":"hello"}"#)
        await settle()
        s.kick()
        await settle()
        k.opened[1].2.deliver(#"{"t":"pong"}"#)
        await settle()
        release?.resume()
        await settle()
        XCTAssertEqual(k.opened.count, 2)
        s.stop()
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
