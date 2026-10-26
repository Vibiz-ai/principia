import XCTest
@testable import Principia

final class PairLinkTests: XCTestCase {
    let code = String(repeating: "a1", count: 16)

    func testHostedLink() {
        let l = PairLink.parse("https://principia-phone.vibiz.dev/#mac=https%3A%2F%2Fquiet-tree-42.trycloudflare.com&code=\(code)")
        XCTAssertEqual(l, PairLink(site: "https://principia-phone.vibiz.dev", mac: "https://quiet-tree-42.trycloudflare.com", code: code))
    }

    func testLoopbackForTesting() {
        let l = PairLink.parse("http://127.0.0.1:5199/#mac=http%3A%2F%2F127.0.0.1%3A61234&code=\(code)")
        XCTAssertEqual(l?.site, "http://127.0.0.1:5199")
        XCTAssertEqual(l?.mac, "http://127.0.0.1:61234")
    }

    func testBareFragmentUsesTheOfficialSite() {
        let l = PairLink.parse("#mac=https%3A%2F%2Fa.trycloudflare.com&code=\(code)")
        XCTAssertEqual(l?.site, PairLink.officialSite)
        XCTAssertEqual(PairLink.parse("principia://pair#mac=https%3A%2F%2Fa.trycloudflare.com&code=\(code)")?.mac, "https://a.trycloudflare.com")
    }

    func testRefusesBadLinks() {
        // no code, a bad code, http to a non-loopback host, credentials, a same-origin #pair link (no Mac address)
        XCTAssertNil(PairLink.parse("https://site.example/#mac=https%3A%2F%2Fa.example"))
        XCTAssertNil(PairLink.parse("https://site.example/#mac=https%3A%2F%2Fa.example&code=<script>"))
        XCTAssertNil(PairLink.parse("https://site.example/#mac=http%3A%2F%2Fevil.example&code=\(code)"))
        XCTAssertNil(PairLink.parse("http://site.example/#mac=https%3A%2F%2Fa.example&code=\(code)"))
        XCTAssertNil(PairLink.parse("https://site.example/#mac=https%3A%2F%2Fu%3Ap%40a.example&code=\(code)"))
        XCTAssertNil(PairLink.parse("https://a.example/#pair=\(code)"))
        XCTAssertNil(PairLink.parse("no link here"))
        XCTAssertNil(PairLink.parse(""))
    }

    func testSiteOrigin() {
        XCTAssertEqual(PairLink.siteOrigin("https://X.example/any/path?q=1"), "https://x.example")
        XCTAssertEqual(PairLink.siteOrigin("https://x.example:443"), "https://x.example")
        XCTAssertEqual(PairLink.siteOrigin("http://localhost:3000"), "http://localhost:3000")
        XCTAssertNil(PairLink.siteOrigin("ftp://x.example"))
        XCTAssertNil(PairLink.siteOrigin("javascript:alert(1)"))
        XCTAssertEqual(PairLink.host("https://quiet-tree-42.trycloudflare.com"), "quiet-tree-42.trycloudflare.com")
    }
}

final class PairLinkSchemeTests: XCTestCase {
    func testAppSchemeCarriesTheSite() {
        let code = String(repeating: "b", count: 32)
        let l = PairLink.parse("principia://pair?site=http%3A%2F%2F127.0.0.1%3A5199#mac=http%3A%2F%2F127.0.0.1%3A55109&code=\(code)")
        XCTAssertEqual(l, PairLink(site: "http://127.0.0.1:5199", mac: "http://127.0.0.1:55109", code: code))
        XCTAssertNil(PairLink.parse("principia://pair?site=http%3A%2F%2Fevil.example#mac=http%3A%2F%2F127.0.0.1%3A1&code=\(code)"))
    }
}
