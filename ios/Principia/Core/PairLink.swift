import Foundation

/// The pairing link the Mac shows (docs/REMOTE.md RA6): `<site>/#mac=<the Mac's address>&code=<one-time code>`.
/// Both values live in the fragment. The app talks to the Mac as that site does: it names the site as its Origin, so the
/// Mac hands it a bearer token, and it keeps the token in the Keychain.
struct PairLink: Equatable, Sendable {
    /// the phone app's origin the Mac accepts (`https://principia-phone.vibiz.dev`, or a loopback http one for testing)
    var site: String
    /// the Mac's origin (a quick tunnel, or loopback when testing)
    var mac: String
    /// 32 hex characters, one use, 5 minutes
    var code: String

    /// the official phone site (PHONE_SITE_URL), used when only the bare `#mac=…&code=…` part is pasted
    static let officialSite = "https://principia-phone.vibiz.dev"

    /// A scanned or pasted link (or its bare fragment, or `principia://pair#…`), else nil.
    static func parse(_ raw: String, defaultSite: String = officialSite) -> PairLink? {
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, text.count <= 2048, let hash = text.firstIndex(of: "#") else { return nil }
        let head = String(text[..<hash])
        let fragment = String(text[text.index(after: hash)...])
        var site = defaultSite
        if !head.isEmpty {
            if head.lowercased().hasPrefix("principia:") {
                // principia://pair?site=<the phone site's origin>#mac=…&code=… (the site defaults to the official one)
                let q = URLComponents(string: head)?.queryItems?.first { $0.name == "site" }?.value
                if let q { guard let o = siteOrigin(q) else { return nil }; site = o } else { site = defaultSite }
            } else {
                guard let o = siteOrigin(head) else { return nil }
                site = o
            }
        }
        guard let p = parseFragment(fragment) else { return nil }
        return PairLink(site: site, mac: p.mac, code: p.code)
    }

    /// `mac=…&code=…` (a leading `#` or `/` is fine) -> the Mac's origin and the code.
    static func parseFragment(_ fragment: String) -> (mac: String, code: String)? {
        var f = fragment
        while f.hasPrefix("#") || f.hasPrefix("/") { f.removeFirst() }
        var q: [String: String] = [:]
        for part in f.split(separator: "&") {
            let kv = part.split(separator: "=", maxSplits: 1).map(String.init)
            guard kv.count == 2, q[kv[0]] == nil else { continue }
            q[kv[0]] = kv[1].replacingOccurrences(of: "+", with: " ").removingPercentEncoding ?? kv[1]
        }
        guard let code = q["code"], code.range(of: "^[0-9a-f]{32}$", options: .regularExpression) != nil else { return nil }
        guard let macRaw = q["mac"], let mac = siteOrigin(macRaw) else { return nil }
        return (mac, code)
    }

    /// `https://x.example/any/path` -> `https://x.example`, or nil. https only, except loopback http (testing). No
    /// credentials, no odd host names (the same rule as the Mac's siteOrigin).
    static func siteOrigin(_ raw: String?) -> String? {
        guard let raw, !raw.trimmingCharacters(in: .whitespaces).isEmpty, raw.count <= 2048,
              let c = URLComponents(string: raw.trimmingCharacters(in: .whitespaces)),
              let scheme = c.scheme?.lowercased(), let host = c.host?.lowercased(), !host.isEmpty else { return nil }
        if c.user != nil || c.password != nil { return nil }
        let loopback = host == "127.0.0.1" || host == "localhost" || host == "[::1]" || host == "::1"
        guard host.range(of: "^[a-z0-9.-]+$", options: .regularExpression) != nil || loopback else { return nil }
        guard scheme == "https" || (scheme == "http" && loopback) else { return nil }
        let defaultPort = scheme == "https" ? 443 : 80
        let port = c.port.flatMap { $0 == defaultPort ? nil : $0 }
        return "\(scheme)://\(host)\(port.map { ":\($0)" } ?? "")"
    }

    /// "quiet-tree-42.trycloudflare.com" for the screens
    static func host(_ origin: String?) -> String {
        guard let origin, let c = URLComponents(string: origin), let h = c.host else { return "" }
        return c.port.map { "\(h):\($0)" } ?? h
    }
}
