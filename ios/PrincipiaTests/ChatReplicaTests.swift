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
        // CHAT-UI.md §8: a task card the Mac patched replaces itself where it is
        var card = m("x", nil)
        card.task = PhoneTaskCard(identifier: "VO-9", title: "Lift UGC conversion", state: "done", label: "Done", result: "Rewrote the hero", prUrl: nil, startedAt: "", finishedAt: nil)
        XCTAssertEqual(AppModel.place(list, card).map { $0.task?.label ?? "" }, ["", "Done"])
    }

    func testWords() {
        XCTAssertEqual(Words.headline(working: 2, needs: 1, paused: false), "2 working · 1 needs you")
        XCTAssertEqual(Words.headline(working: 0, needs: 0, paused: false), "Quiet right now")
        XCTAssertEqual(Words.mentionQuery("hi @li"), "li")
        XCTAssertNil(Words.mentionQuery("hi there"))
        XCTAssertEqual(Words.insertMention("hi @li", handle: "livia"), "hi @livia ")
    }

    /// A terminal on the Mac: its transcript as the chat (mode "terminal"), what it asks, and Continue once it ended.
    func testTerminalSessionDecodesAsAChat() throws {
        let json = #"""
        {"ref":{"kind":"session","id":"se_t"},"title":"shop · Claude","who":null,
         "chat":{"sessionId":"se_t","mode":"terminal","available":false,"turn":"working","activity":"Running tests","turnStartedAt":null,
                 "items":[{"id":"u1","parent":null,"kind":"user","text":"Fix the footer","images":0,"state":"sent"}],"queue":[],"meta":{},"seq":0,"note":null,"startedAs":"terminal"},
         "terminal":{"activity":"Running tests","canReply":false,"ended":false,"canType":false,"held":"It is asking you something.","source":"transcript","screen":null,
                     "asks":[{"id":"ask_1","title":"Bash","question":"Run git push?","detail":null,"who":null,"options":[{"id":"allow","label":"Allow","kind":"allow"}],"text":false,"at":"2026-10-26T10:00:00.000Z","open":null}],
                     "canContinue":false}}
        """#
        let s = try JSONDecoder().decode(PhoneSession.self, from: Data(json.utf8))
        XCTAssertEqual(s.chat?.mode, "terminal")
        XCTAssertEqual(s.terminal?.canType, false)
        XCTAssertEqual(s.terminal?.asks?.first?.id, "ask_1")
        let r = ChatReplica(s.chat!)
        XCTAssertEqual(ChatLines.build(r.items), [.me(id: "u1", text: "Fix the footer", queued: false)])
        // an older Mac sends only the first three
        let old = try JSONDecoder().decode(PhoneSession.self, from: Data(#"{"ref":{"kind":"session","id":"se_t"},"title":"t","who":null,"chat":null,"terminal":{"activity":null,"canReply":true,"ended":false}}"#.utf8))
        XCTAssertNil(old.terminal?.canType)
    }

    /// A terminal opened before its transcript existed (no replica): the Mac's empty chat ops reload it.
    @MainActor
    func testTerminalWithNoTranscriptReloadsOnChatOps() throws {
        let s = try JSONDecoder().decode(PhoneSession.self, from: Data(#"{"ref":{"kind":"session","id":"se_t"},"title":"t","who":null,"chat":null,"terminal":{"activity":null,"canReply":false,"ended":false,"canType":true,"source":"screen","screen":"Reading"}}"#.utf8))
        XCTAssertTrue(AppModel.reloadsOnChat("se_t", replica: nil, session: s))
        XCTAssertFalse(AppModel.reloadsOnChat("se_other", replica: nil, session: s))
        XCTAssertFalse(AppModel.reloadsOnChat("se_t", replica: ChatReplica(snap("[]")), session: s))
        var chat = s
        chat.terminal = nil
        XCTAssertFalse(AppModel.reloadsOnChat("se_t", replica: nil, session: chat))
    }

    /// Its message box: held shows the reason with Send off; ended and a shell have none.
    func testTerminalComposer() {
        let t = PhoneSession.Terminal(activity: nil, canReply: false, ended: false, canType: true)
        XCTAssertEqual(t.composer(name: "Claude")?.placeholder, "Message Claude")
        var held = t
        held.canType = false
        held.held = "It is asking you something."
        XCTAssertEqual(held.composer(name: "Claude")?.placeholder, "It is asking you something.")
        XCTAssertEqual(held.composer(name: "Claude")?.held, true)
        var shell = t
        shell.canType = false
        XCTAssertNil(shell.composer(name: "Shell"))
        var ended = t
        ended.ended = true
        XCTAssertNil(ended.composer(name: "Claude"))
    }
}
