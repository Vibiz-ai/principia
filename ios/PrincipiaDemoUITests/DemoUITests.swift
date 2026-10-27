import XCTest

/// Demo mode end to end, the way Beta App Review meets it (docs/IOS.md, TestFlight): a phone with no Mac taps "Try it
/// without a Mac", walks the sample company and leaves it for the pairing screen. No Mac, no network. Scheme
/// `PrincipiaDemo`; TEST_RUNNER_PRINCIPIA_SHOTS=<folder> also saves each screen as a PNG.
final class DemoUITests: XCTestCase {
    override func setUp() { continueAfterFailure = false }

    private func shot(_ app: XCUIApplication, _ name: String) {
        let a = XCTAttachment(screenshot: app.screenshot())
        a.name = name
        a.lifetime = .keepAlways
        add(a)
        guard let dir = ProcessInfo.processInfo.environment["PRINCIPIA_SHOTS"] else { return }
        try? app.screenshot().pngRepresentation.write(to: URL(fileURLWithPath: dir).appendingPathComponent("\(name).png"))
    }

    private func text(_ app: XCUIApplication, _ s: String) -> XCUIElement {
        app.staticTexts.containing(NSPredicate(format: "label CONTAINS[c] %@", s)).firstMatch
    }

    private func tab(_ app: XCUIApplication, _ name: String) -> XCUIElement {
        app.tabBars.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", name)).firstMatch
    }

    func testTheDemoCompanyAndTheWayOut() throws {
        let app = XCUIApplication()
        app.launch()
        let demo = app.buttons["Try it without a Mac"]
        XCTAssertTrue(demo.waitForExistence(timeout: 15), "the first screen offers the demo")
        shot(app, "01-pair")
        demo.tap()

        // Now: the demo card, the badge, who is working
        XCTAssertTrue(app.buttons["demo-badge"].waitForExistence(timeout: 10), "DEMO shows on every screen")
        XCTAssertTrue(text(app, "Northwind").waitForExistence(timeout: 5))
        XCTAssertTrue(text(app, "A sample company").exists)
        XCTAssertTrue(app.buttons["Settings"].isHittable, "the badge leaves room for Settings")
        sleep(1)
        shot(app, "02-now")

        // the board
        app.buttons.containing(NSPredicate(format: "label CONTAINS[c] %@", "The board")).firstMatch.tap()
        XCTAssertTrue(text(app, "Checkout page: Apple Pay button").waitForExistence(timeout: 5))
        sleep(1)
        shot(app, "03-board")
        app.navigationBars.buttons.element(boundBy: 0).tap()

        // Needs you
        tab(app, "Needs you").tap()
        XCTAssertTrue(text(app, "Deploy a preview of the new checkout").waitForExistence(timeout: 5))
        sleep(1)
        shot(app, "04-needs-you")

        // Chats, then the chat whose reply streams in and finishes
        tab(app, "Chats").tap()
        let plan = text(app, "Plan this week")
        XCTAssertTrue(plan.waitForExistence(timeout: 5))
        sleep(1)
        shot(app, "05-chats")
        plan.tap()
        XCTAssertTrue(text(app, "Ship Apple Pay at checkout").waitForExistence(timeout: 10), "the reply streams in")
        shot(app, "06-chat-streaming")
        XCTAssertTrue(text(app, "Done in").waitForExistence(timeout: 15), "and finishes")
        sleep(1)
        shot(app, "07-chat-finished")
        app.navigationBars.buttons.element(boundBy: 0).tap()

        // the team room
        tab(app, "Team room").tap()
        XCTAssertTrue(text(app, "Apple Pay is working").waitForExistence(timeout: 5))
        sleep(1)
        shot(app, "08-team-room")

        // the way out: DEMO, then Pair your Mac, lands on the pairing screen
        app.buttons["demo-badge"].tap()
        let pair = app.buttons["Pair your Mac"]
        XCTAssertTrue(pair.waitForExistence(timeout: 5))
        shot(app, "09-leave-demo")
        pair.tap()
        XCTAssertTrue(app.buttons["Scan the code on your Mac"].waitForExistence(timeout: 5), "back on the pairing screen")
        XCTAssertTrue(app.buttons["Try it without a Mac"].exists)
        XCTAssertFalse(app.buttons["demo-badge"].exists)
    }
}
