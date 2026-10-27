import SwiftUI
import VisionKit

/// "Principia" in Cinzel over the arch: the pairing and signed-out screens.
private struct Lettering: View {
    var body: some View {
        VStack(spacing: 0) {
            Plate(art: .arch)
                .overlay(LinearGradient(colors: [.clear, .clear, Theme.page], startPoint: .top, endPoint: .bottom))
                .padding(.horizontal, -16)
                .padding(.bottom, -30)
            Text("PRINCIPIA")
                .font(Theme.display(34, semibold: true))
                .tracking(4.8)
                .foregroundStyle(Theme.ink)
                .accessibilityLabel("Principia")
        }
    }
}

private struct StatusChip: View {
    let tile: Tile.Kind
    let text: String
    var body: some View {
        HStack(spacing: 9) {
            Tile(kind: tile)
            Text(text.uppercased()).font(Theme.display(10, semibold: true)).tracking(2).foregroundStyle(Theme.soft).lineLimit(1)
        }
        .padding(.horizontal, 14).frame(height: 32)
        .glassEffect(.regular, in: .capsule)
    }
}

/// Signed out, not paired yet, or the Mac is gone: scan the code, or paste the link.
struct SignedOutView: View {
    @Environment(AppModel.self) private var app
    let reason: AppModel.OutReason
    @State private var paste = ""
    @State private var pasteError: String?
    @State private var scanning = false

    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                Lettering()
                Text(line).font(.body).foregroundStyle(Theme.soft).multilineTextAlignment(.center).frame(maxWidth: 320)
                StatusChip(tile: reason == .gone || reason == .unpaired ? .quiet : .fail, text: head)
                if let e = app.outError {
                    Text(e).font(.footnote).foregroundStyle(Theme.soft).multilineTextAlignment(.center).frame(maxWidth: 320)
                }
                if reason == .gone, !app.macHost.isEmpty {
                    Text("Last address: \(app.macHost)").font(.footnote).foregroundStyle(Theme.faint)
                }
                Spacer(minLength: 18)
                GlassEffectContainer(spacing: 12) {
                    VStack(spacing: 12) {
                        Button {
                            scanning = true
                        } label: {
                            Label("Scan the code on your Mac", systemImage: "qrcode.viewfinder").frame(maxWidth: .infinity).padding(.vertical, 6)
                        }
                        .buttonStyle(.glassProminent)
                        .tint(Theme.ink.opacity(0.9))
                        .foregroundStyle(Theme.page)

                        VStack(alignment: .leading, spacing: 8) {
                            Text("Or paste the pairing link").font(.footnote).foregroundStyle(Theme.muted)
                            HStack(spacing: 8) {
                                TextField("https://…#mac=…&code=…", text: $paste)
                                    .textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
                                    .submitLabel(.go).onSubmit(openPasted)
                                    .padding(.horizontal, 14).frame(minHeight: 46)
                                    .glassEffect(.regular.interactive(), in: .rect(cornerRadius: 14))
                                Button {
                                    if let s = UIPasteboard.general.string { paste = s; openPasted() }
                                } label: { Image(systemName: "doc.on.clipboard").frame(width: 30, height: 34) }
                                    .buttonStyle(.glass)
                                    .accessibilityLabel("Paste from the clipboard")
                            }
                            if let pasteError { Text(pasteError).font(.footnote).foregroundStyle(Theme.soft) }
                        }
                        if !paste.isEmpty {
                            Button("Open the link", action: openPasted).buttonStyle(.glass).frame(maxWidth: .infinity)
                        }
                        if app.paired == nil {
                            Button { Task { await app.startDemo() } } label: {
                                Label("Try it without a Mac", systemImage: "sparkles.rectangle.stack").frame(maxWidth: .infinity).padding(.vertical, 4)
                            }
                            .buttonStyle(.glass)
                            .accessibilityHint("Opens a sample company on this phone. Nothing is sent anywhere.")
                        }
                        if reason == .gone {
                            HStack(spacing: 12) {
                                Button { Task { await app.retry() } } label: { Text("Try again").frame(maxWidth: .infinity) }.buttonStyle(.glass)
                                Button(role: .destructive) { app.forget() } label: { Text("Forget this Mac").frame(maxWidth: .infinity) }.buttonStyle(.glass)
                            }
                        }
                    }
                }
                Text("On your Mac: Settings › App › Phone, turn it on, Share over the internet, then scan. This app keeps only the key to your Mac; your work stays there.")
                    .font(.footnote).foregroundStyle(Theme.faint).multilineTextAlignment(.center).frame(maxWidth: 330)
            }
            .padding(.horizontal, 16).padding(.bottom, 24)
        }
        .scrollBounceBehavior(.basedOnSize)
        .stone()
        .sheet(isPresented: $scanning) {
            ScanSheet(accepts: { PairLink.parse($0) != nil }) { text in
                scanning = false
                if let link = PairLink.parse(text) { app.open(link: link) }
            }
        }
    }

    private var line: String {
        switch reason {
        case .gone: return "Your Mac is not at its last address. Phone may be off there, or its address changed."
        case .off: return "Phone was turned off on your Mac. Turn it on again and scan a new code."
        case .revoked: return "This phone was signed out on your Mac. Scan a new code to pair it again."
        case .unpaired: return "Pair this phone with your Mac to watch your agents and keep the work going."
        }
    }
    private var head: String {
        switch reason {
        case .gone: return "Scan again on your Mac"
        case .off: return "Phone is off"
        case .revoked: return "Signed out on your Mac"
        case .unpaired: return "Not paired"
        }
    }

    private func openPasted() {
        guard let link = PairLink.parse(paste) else {
            pasteError = "That is not a pairing link. On your Mac, Copy link under the code."
            return
        }
        pasteError = nil
        paste = ""
        app.open(link: link)
    }
}

/// The link was scanned or pasted: name this phone and pair.
struct PairView: View {
    @Environment(AppModel.self) private var app
    let link: PairLink

    var body: some View {
        @Bindable var app = app
        ScrollView {
            VStack(spacing: 16) {
                Lettering()
                Text("Pair this phone with your Mac to watch your agents and keep the work going.")
                    .foregroundStyle(Theme.soft).multilineTextAlignment(.center).frame(maxWidth: 320)
                StatusChip(tile: app.pairBusy ? .run : app.pairError != nil ? .fail : .needs, text: app.pairBusy ? "Pairing" : app.pairError != nil ? "Code not accepted" : "One-time code")
                Text("Your Mac: \(PairLink.host(link.mac))").font(.footnote).foregroundStyle(Theme.faint)
                if let other = app.replaces(link) {
                    Text("This phone is paired with another Mac (\(other)). Pair only if this link came from your own Mac: pairing here replaces it.")
                        .font(.footnote).foregroundStyle(Theme.soft)
                        .glassCard(radius: 16)
                }
                Spacer(minLength: 18)
                VStack(alignment: .leading, spacing: 6) {
                    Text("Name this phone").font(.footnote).foregroundStyle(Theme.muted)
                    TextField("iPhone", text: $app.deviceName)
                        .padding(.horizontal, 14).frame(minHeight: 46)
                        .glassEffect(.regular.interactive(), in: .rect(cornerRadius: 14))
                }
                if let e = app.pairError { Text(e).font(.footnote).foregroundStyle(Theme.soft).frame(maxWidth: .infinity, alignment: .leading) }
                GlassEffectContainer(spacing: 10) {
                    VStack(spacing: 10) {
                        Button {
                            Task { await app.pair(link) }
                        } label: {
                            Text(app.pairBusy ? "Pairing…" : app.replaces(link) != nil ? "Replace and pair" : "Pair this phone").frame(maxWidth: .infinity).padding(.vertical, 6)
                        }
                        .buttonStyle(.glassProminent)
                        .tint(Theme.ink.opacity(0.9))
                        .foregroundStyle(Theme.page)
                        .disabled(app.pairBusy)
                        Button("Cancel") { app.cancelPairing() }.buttonStyle(.glass)
                    }
                }
                Text("The code works once, for 5 minutes. Your Mac lists this phone in Settings › App › Phone, with Revoke.")
                    .font(.footnote).foregroundStyle(Theme.faint).multilineTextAlignment(.center).frame(maxWidth: 330)
            }
            .padding(.horizontal, 16).padding(.bottom, 24)
        }
        .scrollBounceBehavior(.basedOnSize)
        .stone()
    }
}

/// The camera, reading the QR code (VisionKit). Where the camera cannot scan (the simulator), it says so.
struct ScanSheet: View {
    /// what this scan takes (a pairing link; on "Waiting for your Mac" also the Mac's move link)
    var accepts: (String) -> Bool
    var prompt = "Point at the code on your Mac"
    let onCode: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var message: String?

    var body: some View {
        NavigationStack {
            ZStack {
                Theme.page.ignoresSafeArea()
                if DataScannerViewController.isSupported && DataScannerViewController.isAvailable {
                    QRScanner(accepts: accepts) { text in
                        if accepts(text) { onCode(text) } else { message = "That code is not a Principia code." }
                    }
                    .ignoresSafeArea()
                    VStack {
                        Spacer()
                        Text(message ?? prompt).font(.subheadline).foregroundStyle(Theme.ink)
                            .padding(.horizontal, 16).padding(.vertical, 10)
                            .glassEffect(.regular, in: .capsule)
                            .padding(.bottom, 30)
                    }
                } else {
                    VStack(spacing: 12) {
                        Image(systemName: "camera").font(.largeTitle).foregroundStyle(Theme.muted)
                        Text("The camera can not scan here.").foregroundStyle(Theme.ink)
                        Text("Copy the link on your Mac and paste it instead.").font(.footnote).foregroundStyle(Theme.muted)
                    }
                }
            }
            .navigationTitle("Scan the code")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Close", systemImage: "xmark") { dismiss() } }
            }
        }
    }
}

struct QRScanner: UIViewControllerRepresentable {
    let accepts: (String) -> Bool
    let onText: (String) -> Void

    func makeUIViewController(context: Context) -> DataScannerViewController {
        let vc = DataScannerViewController(recognizedDataTypes: [.barcode(symbologies: [.qr])], qualityLevel: .balanced, recognizesMultipleItems: false, isHighFrameRateTrackingEnabled: false, isHighlightingEnabled: true)
        vc.delegate = context.coordinator
        try? vc.startScanning()
        return vc
    }
    func updateUIViewController(_ vc: DataScannerViewController, context: Context) {}
    func makeCoordinator() -> Coordinator { Coordinator(accepts: accepts, onText: onText) }

    final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        let accepts: (String) -> Bool
        let onText: (String) -> Void
        private var done = false
        init(accepts: @escaping (String) -> Bool, onText: @escaping (String) -> Void) { self.accepts = accepts; self.onText = onText }
        func dataScanner(_ s: DataScannerViewController, didAdd items: [RecognizedItem], allItems: [RecognizedItem]) {
            for case .barcode(let b) in items {
                guard !done, let v = b.payloadStringValue else { continue }
                if accepts(v) { done = true; s.stopScanning() }
                onText(v)
                return
            }
        }
    }
}

/// The Mac's last address does not answer (RA8): Phone is off there, or it restarted with a new quick-tunnel address.
/// Type its words, paste or scan its link; the new address proves it is this phone's Mac before the key goes there.
/// The last address is tried again on the foreground and every 20 s.
struct WaitingForMacView: View {
    @Environment(AppModel.self) private var app
    @State private var words = ""
    @State private var scanning = false
    @State private var confirmForget = false
    @FocusState private var focused: Bool

    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                Lettering()
                StatusChip(tile: app.retrying || app.moveBusy ? .run : .quiet, text: app.moveBusy ? "Checking the address" : app.retrying ? "Trying your Mac" : "Waiting for your Mac")
                Text("Your Mac has a new address. On your Mac, open Settings › App › Phone and type the words shown under Paired phones, or scan its QR.")
                    .font(.body).foregroundStyle(Theme.soft).multilineTextAlignment(.center).frame(maxWidth: 330)
                if app.phoneOffline {
                    Text("This phone seems to be offline. It tries again once it is back.").font(.footnote).foregroundStyle(Theme.soft).multilineTextAlignment(.center)
                } else if !app.macHost.isEmpty {
                    Text("Last address: \(app.macHost)").font(.footnote).foregroundStyle(Theme.faint).multilineTextAlignment(.center)
                }
                GlassEffectContainer(spacing: 12) {
                    VStack(spacing: 12) {
                        VStack(alignment: .leading, spacing: 8) {
                            Text("The words on your Mac").font(.footnote).foregroundStyle(Theme.muted)
                            HStack(spacing: 8) {
                                TextField("quiet-tree-forty-two", text: $words)
                                    .textInputAutocapitalization(.never).autocorrectionDisabled()
                                    .submitLabel(.go).onSubmit(connect).focused($focused)
                                    .padding(.horizontal, 14).frame(minHeight: 46)
                                    .glassEffect(.regular.interactive(), in: .rect(cornerRadius: 14))
                                    .accessibilityLabel("The words on your Mac, or its link")
                                Button {
                                    if let s = UIPasteboard.general.string { words = s; connect() }
                                } label: { Image(systemName: "doc.on.clipboard").frame(width: 30, height: 34) }
                                    .buttonStyle(.glass)
                                    .accessibilityLabel("Paste the link from the clipboard")
                            }
                            if let e = app.moveError { Text(e).font(.footnote).foregroundStyle(Theme.soft) }
                        }
                        Button(action: connect) {
                            Text(app.moveBusy ? "Checking…" : "Connect").frame(maxWidth: .infinity).padding(.vertical, 6)
                        }
                        .buttonStyle(.glassProminent)
                        .tint(Theme.ink.opacity(0.9))
                        .foregroundStyle(Theme.page)
                        .disabled(app.moveBusy || words.trimmingCharacters(in: .whitespaces).isEmpty)
                        Button { scanning = true } label: {
                            Label("Scan the QR on your Mac", systemImage: "qrcode.viewfinder").frame(maxWidth: .infinity).padding(.vertical, 4)
                        }
                        .buttonStyle(.glass)
                        HStack(spacing: 12) {
                            Button { Task { await app.retry() } } label: { Text(app.retrying ? "Trying…" : "Try again").frame(maxWidth: .infinity) }
                                .buttonStyle(.glass).disabled(app.retrying || app.moveBusy)
                            Button(role: .destructive) { confirmForget = true } label: { Text("Disconnect from this Mac").frame(maxWidth: .infinity).lineLimit(1).minimumScaleFactor(0.8) }
                                .buttonStyle(.glass)
                        }
                    }
                }
                Text("Your key is checked first: the new address must prove it is your Mac before this phone sends it anything. It also tries the last address every 20 seconds.")
                    .font(.footnote).foregroundStyle(Theme.faint).multilineTextAlignment(.center).frame(maxWidth: 330)
            }
            .padding(.horizontal, 16).padding(.bottom, 24)
        }
        .scrollBounceBehavior(.basedOnSize)
        .scrollDismissesKeyboard(.interactively)
        .stone()
        .confirmationDialog("Disconnect from this Mac?", isPresented: $confirmForget, titleVisibility: .visible) {
            Button("Disconnect", role: .destructive) { app.forget() }
        } message: { Text("This phone forgets your Mac and its key. Your Mac still lists this phone until you Revoke it there. Scan a new code to pair again.") }
        .sheet(isPresented: $scanning) {
            ScanSheet(accepts: accepts, prompt: "Point at the QR under Paired phones") { text in
                scanning = false
                Task { await app.move(text) }
            }
        }
        // the last address, every 20 s while this screen shows (it goes away once the Mac answers)
        .task {
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 20_000_000_000)
                guard !Task.isCancelled else { return }
                if !app.moveBusy && !focused { await app.retry() }
            }
        }
    }

    private func accepts(_ text: String) -> Bool {
        PairLink.parse(text) != nil || app.paired.flatMap { MacMove.macFromTyped(text, site: $0.site) } != nil
    }

    private func connect() {
        let t = words
        guard !t.trimmingCharacters(in: .whitespaces).isEmpty else { return }
        focused = false
        Task {
            await app.move(t)
            if app.phase == .main { words = "" }
        }
    }
}
