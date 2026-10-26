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
            ScanSheet { link in
                scanning = false
                app.open(link: link)
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
    let onLink: (PairLink) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var message: String?

    var body: some View {
        NavigationStack {
            ZStack {
                Theme.page.ignoresSafeArea()
                if DataScannerViewController.isSupported && DataScannerViewController.isAvailable {
                    QRScanner { text in
                        if let l = PairLink.parse(text) { onLink(l) } else { message = "That code is not a Principia pairing code." }
                    }
                    .ignoresSafeArea()
                    VStack {
                        Spacer()
                        Text(message ?? "Point at the code on your Mac").font(.subheadline).foregroundStyle(Theme.ink)
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
    let onText: (String) -> Void

    func makeUIViewController(context: Context) -> DataScannerViewController {
        let vc = DataScannerViewController(recognizedDataTypes: [.barcode(symbologies: [.qr])], qualityLevel: .balanced, recognizesMultipleItems: false, isHighFrameRateTrackingEnabled: false, isHighlightingEnabled: true)
        vc.delegate = context.coordinator
        try? vc.startScanning()
        return vc
    }
    func updateUIViewController(_ vc: DataScannerViewController, context: Context) {}
    func makeCoordinator() -> Coordinator { Coordinator(onText: onText) }

    final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        let onText: (String) -> Void
        private var done = false
        init(onText: @escaping (String) -> Void) { self.onText = onText }
        func dataScanner(_ s: DataScannerViewController, didAdd items: [RecognizedItem], allItems: [RecognizedItem]) {
            for case .barcode(let b) in items {
                guard !done, let v = b.payloadStringValue else { continue }
                if PairLink.parse(v) != nil { done = true; s.stopScanning() }
                onText(v)
                return
            }
        }
    }
}
