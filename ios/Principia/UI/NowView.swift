import SwiftUI

struct NowView: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        ScrollView {
            if let n = app.now {
                VStack(alignment: .leading, spacing: 12) {
                    if app.inDemo { DemoCard().padding(.top, 4) }
                    Text(n.name).font(Theme.display(30)).foregroundStyle(Theme.ink).padding(.top, 4)
                    Text(Words.headline(working: n.working.count, needs: n.needs, paused: n.paused)).foregroundStyle(Theme.soft)
                    if n.paused {
                        HStack(spacing: 10) {
                            Image(systemName: "pause").foregroundStyle(Theme.ink)
                            Text("\(n.name) is paused. Agents start nothing new and schedules wait.").font(.subheadline).foregroundStyle(Theme.soft)
                        }
                        .glassCard(radius: 18)
                    }
                    if n.needs > 0 {
                        Button { app.selectTab(.needs) } label: {
                            HStack(spacing: 12) {
                                Rectangle().fill(Theme.page).frame(width: 8, height: 8)
                                Text("\(n.needs) thing\(n.needs == 1 ? "" : "s") need\(n.needs == 1 ? "s" : "") you").fontWeight(.semibold)
                                Spacer()
                                Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).opacity(0.6)
                            }
                            .padding(.vertical, 8)
                        }
                        .buttonStyle(.glassProminent)
                        .tint(Theme.ink.opacity(0.92))
                        .foregroundStyle(Theme.page)
                    }
                    NavigationLink { TasksView() } label: {
                        HStack(spacing: 12) {
                            Image(systemName: "list.bullet.rectangle").foregroundStyle(Theme.soft)
                            VStack(alignment: .leading, spacing: 2) {
                                Text("The board").fontWeight(.semibold).foregroundStyle(Theme.ink)
                                Text("What the team plans, works on and finished").font(.subheadline).foregroundStyle(Theme.muted)
                            }
                            Spacer()
                            Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(Theme.faint)
                        }
                        .glassCard(radius: 22, interactive: true)
                    }
                    .buttonStyle(.plain)
                    SectionLabel("Working now")
                    if n.working.isEmpty {
                        Text(n.paused ? "Resume to let agents pick up their work." : "No one is working right now.")
                            .font(.subheadline).foregroundStyle(Theme.muted).glassCard(radius: 18)
                    } else {
                        GlassEffectContainer(spacing: 8) {
                            VStack(spacing: 8) {
                                ForEach(n.working) { w in WorkingRow(w: w) }
                            }
                        }
                    }
                    SectionLabel("Finished lately")
                    if n.done.isEmpty {
                        Text("Nothing finished yet.").font(.subheadline).foregroundStyle(Theme.muted).glassCard(radius: 18)
                    } else {
                        VStack(spacing: 0) {
                            ForEach(Array(n.done.enumerated()), id: \.element.id) { i, d in
                                if i > 0 { Divider().overlay(Theme.line) }
                                DoneRow(d: d)
                            }
                        }
                        .padding(.horizontal, 16)
                        .glassEffect(.regular, in: .rect(cornerRadius: 22))
                    }
                }
                .padding(.horizontal, 16).padding(.bottom, 24)
            } else {
                Skeleton()
            }
        }
        .refreshable { await app.refresh([.now, .companies]) }
    }
}

struct WorkingRow: View {
    @Environment(AppModel.self) private var app
    let w: PhoneWorking
    var body: some View {
        Button {
            if let r = w.open { app.openChat(r) }
        } label: {
            HStack(alignment: .top, spacing: 12) {
                Face(who: w.who)
                VStack(alignment: .leading, spacing: 3) {
                    WhoLine(who: w.who, fallback: w.title)
                    Text(w.title).font(.subheadline).foregroundStyle(Theme.muted).lineLimit(2)
                    if let a = w.activity {
                        HStack(spacing: 7) {
                            Tile(kind: .run)
                            Text(a).font(.subheadline).foregroundStyle(Theme.soft).lineLimit(2)
                        }
                        .padding(.top, 2)
                    }
                }
                Spacer(minLength: 4)
                Text(Words.ago(w.startedAt)).font(.caption).foregroundStyle(Theme.faint).monospacedDigit()
            }
            .multilineTextAlignment(.leading)
            .glassCard(radius: 22, interactive: w.open != nil)
        }
        .buttonStyle(.plain)
        .disabled(w.open == nil)
    }
}

struct DoneRow: View {
    let d: PhoneDone
    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Tile(kind: d.status == .failed ? .fail : d.status == .review ? .needs : .ok).padding(.top, 7)
            VStack(alignment: .leading, spacing: 2) {
                Text(d.title).fontWeight(.semibold).foregroundStyle(Theme.ink)
                Text([d.who?.name, d.status == .review ? "waiting for your OK" : d.status == .failed ? "stopped" : "done"].compactMap { $0 }.joined(separator: " · "))
                    .font(.subheadline).foregroundStyle(Theme.muted)
                if let s = d.summary { Text(s).font(.footnote).foregroundStyle(Theme.muted).lineLimit(3) }
            }
            Spacer(minLength: 4)
            Text(Words.ago(d.at)).font(.caption).foregroundStyle(Theme.faint).monospacedDigit()
        }
        .padding(.vertical, 14)
    }
}

struct Skeleton: View {
    @State private var dim = false
    var body: some View {
        VStack(spacing: 10) {
            ForEach(0..<3) { i in
                RoundedRectangle(cornerRadius: 20).fill(Theme.panel).frame(height: i == 2 ? 40 : 70).frame(maxWidth: i == 2 ? 220 : .infinity, alignment: .leading)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .opacity(dim ? 0.45 : 1)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .onAppear { withAnimation(.easeInOut(duration: 0.7).repeatForever()) { dim = true } }
        .accessibilityLabel("Loading")
    }
}
