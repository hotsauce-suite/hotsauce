import Foundation
import Testing
@testable import DictateCore

/// Signing in also connects Dictate (docs/PLAN-mac-onboarding.md R8).
@Suite struct DictateHandoffTests {
    let token = "hdt_" + String(repeating: "aB3-_", count: 8) + "xyz"
    func url(_ s: String) -> URL { URL(string: s)! }

    @Test func readsOnlyItsTwoRequests() {
        #expect(DictateHandoff.request(["type": "status"]) == .status)
        #expect(DictateHandoff.request(["type": "connect", "token": token]) == .connect(token: token))
        #expect(DictateHandoff.request(["type": "connect", "token": "hdt_short"]) == nil)
        #expect(DictateHandoff.request(["type": "connect", "token": "abc_" + String(repeating: "x", count: 30)]) == nil)
        #expect(DictateHandoff.request(["type": "connect"]) == nil)
        #expect(DictateHandoff.request(["type": "connect", "token": token, "server": "https://evil.example"]) == nil)
        #expect(DictateHandoff.request(["type": "status", "extra": 1]) == nil)
        #expect(DictateHandoff.request("status") == nil)
        #expect(DictateHandoff.request(["type": "take"]) == nil)
    }

    @Test func onlyOpenShortlyAfterTheTicket() {
        let opened = Date(timeIntervalSince1970: 1_000)
        #expect(!DictateHandoff.isOpen(openedAt: nil, now: opened))
        #expect(DictateHandoff.isOpen(openedAt: opened, now: opened.addingTimeInterval(30)))
        #expect(DictateHandoff.isOpen(openedAt: opened, now: opened.addingTimeInterval(DictateHandoff.window)))
        #expect(!DictateHandoff.isOpen(openedAt: opened, now: opened.addingTimeInterval(DictateHandoff.window + 1)))
        #expect(!DictateHandoff.isOpen(openedAt: opened, now: opened.addingTimeInterval(-1)))
    }

    @Test func nothingIsCreatedForAMacConnectedToThisServer() {
        let server = url("https://team.example.com")
        #expect(!DictateHandoff.needed(connection: url("https://team.example.com"), server: server))
        #expect(DictateHandoff.needed(connection: nil, server: server))
        // Connected elsewhere: kept, never replaced without asking.
        #expect(!DictateHandoff.needed(connection: url("https://other.example.com"), server: server))
    }

    @Test func onlyTheFinishPageThatTookTheTicketMayUseIt() {
        let opened = Date(timeIntervalSince1970: 1_000)
        let now = opened.addingTimeInterval(5)
        func allowed(main: Bool = true, suite: Bool = true, document: String? = "/desktop/finish",
                     live: String? = "/desktop/finish", openedAt: Date? = opened) -> Bool {
            DictateHandoff.allowed(isMainFrame: main, isSuiteFrame: suite, documentPath: document, livePath: live,
                                   openedAt: openedAt, now: now)
        }
        #expect(allowed())
        #expect(!allowed(main: false))
        #expect(!allowed(suite: false))
        // The finish page routed on to Today: the document is still /desktop/finish, the window isn't.
        #expect(!allowed(live: "/today"))
        // Another suite page that pushed /desktop/finish: its document was loaded elsewhere.
        #expect(!allowed(document: "/docs"))
        #expect(!allowed(openedAt: nil))
        #expect(!allowed(openedAt: opened.addingTimeInterval(-DictateHandoff.window - 10)))
    }

    @Test func namesTheDeviceAfterTheMac() {
        #expect(DictateHandoff.deviceName("Ada’s MacBook Air") == "Ada’s MacBook Air")
        #expect(DictateHandoff.deviceName("  ") == "Mac")
        #expect(DictateHandoff.deviceName(nil) == "Mac")
        #expect(DictateHandoff.deviceName("a\nb") == "a b")
        #expect(DictateHandoff.deviceName(String(repeating: "x", count: 200)).count == 80)
    }
}
