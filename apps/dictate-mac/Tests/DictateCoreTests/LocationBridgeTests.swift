import Foundation
import Testing
@testable import DictateCore

@Suite struct LocationBridgeTests {
    @Test func asksFirstThenLocatesAndSendsTheRefusedToSettings() {
        #expect(LocationBridge.step(for: .notDetermined) == .ask)
        #expect(LocationBridge.step(for: .allowed) == .locate)
        #expect(LocationBridge.step(for: .denied) == .refuseAndOpenSettings)
        #expect(LocationBridge.step(for: .servicesOff) == .refuseAndOpenSettings)
    }

    @Test func acceptsOnlyThePositionRequest() {
        #expect(LocationBridge.isRequest("position"))
        #expect(!LocationBridge.isRequest("Position"))
        #expect(!LocationBridge.isRequest(["type": "position"]))
        #expect(!LocationBridge.isRequest(1))
    }

    @Test func roundsThePositionToAboutAKilometre() {
        let reply = LocationBridge.position(latitude: 44.47589, longitude: -73.21234)
        #expect(reply["lat"] as? Double == 44.48)
        #expect(reply["lon"] as? Double == -73.21)
        #expect(reply.count == 2)
    }

    @Test func failuresAreAPlainWord() {
        #expect(LocationBridge.failure(.denied)["error"] as? String == "denied")
        #expect(LocationBridge.failure(.unavailable)["error"] as? String == "unavailable")
    }

    @Test func settingsOpenAtLocationServices() {
        #expect(LocationBridge.settingsURL.absoluteString.hasSuffix("Privacy_LocationServices"))
    }
}
