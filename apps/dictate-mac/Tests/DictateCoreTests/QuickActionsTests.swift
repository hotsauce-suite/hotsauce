@testable import DictateCore
import XCTest

final class QuickActionsTests: XCTestCase {
    func testSaveLinkUsesTheCopiedLink() {
        XCTAssertEqual(
            QuickActions.saveLinkPath(clipboard: "look: https://example.com/a?b=1&c=2."),
            "/links/save?via=shortcut&url=https%3A%2F%2Fexample.com%2Fa%3Fb%3D1%26c%3D2"
        )
    }

    func testSaveLinkWithoutALinkOpensPasteAndSave() {
        XCTAssertEqual(QuickActions.saveLinkPath(clipboard: "just words"), "/links/save?paste=1")
        XCTAssertEqual(QuickActions.saveLinkPath(clipboard: nil), "/links/save?paste=1")
    }

    func testSaveLinkEncodesAccentsAndTakesABareAddress() {
        XCTAssertEqual(
            QuickActions.saveLinkPath(clipboard: "https://x.test/Café"),
            "/links/save?via=shortcut&url=https%3A%2F%2Fx.test%2FCaf%C3%A9"
        )
        XCTAssertEqual(
            QuickActions.saveLinkPath(clipboard: " example.com/a "),
            "/links/save?via=shortcut&url=https%3A%2F%2Fexample.com%2Fa"
        )
    }

    func testEveryActionOpensAPath() {
        XCTAssertEqual(QuickActions.all.map(\.title), ["New Task", "Save Link", "Ask", "Ramble Tasks"])
        for action in QuickActions.all { XCTAssertTrue(action.path.hasPrefix("/")) }
    }
}
