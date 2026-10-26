import XCTest
@testable import Principia

/// The board on the phone (REMOTE.md RA3, read only): routes and decoding of what the Mac sends.
final class BoardTests: XCTestCase {
    let target = APITarget(mac: "https://quiet-tree-42.trycloudflare.com", site: "https://principia-phone.vibiz.dev", token: "tok_abcdefghijklmnop")

    func testRoutesAreReadOnlyAndScoped() {
        XCTAssertEqual(Route.tasks("co_a").path, "/api/c/co_a/tasks")
        XCTAssertEqual(Route.tasks("co_a").method, "GET")
        XCTAssertEqual(Route.task("co_a", taskId: "ta/1").path, "/api/c/co_a/tasks/ta%2F1")
        XCTAssertEqual(Route.task("co_a", taskId: "ta_1").method, "GET")
    }

    func testDecodesTheBoardAndATask() async throws {
        let board = #"""
        {"companyId":"co_a","more":2,
         "planned":[{"id":"ta_1","identifier":"NW-1","title":"Price list","status":"blocked","column":"planned","who":null,"agentId":null,"line":"Waits for another task","priority":1,"at":"2026-10-25T10:00:00.000Z"}],
         "working":[{"id":"ta_2","identifier":"NW-2","title":"Spring menu","status":"in_progress","column":"working","who":{"name":"Livia","role":"Copywriter","bust":"Livia"},"agentId":"ag_a","line":"Editing the menu","priority":0,"at":"2026-10-25T10:00:00.000Z"}],
         "needs":[],"done":[]}
        """#
        let detail = #"""
        {"id":"ta_3","identifier":"NW-3","title":"Instagram week","status":"in_review","column":"needs","who":null,"agentId":"ag_a","line":"Ready for your OK","priority":0,"at":"2026-10-25T10:00:00.000Z",
         "description":"Seven posts.","summary":"All drafted.","doneNote":null,"createdAt":"2026-10-24T10:00:00.000Z","updatedAt":"2026-10-25T10:00:00.000Z",
         "need":{"taskId":"ta_3","kind":"review","title":"Instagram week","text":"All drafted.","who":null,"agentId":"ag_a","at":"2026-10-25T10:00:00.000Z","options":[]}}
        """#
        let t = FakeTransport { req in (200, req.url!.path.hasSuffix("/tasks") ? board : detail) }
        let api = APIClient(transport: t, target: target)
        let b = try await api.tasks("co_a")
        XCTAssertEqual(b.planned.first?.column, .planned)
        XCTAssertEqual(b.working.first?.who?.name, "Livia")
        XCTAssertEqual(b.working.first?.line, "Editing the menu")
        XCTAssertEqual(b.more, 2)
        let d = try await api.task("co_a", "ta_3")
        XCTAssertEqual(d.need?.kind, .review)
        XCTAssertEqual(d.summary, "All drafted.")
        XCTAssertNil(d.doneNote)
        XCTAssertEqual(PhoneTaskDetail.statusWords(d.status), "Waiting for your OK")
        XCTAssertEqual(t.requests.map(\.httpMethod), ["GET", "GET"])
        XCTAssertEqual(t.requests.last?.value(forHTTPHeaderField: "Authorization"), "Bearer tok_abcdefghijklmnop")
    }
}
