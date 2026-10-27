import SwiftUI

/// The team room (Forum channels): read, post, @mention an agent and it answers here.
struct RoomView: View {
    @Environment(AppModel.self) private var app
    @State private var draft = ""
    @State private var whoOpen = false

    var body: some View {
        Group {
            if let r = app.room {
                if !r.enabled {
                    ScrollView {
                        EmptyState(title: "The team room is off", line: r.message ?? "Turn on Companies and Departments on your Mac.", art: .forum).padding(.top, 30)
                    }
                } else {
                    content(r)
                        .safeAreaInset(edge: .bottom) {
                            Composer(text: $draft, placeholder: "Message \(label(r))", busy: app.busy.contains("post"), onSend: {
                                let t = draft
                                draft = ""
                                Task { if !(await app.post(t)) { draft = t } }
                            }, accessory: mentions(r))
                        }
                }
            } else {
                Skeleton()
            }
        }
        .navigationTitle("")
    }

    private func label(_ r: PhoneRoom) -> String {
        r.channels.first { $0.id == r.channelId }?.label ?? "#general"
    }

    private func mentions(_ r: PhoneRoom) -> AnyView? {
        guard let q = Words.mentionQuery(draft) else { return nil }
        let list = Words.mentionMatches(r.members, query: q, me: r.me)
        guard !list.isEmpty else { return nil }
        return AnyView(
            ScrollView(.horizontal, showsIndicators: false) {
                GlassEffectContainer(spacing: 6) {
                    HStack(spacing: 6) {
                        ForEach(list) { m in
                            Button("@\(m.handle)") { draft = Words.insertMention(draft, handle: m.handle) }.buttonStyle(.glass)
                        }
                    }
                }
            }
        )
    }

    private func content(_ r: PhoneRoom) -> some View {
        let by = Dictionary(r.members.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        let agents = r.members.filter { $0.kind == "agent" }
        return ScrollView {
            LazyVStack(alignment: .leading, spacing: 10) {
                if r.messages.isEmpty {
                    Text("Say hello. @mention an agent and it answers here.").font(.subheadline).foregroundStyle(Theme.faint).frame(maxWidth: .infinity).padding(.vertical, 30)
                }
                ForEach(r.messages) { m in message(m, by: by, me: r.me) }
                ForEach(r.answering ?? [], id: \.self) { n in
                    HStack(spacing: 8) { Tile(kind: .run); Text("\(n) is replying…").font(.footnote).foregroundStyle(Theme.muted) }
                }
            }
            .padding(.horizontal, 14).padding(.bottom, 8)
        }
        .defaultScrollAnchor(.bottom)
        .scrollDismissesKeyboard(.interactively)
        .refreshable { await app.refresh([.room]) }
        // the channel and who's who stay right under the top bar; the messages scroll beneath them, never through them
        .safeAreaInset(edge: .top, spacing: 0) {
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 10) {
                    if r.channels.count > 1 {
                        Menu {
                            ForEach(r.channels) { c in Button(c.label) { Task { await app.setChannel(c.id) } } }
                        } label: {
                            HStack(spacing: 6) {
                                Text(label(r)).font(Theme.display(15, semibold: true)).lineLimit(1).minimumScaleFactor(0.6)
                                Image(systemName: "chevron.down").font(.caption2)
                            }
                            .padding(.horizontal, 4)
                        }
                        .buttonStyle(.glass)
                    } else {
                        Text(label(r)).font(Theme.display(18, semibold: true)).foregroundStyle(Theme.ink)
                    }
                    Spacer()
                    if !agents.isEmpty {
                        Button { withAnimation(.smooth) { whoOpen.toggle() } } label: {
                            Text("\(agents.count) agent\(agents.count == 1 ? "" : "s") · who's who").font(.footnote).lineLimit(1).minimumScaleFactor(0.7)
                        }
                        .buttonStyle(.glass)
                    }
                }
                .padding(.top, 4)
                if whoOpen {
                    VStack(spacing: 0) {
                        ForEach(Array(agents.enumerated()), id: \.element.id) { i, m in
                            if i > 0 { Divider().overlay(Theme.line) }
                            Button { draft = Words.insertMention(draft.hasSuffix(" ") || draft.isEmpty ? draft + "@" : draft + " @", handle: m.handle) } label: {
                                HStack {
                                    Text(m.name).fontWeight(.semibold).foregroundStyle(Theme.ink)
                                    Text(m.role ?? "").foregroundStyle(Theme.muted).lineLimit(1)
                                    Spacer()
                                    Text("@\(m.handle)").font(.footnote).foregroundStyle(Theme.faint)
                                }
                                .padding(.vertical, 11)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .padding(.horizontal, 14)
                    .glassEffect(.regular, in: .rect(cornerRadius: 18))
                }
            }
            .padding(.horizontal, 14).padding(.bottom, 8)
            .background(Theme.page.opacity(0.94).ignoresSafeArea(edges: .top))
        }
    }

    @ViewBuilder private func message(_ m: PhoneRoomMessage, by: [String: PhoneRoomMember], me: String?) -> some View {
        if m.kind == "system" {
            Text(m.text).font(.caption).foregroundStyle(Theme.faint).frame(maxWidth: .infinity)
        } else if m.authorId == me {
            VStack(alignment: .trailing, spacing: 4) {
                Text(m.text).foregroundStyle(Theme.ink)
                    .padding(.horizontal, 13).padding(.vertical, 10)
                    .glassEffect(.regular.tint(Color.white.opacity(0.10)), in: .rect(cornerRadius: 18))
                Text(Words.ago(m.at)).font(.caption2).foregroundStyle(Theme.faint)
            }
            .frame(maxWidth: .infinity, alignment: .trailing)
            .padding(.leading, 40)
        } else {
            let a = by[m.authorId]
            HStack(alignment: .top, spacing: 10) {
                Face(who: a.map { PhoneWho(name: $0.name, role: $0.role ?? "", bust: $0.kind == "agent" ? $0.name : nil) }, size: 30)
                VStack(alignment: .leading, spacing: 6) {
                    Text("\(m.threadId != nil ? "↳ " : "")\(a.map { "\($0.name)\($0.role.map { " · \($0)" } ?? "")" } ?? "Someone")")
                        .font(.caption).foregroundStyle(Theme.faint)
                    MarkdownView(m.text)
                    Text(Words.ago(m.at)).font(.caption2).foregroundStyle(Theme.faint)
                }
                .padding(12)
                .glassEffect(.regular, in: .rect(cornerRadius: 18))
            }
            .padding(.leading, m.threadId != nil ? 22 : 0)
            .padding(.trailing, 24)
        }
    }
}
