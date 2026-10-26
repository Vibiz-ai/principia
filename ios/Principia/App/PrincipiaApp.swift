import SwiftUI

@main
struct PrincipiaApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @State private var app = AppModel()
    @Environment(\.scenePhase) private var scene

    init() {
        // badges in white, like the web app's (no red anywhere but a failed step)
        let light = UIColor(red: 0.929, green: 0.945, blue: 0.949, alpha: 1)
        let dark = UIColor(red: 0.039, green: 0.047, blue: 0.051, alpha: 1)
        let item = UITabBarItemAppearance()
        for st in [item.normal, item.selected] {
            st.badgeBackgroundColor = light
            st.badgeTextAttributes = [.foregroundColor: dark]
        }
        let bar = UITabBarAppearance()
        bar.configureWithDefaultBackground()
        bar.stackedLayoutAppearance = item
        bar.inlineLayoutAppearance = item
        bar.compactInlineLayoutAppearance = item
        UITabBar.appearance().standardAppearance = bar
        UITabBar.appearance().scrollEdgeAppearance = bar
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(app)
                .preferredColorScheme(.dark)
                .tint(Theme.ink)
                .task {
                    await app.boot()
                    #if DEBUG
                    // simulator checks (docs/IOS.md): SIMCTL_CHILD_PRINCIPIA_OPEN_URL=principia://… opens a link at launch
                    if let u = ProcessInfo.processInfo.environment["PRINCIPIA_OPEN_URL"].flatMap(URL.init(string:)) { app.handle(url: u) }
                    if ProcessInfo.processInfo.environment["PRINCIPIA_AUTOPAIR"] == "1", case .pair(let l) = app.phase { await app.pair(l) }
                    #endif
                }
                .onOpenURL { url in app.handle(url: url) }
                .onChange(of: scene) { _, s in
                    switch s {
                    case .active: Task { await app.foreground() }
                    case .background: app.background()
                    default: break
                    }
                }
        }
    }
}
