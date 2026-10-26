import Foundation
import UIKit
import UserNotifications

/// Push notifications, client side (docs/IOS.md). The app asks for permission, registers with APNs and hands the device
/// token to `PushRegistration`. The relay that would send a push when something needs the founder is not built yet
/// (RA5: the Mac can not reach APNs by itself, and a relay must never see the work): until then `register` keeps the token
/// on the phone only and sends nothing anywhere.
protocol PushRegistration: Sendable {
    /// a new or changed APNs device token, and the Mac it is for
    func register(apnsToken: String, mac: String) async throws
    func unregister() async
}

/// The stub: remembers the token locally so Settings can show "ready", sends nothing.
struct DeferredPushRegistration: PushRegistration {
    static let key = "principia.push.token"
    func register(apnsToken: String, mac: String) async throws {
        UserDefaults.standard.set(apnsToken, forKey: Self.key)
    }
    func unregister() async {
        UserDefaults.standard.removeObject(forKey: Self.key)
    }
}

@MainActor
final class PushManager: ObservableObject {
    static let shared = PushManager()
    @Published private(set) var status: UNAuthorizationStatus = .notDetermined
    @Published private(set) var token: String?
    @Published private(set) var error: String?
    var registration: PushRegistration = DeferredPushRegistration()
    var mac: String?

    func refresh() async {
        status = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
        token = UserDefaults.standard.string(forKey: DeferredPushRegistration.key)
    }

    /// asks once (the system shows its own prompt), then registers with APNs
    func enable() async {
        do {
            let ok = try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound])
            await refresh()
            if ok { UIApplication.shared.registerForRemoteNotifications() }
        } catch {
            self.error = error.localizedDescription
        }
    }

    func didRegister(_ deviceToken: Data) {
        let hex = deviceToken.map { String(format: "%02x", $0) }.joined()
        token = hex
        error = nil
        guard let mac else { return }
        Task { try? await registration.register(apnsToken: hex, mac: mac) }
    }

    func didFail(_ e: Error) {
        // a build without the Push Notifications capability (a free personal team) lands here: fine, nothing breaks
        error = e.localizedDescription
    }
}

final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        return true
    }
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        Task { @MainActor in PushManager.shared.didRegister(deviceToken) }
    }
    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        Task { @MainActor in PushManager.shared.didFail(error) }
    }
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .list]
    }
}
