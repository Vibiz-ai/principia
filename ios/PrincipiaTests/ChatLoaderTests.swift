import XCTest
@testable import Principia

/// Opening a chat while it streams (QA PQ-02, PQ-06): nothing lost between the snapshot and the subscription, and no
/// older snapshot landing over a newer one.
@MainActor
final class ChatLoaderTests: XCTestCase {
    private func json(_ s: String) -> JSONValue { try! JSONDecoder().decode(JSONValue.self, from: Data(s.utf8)) }
    private func snap(_ items: String = "[]", seq: Int) -> ChatReplica {
        ChatReplica(try! JSONDecoder().decode(ChatSnapshot.self, from: Data(#"{"sessionId":"se_1","mode":"chat","available":true,"turn":"working","activity":null,"turnStartedAt":null,"items":\#(items),"queue":[],"meta":{},"seq":\#(seq),"note":null}"#.utf8)))
    }
    /// a gate a fake fetch waits on. On the main actor like the rest of the test: a plain async method would run off
    /// it, and a go() landing between wait()'s check and its continuation would leave the fetch stuck for good.
    @MainActor
    final class Gate {
        private var c: CheckedContinuation<Void, Never>?
        private var open = false
        var waiting: Bool { c != nil }
        func wait() async { if open { return }; await withCheckedContinuation { c = $0 } }
        func go() { open = true; c?.resume(); c = nil }
    }

    struct TimedOut: Error {}

    /// Waits for what the last step set off, as LiveSocketTests does: no fixed number of yields is sure to be enough.
    /// A timeout ends the test, so a fetch that never starts fails it, not the run.
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

    func testOpsWhileLoadingGoOnTopOfTheSnapshot() async throws {
        let load = ChatLoader()
        let gate = Gate()
        var shown: ChatReplica?
        let t = Task { try await load.run("se_1", fetch: { await gate.wait(); return .chat(self.snap(#"[{"id":"t1","parent":null,"kind":"text","md":"draws its shapes","streaming":true}]"#, seq: 762)) }, put: { shown = $0 }) }
        // the fetch, not `loading`: the load starts by clearing what is held, a moment after `loading` turns on
        try await until("the fetch to go out") { gate.waiting }
        XCTAssertTrue(load.hold("se_1", seq: 762, ops: json(#"[{"op":"append","id":"t1","field":"md","text":" twice"}]"#).array!))
        XCTAssertTrue(load.hold("se_1", seq: 763, ops: json(#"[{"op":"append","id":"t1","field":"md","text":" from science"}]"#).array!))
        XCTAssertTrue(load.hold("se_1", seq: 764, ops: json(#"[{"op":"patch","id":"t1","set":{"streaming":false}},{"op":"state","turn":"idle"}]"#).array!))
        XCTAssertFalse(load.hold("se_2", seq: 1, ops: []))
        gate.go()
        try await t.value
        let r = try XCTUnwrap(shown)
        XCTAssertEqual(r.seq, 764)
        XCTAssertEqual(r.turnWords, "Your turn")
        XCTAssertEqual(ChatLines.build(r.items), [.say(id: "t1", text: "draws its shapes from science", streaming: false)])
        XCTAssertFalse(load.hold("se_1", seq: 765, ops: []), "loaded: ops apply as usual")
    }

    func testAnAckAheadOfTheSnapshotFetchesOnceMore() async throws {
        let load = ChatLoader()
        let gate = Gate()
        var fetches = 0
        let t = Task {
            try await load.run("se_1", fetch: {
                fetches += 1
                if fetches == 1 { await gate.wait(); return .chat(self.snap(seq: 762)) }
                return .chat(self.snap(seq: 764))
            }, put: { _ in })
        }
        try await until("the fetch to go out") { gate.waiting }
        XCTAssertTrue(load.acked("se_1", seq: 764))
        gate.go()
        try await t.value
        XCTAssertEqual(fetches, 2)
    }

    func testAsksWhileOneIsOutRunOnceMoreAfterNeverInParallel() async throws {
        let load = ChatLoader()
        let gates = [Gate(), Gate()]
        var fetches = 0
        var inFlight = 0
        var most = 0
        var seqs: [Int] = []
        var asked = 0
        let f: () async throws -> ChatLoader.Fetched = {
            inFlight += 1
            most = max(most, inFlight)
            await gates[fetches].wait()
            fetches += 1
            inFlight -= 1
            return .chat(self.snap(seq: 10 + fetches))
        }
        // run() is on the main actor too, so a counted ask has reached its first wait before anything else runs
        let ask = { Task { asked += 1; try await load.run("se_1", fetch: f, put: { seqs.append($0.seq) }) } }
        let a = ask()
        try await until("the first fetch to go out") { gates[0].waiting }
        let b = ask()
        let c = ask()
        try await until("all three asks, got \(asked)") { asked == 3 }
        gates[0].go()
        try await until("the second fetch to go out") { gates[1].waiting }
        gates[1].go()
        try await a.value; try await b.value; try await c.value
        XCTAssertEqual(fetches, 2)
        XCTAssertEqual(most, 1)
        XCTAssertEqual(seqs, [11, 12], "the newest snapshot lands last")
    }

    func testStaleFetchPutsNothing() async throws {
        let load = ChatLoader()
        var put = false
        try await load.run("se_1", fetch: { .stale }, put: { _ in put = true })
        XCTAssertFalse(put)
        XCTAssertNil(load.loading)
    }

    func testSubbedDecodesAndWriteAsksToCreate() {
        XCTAssertEqual(PhoneServerMsg.decode(#"{"t":"subbed","sessionId":"se_1","seq":764}"#), .subbed(sessionId: "se_1", seq: 764))
        XCTAssertEqual(PhoneServerMsg.decode(#"{"t":"subbed","sessionId":null,"seq":0}"#), .subbed(sessionId: nil, seq: 0))
        XCTAssertEqual(ChatLines.permissionTitle("Write", json(#"{"file_path":"/x/qa-chat.txt"}"#)), "Create qa-chat.txt?")
        XCTAssertEqual(ChatLines.permissionTitle("Edit", json(#"{"file_path":"/x/a.ts"}"#)), "Change a.ts?")
    }
}
