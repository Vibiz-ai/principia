import XCTest
@testable import Principia

/// RA8: the Mac's new address after a restart (docs/REMOTE.md). Mirrors src/main/remote/persist.test.ts.
final class MacMoveTests: XCTestCase {
    let site = "https://principia-phone.vibiz.dev"
    let mac = "https://quiet-tree-forty-two.trycloudflare.com"
    let target = APITarget(mac: "https://old-words-here.trycloudflare.com", site: "https://principia-phone.vibiz.dev", token: "tok_abcdefghijklmnop")

    // ---------- "the Mac moved or is off", never a status code ----------

    func testCloudflareAnswersMeanTheMacIsGone() async {
        let html1033 = "<!DOCTYPE html><html><head><title>Cloudflare Tunnel error | trycloudflare.com | Cloudflare</title></head><body><span>Error</span> <span>1033</span> ... Error code: 1033</body></html>"
        let json1033 = #"{"type":"https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-1xxx-errors/error-1033/","title":"Error 1033: Cloudflare Tunnel error","status":530,"detail":"The tunnel is not connected","error_code":1033}"#
        XCTAssertTrue(MacReach.isGone(status: 530, body: Data(html1033.utf8)))
        XCTAssertTrue(MacReach.isGone(status: 530, body: Data(json1033.utf8)))
        XCTAssertTrue(MacReach.isGone(status: 530, body: Data()))
        XCTAssertTrue(MacReach.isGone(status: 502, body: Data(json1033.utf8)))
        XCTAssertTrue(MacReach.isGone(status: 502, body: Data("<html>Bad gateway</html>".utf8)))
        XCTAssertTrue(MacReach.isGone(status: 503, body: Data("<html>cloudflare</html>".utf8)))
        XCTAssertTrue(MacReach.isGone(status: 504, body: Data()))
        XCTAssertTrue(MacReach.isTunnelError(body: Data(html1033.utf8)))
        // the Mac's own answers are not
        XCTAssertFalse(MacReach.isGone(status: 500, body: Data(#"{"message":"Something broke on your Mac"}"#.utf8)))
        XCTAssertFalse(MacReach.isGone(status: 409, body: Data(#"{"message":"It is not waiting for your OK anymore"}"#.utf8)))
        XCTAssertFalse(MacReach.isGone(status: 200, body: Data(#"{"ok":true}"#.utf8)))
        // a successful answer that only quotes Cloudflare's words (a task, a chat line) is still the Mac's
        XCTAssertFalse(MacReach.isGone(status: 200, body: Data(#"{"title":"Fix the tunnel: Error code: 1033","error_code":1033}"#.utf8)))
        XCTAssertFalse(MacReach.isGone(status: 204, body: Data(html1033.utf8)))

        for (status, body) in [(530, json1033), (530, html1033), (502, html1033)] {
            let api = APIClient(transport: FakeTransport { _ in (status, body) }, target: target)
            do { _ = try await api.me(); XCTFail() } catch {
                XCTAssertEqual(error as? APIError, .macGone)
                XCTAssertFalse((error as? APIError)?.errorDescription?.contains("530") ?? true)
            }
        }
        // a status the Mac sends without a message: plain words, no number
        let odd = APIClient(transport: FakeTransport { _ in (418, "") }, target: target)
        do { _ = try await odd.me(); XCTFail() } catch {
            guard case .server(_, let m)? = error as? APIError else { return XCTFail() }
            XCTAssertFalse(m.contains("418"))
        }
    }

    func testTransportFailures() async {
        for code in [URLError.Code.cannotFindHost, .dnsLookupFailed, .cannotConnectToHost, .timedOut] {
            let api = APIClient(transport: FakeTransport { _ in throw URLError(code) }, target: target)
            do { _ = try await api.me(); XCTFail() } catch { XCTAssertEqual(error as? APIError, .macGone, "\(code)") }
            XCTAssertTrue(LiveSocket.looksGone(URLError(code), status: nil))
        }
        let offline = APIClient(transport: FakeTransport { _ in throw URLError(.notConnectedToInternet) }, target: target)
        do { _ = try await offline.me(); XCTFail() } catch { XCTAssertEqual(error as? APIError, .noInternet) }
        XCTAssertTrue(LiveSocket.looksGone(URLError(.badServerResponse), status: 530))
        XCTAssertFalse(LiveSocket.looksGone(URLError(.networkConnectionLost), status: nil))
    }

    // ---------- the words, the link ----------

    func testNewAddressFromWordsOrLinks() {
        let link = "\(site)/#move=\(mac.addingPercentEncoding(withAllowedCharacters: .alphanumerics)!)"
        XCTAssertEqual(MacMove.tunnelWords(mac), "quiet-tree-forty-two")
        XCTAssertNil(MacMove.tunnelWords("https://phone.example.com"))
        XCTAssertEqual(MacMove.parseMoveFragment("#move=" + mac), mac)
        XCTAssertEqual(MacMove.macFromTyped("quiet-tree-forty-two", site: site), mac)
        XCTAssertEqual(MacMove.macFromTyped("  Quiet Tree Forty Two ", site: site), mac)
        XCTAssertEqual(MacMove.macFromTyped("quiet_tree  forty-two", site: site), mac)
        XCTAssertEqual(MacMove.macFromTyped("quiet-tree-forty-two.trycloudflare.com", site: site), mac)
        XCTAssertEqual(MacMove.macFromTyped(link, site: site), mac)
        XCTAssertEqual(MacMove.macFromTyped("#move=" + mac, site: site), mac)
        XCTAssertEqual(MacMove.macFromTyped(mac, site: site), mac)
        XCTAssertEqual(MacMove.macFromTyped(mac + "/", site: site), mac)
        XCTAssertEqual(MacMove.macFromTyped("principia://pair?site=\(site.addingPercentEncoding(withAllowedCharacters: .alphanumerics)!)#move=\(mac)", site: site), mac)
        XCTAssertEqual(MacMove.macFromTyped("principia://pair#move=\(mac)", site: site), mac)
        // another site's link, plain http, junk, a pairing link
        XCTAssertNil(MacMove.macFromTyped("https://evil.example/#move=\(mac)", site: site))
        XCTAssertNil(MacMove.macFromTyped("principia://pair?site=https%3A%2F%2Fevil.example#move=\(mac)", site: site))
        XCTAssertNil(MacMove.macFromTyped("http://quiet-tree.example.com", site: site))
        XCTAssertNil(MacMove.macFromTyped("hello", site: site))
        XCTAssertNil(MacMove.macFromTyped("a/b/c", site: site))
        XCTAssertNil(MacMove.macFromTyped("\(site)/#mac=\(mac)&code=\(String(repeating: "a", count: 32))", site: site))
        XCTAssertNil(MacMove.macFromTyped("#move=http://evil.example", site: site))
    }

    // ---------- the hello proof ----------

    /// Fixture computed by the web app's helloProofFor (src/cloud/phone/mac.ts, WebCrypto) and the Mac's
    /// createHmac('sha256', sha256hex(token)) (src/main/remote/auth.ts): both give the same hex.
    func testHelloProofMatchesTheWebApp() {
        let token = "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0U1v"
        let nonce = String(repeating: "n", count: 32)
        XCTAssertEqual(MacMove.sha256Hex(token), "82ab4612e23cd296ef492436ba494f1709dce9f681d38d00897f4f74b6257cdc")
        XCTAssertEqual(MacMove.helloMessage(origin: "https://Quiet-Tree-Forty-Two.trycloudflare.com/", nonce: nonce),
                       "principia-hello-v1|https://quiet-tree-forty-two.trycloudflare.com|\(nonce)")
        XCTAssertEqual(MacMove.helloProof(token: token, origin: mac, nonce: nonce), "bd33ae43e485a590f3a670b60147b9d0a464602525b39aa23f02f7eeff277934")
        let n = MacMove.newNonce()
        XCTAssertNotNil(n.range(of: "^[A-Za-z0-9_-]{32}$", options: .regularExpression))
        XCTAssertNotEqual(n, MacMove.newNonce())
        XCTAssertTrue(MacMove.constantTimeEqual("abc", "abc"))
        XCTAssertFalse(MacMove.constantTimeEqual("abc", "abd"))
        XCTAssertFalse(MacMove.constantTimeEqual("abc", "abcd"))
    }

    func testHelloNeverSendsTheTokenAndChecksTheProof() async throws {
        let token = "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0U1v"
        func mac(proofFor signer: String?, at origin: String, status: Int = 200) -> FakeTransport {
            FakeTransport { req in
                let b = try JSONSerialization.jsonObject(with: req.httpBody!) as! [String: String]
                guard let signer else { return (status, #"{"message":"Not found"}"#) }
                return (status, #"{"proof":"\#(MacMove.helloProof(token: signer, origin: origin, nonce: b["nonce"]!))"}"#)
            }
        }
        let good = mac(proofFor: token, at: self.mac)
        let r = await MacMove.check(transport: good, mac: self.mac, site: site, deviceId: "dev_1", token: token)
        XCTAssertEqual(r, .ok)
        let req = try XCTUnwrap(good.requests.first)
        XCTAssertEqual(req.url?.absoluteString, "\(self.mac)/api/hello")
        XCTAssertEqual(req.httpMethod, "POST")
        XCTAssertEqual(req.value(forHTTPHeaderField: "Origin"), site)
        XCTAssertNil(req.value(forHTTPHeaderField: "Authorization"))
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: req.httpBody!) as? [String: String])
        XCTAssertEqual(body["device"], "dev_1")
        XCTAssertEqual(body["nonce"]?.count, 32)
        XCTAssertFalse(String(decoding: req.httpBody!, as: UTF8.self).contains(token))
        XCTAssertFalse(req.allHTTPHeaderFields!.values.contains { $0.contains(token) })

        // another phone's key, or a relay: the Mac signed another address
        let other = await MacMove.check(transport: mac(proofFor: "y" + String(repeating: "y", count: 42), at: self.mac), mac: self.mac, site: site, deviceId: "dev_1", token: token)
        XCTAssertEqual(other, .wrong)
        let relay = await MacMove.check(transport: mac(proofFor: token, at: "https://real-mac-words.trycloudflare.com"), mac: self.mac, site: site, deviceId: "dev_1", token: token)
        XCTAssertEqual(relay, .wrong)
        let unknown = await MacMove.check(transport: mac(proofFor: nil, at: self.mac, status: 404), mac: self.mac, site: site, deviceId: "dev_1", token: token)
        XCTAssertEqual(unknown, .unknown)
        let gone = await MacMove.check(transport: FakeTransport { _ in throw URLError(.cannotFindHost) }, mac: self.mac, site: site, deviceId: "dev_1", token: token)
        XCTAssertEqual(gone, .gone)
        let cf = await MacMove.check(transport: FakeTransport { _ in (530, #"{"error_code":1033,"status":530}"#) }, mac: self.mac, site: site, deviceId: "dev_1", token: token)
        XCTAssertEqual(cf, .gone)
        let page = await MacMove.check(transport: FakeTransport { _ in (200, "<html>hi</html>") }, mac: self.mac, site: site, deviceId: "dev_1", token: token)
        XCTAssertEqual(page, .wrong)
    }

    // ---------- the app: only a proven address is kept ----------

    @MainActor
    func testTheAppMovesOnlyAfterTheProof() async throws {
        let token = "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0U1v"
        let old = "https://old-words-here.trycloudflare.com"
        let store = MemoryMacStore(PairedMac(mac: old, site: site, token: token, deviceId: "dev_1", deviceName: "iPhone", pairedAt: Date()))
        var signFor = "https://somewhere-else.trycloudflare.com"
        let t = FakeTransport { req in
            let u = req.url!.absoluteString
            if u.hasPrefix(old) { return (530, "<html>error code: 1033</html>") }
            if u.hasSuffix("/api/hello") {
                let b = try JSONSerialization.jsonObject(with: req.httpBody!) as! [String: String]
                return (200, #"{"proof":"\#(MacMove.helloProof(token: token, origin: signFor, nonce: b["nonce"]!))"}"#)
            }
            if u.hasSuffix("/api/me") { return (200, #"{"device":{"id":"dev_1","name":"iPhone"},"host":"mac","companies":[]}"#) }
            return (200, "{}")
        }
        let app = AppModel(api: APIClient(transport: t), store: store, connector: FakeConnector())
        await app.boot()
        XCTAssertEqual(app.phase, .out(.gone))
        XCTAssertEqual(store.value?.token, token, "the token stays")

        // a look-alike: refused, nothing kept, the token never went there
        await app.move("quiet-tree-forty-two")
        XCTAssertEqual(store.value?.mac, old)
        XCTAssertNotNil(app.moveError)
        XCTAssertFalse(t.requests.contains { $0.url!.absoluteString.hasPrefix(mac) && $0.value(forHTTPHeaderField: "Authorization") != nil })

        // the real one
        signFor = mac
        await app.move("Quiet Tree Forty Two")
        XCTAssertEqual(store.value?.mac, mac)
        XCTAssertEqual(app.phase, .main)
        XCTAssertNil(app.moveError)
        let me = try XCTUnwrap(t.requests.last { $0.url!.absoluteString == "\(mac)/api/me" })
        XCTAssertEqual(me.value(forHTTPHeaderField: "Authorization"), "Bearer \(token)")
        app.forget()
    }
}
