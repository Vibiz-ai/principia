import Observation
import UIKit

/// A photo attached to a chat message: a JPEG that fits (sent in full) and a small thumb (the bubble on the Mac).
struct ChatAttachment: Identifiable, Equatable, Sendable {
    let id = UUID()
    let jpeg: Data
    let thumb: Data?
    let preview: UIImage

    /// the Phone API's shape (`images` on sessionSend and agentSend)
    var json: [String: Any] {
        var o: [String: Any] = ["mime": "image/jpeg", "data": jpeg.base64EncodedString()]
        if let thumb { o["thumb"] = "data:image/jpeg;base64,\(thumb.base64EncodedString())" }
        return o
    }

    static func == (a: ChatAttachment, b: ChatAttachment) -> Bool { a.id == b.id }
}

/// Fitting a photo for a message, as the Mac's composer does: at most 2048 px on its long side, JPEG, the quality
/// stepped down (then the size) until it fits. The Mac takes 5 MB an image; the phone aims lower, for the tunnel.
enum ImageFit {
    /// per message (the Mac's own limit)
    static let max = 6
    /// what the Mac takes, decoded
    static let macBytes = 5 * 1024 * 1024
    /// what the phone aims for
    static let budget = 1_500_000
    static let sides: [CGFloat] = [2048, 1536, 1024]
    static let qualities: [CGFloat] = [0.8, 0.65, 0.5]

    /// the size drawn at: never larger than the photo, its long side at most `long`
    static func size(_ s: CGSize, long: CGFloat) -> CGSize {
        let k = min(1, long / Swift.max(s.width, s.height, 1))
        return CGSize(width: Swift.max(1, (s.width * k).rounded()), height: Swift.max(1, (s.height * k).rounded()))
    }

    /// the JPEG to send, or nil when even the smallest step does not fit
    static func jpeg(_ image: UIImage, budget: Int = budget) -> Data? {
        for side in sides {
            let drawn = draw(image, size(image.size, long: side))
            for q in qualities {
                if let d = drawn.jpegData(compressionQuality: q), d.count <= budget { return d }
            }
        }
        return nil
    }

    /// a ~96 px JPEG for the bubble (the Mac takes it under 60 000 characters as a data URL)
    static func thumb(_ image: UIImage) -> Data? {
        guard let d = draw(image, size(image.size, long: 96)).jpegData(compressionQuality: 0.7), d.count * 4 / 3 < 59_000 else { return nil }
        return d
    }

    /// a picked photo (any format UIKit reads, HEIC too), fitted; nil when it is not an image or cannot fit
    static func attachment(_ data: Data) -> ChatAttachment? {
        guard let img = UIImage(data: data), let jpeg = jpeg(img) else { return nil }
        return ChatAttachment(jpeg: jpeg, thumb: thumb(img), preview: draw(img, size(img.size, long: 160)))
    }

    private static func draw(_ image: UIImage, _ s: CGSize) -> UIImage {
        let f = UIGraphicsImageRendererFormat.default()
        f.scale = 1
        f.opaque = true
        return UIGraphicsImageRenderer(size: s, format: f).image { _ in image.draw(in: CGRect(origin: .zero, size: s)) }
    }
}

/// The photos of the message being written: read and fitted off the main thread; Send waits while any still is.
@MainActor
@Observable
final class PhotoDraft {
    private(set) var items: [ChatAttachment] = []
    private(set) var loading = 0
    /// why a picked photo was left out (above the field until the next pick)
    private(set) var note: String?

    /// how many more fit in this message
    var room: Int { Swift.max(0, ImageFit.max - items.count - loading) }

    /// picked photos, in order; `load` reads one (the picker's item), nil when it cannot
    func add<P: Sendable>(_ picked: [P], load: @escaping @Sendable (P) async -> Data?) async {
        note = nil
        let list = Array(picked.prefix(room))
        loading += list.count
        var skipped = 0
        for p in list {
            let a = await Task.detached(priority: .userInitiated) { await load(p).flatMap(ImageFit.attachment) }.value
            loading -= 1
            if let a, items.count < ImageFit.max { items.append(a) } else { skipped += 1 }
        }
        if skipped > 0 { note = skipped == 1 ? "That photo could not be attached." : "\(skipped) photos could not be attached." }
        if picked.count > list.count { note = "Up to \(ImageFit.max) photos per message." }
    }
    func remove(_ id: UUID) { items.removeAll { $0.id == id } }
    /// the photos to send; the draft is empty after
    func take() -> [ChatAttachment] {
        defer { items = []; note = nil }
        return items
    }
    /// a send that failed gets its photos back
    func restore(_ a: [ChatAttachment]) { items = Array((a + items).prefix(ImageFit.max)) }
}
