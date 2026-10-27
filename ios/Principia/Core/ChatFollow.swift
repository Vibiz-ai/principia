import Foundation

/// How a conversation's scroll keeps to its newest message (the rules ChatScroll follows; QA PQ-01, PQ-20).
///
/// A lazy stack only estimates the height of rows it has not drawn: a jump to its end could land past every drawn row
/// (the screen showed nothing until the reader swiped, after opening a long chat or coming back from the background),
/// and its distance from the end read hundreds of points off, so a touch at the end stopped the chat following. The
/// conversation lays out every row it shows instead, and a long one shows its newest `page` rows, older ones a tap
/// away. Each snapshot that lands (opened, back from the background, after a gap) settles it at the end again.
enum ChatFollow {
    /// the rows a conversation shows at first, and how many more "Show earlier messages" adds
    static let page = 30

    /// after a snapshot lands: go to the end now and again once its rows had time to lay out (markdown measures late),
    /// while the reader is still at the end
    static let settle: [UInt64] = [0, 80_000_000, 350_000_000, 900_000_000]

    /// within this of the end counts as at the newest message
    static let slack: CGFloat = 60

    struct Spot: Equatable {
        var offset: CGFloat
        /// how far the end is below the screen
        var gap: CGFloat
        var atEnd: Bool { gap <= ChatFollow.slack }
    }

    /// the reader's own scroll: the chat follows new lines while the end shows; it stops once their finger took it
    /// toward older messages (not when a reply growing under a flick, or a bounce, pushed the end off screen)
    static func afterScroll(pinned: Bool, atEnd: Bool, movedUp: Bool) -> Bool {
        atEnd || (pinned && !movedUp)
    }

    /// the first row shown: the one the reader brought in with "Show earlier messages", else the newest page
    static func start(ids: [String], first: String?) -> Int {
        if let first, let i = ids.firstIndex(of: first) { return i }
        return max(0, ids.count - page)
    }

    /// "Show earlier messages": a page more
    static func earlier(_ from: Int) -> Int { max(0, from - page) }

    /// at the newest message as the chat grows: the oldest rows past two pages leave the top (back to one page)
    static func trim(ids: [String], from: Int) -> String? {
        ids.count - from > 2 * page ? ids[ids.count - page] : nil
    }
}
