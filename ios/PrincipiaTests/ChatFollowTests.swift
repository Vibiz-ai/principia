import XCTest
@testable import Principia

/// A chat back from the background showed nothing until the reader swiped (QA PQ-20): the conversation lays out the
/// rows it shows (a long one pages), only the reader's own scroll up stops it following, and every snapshot that lands
/// settles it at the newest message again.
@MainActor
final class ChatFollowTests: XCTestCase {
    /// A long chat shows its newest page; "Show earlier messages" adds a page above; a chat followed at its end drops
    /// what scrolled far off the top; a row that is gone (a new snapshot) falls back to the newest page.
    func testALongChatShowsItsNewestPage() {
        let ids = (0..<300).map { "r\($0)" }
        let p = ChatFollow.page
        XCTAssertEqual(ChatFollow.start(ids: ids, first: nil), 300 - p)
        XCTAssertEqual(ChatFollow.start(ids: Array(ids.prefix(30)), first: nil), 0, "a short chat shows all of it")
        let more = ChatFollow.earlier(300 - p)
        XCTAssertEqual(more, 300 - 2 * p)
        XCTAssertEqual(ChatFollow.start(ids: ids, first: ids[more]), more)
        XCTAssertEqual(ChatFollow.earlier(10), 0)
        XCTAssertEqual(ChatFollow.start(ids: ids, first: "gone"), 300 - p)
        XCTAssertNil(ChatFollow.trim(ids: ids, from: 300 - p))
        XCTAssertNil(ChatFollow.trim(ids: ids, from: 300 - 2 * p))
        XCTAssertEqual(ChatFollow.trim(ids: ids, from: 0), ids[300 - p])
    }

    func testTheEndIsWithinSlack() {
        XCTAssertTrue(ChatFollow.Spot(offset: 0, gap: 0).atEnd)
        XCTAssertTrue(ChatFollow.Spot(offset: 0, gap: -30).atEnd, "a bounce past the end")
        XCTAssertTrue(ChatFollow.Spot(offset: 0, gap: ChatFollow.slack).atEnd)
        XCTAssertFalse(ChatFollow.Spot(offset: 0, gap: 400).atEnd)
        XCTAssertEqual(ChatFollow.settle.first, 0)
        XCTAssertEqual(ChatFollow.settle, ChatFollow.settle.sorted())
    }

    /// Touching a chat at its end while a reply streams (a flick, a bounce) must not stop it following; scrolling up to
    /// read does, and coming back to the end follows again.
    func testOnlyTheReadersScrollUpStopsFollowing() {
        XCTAssertTrue(ChatFollow.afterScroll(pinned: true, atEnd: false, movedUp: false), "the reply grew under a flick")
        XCTAssertFalse(ChatFollow.afterScroll(pinned: true, atEnd: false, movedUp: true), "scrolled up to read")
        XCTAssertFalse(ChatFollow.afterScroll(pinned: false, atEnd: false, movedUp: false), "still reading further up")
        XCTAssertTrue(ChatFollow.afterScroll(pinned: false, atEnd: true, movedUp: false), "back at the end")
        XCTAssertTrue(ChatFollow.afterScroll(pinned: false, atEnd: true, movedUp: true))
    }

    /// Each snapshot of the open chat, the first and every reload after it (foreground, a gap), bumps snapshotTick:
    /// the scroll settles again on each one, not only when the screen first appears.
    func testEveryReloadOfTheOpenChatBumpsTheSnapshotTick() async throws {
        var turn = "working"
        var items = #"[{"id":"u1","parent":null,"kind":"user","text":"Write 45 lines"},{"id":"t1","parent":null,"kind":"text","md":"1. One","streaming":true}]"#
        let t = FakeTransport { req in
            let u = req.url!.absoluteString
            if u.hasSuffix("/sessions/se_long") {
                return (200, #"{"ref":{"kind":"session","id":"se_long"},"title":"QA chat","who":null,"chat":{"sessionId":"se_long","mode":"chat","available":true,"turn":"\#(turn)","activity":null,"turnStartedAt":null,"items":\#(items),"queue":[],"meta":{},"seq":5,"note":null},"terminal":null}"#)
            }
            return (200, "{}")
        }
        let store = MemoryMacStore(nil)
        let app = AppModel(api: APIClient(transport: t, target: APITarget(mac: "http://127.0.0.1:1", site: "http://127.0.0.1:2", token: "tok_abcdefghijklmnop")), store: store, connector: FakeConnector())
        let ref = PhoneChatRef(kind: .session, id: "se_long")
        app.companyId = "co_1"
        app.tab = .chats
        app.chatPath = [ref]

        await app.load(ref)
        XCTAssertEqual(app.snapshotTick, 1)
        XCTAssertEqual(app.replica?.busy, true)

        // the turn finished while the phone was in the background: the reload on foreground replaces the replica
        turn = "idle"
        items = #"[{"id":"u1","parent":null,"kind":"user","text":"Write 45 lines"},{"id":"t1","parent":null,"kind":"text","md":"1. One\n2. Two\n3. Three","streaming":false}]"#
        await app.reloadOpen()
        XCTAssertEqual(app.snapshotTick, 2)
        XCTAssertEqual(app.replica?.busy, false)

        // the same snapshot again still settles (its rows lay out anew)
        await app.reloadOpen()
        XCTAssertEqual(app.snapshotTick, 3)
    }
}
