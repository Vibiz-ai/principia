import SwiftUI
import UIKit

/// The landing page's look, native: near-black stone, cool greys and white, Cinzel lettering for titles, white line
/// engravings where a screen is otherwise empty. No warm colour anywhere. Liquid Glass for everything that floats or
/// can be pressed.
enum Theme {
    static let page = Color(red: 0.039, green: 0.047, blue: 0.051)
    static let panel = Color(red: 0.086, green: 0.102, blue: 0.110)
    static let raised = Color(red: 0.114, green: 0.133, blue: 0.145)
    static let ink = Color(red: 0.929, green: 0.945, blue: 0.949)
    static let soft = Color(red: 0.804, green: 0.831, blue: 0.839)
    static let muted = Color(red: 0.596, green: 0.635, blue: 0.651)
    static let faint = Color(red: 0.424, green: 0.467, blue: 0.482)
    static let line = Color.white.opacity(0.08)
    static let ok = Color(red: 0.655, green: 0.757, blue: 0.690)
    static let fail = Color(red: 0.890, green: 0.525, blue: 0.561)
    static let run = Color(red: 0.765, green: 0.796, blue: 0.808)

    static func display(_ size: CGFloat, semibold: Bool = false) -> Font {
        let name = semibold ? "Cinzel-SemiBold" : "Cinzel-Medium"
        return UIFont(name: name, size: size) != nil ? .custom(name, size: size, relativeTo: .title) : .system(size: size, weight: .semibold, design: .serif)
    }
    /// small capitals in Cinzel, tracked out (section labels, kickers, tab names)
    static let kicker = display(11, semibold: true)
}

extension View {
    /// a card of glass over the stone
    func glassCard(radius: CGFloat = 22, interactive: Bool = false) -> some View {
        padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .glassEffect(interactive ? .regular.interactive() : .regular, in: .rect(cornerRadius: radius))
    }
    /// the page background everywhere
    func stone() -> some View {
        background(Theme.page.ignoresSafeArea())
    }
}

/// "WORKING NOW" with a fading rule, as on the landing page
struct SectionLabel: View {
    let text: String
    init(_ text: String) { self.text = text }
    var body: some View {
        HStack(spacing: 12) {
            Text(text.uppercased())
                .font(Theme.kicker)
                .tracking(2.6)
                .foregroundStyle(Theme.muted)
            LinearGradient(colors: [Color.white.opacity(0.16), .clear], startPoint: .leading, endPoint: .trailing)
                .frame(height: 1)
        }
        .padding(.top, 14)
        .accessibilityAddTraits(.isHeader)
    }
}

/// Small square status tiles, the only colour, all cool.
struct Tile: View {
    enum Kind { case ok, needs, fail, run, quiet }
    let kind: Kind
    @State private var dim = false
    var body: some View {
        Rectangle()
            .fill(color)
            .frame(width: 8, height: 8)
            .opacity(kind == .run && dim ? 0.3 : 1)
            .onAppear {
                guard kind == .run else { return }
                withAnimation(.easeInOut(duration: 0.8).repeatForever(autoreverses: true)) { dim = true }
            }
            .accessibilityHidden(true)
    }
    private var color: Color {
        switch kind {
        case .ok: return Theme.ok
        case .needs: return Theme.ink
        case .fail: return Theme.fail
        case .run: return Theme.run
        case .quiet: return Theme.faint
        }
    }
}

/// The persona's white line-art bust, or a thin ring.
struct Face: View {
    let who: PhoneWho?
    var size: CGFloat = 40
    var body: some View {
        Group {
            if let name = bustName, UIImage(named: name) != nil {
                Image(name).resizable().scaledToFit()
            } else {
                Circle().stroke(Color.white.opacity(0.22), lineWidth: 1).padding(1)
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
    private var bustName: String? {
        guard let b = who?.bust else { return nil }
        // "Marcus II" draws Marcus
        let base = b.replacingOccurrences(of: #" [IVX]+$"#, with: "", options: .regularExpression)
        return "Bust" + base.filter { $0.isLetter || $0.isNumber }
    }
}

/// The white line engravings (arch, senate, scribe, forum), melting into the page at the edges.
struct Plate: View {
    enum Art: String { case arch = "ArtArch", senate = "ArtSenate", scribe = "ArtScribe", forum = "ArtForum" }
    let art: Art
    var body: some View {
        Image(art.rawValue)
            .resizable()
            .aspectRatio(900.0 / 503.0, contentMode: .fit)
            .opacity(0.85)
            .mask(
                RadialGradient(colors: [.black, .black, .clear], center: .center, startRadius: 0, endRadius: 210)
                    .scaleEffect(x: 1.25, y: 1)
            )
            .mask(LinearGradient(stops: [.init(color: .clear, location: 0), .init(color: .black, location: 0.2), .init(color: .black, location: 0.8), .init(color: .clear, location: 1)], startPoint: .top, endPoint: .bottom))
            .accessibilityHidden(true)
    }
}

/// The arch, drawn: the app's mark, in white line.
struct ArchMark: View {
    var size: CGFloat = 28
    var body: some View {
        Canvas { ctx, s in
            let k = s.width / 64
            func p(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: x * k, y: y * k) }
            var top = Path(); top.move(to: p(14, 11)); top.addLine(to: p(50, 11))
            var outer = Path()
            outer.move(to: p(12, 52)); outer.addLine(to: p(52, 52))
            outer.move(to: p(17, 52)); outer.addLine(to: p(17, 32))
            outer.addArc(center: p(32, 32), radius: 15 * k, startAngle: .degrees(180), endAngle: .degrees(0), clockwise: false)
            outer.addLine(to: p(47, 52))
            var inner = Path()
            inner.move(to: p(24, 52)); inner.addLine(to: p(24, 33))
            inner.addArc(center: p(32, 33), radius: 8 * k, startAngle: .degrees(180), endAngle: .degrees(0), clockwise: false)
            inner.addLine(to: p(40, 52))
            let st = StrokeStyle(lineWidth: max(1, 1.6 * k), lineCap: .round, lineJoin: .round)
            ctx.stroke(top, with: .color(.white.opacity(0.3)), style: st)
            ctx.stroke(outer, with: .color(.white.opacity(0.92)), style: st)
            ctx.stroke(inner, with: .color(.white.opacity(0.42)), style: st)
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

/// A quiet empty state: an engraving, a title in Cinzel, one line.
struct EmptyState: View {
    let title: String
    let line: String
    let art: Plate.Art
    var body: some View {
        VStack(spacing: 10) {
            Plate(art: art).padding(.horizontal, -16).padding(.bottom, -18)
            Text(title).font(Theme.display(22)).foregroundStyle(Theme.ink).multilineTextAlignment(.center)
            Text(line).font(.subheadline).foregroundStyle(Theme.muted).multilineTextAlignment(.center).frame(maxWidth: 300)
        }
        .frame(maxWidth: .infinity)
        .padding(.bottom, 40)
    }
}

/// "Persona · Role"
struct WhoLine: View {
    let who: PhoneWho?
    let fallback: String
    var body: some View {
        line
            .font(.subheadline)
            .lineLimit(1)
    }
    private var line: Text {
        let name = Text(who?.name ?? fallback).fontWeight(.semibold).foregroundStyle(Theme.ink)
        let role = Text(who.map { $0.role.isEmpty ? "" : " · \($0.role)" } ?? "").foregroundStyle(Theme.faint)
        return Text("\(name)\(role)")
    }
}

/// The toast at the bottom, in glass.
struct Toast: View {
    let text: String
    var body: some View {
        Text(text)
            .font(.subheadline.weight(.medium))
            .foregroundStyle(Theme.ink)
            .padding(.horizontal, 18).padding(.vertical, 12)
            .glassEffect(.regular, in: .capsule)
            .padding(.bottom, 8)
            .transition(.move(edge: .bottom).combined(with: .opacity))
            .accessibilityAddTraits(.updatesFrequently)
    }
}
