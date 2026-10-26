import XCTest
@testable import Principia

final class MarkdownTests: XCTestCase {
    private func intents(_ a: AttributedString) -> [InlinePresentationIntent] {
        a.runs.compactMap { $0.inlinePresentationIntent }
    }

    func testInlineStylesNotRawMarkers() {
        let a = Markdown.inline("This is **bold**, *italic*, `code` and ~~gone~~.")
        XCTAssertEqual(String(a.characters), "This is bold, italic, code and gone.")
        let all = intents(a)
        XCTAssertTrue(all.contains { $0.contains(.stronglyEmphasized) })
        XCTAssertTrue(all.contains { $0.contains(.emphasized) })
        XCTAssertTrue(all.contains { $0.contains(.code) })
        XCTAssertTrue(all.contains { $0.contains(.strikethrough) })
    }

    func testOnlySafeLinks() {
        let a = Markdown.inline("[docs](https://example.com) and [bad](javascript:alert(1))")
        let links = a.runs.compactMap { $0.link }
        XCTAssertEqual(links, [URL(string: "https://example.com")!])
        XCTAssertTrue(String(a.characters).contains("bad"))
    }

    func testBlocks() {
        let b = Markdown.parse("# Plan\n\n- one\n- **two**\n\n3. third\n4. fourth\n\n- [x] done\n- [ ] open\n\n> quoted\n\n---\n\n```swift\nlet a = 1 < 2\n```\nlast line")
        guard case .heading(1, _) = b[0] else { return XCTFail("\(b[0])") }
        guard case .list(false, _, let items) = b[1] else { return XCTFail() }
        XCTAssertEqual(items.count, 2)
        guard case .list(true, 3, let ord) = b[2] else { return XCTFail() }
        XCTAssertEqual(ord.count, 2)
        guard case .list(false, _, let tasks) = b[3] else { return XCTFail() }
        XCTAssertEqual(tasks.map(\.checked), [true, false])
        guard case .quote = b[4], case .rule = b[5] else { return XCTFail() }
        XCTAssertEqual(b[6], .code(language: "swift", "let a = 1 < 2"))
        guard case .paragraph(let p) = b[7] else { return XCTFail() }
        XCTAssertEqual(String(p.characters), "last line")
    }

    func testTables() {
        let b = Markdown.parse("| Dish | Price |\n|:--|--:|\n| **Soup** | 9 |\n| Pie \\| tart | 12 |")
        guard case .table(let header, let align, let rows) = b.first else { return XCTFail("\(b)") }
        XCTAssertEqual(header.map { String($0.characters) }, ["Dish", "Price"])
        XCTAssertEqual(align, [.leading, .trailing])
        XCTAssertEqual(rows.map { $0.map { String($0.characters) } }, [["Soup", "9"], ["Pie | tart", "12"]])
        // pipes without a separator line stay a paragraph
        guard case .paragraph = Markdown.parse("| not | a table |").first else { return XCTFail() }
    }

    func testHalfWrittenStaysText() {
        XCTAssertEqual(String(Markdown.inline("Working on **the menu").characters), "Working on **the menu")
    }
}
