import SwiftUI

/// Agent markdown, native (Markdown.swift): text styles come from AttributedString, tables scroll sideways.
struct MarkdownView: View {
    let blocks: [MarkdownBlock]
    init(_ text: String) { blocks = Markdown.parse(text) }
    init(blocks: [MarkdownBlock]) { self.blocks = blocks }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, b in
                block(b)
            }
        }
        .tint(Theme.ink)
        .textSelection(.enabled)
    }

    @ViewBuilder private func block(_ b: MarkdownBlock) -> some View {
        switch b {
        case .paragraph(let a):
            Text(a).foregroundStyle(Theme.ink).fixedSize(horizontal: false, vertical: true)
        case .heading(let level, let a):
            Text(a)
                .font(level <= 1 ? Theme.display(20) : level == 2 ? Theme.display(17) : .headline)
                .foregroundStyle(Theme.ink)
                .padding(.top, 2)
                .accessibilityAddTraits(.isHeader)
        case .list(let ordered, let start, let items):
            VStack(alignment: .leading, spacing: 5) {
                ForEach(Array(items.enumerated()), id: \.offset) { n, item in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        if let c = item.checked {
                            Image(systemName: c ? "checkmark.square" : "square").font(.footnote).foregroundStyle(c ? Theme.ok : Theme.muted)
                        } else {
                            Text(ordered ? "\(start + n)." : "•").foregroundStyle(Theme.muted).monospacedDigit()
                        }
                        Text(item.text).foregroundStyle(item.checked == true ? Theme.muted : Theme.ink).fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
        case .quote(let inner):
            HStack(spacing: 10) {
                Rectangle().fill(Color.white.opacity(0.2)).frame(width: 2)
                MarkdownView(blocks: inner).foregroundStyle(Theme.soft)
            }
        case .code(_, let code):
            ScrollView(.horizontal, showsIndicators: false) {
                Text(code).font(.system(.footnote, design: .monospaced)).foregroundStyle(Theme.soft).padding(10)
            }
            .background(Theme.page.opacity(0.7), in: .rect(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.line))
        case .rule:
            Rectangle().fill(Color.white.opacity(0.14)).frame(height: 1)
        case .table(let header, let align, let rows):
            ScrollView(.horizontal, showsIndicators: true) {
                Grid(alignment: .leading, horizontalSpacing: 0, verticalSpacing: 0) {
                    GridRow {
                        ForEach(header.indices, id: \.self) { n in
                            cell(header[n], align[n]).fontWeight(.semibold).foregroundStyle(Theme.soft).background(Color.white.opacity(0.04))
                        }
                    }
                    ForEach(rows.indices, id: \.self) { r in
                        Divider().overlay(Theme.line)
                        GridRow {
                            ForEach(rows[r].indices, id: \.self) { n in
                                cell(rows[r][n], align[n]).foregroundStyle(Theme.ink)
                            }
                        }
                    }
                }
            }
            .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.line))
            .clipShape(.rect(cornerRadius: 10))
            .accessibilityLabel("Table")
        }
    }

    private func cell(_ a: AttributedString, _ al: MarkdownBlock.Align) -> some View {
        Text(a)
            .font(.footnote)
            .frame(minWidth: 70, maxWidth: 240, alignment: al == .trailing ? .trailing : al == .center ? .center : .leading)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.horizontal, 10).padding(.vertical, 7)
            .gridColumnAlignment(al == .trailing ? .trailing : al == .center ? .center : .leading)
    }
}
