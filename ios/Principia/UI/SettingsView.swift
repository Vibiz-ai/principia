import SwiftUI

struct SettingsView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    @ObservedObject private var push = PushManager.shared
    @State private var confirmSignOut = false

    var body: some View {
        @Bindable var app = app
        NavigationStack {
            Form {
                Section {
                    LabeledContent("Mac", value: app.macHost)
                    LabeledContent("This phone", value: app.paired?.deviceName ?? "")
                    if let at = app.paired?.pairedAt {
                        LabeledContent("Paired", value: at.formatted(date: .abbreviated, time: .shortened))
                    }
                } header: { Text("Your Mac") } footer: {
                    Text("This app keeps only the key to your Mac, in the Keychain. Your work stays on the Mac. Revoke this phone there any time: Settings › App › Phone.")
                }
                Section {
                    Toggle("Lock with Face ID", isOn: $app.lockEnabled)
                } footer: { Text("Asks for Face ID (or your passcode) each time Principia opens.") }
                Section {
                    switch push.status {
                    case .authorized, .provisional, .ephemeral:
                        LabeledContent("Notifications", value: push.token == nil ? "Allowed" : "Ready")
                    case .denied:
                        LabeledContent("Notifications", value: "Off in iOS Settings")
                    default:
                        Button("Allow notifications") { Task { await push.enable() } }
                    }
                } footer: {
                    Text("Pushes for \"needs you\" come with the Principia relay, which is not live yet. Allowing now only gets this phone ready.")
                }
                Section {
                    Button("Sign out on this phone and the Mac", role: .destructive) { confirmSignOut = true }
                    Button("Forget this Mac", role: .destructive) { app.forget(); dismiss() }
                }
            }
            .scrollContentBackground(.hidden)
            .background(Theme.page)
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done", systemImage: "checkmark") { dismiss() } } }
            .confirmationDialog("Sign out?", isPresented: $confirmSignOut, titleVisibility: .visible) {
                Button("Sign out", role: .destructive) { Task { await app.signOut(); dismiss() } }
            } message: { Text("Your Mac removes this phone. Scan a new code to pair again.") }
            .task { await push.refresh() }
        }
        .presentationDetents([.medium, .large])
    }
}
