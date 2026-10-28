import XCTest
@testable import Principia

/// Demo mode ("Try it without a Mac"): the sample company opens offline, shows real-looking data through the same API
/// and socket code as a paired Mac, streams a reply, and the way out lands on the pairing screen.
@MainActor
final class DemoModeTests: XCTestCase {
    /// the real seams, as fakes that record: demo mode must never reach them
    private func model() -> (AppModel, FakeTransport, FakeConnector, MemoryMacStore) {
        let t = FakeTransport { req in XCTFail("demo mode reached the network: \(req.url?.absoluteString ?? "")"); return (500, "") }
        let c = FakeConnector()
        let store = MemoryMacStore()
        return (AppModel(api: APIClient(transport: t), store: store, connector: c), t, c, store)
    }

    private func eventually(_ what: String, timeout: Double = 5, _ check: () -> Bool) async {
        let end = Date().addingTimeInterval(timeout)
        while !check() && Date() < end { try? await Task.sleep(nanoseconds: 20_000_000) }
        XCTAssertTrue(check(), what)
    }

    func testOpensOfflineWithTheSampleCompany() async throws {
        let (app, t, c, store) = model()
        await app.boot()
        XCTAssertEqual(app.phase, .out(.unpaired))
        await app.startDemo(pace: 0)
        XCTAssertTrue(app.inDemo)
        XCTAssertEqual(app.phase, .main)
        XCTAssertEqual(app.company?.name, "Northwind")
        XCTAssertFalse(try XCTUnwrap(app.now).working.isEmpty)
        XCTAssertEqual(app.needs?.count, 3)
        XCTAssertEqual(app.needs?.asks.first?.heading, "Run a command?")
        XCTAssertEqual(app.chats?.rows.count, 4)
        XCTAssertEqual(app.room?.enabled, true)
        XCTAssertFalse(app.room?.messages.isEmpty ?? true)
        await app.loadBoard()
        XCTAssertEqual(app.board?.working.count, 2)
        XCTAssertEqual(app.board?.needs.count, 2)
        await app.loadBoardTask("task-pricing")
        XCTAssertEqual(app.boardTask?.need?.kind, .review)
        await eventually("the demo socket says hello") { app.online }
        XCTAssertTrue(t.requests.isEmpty, "no request to a real Mac")
        XCTAssertTrue(c.opened.isEmpty, "no real socket")
        XCTAssertNil(store.value, "nothing saved to the Keychain")
        app.exitDemo()
    }

    func testAChatStreamsItsReplyAndFinishes() async throws {
        let (app, _, _, _) = model()
        await app.boot()
        await app.startDemo(pace: 0)
        let ref = PhoneChatRef(kind: .session, id: "demo-plan")
        app.openChat(ref)
        await app.load(ref)
        XCTAssertEqual(app.session?.title, "Plan this week")
        await app.demo?.settled()
        await eventually("the reply finished streaming") { app.replica?.turn == "idle" }
        let lines = ChatLines.build(app.replica?.items ?? [])
        let say = lines.compactMap { l -> (String, Bool)? in if case .say(_, let t, let s) = l { return (t, s) }; return nil }.last
        XCTAssertEqual(say?.1, false, "finished, not streaming")
        XCTAssertTrue(say?.0.contains("Ship Apple Pay at checkout") == true)
        XCTAssertTrue(lines.contains { if case .end(_, let t) = $0 { return t.hasPrefix("Done in") }; return false })

        // anything typed gets an honest, streamed answer
        let ok = await app.send("Can you also check shipping?")
        XCTAssertTrue(ok)
        await app.demo?.settled()
        await eventually("the answer streamed in") {
            ChatLines.build(app.replica?.items ?? []).contains { if case .say(_, let t, false) = $0 { return t.contains("demo company") }; return false }
        }
        app.exitDemo()
    }

    func testNeedsYouActionsChangeTheCompany() async throws {
        let (app, _, _, _) = model()
        await app.boot()
        await app.startDemo(pace: 0)
        let ask = try XCTUnwrap(app.needs?.asks.first)
        await app.answerAsk(ask, optionId: "allow", text: nil)
        XCTAssertEqual(app.needs?.count, 2)
        await app.approve("task-pricing")
        XCTAssertEqual(app.needs?.count, 1)
        await app.answerTask("task-shipping", text: "Sendle")
        XCTAssertEqual(app.needs?.count, 0)
        await app.demo?.settled()
        await app.refresh([.now])
        XCTAssertEqual(app.now?.needs, 0)
        app.exitDemo()
    }

    func testLeavingReturnsToPairingWithTheRealPlumbing() async throws {
        let (app, t, _, store) = model()
        await app.boot()
        await app.startDemo(pace: 0)
        app.showSettings = true
        app.exitDemo()
        XCTAssertFalse(app.inDemo)
        XCTAssertEqual(app.phase, .out(.unpaired))
        XCTAssertNil(app.paired)
        XCTAssertNil(app.me)
        XCTAssertNil(app.now)
        XCTAssertFalse(app.showSettings)
        XCTAssertTrue(app.api.transport is FakeTransport, "the real API is back")
        XCTAssertNil(store.value)
        XCTAssertTrue(t.requests.isEmpty)
        // Disconnect and Sign out inside the demo leave it the same way
        await app.startDemo(pace: 0)
        app.forget()
        XCTAssertEqual(app.phase, .out(.unpaired))
        XCTAssertFalse(app.inDemo)
        await app.startDemo(pace: 0)
        await app.signOut()
        XCTAssertFalse(app.inDemo)
        XCTAssertTrue(t.requests.isEmpty)
    }

    func testEveryRouteAnswersInTheShapeTheAppReads() async throws {
        let mac = DemoMac(pace: 0)
        let api = APIClient(transport: DemoTransport(mac: mac), target: APITarget(mac: DemoMac.address, site: DemoMac.site, token: DemoMac.token))
        let co = DemoMac.companyId
        let me = try await api.me()
        XCTAssertEqual(me.companies.map(\.id), [co, DemoMac.personalId])
        _ = try await api.now(co)
        _ = try await api.needs(co)
        let board = try await api.tasks(co)
        for r in board.planned + board.working + board.needs + board.done { _ = try await api.task(co, r.id) }
        for r in try await api.chats(co).rows {
            let s = try await api.session(co, r.ref.id)
            XCTAssertNotNil(s.chat)
            XCTAssertFalse(ChatLines.build(s.chat?.items ?? []).isEmpty)
        }
        let agent = try await api.agent(co, "agent-cicero")
        XCTAssertEqual(agent.chatSessionId, "demo-launch")
        let room = try await api.room(co, channelId: "general")
        let posted = try await api.roomPost(co, channelId: "general", text: "Hello team")
        XCTAssertEqual(posted.text, "Hello team")
        let after = try await api.room(co, channelId: "general")
        XCTAssertTrue(after.messages.contains { $0.id == posted.id }, "the post is in the room")
        XCTAssertTrue(after.messages.count > room.messages.count)
        let paused = try await api.setPaused(co, true)
        XCTAssertTrue(paused.paused)
        XCTAssertTrue(paused.working.isEmpty)
        do {
            _ = try await api.session(co, "nope")
            XCTFail("an unknown chat is a 404 in words")
        } catch APIError.server(404, let m) {
            XCTAssertFalse(m.isEmpty)
        }
        await mac.settled()
    }

    func testNewChatStartsAndOpensIt() async throws {
        let (app, _, _, _) = model()
        await app.boot()
        await app.startDemo(pace: 0)
        XCTAssertEqual(app.chats?.team?.count, 4, "the agents a New chat can be with")
        let ok = await app.newChat("  Draft a thank-you note  ", agentId: nil)
        XCTAssertTrue(ok)
        let ref = try XCTUnwrap(app.chatPath.last)
        XCTAssertEqual(ref.kind, .session)
        XCTAssertEqual(app.chats?.rows.count, 5)
        XCTAssertTrue(app.chats?.rows.contains { $0.ref == ref && $0.title == "Draft a thank-you note" } ?? false)
        await app.load(ref)
        await app.demo?.settled()
        await eventually("the reply finished streaming") { app.replica?.turn == "idle" }
        // with an agent: its own chat
        let withAgent = await app.newChat("hi", agentId: "agent-cicero")
        XCTAssertTrue(withAgent)
        XCTAssertEqual(app.chatPath.last, PhoneChatRef(kind: .session, id: "demo-launch"))
        // empty or another company's: nothing starts
        let api = APIClient(transport: DemoTransport(mac: DemoMac(pace: 0)), target: APITarget(mac: DemoMac.address, site: DemoMac.site, token: DemoMac.token))
        do { _ = try await api.newChat(DemoMac.companyId, text: "  "); XCTFail() } catch APIError.server(400, _) {}
        do { _ = try await api.newChat(DemoMac.companyId, text: "hi", agentId: "nope"); XCTFail() } catch APIError.server(404, _) {}
        await app.demo?.settled()
    }

    func testChunksKeepEveryWord() {
        let s = "one two three four five six seven"
        XCTAssertEqual(DemoMac.chunks(s, count: 3).joined(), s)
        XCTAssertEqual(DemoMac.chunks("single", count: 8), ["single"])
    }
}
