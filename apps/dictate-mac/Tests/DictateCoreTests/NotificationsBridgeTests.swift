import Testing
@testable import DictateCore

@Suite struct NotificationsBridgeTests {
    @Test func readsOnlyItsTwoRequests() {
        #expect(NotificationsBridge.request("state") == .state)
        #expect(NotificationsBridge.request("open") == .open)
        #expect(NotificationsBridge.request("OPEN") == nil)
        #expect(NotificationsBridge.request("position") == nil)
        #expect(NotificationsBridge.request(["type": "open"]) == nil)
        #expect(NotificationsBridge.request(1) == nil)
    }

    @Test func asksTheFirstTimeThenOpensSettings() {
        #expect(NotificationsBridge.step(for: .undecided) == .ask)
        #expect(NotificationsBridge.step(for: .off) == .openSettings)
        #expect(NotificationsBridge.step(for: .on) == .openSettings)
    }

    @Test func thePageReadsTheStateAsAString() {
        #expect(NotificationsBridge.State.on.rawValue == "on")
        #expect(NotificationsBridge.State.off.rawValue == "off")
        #expect(NotificationsBridge.State.undecided.rawValue == "undecided")
    }
}
