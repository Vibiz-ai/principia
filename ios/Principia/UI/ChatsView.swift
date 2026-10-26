import SwiftUI

struct ChatsTab: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        @Bindable var app = app
        NavigationStack(path: $app.chatPath) {
            ChatsList()
                .stone()
                .toolbar { TopBar() }
                .navigationDestination(for: PhoneChatRef.self) { ref in
                    ConversationView(ref: ref)
                }
        }
        .onChange(of: app.chatPath) { _, path in
            if path.isEmpty { app.closedChat() }
        }
    }
}

struct ChatsList: View {
    @Environment(AppModel.self) private var app
    var body: some View {
        ScrollView {
            if let c = app.chats {
                if c.rows.isEmpty {
                    EmptyState(title: "No chats yet", line: "Conversations with your agents and Claude show here.", art: .scribe).padding(.top, 30)
                } else {
                    VStack(alignment: .leading, spacing: 12) {
                        Text("Chats").font(Theme.display(30)).foregroundStyle(Theme.ink).padding(.top, 4)
                        VStack(spacing: 0) {
                            ForEach(Array(c.rows.enumerated()), id: \.element.id) { i, r in
                                if i > 0 { Divider().overlay(Theme.line) }
                                Button { app.openChat(r.ref) } label: { ChatRow(r: r) }.buttonStyle(.plain)
                            }
                        }
                        .padding(.horizontal, 16)
                        .glassEffect(.regular, in: .rect(cornerRadius: 22))
                    }
                    .padding(.horizontal, 16).padding(.bottom, 24)
                }
            } else {
                Skeleton()
            }
        }
        .refreshable { await app.refresh([.chats]) }
    }
}

struct ChatRow: View {
    let r: PhoneChatRow
    var body: some View {
        HStack(spacing: 12) {
            Face(who: r.who, size: 32)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 8) {
                    Text(r.title).fontWeight(.semibold).foregroundStyle(Theme.ink).lineLimit(1)
                    if r.live {
                        Text("LIVE").font(Theme.display(9, semibold: true)).tracking(1.8).foregroundStyle(Theme.ink)
                            .padding(.horizontal, 7).padding(.vertical, 2)
                            .overlay(Capsule().stroke(Color.white.opacity(0.3)))
                    }
                }
                if let l = r.line { Text(l).font(.subheadline).foregroundStyle(Theme.muted).lineLimit(2) }
            }
            Spacer(minLength: 4)
            Text(Words.ago(r.at)).font(.caption).foregroundStyle(Theme.faint)
        }
        .padding(.vertical, 12)
        .contentShape(Rectangle())
    }
}

/// One conversation: a chat that streams live, a terminal session, or an agent's thread.
struct ConversationView: View {
    @Environment(AppModel.self) private var app
    let ref: PhoneChatRef
    @State private var draft = ""

    var body: some View {
        Group {
            switch ref.kind {
            case .session: SessionBody(ref: ref)
            case .agent: AgentBody(ref: ref)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .stone()
        .navigationBarTitleDisplayMode(.inline)
        .navigationTitle(title)
        .navigationSubtitle(subtitle)
        // Solid bar: messages scroll under it, never through the title.
        .toolbarBackground(Theme.page, for: .navigationBar)
        .toolbarBackgroundVisibility(.visible, for: .navigationBar)
        .toolbar {
            if ref.kind == .session, let r = app.replica, r.busy, app.session?.ref.id == ref.id {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { Task { await app.stop() } } label: { Label("Stop", systemImage: "stop.fill") }
                        .disabled(app.busy.contains("stop"))
                }
            }
        }
        .safeAreaInset(edge: .bottom) {
            if canWrite {
                Composer(text: $draft, placeholder: placeholder, busy: app.busy.contains("send")) {
                    let t = draft
                    draft = ""
                    Task { if !(await app.send(t)) { draft = t } }
                }
            }
        }
        .task(id: ref) { await app.load(ref) }
    }

    private var title: String {
        switch ref.kind {
        case .session: return app.session?.ref.id == ref.id ? app.session?.title ?? "" : ""
        case .agent: return app.agent?.ref.id == ref.id ? app.agent?.who.name ?? "" : ""
        }
    }
    private var subtitle: String {
        switch ref.kind {
        case .session:
            guard let s = app.session, s.ref.id == ref.id else { return "" }
            if let r = app.replica { return r.turnWords }
            return s.terminal?.ended == true ? "Ended" : "In a terminal on your Mac"
        case .agent:
            return app.agent?.ref.id == ref.id ? app.agent?.status ?? "" : ""
        }
    }
    private var canWrite: Bool {
        switch ref.kind {
        case .session:
            guard let s = app.session, s.ref.id == ref.id else { return false }
            return app.replica != nil || s.terminal?.canReply == true
        case .agent: return app.agent?.ref.id == ref.id
        }
    }
    private var placeholder: String {
        if ref.kind == .agent { return "Ask \(app.agent?.who.name ?? "them") for something" }
        if let r = app.replica, r.busy { return "Queue a message" }
        return "Message"
    }
}

struct SessionBody: View {
    @Environment(AppModel.self) private var app
    let ref: PhoneChatRef

    var body: some View {
        if let s = app.session, s.ref.id == ref.id {
            if let r = app.replica {
                ChatScroll(lines: ChatLines.build(r.items), queue: r.queue, busy: r.busy)
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 10) {
                        if let a = s.terminal?.activity {
                            HStack(spacing: 7) { Tile(kind: .run); Text(a).foregroundStyle(Theme.soft) }
                        }
                        Text(s.terminal?.canReply == true ? "It finished and waits for you. Reply below and it carries on." : "This one runs in a terminal on your Mac. You can reply here when it waits for you.")
                            .foregroundStyle(Theme.muted)
                    }
                    .glassCard()
                    .padding(16)
                }
            }
        } else {
            Skeleton()
        }
    }
}

struct ChatScroll: View {
    @Environment(AppModel.self) private var app
    let lines: [ChatLine]
    let queue: [ChatQueued]
    let busy: Bool

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 10) {
                    ForEach(lines) { l in ChatLineView(line: l).id(l.id) }
                    ForEach(Array(queue.enumerated()), id: \.element.id) { n, q in
                        VStack(alignment: .trailing, spacing: 6) {
                            Text(q.text).foregroundStyle(Theme.ink)
                                .padding(.horizontal, 13).padding(.vertical, 10)
                                .overlay(RoundedRectangle(cornerRadius: 18).stroke(Color.white.opacity(0.2), style: StrokeStyle(lineWidth: 1, dash: [4, 3])))
                            HStack(spacing: 10) {
                                Text(busy ? "Queued: sends when it finishes" : "Waiting to send").font(.caption).foregroundStyle(Theme.muted)
                                if n == queue.count - 1 {
                                    Button(busy ? "Stop and send now" : "Send now") { Task { await app.stop(sendNow: true) } }
                                        .font(.caption.weight(.semibold)).buttonStyle(.glass).disabled(app.busy.contains("sendNow"))
                                }
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .trailing)
                    }
                    Color.clear.frame(height: 1).id("bottom")
                }
                .padding(.horizontal, 14).padding(.top, 8)
            }
            .defaultScrollAnchor(.bottom)
            .scrollDismissesKeyboard(.interactively)
            .onChange(of: lines.last) { _, _ in
                withAnimation(.smooth) { proxy.scrollTo("bottom", anchor: .bottom) }
            }
        }
    }
}

struct ChatLineView: View {
    @Environment(AppModel.self) private var app
    let line: ChatLine
    @State private var picks: [String: Set<String>] = [:]
    @State private var typed = ""

    var body: some View {
        switch line {
        case .me(_, let text, let queued):
            Text(text).foregroundStyle(Theme.ink)
                .padding(.horizontal, 13).padding(.vertical, 10)
                .glassEffect(.regular.tint(Color.white.opacity(queued ? 0.02 : 0.10)), in: .rect(cornerRadius: 18))
                .frame(maxWidth: .infinity, alignment: .trailing)
                .padding(.leading, 40)
        case .say(_, let text, let streaming):
            VStack(alignment: .leading, spacing: 4) {
                MarkdownView(text)
                if streaming { Rectangle().fill(Color.white.opacity(0.5)).frame(width: 7, height: 14) }
            }
            .padding(.horizontal, 2)
            .frame(maxWidth: .infinity, alignment: .leading)
        case .thinking:
            HStack(spacing: 9) { Tile(kind: .run); Text("Thinking").font(.subheadline).foregroundStyle(Theme.muted) }
        case .tool(_, let text, let code, let state, let sub):
            HStack(alignment: .firstTextBaseline, spacing: 9) {
                Tile(kind: state == .run ? .run : state == .ok ? .ok : .fail)
                VStack(alignment: .leading, spacing: 2) {
                    Text(text + (sub > 0 ? " · \(sub) step\(sub == 1 ? "" : "s")" : "")).font(.subheadline).foregroundStyle(Theme.muted)
                    if !code.isEmpty { Text(code).font(.system(.caption, design: .monospaced)).foregroundStyle(Theme.faint).lineLimit(2) }
                }
            }
            .padding(.horizontal, 4)
        case .plan(_, let done, let total, let items):
            VStack(alignment: .leading, spacing: 5) {
                Text("PLAN · \(done) OF \(total) DONE").font(Theme.display(10, semibold: true)).tracking(1.8).foregroundStyle(Theme.muted)
                ForEach(Array(items.enumerated()), id: \.offset) { _, i in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Image(systemName: i.done ? "checkmark" : i.now ? "circle.fill" : "circle").font(.caption2).foregroundStyle(i.now ? Theme.ink : Theme.muted)
                        Text(i.text).font(.subheadline).strikethrough(i.done).foregroundStyle(i.now ? Theme.ink : i.done ? Theme.faint : Theme.muted)
                    }
                }
            }
            .glassCard(radius: 18)
        case .permission(_, let requestId, let title, let detail, let open, let outcome):
            VStack(alignment: .leading, spacing: 10) {
                Text(title).foregroundStyle(Theme.ink)
                if let d = detail {
                    Text(d).font(.system(.footnote, design: .monospaced)).foregroundStyle(Theme.soft).lineLimit(8)
                        .padding(10).frame(maxWidth: .infinity, alignment: .leading)
                        .background(Theme.page.opacity(0.6), in: .rect(cornerRadius: 10))
                }
                if open {
                    GlassEffectContainer(spacing: 8) {
                        HStack(spacing: 8) {
                            Button("Allow") { Task { await app.chatAnswer(requestId, .allow) } }
                                .buttonStyle(.glassProminent).tint(Theme.ink.opacity(0.9)).foregroundStyle(Theme.page)
                            Button("Deny") { Task { await app.chatAnswer(requestId, .deny(message: nil)) } }.buttonStyle(.glass)
                        }
                    }
                    .disabled(app.busy.contains("req:\(requestId)"))
                } else if let o = outcome {
                    Text(o).font(.footnote).foregroundStyle(Theme.faint)
                }
            }
            .glassCard(radius: 18)
        case .question(_, let requestId, let questions, let open, let answers):
            VStack(alignment: .leading, spacing: 10) {
                ForEach(questions, id: \.question) { q in
                    Text(q.question).foregroundStyle(Theme.ink)
                    if open {
                        FlowRow {
                            ForEach(q.options, id: \.self) { o in
                                let on = picks[q.question]?.contains(o) == true
                                Button(o) {
                                    if questions.count == 1 && !q.multi { Task { await app.chatAnswer(requestId, .answer([q.question: o])) } }
                                    else { toggle(q, o) }
                                }
                                .buttonStyle(.glass)
                                .tint(on ? Theme.ink : nil)
                            }
                        }
                    }
                }
                if open {
                    AnswerField(text: $typed, placeholder: "Or type an answer", busy: app.busy.contains("req:\(requestId)")) {
                        let t = typed.trimmingCharacters(in: .whitespacesAndNewlines)
                        let out = t.isEmpty ? picks.mapValues { $0.sorted().joined(separator: ", ") } : Dictionary(uniqueKeysWithValues: questions.map { ($0.question, t) })
                        Task { await app.chatAnswer(requestId, .answer(out)) }
                    }
                    if questions.count > 1 || questions.first?.multi == true {
                        Button("Send picks") { Task { await app.chatAnswer(requestId, .answer(picks.mapValues { $0.sorted().joined(separator: ", ") })) } }
                            .buttonStyle(.glass).disabled(picks.isEmpty)
                    }
                    Button("Skip") { Task { await app.chatAnswer(requestId, .skip) } }.font(.subheadline).foregroundStyle(Theme.soft)
                } else {
                    Text(answers.map { $0.values.joined(separator: " · ") } ?? "Skipped").font(.footnote).foregroundStyle(Theme.faint)
                }
            }
            .glassCard(radius: 18)
        case .planCard(_, let requestId, let plan, let open, let outcome):
            VStack(alignment: .leading, spacing: 10) {
                Text("THE PLAN").font(Theme.display(10, semibold: true)).tracking(1.8).foregroundStyle(Theme.muted)
                MarkdownView(plan)
                if open {
                    HStack(spacing: 8) {
                        Button("Approve the plan") { Task { await app.chatAnswer(requestId, .approvePlan) } }
                            .buttonStyle(.glassProminent).tint(Theme.ink.opacity(0.9)).foregroundStyle(Theme.page)
                        Button("Keep planning") { Task { await app.chatAnswer(requestId, .rejectPlan(message: nil)) } }.buttonStyle(.glass)
                    }
                } else if let o = outcome {
                    Text(o).font(.footnote).foregroundStyle(Theme.faint)
                }
            }
            .glassCard(radius: 18)
        case .notice(_, let tone, let text):
            HStack(spacing: 10) {
                Rectangle().fill(tone == "error" ? Theme.fail : tone == "warn" ? Theme.ink : Color.white.opacity(0.2)).frame(width: 2)
                Text(text).font(.footnote).foregroundStyle(Theme.muted)
            }
            .fixedSize(horizontal: false, vertical: true)
        case .end(_, let text):
            Text(text).font(.caption).foregroundStyle(Theme.faint).frame(maxWidth: .infinity)
        }
    }

    private func toggle(_ q: ChatLine.Question, _ o: String) {
        var s = picks[q.question] ?? []
        if q.multi { if s.contains(o) { s.remove(o) } else { s.insert(o) } } else { s = [o] }
        picks[q.question] = s
    }
}

struct AgentBody: View {
    @Environment(AppModel.self) private var app
    let ref: PhoneChatRef
    @State private var sendingBack: [String: Bool] = [:]
    @State private var answers: [String: String] = [:]

    var body: some View {
        if let g = app.agent, g.ref.id == ref.id {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 10) {
                    if g.items.isEmpty {
                        VStack(spacing: 10) {
                            Face(who: g.who, size: 64)
                            Text("Ask \(g.who.name) for something. It becomes a task \(g.who.name) works on.").font(.subheadline).foregroundStyle(Theme.muted).multilineTextAlignment(.center)
                        }
                        .frame(maxWidth: .infinity).padding(.top, 40)
                    }
                    ForEach(g.items) { i in item(i) }
                }
                .padding(.horizontal, 14).padding(.top, 8)
            }
            .defaultScrollAnchor(.bottom)
            .scrollDismissesKeyboard(.interactively)
        } else {
            Skeleton()
        }
    }

    @ViewBuilder private func item(_ i: PhoneThreadItem) -> some View {
        switch i.kind {
        case "me":
            VStack(alignment: .trailing, spacing: 4) {
                Text(i.text).foregroundStyle(Theme.ink)
                    .padding(.horizontal, 13).padding(.vertical, 10)
                    .glassEffect(.regular.tint(Color.white.opacity(0.10)), in: .rect(cornerRadius: 18))
                Text(Words.ago(i.at)).font(.caption2).foregroundStyle(Theme.faint)
            }
            .frame(maxWidth: .infinity, alignment: .trailing)
            .padding(.leading, 40)
        case "agent":
            VStack(alignment: .leading, spacing: 8) {
                MarkdownView(i.text)
                if i.card == "review" {
                    ReviewButtons(taskId: i.taskId, sendingBack: Binding(get: { sendingBack[i.taskId] ?? false }, set: { sendingBack[i.taskId] = $0 }))
                }
                if i.card == "ask" {
                    AnswerField(text: Binding(get: { answers[i.taskId] ?? "" }, set: { answers[i.taskId] = $0 }), placeholder: "Your answer", busy: app.busy.contains("task:\(i.taskId)")) {
                        let a = answers[i.taskId] ?? ""
                        Task { await app.answerTask(i.taskId, text: a); answers[i.taskId] = "" }
                    }
                }
                Text(Words.ago(i.at)).font(.caption2).foregroundStyle(Theme.faint)
            }
            .glassCard(radius: 18)
            .padding(.trailing, 24)
        default:
            Text(i.text).font(.caption).foregroundStyle(Theme.faint).frame(maxWidth: .infinity)
        }
    }
}

/// The composer: a glass field and a glass send button, above the keyboard.
struct Composer: View {
    @Binding var text: String
    let placeholder: String
    let busy: Bool
    var onSend: () -> Void
    var accessory: AnyView? = nil

    var body: some View {
        VStack(spacing: 8) {
            if let accessory { accessory }
            GlassEffectContainer(spacing: 8) {
                HStack(alignment: .bottom, spacing: 8) {
                    TextField(placeholder, text: $text, axis: .vertical)
                        .lineLimit(1...6)
                        .padding(.horizontal, 16).padding(.vertical, 12)
                        .glassEffect(.regular.interactive(), in: .rect(cornerRadius: 22))
                    Button(action: onSend) {
                        Image(systemName: "arrow.up").font(.body.weight(.semibold)).frame(width: 26, height: 30)
                    }
                    .buttonStyle(.glassProminent)
                    .tint(Theme.ink.opacity(0.92))
                    .foregroundStyle(Theme.page)
                    .buttonBorderShape(.circle)
                    .disabled(busy || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    .accessibilityLabel("Send")
                }
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
    }
}
