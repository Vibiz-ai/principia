import PhotosUI
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
    @State private var photos = PhotoDraft()

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
            // a terminal on the Mac is stopped there (Esc in its pane), never from the phone
            if ref.kind == .session, let r = app.replica, r.busy, app.session?.ref.id == ref.id, app.session?.terminal == nil {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { Task { await app.stop() } } label: { Label("Stop", systemImage: "stop.fill") }
                        .disabled(app.busy.contains("stop"))
                }
            }
        }
        .safeAreaInset(edge: .bottom) {
            if canWrite {
                Composer(text: $draft, placeholder: placeholder, busy: app.busy.contains("send"), held: held, note: heldNote, onSend: {
                    let t = draft
                    let im = takesPhotos ? photos.take() : []
                    draft = ""
                    Task {
                        if !(await app.send(t, images: im)) {
                            draft = t
                            photos.restore(im)
                        }
                    }
                }, photos: takesPhotos ? photos : nil)
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
            // a terminal on the Mac takes a message any time it runs; while it asks something the box stays, held
            if let t = s.terminal, t.canType != nil { return t.composer(name: s.who?.name ?? "Claude") != nil }
            return app.replica != nil || s.terminal?.canReply == true
        case .agent: return app.agent?.ref.id == ref.id
        }
    }
    /// photos go into a chat (one on the Mac, or an agent's), never typed into a terminal
    private var takesPhotos: Bool {
        switch ref.kind {
        case .session:
            guard let s = app.session, s.ref.id == ref.id else { return false }
            return s.terminal == nil && app.replica != nil
        case .agent: return true
        }
    }
    private var held: Bool {
        guard ref.kind == .session, let s = app.session, s.ref.id == ref.id, let t = s.terminal, t.canType != nil else { return false }
        return t.composer(name: s.who?.name ?? "Claude")?.held ?? false
    }
    /// why it cannot take a message now, in full above the field (a placeholder cuts it off)
    private var heldNote: String? {
        guard held, let s = app.session, let t = s.terminal else { return nil }
        return t.composer(name: s.who?.name ?? "Claude")?.placeholder
    }
    private var placeholder: String {
        if ref.kind == .agent { return "Ask \(app.agent?.who.name ?? "them") for something" }
        if held { return "Message \(app.session?.who?.name ?? "Claude")" }
        if let s = app.session, let t = s.terminal, t.canType != nil, let c = t.composer(name: s.who?.name ?? "Claude") { return c.placeholder }
        if app.session?.terminal != nil { return "Message \(app.session?.who?.name ?? "Claude")" }
        if let r = app.replica, r.busy { return "Queue a message" }
        return "Message"
    }
}

struct SessionBody: View {
    @Environment(AppModel.self) private var app
    let ref: PhoneChatRef

    var body: some View {
        if let s = app.session, s.ref.id == ref.id {
            if let t = s.terminal, t.canType != nil || app.replica != nil {
                // a terminal on the Mac, read as its chat: what it said and did, live; its screen until it writes a
                // transcript; what it asks; and Continue once it ended
                ChatScroll(lines: ChatLines.build(app.replica?.items ?? []), queue: [], busy: false, footer: AnyView(TerminalFooter(t: t, empty: (app.replica?.items ?? []).isEmpty)))
            } else if let r = app.replica {
                ChatScroll(lines: ChatLines.build(r.items), queue: r.queue, busy: r.busy)
            } else {
                // an older Mac: only the live line, and a reply when it waits at its prompt
                ScrollView {
                    VStack(alignment: .leading, spacing: 10) {
                        if let a = s.terminal?.activity {
                            HStack(spacing: 7) { Tile(kind: .run); Text(a).foregroundStyle(Theme.soft) }
                        }
                        Text(s.terminal?.ended == true ? "This session ended." : s.terminal?.canReply == true ? "It finished and waits for you. Reply below and it carries on." : "It is working in a terminal on your Mac. You can reply here when it waits for you.")
                            .foregroundStyle(Theme.muted)
                    }
                    .glassCard()
                    .padding(16)
                }
            }
        } else if app.loadFailed == ref {
            LoadFailed(ref: ref)
        } else {
            Skeleton()
        }
    }
}

/// The conversation did not load: why, and Try again (never an endless skeleton).
struct LoadFailed: View {
    @Environment(AppModel.self) private var app
    let ref: PhoneChatRef
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(app.loadFailure ?? "It did not load.").foregroundStyle(Theme.ink)
            HStack(spacing: 8) {
                Button("Try again") { Task { await app.load(ref) } }
                    .buttonStyle(.glassProminent).tint(Theme.ink.opacity(0.9)).foregroundStyle(Theme.page)
                Button("Back to Chats") { app.chatPath = [] }.buttonStyle(.glass)
            }
        }
        .glassCard()
        .padding(16)
        .frame(maxHeight: .infinity, alignment: .top)
    }
}

/// Below a terminal's conversation: its screen (no transcript yet), its open asks, and how it ended.
struct TerminalFooter: View {
    @Environment(AppModel.self) private var app
    let t: PhoneSession.Terminal
    let empty: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if t.source == "screen", let screen = t.screen, !screen.isEmpty {
                Text(screen).font(.system(.footnote, design: .monospaced)).foregroundStyle(Theme.soft)
                    .textSelection(.enabled)
                    .padding(12).frame(maxWidth: .infinity, alignment: .leading)
                    .background(Theme.page.opacity(0.6), in: .rect(cornerRadius: 12))
                    .accessibilityLabel("What the terminal shows")
            } else if empty && !t.ended {
                Text(t.activity.map { "\($0). Its words show here as it works." } ?? "It runs in a terminal on your Mac. Its words show here as it works; send a message below.")
                    .font(.subheadline).foregroundStyle(Theme.muted).frame(maxWidth: .infinity)
            }
            ForEach(t.asks ?? []) { a in AskCard(ask: a, inChat: true) }
            if t.ended {
                if t.canContinue == true {
                    VStack(alignment: .leading, spacing: 10) {
                        Text(empty ? "This session ended. Continue it and it picks up where it stopped, on your Mac." : "This session ended. Continue it and it picks up right here, on your Mac.")
                            .foregroundStyle(Theme.muted)
                        Button("Continue") { Task { await app.continueSession() } }
                            .buttonStyle(.glassProminent).tint(Theme.ink.opacity(0.9)).foregroundStyle(Theme.page)
                            .disabled(app.busy.contains("continue"))
                    }
                    .glassCard(radius: 18)
                } else {
                    Text(empty ? "This session ended, and it left nothing to read here. Open it on your Mac." : "This session ended. Open it on your Mac to start it again.")
                        .font(.caption).foregroundStyle(Theme.faint).frame(maxWidth: .infinity)
                }
            }
        }
    }
}

/// A conversation's scroll: it opens at the newest message and stays there as the chat grows (new lines, a card that
/// comes or goes, the keyboard). Once the reader scrolls up it keeps their place until they come back down.
///
/// Its rows are a plain stack, not a lazy one: a lazy stack only estimates the height of rows it has not drawn, so a
/// jump to its end can land past every drawn row (a black screen until the reader swipes, QA PQ-01 and PQ-20), its
/// distance from the end reads hundreds of points off, and a fling can snap to the end. Every row laid out keeps all
/// of that exact; a long chat shows its newest `ChatFollow.page` rows, with "Show earlier messages" above them.
struct ChatScroll: View {
    @Environment(AppModel.self) private var app
    let lines: [ChatLine]
    let queue: [ChatQueued]
    let busy: Bool
    var footer: AnyView? = nil

    @State private var position = ScrollPosition(edge: .bottom)
    /// at the newest message (or put there): growth keeps it there
    @State private var pinned = true
    /// the reader's finger (or its fling) moves it: their scroll decides `pinned`
    @State private var reading = false
    @State private var atEnd = true
    /// the reader's finger took it toward older messages (only their drag counts: a bounce, or a reply growing under
    /// a flick, moves it too)
    @State private var movedUp = false
    @State private var dragging = false
    @State private var dragFrom: CGFloat = 0
    @State private var offset: CGFloat = 0
    /// the oldest row shown (nil: the newest page)
    @State private var first: String?
    @Environment(\.scenePhase) private var scene

    var body: some View {
        let from = ChatFollow.start(ids: lines.map(\.id), first: first)
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    if from > 0 {
                        Button("Show earlier messages") {
                            let top = lines[from].id
                            first = lines[ChatFollow.earlier(from)].id
                            pinned = false
                            // the row that was on top stays where it was
                            DispatchQueue.main.async { proxy.scrollTo(top, anchor: .top) }
                        }
                        .font(.subheadline).buttonStyle(.glass)
                        .frame(maxWidth: .infinity)
                    }
                    // a row is drawn again only when it changed (a streamed word redraws its own row, not the page)
                    ForEach(lines[from...]) { l in ChatLineRow(line: l).equatable().id(l.id) }
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
                    if let footer { footer }
                }
                .padding(.horizontal, 14).padding(.top, 8).padding(.bottom, 4)
            }
            .scrollPosition($position)
            .defaultScrollAnchor(.bottom, for: .initialOffset)
            .scrollDismissesKeyboard(.interactively)
            // the reader's own scroll: pinned again once they come back to the end
            .onScrollPhaseChange { old, phase in
                dragging = phase == .interacting
                switch phase {
                case .interacting:
                    reading = true
                    dragFrom = offset
                    movedUp = false
                case .idle:
                    if reading || old == .decelerating {
                        pinned = ChatFollow.afterScroll(pinned: pinned, atEnd: atEnd, movedUp: movedUp)
                        // a flick at the end while the reply grew: its end moved on, catch up with it
                        if pinned && !atEnd { toBottom() }
                    }
                    reading = false
                default: break
                }
            }
            .onScrollGeometryChange(for: ChatFollow.Spot.self) { g in
                ChatFollow.Spot(offset: g.contentOffset.y, gap: g.contentSize.height + g.contentInsets.bottom - (g.contentOffset.y + g.containerSize.height))
            } action: { _, s in
                offset = s.offset
                if dragging && s.offset < dragFrom - 2 { movedUp = true }
                atEnd = s.atEnd
                if reading { pinned = ChatFollow.afterScroll(pinned: pinned, atEnd: atEnd, movedUp: movedUp) }
            }
            // anything that changes the content's or the window's height (a line, a streamed word, a card, the keyboard):
            // a pinned chat follows it to the bottom, after layout
            .onScrollGeometryChange(for: [CGFloat].self) { g in [g.contentSize.height, g.containerSize.height] } action: { _, _ in
                if pinned && !reading { toBottom() }
            }
            .onChange(of: lines.last) { _, _ in
                guard pinned && !reading else { return }
                // at the newest message: older rows past a page leave the top (nobody is looking at them)
                if let f = ChatFollow.trim(ids: lines.map(\.id), from: from) { first = f }
                toBottom()
            }
            // the reader left the end: the rows they see stay put as new ones come (the page stops sliding)
            .onChange(of: pinned) { _, p in
                if !p && first == nil && !lines.isEmpty { first = lines[ChatFollow.start(ids: lines.map(\.id), first: nil)].id }
            }
            // you sent something: back to the newest message
            .onChange(of: app.sentTick) { _, _ in pinned = true; toBottom() }
            // opened, a fresh snapshot (back from the background, after a gap), or the app active again: its rows lay out
            // anew (markdown measures late). A reader at the end is put back there once they did.
            .task(id: "\(app.snapshotTick)/\(scene == .active)") {
                guard scene == .active else { return }
                var waited: UInt64 = 0
                for at in ChatFollow.settle {
                    if at > waited { try? await Task.sleep(nanoseconds: at - waited); waited = at }
                    if Task.isCancelled { return }
                    if pinned && !reading { toBottom() }
                }
            }
        }
    }

    private func toBottom() {
        DispatchQueue.main.async { position.scrollTo(edge: .bottom) }
    }
}

/// One row of a conversation, compared by its line: the page's other rows skip their body (and their markdown parse)
/// while one streams.
struct ChatLineRow: View, Equatable {
    let line: ChatLine
    var body: some View { ChatLineView(line: line) }
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
        } else if app.loadFailed == ref {
            LoadFailed(ref: ref)
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
    /// it cannot take a message now (the placeholder says why): Send is off
    var held: Bool = false
    /// a line above the field (why Send is off)
    var note: String? = nil
    var onSend: () -> Void
    var accessory: AnyView? = nil
    /// the message's photos (nil: this one takes words only)
    var photos: PhotoDraft? = nil

    private var empty: Bool {
        text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && (photos?.items.isEmpty ?? true)
    }

    var body: some View {
        VStack(spacing: 8) {
            if let accessory { accessory }
            if let note = note ?? photos?.note {
                Text(note).font(.footnote).foregroundStyle(Theme.soft)
                    .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 6)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let photos, !photos.items.isEmpty || photos.loading > 0 { PhotoStrip(photos: photos) }
            GlassEffectContainer(spacing: 8) {
                HStack(alignment: .bottom, spacing: 8) {
                    if let photos { PhotoButton(photos: photos).disabled(busy || held) }
                    TextField(placeholder, text: $text, axis: .vertical)
                        .lineLimit(1...6)
                        .padding(.horizontal, 16).padding(.vertical, 12)
                        // tinted dark: the conversation scrolling under it never shows through the words
                        .background(Theme.page.opacity(0.85), in: .rect(cornerRadius: 22))
                        .glassEffect(.regular.tint(Theme.page.opacity(0.6)).interactive(), in: .rect(cornerRadius: 22))
                    Button(action: onSend) {
                        Image(systemName: "arrow.up").font(.body.weight(.semibold)).frame(width: 26, height: 30)
                    }
                    .buttonStyle(.glassProminent)
                    .tint(Theme.ink.opacity(0.92))
                    .foregroundStyle(Theme.page)
                    .buttonBorderShape(.circle)
                    // a photo still being fitted goes with the message: Send waits for it
                    .disabled(busy || held || empty || (photos?.loading ?? 0) > 0)
                    .accessibilityLabel("Send")
                }
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
        .background(alignment: .bottom) {
            // the page fades in behind the composer, so text passing under it is never under the field's words
            LinearGradient(colors: [Theme.page.opacity(0), Theme.page.opacity(0.92)], startPoint: .top, endPoint: .init(x: 0.5, y: 0.3))
                .ignoresSafeArea(edges: .bottom)
                .allowsHitTesting(false)
        }
    }
}

/// Photos for the message, from the library (picking needs no permission; no camera).
struct PhotoButton: View {
    let photos: PhotoDraft
    @State private var picked: [PhotosPickerItem] = []

    var body: some View {
        PhotosPicker(selection: $picked, maxSelectionCount: max(1, photos.room), matching: .images) {
            Image(systemName: "photo").font(.body.weight(.semibold)).frame(width: 26, height: 30)
        }
        .buttonStyle(.glass)
        .buttonBorderShape(.circle)
        .disabled(photos.room == 0)
        .accessibilityLabel("Add photos")
        .onChange(of: picked) { _, list in
            guard !list.isEmpty else { return }
            picked = []
            Task { await photos.add(list) { try? await $0.loadTransferable(type: Data.self) } }
        }
    }
}

/// The photos going with the message, each with its remove button; a spinner for one still being fitted.
struct PhotoStrip: View {
    let photos: PhotoDraft

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(photos.items) { a in
                    Image(uiImage: a.preview).resizable().scaledToFill()
                        .frame(width: 56, height: 56)
                        .clipShape(.rect(cornerRadius: 12))
                        .overlay(alignment: .topTrailing) {
                            Button { photos.remove(a.id) } label: {
                                Image(systemName: "xmark.circle.fill").font(.body).symbolRenderingMode(.palette)
                                    .foregroundStyle(Theme.page, Theme.ink.opacity(0.9))
                            }
                            .offset(x: 6, y: -6)
                            .accessibilityLabel("Remove photo")
                        }
                }
                ForEach(0..<photos.loading, id: \.self) { _ in
                    ProgressView().frame(width: 56, height: 56)
                        .background(Theme.panel, in: .rect(cornerRadius: 12))
                }
            }
            .padding(.top, 6).padding(.horizontal, 6)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
