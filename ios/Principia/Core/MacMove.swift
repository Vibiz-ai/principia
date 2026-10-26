import CryptoKit
import Foundation
import Security

/// Is the Mac there? (docs/REMOTE.md RA8). A quick tunnel that is gone answers from Cloudflare's edge, not from the Mac:
/// 530 (often error 1033, as an HTML page or, when asked for JSON, a JSON problem), or a 502/503/504 page; or its name
/// no longer resolves. All of that means "the Mac moved or is off", never a status code for the person to read.
enum MacReach {
    /// An HTTP answer that came from Cloudflare instead of the Mac.
    static func isGone(status: Int, body: Data) -> Bool {
        if status == 530 { return true }
        // a successful answer is the Mac's, whatever its text says (a task may quote "error code 1033")
        guard status >= 400 else { return false }
        let json = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any]
        if isTunnelError(body: body, json: json) { return true }
        guard status >= 500 else { return false }
        // the Mac's own errors are JSON with a message (and never a Cloudflare error code)
        if let json, json["message"] is String, json["error_code"] == nil, json["errorCode"] == nil { return false }
        return true
    }

    /// Cloudflare's "tunnel not found / not running" (error 1033), in its HTML page or its JSON problem.
    static func isTunnelError(body: Data, json: [String: Any]? = nil) -> Bool {
        let j = json ?? ((try? JSONSerialization.jsonObject(with: body)) as? [String: Any])
        for k in ["error_code", "errorCode", "code"] {
            if let n = j?[k] as? Int, n == 1033 { return true }
            if let s = j?[k] as? String, s == "1033" { return true }
        }
        let text = String(decoding: body.prefix(65_536), as: UTF8.self)
        return text.range(of: #"error[\s_-]*code["':\s]*1033\b"#, options: [.regularExpression, .caseInsensitive]) != nil
    }

    /// The phone itself has no internet: not the Mac's fault, and not a reason to ask for a new address.
    static func isNoInternet(_ error: Error) -> Bool {
        guard let u = error as? URLError else { return false }
        return [.notConnectedToInternet, .dataNotAllowed, .internationalRoamingOff, .callIsActive].contains(u.code)
    }

    /// A socket or call that could not reach the Mac's address at all: no such name (DNS), refused, timed out.
    static func isUnreachable(_ error: Error) -> Bool {
        guard let u = error as? URLError else { return false }
        return [.cannotFindHost, .dnsLookupFailed, .cannotConnectToHost, .timedOut, .badServerResponse, .secureConnectionFailed].contains(u.code)
    }
}

/// The Mac's new address after a restart, and the proof that it is this phone's Mac (docs/REMOTE.md RA8). Mirrors the
/// web phone app (`src/cloud/phone/mac.ts`, `macFromTyped` and `helloMessage` in `src/shared/remote.ts`).
enum MacMove {
    static let tunnelSuffix = ".trycloudflare.com"

    /// `principia-hello-v1|<origin, no trailing slash, lowercased>|<nonce>`
    static func helloMessage(origin: String, nonce: String) -> String {
        var o = origin
        while o.hasSuffix("/") { o.removeLast() }
        return "principia-hello-v1|\(o.lowercased())|\(nonce)"
    }

    static func sha256Hex(_ s: String) -> String {
        SHA256.hash(data: Data(s.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    /// The proof the real Mac gives at `origin`: hex HMAC-SHA256, keyed with sha256hex(token) (the Mac keeps only that).
    static func helloProof(token: String, origin: String, nonce: String) -> String {
        let key = SymmetricKey(data: Data(sha256Hex(token).utf8))
        let mac = HMAC<SHA256>.authenticationCode(for: Data(helloMessage(origin: origin, nonce: nonce).utf8), using: key)
        return mac.map { String(format: "%02x", $0) }.joined()
    }

    /// 24 random bytes, base64url without padding (32 characters), as the web app makes it.
    static func newNonce() -> String {
        var b = [UInt8](repeating: 0, count: 24)
        if SecRandomCopyBytes(kSecRandomDefault, b.count, &b) != errSecSuccess {
            var g = SystemRandomNumberGenerator()
            b = b.map { _ in UInt8.random(in: 0...255, using: &g) }
        }
        return Data(b).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }

    /// Compares every byte, whatever differs first.
    static func constantTimeEqual(_ a: String, _ b: String) -> Bool {
        let x = Array(a.utf8), y = Array(b.utf8)
        var diff = UInt8(x.count == y.count ? 0 : 1)
        for i in 0..<max(x.count, y.count) {
            diff |= (i < x.count ? x[i] : 0) ^ (i < y.count ? y[i] : 0)
        }
        return diff == 0
    }

    /// `#move=<mac>` (a leading `#` or `/` is fine) -> the Mac's origin, or nil.
    static func parseMoveFragment(_ fragment: String) -> String? {
        guard let v = PairLink.fragmentParams(fragment)["move"] else { return nil }
        return PairLink.siteOrigin(v)
    }

    /// `https://quiet-tree.trycloudflare.com` -> `quiet-tree` (what the Mac shows under Paired phones).
    static func tunnelWords(_ url: String?) -> String? {
        guard let o = PairLink.siteOrigin(url), let host = URLComponents(string: o)?.host, host.hasSuffix(tunnelSuffix) else { return nil }
        return String(host.dropLast(tunnelSuffix.count))
    }

    /// What the "new address" field accepts: the Mac's move link of this phone's site (`<site>/#move=…`, or just its
    /// `#move=…` part, or `principia://pair?site=<site>#move=…`), a Mac address (https), or the tunnel's words
    /// ("quiet tree forty two" / "quiet-tree-forty-two"). Returns the Mac's origin, or nil.
    static func macFromTyped(_ raw: String, site: String) -> String? {
        let t = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty, t.count <= 2048 else { return nil }
        if let hash = t.firstIndex(of: "#") {
            let head = String(t[..<hash])
            if !head.isEmpty {
                if head.lowercased().hasPrefix("principia:") {
                    // the site, when named, must be this phone's site (the default is the official one)
                    let q = URLComponents(string: head)?.queryItems?.first { $0.name == "site" }?.value
                    let named = q == nil ? PairLink.officialSite : PairLink.siteOrigin(q)
                    guard named == site else { return nil }
                } else {
                    guard PairLink.siteOrigin(head) == site, head.lowercased().hasPrefix("http") else { return nil }
                }
            }
            return parseMoveFragment(String(t[t.index(after: hash)...]))
        }
        if t.range(of: "^https?://", options: [.regularExpression, .caseInsensitive]) != nil { return PairLink.siteOrigin(t) }
        var w = t.lowercased()
        if let r = w.range(of: #"\.trycloudflare\.com/?$"#, options: .regularExpression) { w.removeSubrange(r) }
        w = w.replacingOccurrences(of: #"[\s_]+"#, with: "-", options: .regularExpression)
            .replacingOccurrences(of: "-+", with: "-", options: .regularExpression)
            .replacingOccurrences(of: "^-|-$", with: "", options: .regularExpression)
        guard w.count <= 63, w.range(of: "^[a-z0-9]+(-[a-z0-9]+){1,9}$", options: .regularExpression) != nil else { return nil }
        return "https://\(w)\(tunnelSuffix)"
    }

    enum Check: Equatable { case ok, unknown, wrong, gone }

    /// Is `mac` the Mac this phone is paired with? `POST /api/hello {device, nonce}` with no token; it must sign a fresh
    /// nonce bound to that very address with the token's hash. The token is never sent: a look-alike address learns
    /// nothing. ok: go there; unknown: that Mac does not know this phone (pair again); wrong: not our Mac; gone: nothing answers.
    static func check(transport: HTTPTransport, mac: String, site: String, deviceId: String, token: String, nonce: String = newNonce()) async -> Check {
        guard let origin = PairLink.siteOrigin(mac), !deviceId.isEmpty, let url = URL(string: origin + "/api/hello") else { return .wrong }
        var r = URLRequest(url: url)
        r.httpMethod = "POST"
        r.cachePolicy = .reloadIgnoringLocalCacheData
        r.httpShouldHandleCookies = false
        r.setValue("application/json", forHTTPHeaderField: "Accept")
        r.setValue("application/json", forHTTPHeaderField: "Content-Type")
        r.setValue(site, forHTTPHeaderField: "Origin")
        r.httpBody = try? JSONSerialization.data(withJSONObject: ["device": deviceId, "nonce": nonce], options: [.sortedKeys])
        let data: Data
        let res: HTTPURLResponse
        do {
            (data, res) = try await transport.send(r)
        } catch {
            return .gone
        }
        if MacReach.isGone(status: res.statusCode, body: data) { return .gone }
        guard let body = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            return res.statusCode >= 500 || res.statusCode == 404 ? .gone : .wrong
        }
        if res.statusCode == 404 { return .unknown }
        guard (200..<300).contains(res.statusCode), let proof = body["proof"] as? String else { return .wrong }
        return constantTimeEqual(proof.lowercased(), helloProof(token: token, origin: origin, nonce: nonce)) ? .ok : .wrong
    }
}
