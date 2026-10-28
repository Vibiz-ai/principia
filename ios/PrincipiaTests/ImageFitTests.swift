import UIKit
import XCTest
@testable import Principia

/// Photos in a chat message: fitted like the Mac's composer, and sent in the Phone API's shape.
final class ImageFitTests: XCTestCase {
    /// a busy photo (noise compresses badly, like a real one)
    private func photo(_ w: CGFloat, _ h: CGFloat) -> UIImage {
        let f = UIGraphicsImageRendererFormat.default()
        f.scale = 1
        var g = SystemRandomNumberGenerator()
        return UIGraphicsImageRenderer(size: CGSize(width: w, height: h), format: f).image { c in
            for x in stride(from: 0, to: Int(w), by: 8) {
                for y in stride(from: 0, to: Int(h), by: 8) {
                    UIColor(red: .random(in: 0...1, using: &g), green: .random(in: 0...1, using: &g), blue: .random(in: 0...1, using: &g), alpha: 1).setFill()
                    c.fill(CGRect(x: x, y: y, width: 8, height: 8))
                }
            }
        }
    }

    func testSizeKeepsTheShapeAndNeverGrows() {
        XCTAssertEqual(ImageFit.size(CGSize(width: 4032, height: 3024), long: 2048), CGSize(width: 2048, height: 1536))
        XCTAssertEqual(ImageFit.size(CGSize(width: 1000, height: 3000), long: 1024), CGSize(width: 341, height: 1024))
        XCTAssertEqual(ImageFit.size(CGSize(width: 300, height: 200), long: 2048), CGSize(width: 300, height: 200))
        XCTAssertEqual(ImageFit.size(.zero, long: 2048), CGSize(width: 1, height: 1))
    }

    func testABigPhotoFitsTheBudgetAt2048OrLess() throws {
        let d = try XCTUnwrap(ImageFit.jpeg(photo(4000, 3000)))
        XCTAssertLessThanOrEqual(d.count, ImageFit.budget)
        let back = try XCTUnwrap(UIImage(data: d))
        XCTAssertLessThanOrEqual(max(back.size.width, back.size.height), 2048)
        XCTAssertLessThan(ImageFit.budget, ImageFit.macBytes)
    }

    func testStepsDownUntilItFitsOrGivesUp() throws {
        let img = photo(2400, 1600)
        let first = try XCTUnwrap(ImageFit.jpeg(img, budget: .max))
        let small = try XCTUnwrap(ImageFit.jpeg(img, budget: first.count / 2))
        XCTAssertLessThanOrEqual(small.count, first.count / 2)
        XCTAssertNil(ImageFit.jpeg(img, budget: 1_000))
    }

    func testThumbIsSmallEnoughForTheMac() throws {
        let t = try XCTUnwrap(ImageFit.thumb(photo(1200, 900)))
        XCTAssertLessThan(t.base64EncodedString().count + "data:image/jpeg;base64,".count, 60_000)
        XCTAssertNil(ImageFit.attachment(Data("not an image".utf8)))
    }

    func testMessageBodyCarriesImagesOnlyWhenThereAreSome() throws {
        XCTAssertEqual(APIClient.message("hi", []) as? [String: String], ["text": "hi"])
        let a = try XCTUnwrap(ImageFit.attachment(try XCTUnwrap(photo(64, 64).pngData())))
        let b = APIClient.message("", [a])
        XCTAssertEqual(b["text"] as? String, "")
        let im = try XCTUnwrap((b["images"] as? [[String: Any]])?.first)
        XCTAssertEqual(im["mime"] as? String, "image/jpeg")
        XCTAssertEqual(Data(base64Encoded: try XCTUnwrap(im["data"] as? String)), a.jpeg)
        XCTAssertTrue((im["thumb"] as? String)?.hasPrefix("data:image/jpeg;base64,") == true)
    }

    @MainActor
    func testDraftKeepsAtMostSixAndSaysWhy() async throws {
        let png = try XCTUnwrap(photo(64, 64).pngData())
        let draft = PhotoDraft()
        await draft.add(Array(repeating: png, count: 4)) { $0 }
        XCTAssertEqual(draft.items.count, 4)
        XCTAssertNil(draft.note)
        await draft.add([Data("nope".utf8)]) { $0 }
        XCTAssertEqual(draft.items.count, 4)
        XCTAssertEqual(draft.note, "That photo could not be attached.")
        await draft.add(Array(repeating: png, count: 5)) { $0 }
        XCTAssertEqual(draft.items.count, ImageFit.max)
        XCTAssertEqual(draft.room, 0)
        XCTAssertEqual(draft.note, "Up to 6 photos per message.")
        draft.remove(draft.items[0].id)
        XCTAssertEqual(draft.items.count, 5)
        let sent = draft.take()
        XCTAssertEqual(sent.count, 5)
        XCTAssertTrue(draft.items.isEmpty)
        draft.restore(sent)
        XCTAssertEqual(draft.items, sent)
    }
}
