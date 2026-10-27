import SwiftUI

struct RootView: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        ZStack(alignment: .bottom) {
            switch app.phase {
            case .boot:
                VStack(spacing: 18) {
                    ArchMark(size: 72)
                    ProgressView().tint(Theme.muted)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .stone()
            case .pair(let link):
                PairView(link: link)
            case .out(.gone):
                WaitingForMacView()
            case .out(let reason):
                SignedOutView(reason: reason)
            case .main:
                MainTabs()
            }
            if let t = app.toast {
                Toast(text: t).padding(.bottom, app.phase == .main ? 70 : 12)
            }
        }
        .animation(.smooth, value: app.toast)
        .overlay {
            if app.locked { LockView() }
        }
    }
}

struct MainTabs: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        TabView(selection: Binding(get: { app.tab }, set: { app.selectTab($0) })) {
            Tab("Now", systemImage: "waveform.path.ecg", value: AppTab.now) {
                Screen { NowView() }
            }
            Tab("Needs you", systemImage: "exclamationmark.triangle", value: AppTab.needs) {
                Screen { NeedsView() }
            }
            .badge(app.needs?.count ?? app.company?.needs ?? 0)
            Tab("Chats", systemImage: "bubble.left.and.text.bubble.right", value: AppTab.chats) {
                ChatsTab()
            }
            Tab("Team room", systemImage: "person.3", value: AppTab.room) {
                Screen { RoomView() }
            }
        }
        .tabBarMinimizeBehavior(.onScrollDown)
        .sheet(isPresented: Binding(get: { app.showSettings }, set: { app.showSettings = $0 })) { SettingsView() }
        .tint(Theme.ink)
    }
}

/// One tab's stack: the company on top, the live tile, Pause, Settings.
struct Screen<Content: View>: View {
    @ViewBuilder var content: () -> Content
    var body: some View {
        NavigationStack {
            content()
                .stone()
                .toolbar { TopBar() }
                .toolbarBackground(.hidden, for: .navigationBar)
                // what scrolls under the floating company and Pause buttons fades out, never under their words
                .scrollEdgeEffectStyle(.hard, for: .top)
        }
    }
}

struct TopBar: ToolbarContent {
    @Environment(AppModel.self) private var app
    @State private var confirmPause = false

    var body: some ToolbarContent {
        ToolbarItem(placement: .topBarLeading) {
            Menu {
                Picker("Company", selection: Binding(get: { app.companyId ?? "" }, set: { app.selectCompany($0) })) {
                    ForEach(app.me?.companies ?? []) { c in
                        Text(c.needs > 0 ? "\(c.name) (\(c.needs))" : c.name).tag(c.id)
                    }
                }
            } label: {
                HStack(spacing: 6) {
                    Text(app.company?.name ?? "Principia").font(Theme.display(15, semibold: true)).lineLimit(1)
                    Image(systemName: "chevron.down").font(.caption2.weight(.semibold)).foregroundStyle(Theme.muted)
                }
                .padding(.horizontal, 6)
                .frame(maxWidth: app.inDemo ? 160 : 210)
            }
            .accessibilityLabel("Company: \(app.company?.name ?? "")")
        }
        if app.inDemo {
            // its own item, beside the company: the trailing group keeps Pause and Settings
            ToolbarItem(placement: .topBarLeading) { DemoBadge() }
        }
        ToolbarItemGroup(placement: .topBarTrailing) {
            if !app.inDemo {
                HStack(spacing: 6) {
                    Tile(kind: app.online ? .ok : .quiet)
                    if !app.online { Text("Offline").font(.caption).foregroundStyle(Theme.faint) }
                }
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(app.online ? "Connected to your Mac" : "Reconnecting")
            }
            if let c = app.company, !c.personal {
                Button {
                    confirmPause = true
                } label: {
                    Image(systemName: c.paused ? "play.fill" : "pause.fill")
                }
                .accessibilityLabel(c.paused ? "Resume \(c.name)" : "Pause \(c.name)")
                .disabled(app.busy.contains("pause"))
                .confirmationDialog(c.paused ? "Resume \(c.name)?" : "Pause \(c.name)?", isPresented: $confirmPause, titleVisibility: .visible) {
                    Button(c.paused ? "Resume" : "Pause") { Task { await app.setPaused(!c.paused) } }
                } message: {
                    Text(c.paused ? "Agents pick their work up again and schedules run." : "Agents start nothing new and schedules wait. Work in progress is saved.")
                }
            }
            Button { app.showSettings = true } label: { Image(systemName: "gearshape") }
                .accessibilityLabel("Settings")
        }
    }
}

/// "DEMO" on every screen of the sample company; a tap offers the way out to pairing a real Mac.
struct DemoBadge: View {
    @Environment(AppModel.self) private var app
    @State private var ask = false
    var body: some View {
        Button { ask = true } label: {
            Text("DEMO").font(Theme.display(10, semibold: true)).tracking(1.6).foregroundStyle(Theme.ink)
                .lineLimit(1).fixedSize()
                .padding(.horizontal, 7).padding(.vertical, 3)
                .overlay(Capsule().stroke(Color.white.opacity(0.45)))
                .fixedSize()
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Demo company")
        .accessibilityHint("Leave the demo and pair your Mac")
        .accessibilityIdentifier("demo-badge")
        .confirmationDialog("This is a sample company", isPresented: $ask, titleVisibility: .visible) {
            Button("Pair your Mac") { app.exitDemo() }
            Button("Keep looking", role: .cancel) {}
        } message: {
            Text("Everything here is made up and stays on this phone. Pair your Mac to see your own company.")
        }
    }
}

/// The demo's first card on Now: what this is and the way out.
struct DemoCard: View {
    @Environment(AppModel.self) private var app
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("DEMO COMPANY").font(Theme.kicker).tracking(2.4).foregroundStyle(Theme.muted)
            Text("A sample company, on this phone only. Open a chat, answer what needs you, look at the board: nothing is sent anywhere.")
                .font(.subheadline).foregroundStyle(Theme.soft)
            Button { app.exitDemo() } label: {
                Label("Pair your Mac", systemImage: "qrcode.viewfinder").font(.subheadline.weight(.semibold))
            }
            .buttonStyle(.glass)
        }
        .glassCard(radius: 20)
    }
}

/// Face ID before anything shows (Settings › Lock with Face ID).
struct LockView: View {
    @Environment(AppModel.self) private var app
    var body: some View {
        VStack(spacing: 22) {
            ArchMark(size: 80)
            Text("PRINCIPIA").font(Theme.display(28, semibold: true)).tracking(4).foregroundStyle(Theme.ink)
            Button { Task { await app.unlock() } } label: {
                Label("Unlock", systemImage: "faceid").padding(.horizontal, 18).padding(.vertical, 6)
            }
            .buttonStyle(.glass)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.page.ignoresSafeArea())
        .task { await app.unlock() }
    }
}
