import XCTest
@testable import Principia

/// Records requests and answers from a script.
final class FakeTransport: HTTPTransport, @unchecked Sendable {
    var requests: [URLRequest] = []
    var answer: (URLRequest) throws -> (Int, String)
    init(_ answer: @escaping (URLRequest) throws -> (Int, String)) { self.answer = answer }
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        requests.append(request)
        let (status, body) = try answer(request)
        return (Data(body.utf8), HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!)
    }
}

final class APIClientTests: XCTestCase {
    let target = APITarget(mac: "https://quiet-tree-42.trycloudflare.com", site: "https://principia-phone.vibiz.dev", token: "tok_abcdefghijklmnop")

    func testPairSendsTheSiteAsOriginAndNoBearer() async throws {
        let t = FakeTransport { _ in (200, #"{"device":{"id":"dev_1","name":"iPhone"},"token":"tok_new_abcdefghijk"}"#) }
        let api = APIClient(transport: t, target: APITarget(mac: target.mac, site: target.site, token: nil))
        let r = try await api.pair(code: String(repeating: "a", count: 32), name: "iPhone")
        XCTAssertEqual(r.token, "tok_new_abcdefghijk")
        let req = try XCTUnwrap(t.requests.first)
        XCTAssertEqual(req.url?.absoluteString, "https://quiet-tree-42.trycloudflare.com/api/pair")
        XCTAssertEqual(req.httpMethod, "POST")
        XCTAssertEqual(req.value(forHTTPHeaderField: "Origin"), "https://principia-phone.vibiz.dev")
        XCTAssertNil(req.value(forHTTPHeaderField: "Authorization"))
        XCTAssertEqual(req.value(forHTTPHeaderField: "Content-Type"), "application/json")
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: req.httpBody ?? Data()) as? [String: String])
        XCTAssertEqual(body, ["code": String(repeating: "a", count: 32), "name": "iPhone"])
    }

    func testEveryCallCarriesTheBearerInAHeaderNeverTheURL() async throws {
        let t = FakeTransport { _ in (200, #"{"device":{"id":"d","name":"n"},"csrf":"x","host":"mac","companies":[{"id":"co_a","name":"Café","personal":false,"paused":false,"working":2,"needs":1}]}"#) }
        let api = APIClient(transport: t, target: target)
        let me = try await api.me()
        XCTAssertEqual(me.companies.first?.name, "Café")
        let req = try XCTUnwrap(t.requests.first)
        XCTAssertEqual(req.value(forHTTPHeaderField: "Authorization"), "Bearer tok_abcdefghijklmnop")
        XCTAssertFalse(req.url!.absoluteString.contains("tok_"))
        XCTAssertFalse(req.httpShouldHandleCookies)
    }

    func testRoutesEncodeIdsAndBodies() async throws {
        let t = FakeTransport { _ in (200, #"{"ok":true}"#) }
        let api = APIClient(transport: t, target: target)
        try await api.sessionAnswer("co_a", "se/1", requestId: "r1", decision: .deny(message: "no"))
        let req = try XCTUnwrap(t.requests.last)
        XCTAssertEqual(req.url?.path(percentEncoded: true), "/api/c/co_a/sessions/se%2F1/answer")
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: req.httpBody!) as? [String: Any])
        XCTAssertEqual(body["requestId"] as? String, "r1")
        XCTAssertEqual((body["decision"] as? [String: String]), ["kind": "deny", "message": "no"])
        XCTAssertEqual(Route.room("co_a", channelId: "ch_1").path, "/api/c/co_a/room?channelId=ch_1")
        XCTAssertEqual(Route.cancelTask("co_a", taskId: "ta_1").path, "/api/c/co_a/tasks/ta_1/cancel")
        XCTAssertEqual(Route.sessionContinue("co_a", sessionId: "se_1").path, "/api/c/co_a/sessions/se_1/continue")
        XCTAssertEqual(Route.sessionContinue("co_a", sessionId: "se_1").method, "POST")
        XCTAssertEqual(Route.now("co_a").method, "GET")
        XCTAssertEqual(Route.pause("co_a").method, "POST")
    }

    func testNewChatPostsTheTextAndTheAgentAndReturnsTheSession() async throws {
        let t = FakeTransport { _ in (200, #"{"sessionId":"se_new"}"#) }
        let api = APIClient(transport: t, target: target)
        let plain = try await api.newChat("co_a", text: "hi")
        XCTAssertEqual(plain, "se_new")
        var req = try XCTUnwrap(t.requests.last)
        XCTAssertEqual(req.httpMethod, "POST")
        XCTAssertEqual(req.url?.path(percentEncoded: true), "/api/c/co_a/chats/new")
        XCTAssertEqual(try XCTUnwrap(JSONSerialization.jsonObject(with: req.httpBody!) as? [String: String]), ["text": "hi"])
        _ = try await api.newChat("co_a", text: "hi", agentId: "ag_1")
        req = try XCTUnwrap(t.requests.last)
        XCTAssertEqual(try XCTUnwrap(JSONSerialization.jsonObject(with: req.httpBody!) as? [String: String]), ["text": "hi", "agentId": "ag_1"])
    }

    func testErrorsMeanWhatTheWebAppSays() async {
        func expect(_ status: Int, _ body: String, _ want: APIError) async {
            let api = APIClient(transport: FakeTransport { _ in (status, body) }, target: target)
            do {
                _ = try await api.now("co_a")
                XCTFail("expected \(want)")
            } catch {
                XCTAssertEqual(error as? APIError, want)
            }
        }
        await expect(401, #"{"message":"Open the pairing link"}"#, .notPaired)
        await expect(502, "<html>Bad gateway</html>", .macGone)
        await expect(409, #"{"message":"It is not waiting for your OK anymore"}"#, .server(status: 409, message: "It is not waiting for your OK anymore"))
        let offline = APIClient(transport: FakeTransport { _ in throw URLError(.cannotFindHost) }, target: target)
        do { _ = try await offline.me(); XCTFail() } catch { XCTAssertEqual(error as? APIError, .macGone) }
    }
}
