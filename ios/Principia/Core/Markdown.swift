import Foundation

/// Agent markdown as native blocks (the same subset as the web phone app's markdown.ts): paragraphs, headings, lists,
/// task items, quotes, fenced code, rules and pipe tables, with inline **bold**, *italic*, `code`, ~~strike~~ and
/// links through AttributedString. A link is kept only for http(s) and mailto; anything else reads as its words.
/// Nothing here is ever HTML.
enum MarkdownBlock: Equatable, Sendable {
    enum Align: Equatable, Sendable { case leading, center, trailing }
    struct Item: Equatable, Sendable {
        /// nil: a plain item; true/false: a task item, done or open
        var checked: Bool?
        var text: AttributedString
    }
    case paragraph(AttributedString)
    case heading(level: Int, AttributedString)
    case list(ordered: Bool, start: Int, items: [Item])
    case quote([MarkdownBlock])
    case code(language: String?, String)
    case rule
    case table(header: [AttributedString], align: [Align], rows: [[AttributedString]])
}

enum Markdown {
    static func safeURL(_ url: URL?) -> URL? {
        guard let url, let s = url.scheme?.lowercased(), ["http", "https", "mailto"].contains(s) else { return nil }
        return url
    }

    /// One line of inline markdown. Half-written markers (a reply still streaming) stay as text.
    static func inline(_ s: String) -> AttributedString {
        let opts = AttributedString.MarkdownParsingOptions(allowsExtendedAttributes: false, interpretedSyntax: .inlineOnlyPreservingWhitespace, failurePolicy: .returnPartiallyParsedIfPossible)
        guard var a = try? AttributedString(markdown: s, options: opts) else { return AttributedString(s) }
        // only safe links survive; images (which inline parsing could name) never load anything here
        for run in a.runs where run.link != nil {
            if safeURL(run.link) == nil { a[run.range].link = nil }
        }
        for run in a.runs where run.imageURL != nil {
            a[run.range].imageURL = nil
        }
        return a
    }

    private static func match(_ re: String, _ s: String) -> [String]? {
        guard let r = try? NSRegularExpression(pattern: re), let m = r.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) else { return nil }
        return (0..<m.numberOfRanges).map { i in
            let rg = m.range(at: i)
            return rg.location == NSNotFound ? "" : String(s[Range(rg, in: s)!])
        }
    }
    private static func isTableRow(_ s: String) -> Bool { match(#"^\s*\|.*\|\s*$"#, s) != nil }
    private static func isTableSep(_ s: String) -> Bool { match(#"^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$"#, s) != nil }

    static func cells(_ row: String) -> [String] {
        var t = row.trimmingCharacters(in: .whitespaces)
        if t.hasPrefix("|") { t.removeFirst() }
        if t.hasSuffix("|") && !t.hasSuffix("\\|") { t.removeLast() }
        var out: [String] = []
        var cur = ""
        let it = Array(t)
        var i = 0
        while i < it.count {
            if it[i] == "\\", i + 1 < it.count, it[i + 1] == "|" { cur.append("|"); i += 2; continue }
            if it[i] == "|" { out.append(cur.trimmingCharacters(in: .whitespaces)); cur = "" } else { cur.append(it[i]) }
            i += 1
        }
        out.append(cur.trimmingCharacters(in: .whitespaces))
        return out
    }

    static func parse(_ src: String) -> [MarkdownBlock] {
        let lines = src.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n").components(separatedBy: "\n")
        var out: [MarkdownBlock] = []
        var para: [String] = []
        func endPara() {
            guard !para.isEmpty else { return }
            out.append(.paragraph(inline(para.map { $0.trimmingCharacters(in: .whitespaces) }.joined(separator: "\n"))))
            para = []
        }
        var i = 0
        while i < lines.count {
            let line = lines[i]
            if line.trimmingCharacters(in: .whitespaces).isEmpty { endPara(); i += 1; continue }
            if let f = match(#"^\s*(```|~~~)\s*([\w+-]*)\s*$"#, line) {
                endPara()
                var body: [String] = []
                i += 1
                while i < lines.count, lines[i].trimmingCharacters(in: .whitespaces) != f[1] { body.append(lines[i]); i += 1 }
                i += 1
                out.append(.code(language: f[2].isEmpty ? nil : f[2], body.joined(separator: "\n")))
                continue
            }
            if let h = match(#"^(#{1,6})\s+(.*?)\s*#*\s*$"#, line) {
                endPara()
                out.append(.heading(level: h[1].count, inline(h[2])))
                i += 1
                continue
            }
            if match(#"^\s*([-*_])(\s*\1){2,}\s*$"#, line) != nil {
                endPara()
                out.append(.rule)
                i += 1
                continue
            }
            if isTableRow(line), i + 1 < lines.count, isTableSep(lines[i + 1]) {
                endPara()
                let head = cells(line)
                let align: [MarkdownBlock.Align] = cells(lines[i + 1]).map { c in
                    c.hasPrefix(":") && c.hasSuffix(":") ? .center : c.hasSuffix(":") ? .trailing : .leading
                }
                i += 2
                var rows: [[AttributedString]] = []
                while i < lines.count, isTableRow(lines[i]) {
                    let r = cells(lines[i])
                    rows.append(head.indices.map { n in inline(n < r.count ? r[n] : "") })
                    i += 1
                }
                out.append(.table(header: head.map(inline), align: head.indices.map { $0 < align.count ? align[$0] : .leading }, rows: rows))
                continue
            }
            let bullet = #"^(\s*)[-*+]\s+(.*)$"#
            let numbered = #"^(\s*)(\d{1,9})[.)]\s+(.*)$"#
            if match(bullet, line) != nil || match(numbered, line) != nil {
                endPara()
                let ordered = match(bullet, line) == nil
                let start = ordered ? Int(match(numbered, line)![2]) ?? 1 : 1
                var items: [[String]] = []
                while i < lines.count {
                    let l = lines[i]
                    if let b = ordered ? match(numbered, l) : match(bullet, l) {
                        items.append([ordered ? b[3] : b[2]])
                        i += 1
                    } else if !l.trimmingCharacters(in: .whitespaces).isEmpty, l.hasPrefix("  "), !items.isEmpty {
                        items[items.count - 1].append(l.trimmingCharacters(in: .whitespaces))
                        i += 1
                    } else { break }
                }
                out.append(.list(ordered: ordered, start: start, items: items.map { parts in
                    var first = parts[0]
                    var checked: Bool?
                    if let t = match(#"^\[([ xX])\]\s+(.*)$"#, first) {
                        checked = t[1] != " "
                        first = t[2]
                    }
                    let rest = parts.dropFirst().map { r -> String in
                        if let b = match(#"^[-*+]\s+(.*)$"#, r) { return "• " + b[1] }
                        return r
                    }
                    return MarkdownBlock.Item(checked: checked, text: inline(([first] + rest).joined(separator: "\n")))
                }))
                continue
            }
            if line.trimmingCharacters(in: .whitespaces).hasPrefix(">") {
                endPara()
                var q: [String] = []
                while i < lines.count, lines[i].trimmingCharacters(in: .whitespaces).hasPrefix(">") {
                    var l = lines[i].trimmingCharacters(in: .whitespaces)
                    l.removeFirst()
                    if l.hasPrefix(" ") { l.removeFirst() }
                    q.append(l)
                    i += 1
                }
                out.append(.quote(parse(q.joined(separator: "\n"))))
                continue
            }
            para.append(line)
            i += 1
        }
        endPara()
        return out
    }
}
