import XCTest
@testable import Principia

final class ChatReplicaTests: XCTestCase {
    private func json(_ s: String) -> JSONValue { try! JSONDecoder().decode(JSONValue.self, from: Data(s.utf8)) }
    private func snap(_ items: String = "[]", seq: Int = 1) -> ChatSnapshot {
        try! JSONDecoder().decode(ChatSnapshot.self, from: Data(#"{"sessionId":"se_1","mode":"chat","available":true,"turn":"idle","activity":null,"turnStartedAt":null,"items":\#(items),"queue":[],"meta":{},"seq":\#(seq),"note":null}"#.utf8))
    }

    func testOpsInOrderAndGaps() {
        var r = ChatReplica(snap())
        let add = json(#"[{"op":"add","item":{"id":"t1","parent":null,"kind":"text","md":"Hel","streaming":true}},{"op":"state","turn":"working","activity":"Writing"}]"#).array!
        XCTAssertEqual(r.apply(seq: 2, ops: add), .ok)
        XCTAssertEqual(r.apply(seq: 3, ops: json(#"[{"op":"append","id":"t1","field":"md","text":"lo **you**"}]"#).array!), .ok)
        XCTAssertEqual(r.apply(seq: 3, ops: []), .old)
        XCTAssertEqual(r.apply(seq: 9, ops: []), .gap)
        XCTAssertTrue(r.busy)
        XCTAssertEqual(r.turnWords, "Writing")
        XCTAssertEqual(ChatLines.build(r.items), [.say(id: "t1", text: "Hello **you**", streaming: true)])
        XCTAssertEqual(r.apply(seq: 4, ops: json(#"[{"op":"patch","id":"t1","set":{"streaming":false}},{"op":"state","turn":"idle"}]"#).array!), .ok)
        XCTAssertEqual(ChatLines.build(r.items), [.say(id: "t1", text: "Hello **you**", streaming: false)])
        XCTAssertFalse(r.busy)
    }

    func testReplayDividersAreDropped() {
        let items = json(#"[{"id":"n1","parent":null,"kind":"notice","tone":"info","text":"From the terminal","action":null},{"id":"n2","parent":null,"kind":"notice","tone":"info","text":"Conversation compacted","action":null}]"#).array!
        XCTAssertEqual(ChatLines.build(items), [.notice(id: "n2", tone: "info", text: "Conversation compacted")])
    }

    func testToolsReadAsWordsAndReadsGroup() {
        let items = json(#"""
        [{"id":"a","parent":null,"kind":"tool","toolUseId":"tu_a","name":"Read","input":{"file_path":"/x/menu.md"},"status":"ok"},
         {"id":"b","parent":null,"kind":"tool","toolUseId":"tu_b","name":"Grep","input":{"pattern":"latte"},"status":"ok"},
         {"id":"c","parent":null,"kind":"tool","toolUseId":"tu_c","name":"Edit","input":{"file_path":"/x/menu.md"},"status":"running"},
         {"id":"p","parent":null,"kind":"permission","requestId":"r1","toolUseId":"tu_d","tool":"Bash","input":{"command":"npm test"},"description":null,"state":"open","outcome":null}]
        """#).array!
        let lines = ChatLines.build(items)
        XCTAssertEqual(lines.count, 3)
        XCTAssertEqual(lines[0], .tool(id: "g:a", text: "Read 1 file, searched 1 time", code: "", state: .ok, sub: 0))
        XCTAssertEqual(lines[1], .tool(id: "c", text: "Editing", code: "menu.md", state: .run, sub: 0))
        XCTAssertEqual(lines[2], .permission(id: "p", requestId: "r1", title: "Run a command?", detail: "npm test", open: true, outcome: nil))
    }

    func testRoomPlacement() {
        func m(_ id: String, _ thread: String?) -> PhoneRoomMessage { .init(id: id, seq: 0, channelId: "ch", threadId: thread, authorId: "a", kind: "text", text: id, at: "") }
        let list = [m("r", nil), m("x", nil)]
        XCTAssertEqual(AppModel.place(list, m("reply", "r")).map(\.id), ["r", "reply", "x"])
        XCTAssertEqual(AppModel.place(list, m("y", nil)).map(\.id), ["r", "x", "y"])
        XCTAssertEqual(AppModel.place(list, m("x", nil)).map(\.id), ["r", "x"])
    }

    func testWords() {
        XCTAssertEqual(Words.headline(working: 2, needs: 1, paused: false), "2 working · 1 needs you")
        XCTAssertEqual(Words.headline(working: 0, needs: 0, paused: false), "Quiet right now")
        XCTAssertEqual(Words.mentionQuery("hi @li"), "li")
        XCTAssertNil(Words.mentionQuery("hi there"))
        XCTAssertEqual(Words.insertMention("hi @li", handle: "livia"), "hi @livia ")
    }
}
