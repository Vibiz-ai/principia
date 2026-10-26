import SwiftUI

struct NeedsView: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        ScrollView {
            if let n = app.needs {
                if n.asks.isEmpty && n.tasks.isEmpty {
                    EmptyState(title: "Nothing needs you", line: "Your team asks here when they need a decision.", art: .senate)
                        .padding(.top, 30)
                } else {
                    VStack(alignment: .leading, spacing: 12) {
                        Text("Needs you").font(Theme.display(30)).foregroundStyle(Theme.ink).padding(.top, 4)
                        ForEach(n.asks) { a in AskCard(ask: a) }
                        ForEach(n.tasks) { t in TaskCard(t: t) }
                    }
                    .padding(.horizontal, 16).padding(.bottom, 24)
                }
            } else {
                Skeleton()
            }
        }
        .refreshable { await app.refresh([.needs]) }
    }
}

struct CardHead: View {
    let who: PhoneWho?
    let fallback: String
    let at: String
    var body: some View {
        HStack(spacing: 10) {
            Face(who: who, size: 30)
            WhoLine(who: who, fallback: fallback)
            Spacer()
            Text(Words.ago(at)).font(.caption).foregroundStyle(Theme.faint)
        }
    }
}

struct AskCard: View {
    @Environment(AppModel.self) private var app
    let ask: PhoneAsk
    @State private var text = ""

    var body: some View {
        let busy = app.busy.contains("ask:\(ask.id)")
        VStack(alignment: .leading, spacing: 12) {
            CardHead(who: ask.who, fallback: "Agent", at: ask.at)
            Text(ask.question ?? ask.title).font(.body).foregroundStyle(Theme.ink)
            if let d = ask.detail, d != ask.question {
                Text(d).font(.system(.footnote, design: .monospaced)).foregroundStyle(Theme.soft)
                    .lineLimit(8)
                    .padding(10).frame(maxWidth: .infinity, alignment: .leading)
                    .background(Theme.page.opacity(0.6), in: .rect(cornerRadius: 10))
            }
            if !ask.options.isEmpty {
                GlassEffectContainer(spacing: 8) {
                    FlowRow {
                        ForEach(ask.options) { o in
                            if o.kind == "deny" {
                                Button(o.label) { Task { await app.answerAsk(ask, optionId: o.id, text: nil) } }.buttonStyle(.glass)
                            } else {
                                Button(o.label) { Task { await app.answerAsk(ask, optionId: o.id, text: nil) } }
                                    .buttonStyle(.glassProminent).tint(Theme.ink.opacity(0.9)).foregroundStyle(Theme.page)
                            }
                        }
                    }
                }
                .disabled(busy)
            }
            if ask.text {
                AnswerField(text: $text, placeholder: "Your answer", busy: busy) {
                    let t = text
                    Task { await app.answerAsk(ask, optionId: nil, text: t); text = "" }
                }
            }
            if ask.options.isEmpty && !ask.text && ask.open == nil {
                Text("Answer this on your Mac.").font(.footnote).foregroundStyle(Theme.faint)
            }
            if let r = ask.open {
                Button("Open the conversation") { app.openChat(r) }.font(.subheadline).foregroundStyle(Theme.soft)
            }
        }
        .glassCard()
    }
}

struct TaskCard: View {
    @Environment(AppModel.self) private var app
    let t: PhoneTaskNeed
    @State private var text = ""
    @State private var sendingBack = false
    @State private var confirmNotNeeded = false

    var body: some View {
        let busy = app.busy.contains("task:\(t.taskId)")
        VStack(alignment: .leading, spacing: 10) {
            CardHead(who: t.who, fallback: t.kind == .idea ? "Principia" : "Board", at: t.at)
            Text(kicker.uppercased()).font(Theme.display(10, semibold: true)).tracking(2).foregroundStyle(Theme.muted)
            Text(t.title).fontWeight(.semibold).foregroundStyle(Theme.ink)
            LongText(text: t.text)
            switch t.kind {
            case .review:
                ReviewButtons(taskId: t.taskId, sendingBack: $sendingBack)
            case .question:
                if !t.options.isEmpty {
                    GlassEffectContainer(spacing: 8) {
                        FlowRow {
                            ForEach(t.options, id: \.self) { o in
                                Button(o) { Task { await app.answerTask(t.taskId, text: o) } }
                                    .buttonStyle(.glassProminent).tint(Theme.ink.opacity(0.9)).foregroundStyle(Theme.page)
                            }
                        }
                    }
                    .disabled(busy)
                }
                AnswerField(text: $text, placeholder: "Your answer", busy: busy) {
                    let a = text
                    Task { await app.answerTask(t.taskId, text: a); text = "" }
                }
            case .stuck, .idea:
                EmptyView()
            }
            HStack(spacing: 16) {
                if let a = t.agentId {
                    Button("Open the conversation") { app.openChat(PhoneChatRef(kind: .agent, id: a)) }
                }
                Spacer()
                if t.kind != .idea {
                    Button("Not needed") { confirmNotNeeded = true }
                        .disabled(busy)
                        .confirmationDialog("Cancel “\(t.title)”?", isPresented: $confirmNotNeeded, titleVisibility: .visible) {
                            Button("Cancel task", role: .destructive) { Task { await app.notNeeded(t.taskId) } }
                            Button("Keep it", role: .cancel) {}
                        } message: {
                            Text("It leaves Needs you. You can reopen it from the Board on your Mac.")
                        }
                }
            }
            .font(.subheadline)
            .foregroundStyle(Theme.soft)
            .padding(.top, 2)
        }
        .glassCard()
    }

    private var kicker: String {
        switch t.kind {
        case .review: return "Ready for your OK"
        case .question: return "A question"
        case .idea: return "Idea"
        case .stuck: return "Stuck"
        }
    }
}

/// Approve / Send back; Send back opens a box for what should change (Needs you and the conversation).
struct ReviewButtons: View {
    @Environment(AppModel.self) private var app
    let taskId: String
    @Binding var sendingBack: Bool
    @State private var note = ""

    var body: some View {
        let busy = app.busy.contains("task:\(taskId)")
        GlassEffectContainer(spacing: 8) {
            if sendingBack {
                VStack(alignment: .leading, spacing: 8) {
                    TextField("What should change?", text: $note, axis: .vertical)
                        .lineLimit(2...6)
                        .padding(12)
                        .glassEffect(.regular.interactive(), in: .rect(cornerRadius: 14))
                    HStack(spacing: 8) {
                        Button("Send back") {
                            let n = note
                            Task { await app.sendBack(taskId, text: n); note = ""; sendingBack = false }
                        }
                        .buttonStyle(.glassProminent).tint(Theme.ink.opacity(0.9)).foregroundStyle(Theme.page)
                        .disabled(busy || note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                        Button("Cancel") { sendingBack = false }.buttonStyle(.glass)
                    }
                }
            } else {
                HStack(spacing: 8) {
                    Button("Approve") { Task { await app.approve(taskId) } }
                        .buttonStyle(.glassProminent).tint(Theme.ink.opacity(0.9)).foregroundStyle(Theme.page)
                    Button("Send back") { sendingBack = true }.buttonStyle(.glass)
                }
                .disabled(busy)
            }
        }
    }
}

/// A one-line answer with Send, in glass.
struct AnswerField: View {
    @Binding var text: String
    let placeholder: String
    let busy: Bool
    let onSend: () -> Void
    var body: some View {
        HStack(alignment: .bottom, spacing: 8) {
            TextField(placeholder, text: $text, axis: .vertical)
                .lineLimit(1...5)
                .padding(.horizontal, 14).padding(.vertical, 11)
                .glassEffect(.regular.interactive(), in: .rect(cornerRadius: 18))
            Button("Send", action: onSend)
                .buttonStyle(.glassProminent).tint(Theme.ink.opacity(0.9)).foregroundStyle(Theme.page)
                .disabled(busy || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
    }
}

/// Buttons that wrap onto the next line.
struct FlowRow: Layout {
    var spacing: CGFloat = 8
    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let w = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, row: CGFloat = 0, maxX: CGFloat = 0
        for s in subviews {
            let d = s.sizeThatFits(.unspecified)
            if x > 0 && x + d.width > w { x = 0; y += row + spacing; row = 0 }
            x += d.width + spacing
            maxX = max(maxX, x - spacing)
            row = max(row, d.height)
        }
        return CGSize(width: proposal.width ?? maxX, height: y + row)
    }
    func placeSubviews(in b: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = b.minX, y = b.minY, row: CGFloat = 0
        for s in subviews {
            let d = s.sizeThatFits(.unspecified)
            if x > b.minX && x + d.width > b.maxX { x = b.minX; y += row + spacing; row = 0 }
            s.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(d))
            x += d.width + spacing
            row = max(row, d.height)
        }
    }
}

/// A long report reads in a few lines first, with Show all (cards must not push the buttons off screen).
struct LongText: View {
    let text: String
    @State private var open = false
    var body: some View {
        let long = text.count > 320
        VStack(alignment: .leading, spacing: 6) {
            MarkdownView(text)
                .frame(maxHeight: long && !open ? 132 : nil, alignment: .top)
                .clipped()
                .mask(LinearGradient(stops: [.init(color: .black, location: 0), .init(color: .black, location: long && !open ? 0.7 : 1), .init(color: long && !open ? .clear : .black, location: 1)], startPoint: .top, endPoint: .bottom))
            if long {
                Button(open ? "Show less" : "Show all") { withAnimation(.smooth) { open.toggle() } }
                    .font(.subheadline.weight(.medium)).foregroundStyle(Theme.soft)
            }
        }
    }
}
