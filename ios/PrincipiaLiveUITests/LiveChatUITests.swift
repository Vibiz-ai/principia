import XCTest

/// Against a real Mac (docs/IOS.md, "Check it against your Mac"): the app must be paired already, and the Mac's chat
/// must wait on a permission. Run with
///   TEST_RUNNER_PRINCIPIA_OPEN_URL=principia://chat/session/<id> xcodebuild test -scheme PrincipiaLive …
/// Skipped without it, so it never runs in the unit test pass.
final class LiveChatUITests: XCTestCase {
    func testAllowFromThePhone() throws {
        guard let url = ProcessInfo.processInfo.environment["PRINCIPIA_OPEN_URL"] else { throw XCTSkip("set TEST_RUNNER_PRINCIPIA_OPEN_URL") }
        let app = XCUIApplication()
        app.launchEnvironment["PRINCIPIA_OPEN_URL"] = url
        app.launch()
        let allow = app.buttons["Allow"]
        XCTAssertTrue(allow.waitForExistence(timeout: 15), "the permission card shows Allow")
        allow.tap()
        let done = app.staticTexts.containing(NSPredicate(format: "label CONTAINS[c] %@", "Pushed")).firstMatch
        XCTAssertTrue(done.waitForExistence(timeout: 20), "the Mac's reply streams in after Allow")
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.lifetime = .keepAlways
        add(shot)
    }

    func testComposerSendsToTheMac() throws {
        guard let url = ProcessInfo.processInfo.environment["PRINCIPIA_OPEN_URL"], ProcessInfo.processInfo.environment["PRINCIPIA_SEND"] != nil else { throw XCTSkip("set TEST_RUNNER_PRINCIPIA_SEND=1") }
        let app = XCUIApplication()
        app.launchEnvironment["PRINCIPIA_OPEN_URL"] = url
        app.launch()
        let field = app.textFields.firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 15))
        field.tap()
        field.typeText("Sent from the phone app")
        app.buttons["Send"].tap()
        XCTAssertTrue(app.staticTexts["Sent from the phone app"].waitForExistence(timeout: 10))
    }
}

/// Screens that need a tap (dialogs), saved as PNGs for review: TEST_RUNNER_PRINCIPIA_SHOTS=<folder>.
final class LiveShotsUITests: XCTestCase {
    private func save(_ app: XCUIApplication, _ name: String) {
        guard let dir = ProcessInfo.processInfo.environment["PRINCIPIA_SHOTS"] else { return }
        try? app.screenshot().pngRepresentation.write(to: URL(fileURLWithPath: dir).appendingPathComponent("\(name).png"))
    }

    private func dismissPopover(_ app: XCUIApplication) {
        let region = app.otherElements["PopoverDismissRegion"]
        if region.exists { region.tap() } else { app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.6)).tap() }
        sleep(1)
    }

    func testDialogs() throws {
        guard ProcessInfo.processInfo.environment["PRINCIPIA_SHOTS"] != nil else { throw XCTSkip("set TEST_RUNNER_PRINCIPIA_SHOTS") }
        let app = XCUIApplication()
        app.launchEnvironment["PRINCIPIA_OPEN_URL"] = "principia://tab/now"
        app.launch()
        let pause = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Pause' OR label BEGINSWITH 'Resume'")).firstMatch
        XCTAssertTrue(pause.waitForExistence(timeout: 15))
        pause.tap()
        sleep(1)
        save(app, "12-pause-confirm")
        dismissPopover(app)
        app.buttons["Needs you"].tap()
        let notNeeded = app.buttons["Not needed"].firstMatch
        XCTAssertTrue(notNeeded.waitForExistence(timeout: 10))
        notNeeded.tap()
        sleep(1)
        save(app, "13-not-needed-confirm")
        if app.buttons["Keep it"].exists { app.buttons["Keep it"].tap() } else { dismissPopover(app) }
        app.buttons["Settings"].firstMatch.tap()
        sleep(1)
        save(app, "14-settings")
    }
}

/// The web phone app in Safari (src/cloud/phone), against the same Mac: TEST_RUNNER_PRINCIPIA_WEB_LINK=<pairing link>,
/// TEST_RUNNER_PRINCIPIA_WEB_CHAT=<the app's #/c/…/chats/session/… route>.
final class WebPhoneUITests: XCTestCase {
    func testWebChatRendersMarkdown() throws {
        let env = ProcessInfo.processInfo.environment
        guard let link = env["PRINCIPIA_WEB_LINK"].flatMap(URL.init(string:)), let dir = env["PRINCIPIA_SHOTS"] else { throw XCTSkip("set TEST_RUNNER_PRINCIPIA_WEB_LINK") }
        let safari = XCUIApplication(bundleIdentifier: "com.apple.mobilesafari")
        safari.launch()
        safari.open(link)
        let pair = safari.buttons["Pair this phone"]
        // already paired (the site keeps its token): straight on
        if pair.waitForExistence(timeout: 8) {
            sleep(2)
            pair.tap()
            sleep(5)
            try? safari.screenshot().pngRepresentation.write(to: URL(fileURLWithPath: dir).appendingPathComponent("19-web-after-pair.png"))
        }
        if let chat = env["PRINCIPIA_WEB_CHAT"], let u = URL(string: chat) {
            safari.open(u)
            sleep(4)
        }
        try? safari.screenshot().pngRepresentation.write(to: URL(fileURLWithPath: dir).appendingPathComponent("20-web-chat.png"))
        safari.swipeDown()
        sleep(1)
        try? safari.screenshot().pngRepresentation.write(to: URL(fileURLWithPath: dir).appendingPathComponent("21-web-chat-scrolled.png"))
    }
}
