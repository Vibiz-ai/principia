import SwiftUI

/// The board, read only (REMOTE.md RA3): what the team plans, works on, waits on you for, and finished this week.
/// Reached from Now. Changing tasks stays on the Mac; a task that waits on you has the same actions as Needs you.
struct TasksView: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        ScrollView {
            if let b = app.board {
                VStack(alignment: .leading, spacing: 12) {
                    Text("The board").font(Theme.display(30)).foregroundStyle(Theme.ink).padding(.top, 4)
                    Text("Read only. Change tasks on your Mac.").font(.subheadline).foregroundStyle(Theme.muted)
                    if b.planned.isEmpty && b.working.isEmpty && b.needs.isEmpty && b.done.isEmpty {
                        Text("Nothing on the board yet. When your team plans work, it shows here.")
                            .font(.subheadline).foregroundStyle(Theme.muted).glassCard(radius: 18)
                    } else {
                        group("Needs you", b.needs, none: "Nothing waits on you.")
                        group("Working", b.working, none: "No one is working on a task right now.")
                        group("Planned", b.planned, none: "Nothing planned yet.")
                        if b.more > 0 {
                            Text("And \(b.more) more on your Mac.").font(.footnote).foregroundStyle(Theme.faint)
                        }
                        group("Done this week", b.done, none: "Nothing finished this week.")
                    }
                }
                .padding(.horizontal, 16).padding(.bottom, 24)
            } else {
                Skeleton()
            }
        }
        .stone()
        .navigationTitle("Board")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await app.loadBoard() }
        .task { await app.loadBoard() }
        .onAppear { app.boardViews += 1 }
        .onDisappear { app.boardViews = max(0, app.boardViews - 1) }
    }

    @ViewBuilder
    private func group(_ title: String, _ rows: [PhoneTaskRow], none: String) -> some View {
        SectionLabel(rows.isEmpty ? title : "\(title) · \(rows.count)")
        if rows.isEmpty {
            Text(none).font(.subheadline).foregroundStyle(Theme.muted).glassCard(radius: 18)
        } else {
            VStack(spacing: 0) {
                ForEach(Array(rows.enumerated()), id: \.element.id) { i, r in
                    if i > 0 { Divider().overlay(Theme.line) }
                    NavigationLink { TaskDetailView(taskId: r.id) } label: { TaskRowView(r: r) }
                        .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 16)
            .glassEffect(.regular, in: .rect(cornerRadius: 22))
        }
    }
}

struct TaskRowView: View {
    let r: PhoneTaskRow
    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Tile(kind: tile).padding(.top, 7)
            VStack(alignment: .leading, spacing: 2) {
                Text(r.title).fontWeight(.semibold).foregroundStyle(Theme.ink).multilineTextAlignment(.leading)
                let sub = [r.who?.name, r.column == .planned || r.column == .done ? PhoneTaskDetail.statusWords(r.status) : nil].compactMap { $0 }.joined(separator: " · ")
                Text(sub.isEmpty ? r.identifier : sub).font(.subheadline).foregroundStyle(Theme.muted)
                if let l = r.line {
                    Text(l).font(r.column == .working ? .subheadline : .footnote).foregroundStyle(r.column == .working ? Theme.soft : Theme.muted).lineLimit(2)
                }
            }
            Spacer(minLength: 4)
            VStack(alignment: .trailing, spacing: 6) {
                Text(Words.ago(r.at)).font(.caption).foregroundStyle(Theme.faint).monospacedDigit()
                Image(systemName: "chevron.right").font(.caption2.weight(.semibold)).foregroundStyle(Theme.faint)
            }
        }
        .padding(.vertical, 14)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
    private var tile: Tile.Kind {
        switch r.column {
        case .planned: return .quiet
        case .working: return .run
        case .needs: return .needs
        case .done: return .ok
        }
    }
}

struct TaskDetailView: View {
    @Environment(AppModel.self) private var app
    let taskId: String

    var body: some View {
        ScrollView {
            if let t = app.boardTask, t.id == taskId {
                VStack(alignment: .leading, spacing: 12) {
                    Text(t.identifier).font(Theme.display(11, semibold: true)).tracking(2).foregroundStyle(Theme.muted).padding(.top, 4)
                    Text(t.title).font(Theme.display(24)).foregroundStyle(Theme.ink)
                    VStack(alignment: .leading, spacing: 8) {
                        fact("Status", PhoneTaskDetail.statusWords(t.status))
                        fact("Assigned to", t.who?.name ?? "No one yet")
                        if let l = t.line { fact(t.column == .working ? "Now" : "Why", l) }
                        fact("Created", date(t.createdAt))
                        fact("Updated", "\(date(t.updatedAt)) (\(Words.ago(t.updatedAt)))")
                    }
                    .glassCard(radius: 18)
                    if let n = t.need { TaskCard(t: n) }
                    if let s = t.summary {
                        SectionLabel("Report")
                        LongText(text: s).glassCard(radius: 18)
                    }
                    if let d = t.doneNote, d != t.summary {
                        Text(d).font(.subheadline).foregroundStyle(Theme.soft).glassCard(radius: 18)
                    }
                    SectionLabel("Description")
                    if t.description.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                        Text("No description.").font(.subheadline).foregroundStyle(Theme.muted).glassCard(radius: 18)
                    } else {
                        LongText(text: t.description).glassCard(radius: 18)
                    }
                }
                .padding(.horizontal, 16).padding(.bottom, 24)
            } else {
                Skeleton()
            }
        }
        .stone()
        .navigationTitle("Task")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await app.loadBoardTask(taskId) }
        .task { await app.loadBoardTask(taskId) }
        .onAppear { app.boardViews += 1 }
        .onDisappear { app.boardViews = max(0, app.boardViews - 1) }
    }

    private func fact(_ k: String, _ v: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text(k).font(.subheadline).foregroundStyle(Theme.muted).frame(width: 96, alignment: .leading)
            Text(v).font(.subheadline).foregroundStyle(Theme.ink).frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func date(_ s: String) -> String {
        Words.date(s)?.formatted(date: .abbreviated, time: .shortened) ?? s
    }
}
