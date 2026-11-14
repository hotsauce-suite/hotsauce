import Foundation
import Testing
@testable import DictateCore

@Suite struct ServerAddressTests {
    func url(_ s: String) -> URL { URL(string: s)! }

    @Test func windowOpensSettingsThenTheConnectionThenTheDefault() {
        let setting = url("https://office.acme.com")
        let connection = url("https://hotsauce.acme.com")
        #expect(ServerAddress.windowServer(setting: setting, connection: connection) == setting)
        #expect(ServerAddress.windowServer(setting: nil, connection: connection) == connection)
        #expect(ServerAddress.windowServer(setting: nil, connection: nil) == ConnectLink.defaultServer)
    }

    @Test func readsTheAddressTheServerReports() {
        let health = Data(#"{"ok":true,"version":"0.11.2","publicUrl":"https://Hotsauce.acme.com/"}"#.utf8)
        #expect(ServerAddress.reportedOrigin(healthJSON: health) == url("https://hotsauce.acme.com"))
    }

    @Test func noAddressFromAnOlderServerOrABadAnswer() {
        #expect(ServerAddress.reportedOrigin(healthJSON: Data(#"{"ok":true}"#.utf8)) == nil)
        #expect(ServerAddress.reportedOrigin(healthJSON: Data("<html>".utf8)) == nil)
        #expect(ServerAddress.reportedOrigin(healthJSON: Data(#"{"publicUrl":"http://evil.example.com"}"#.utf8)) == nil)
        #expect(ServerAddress.reportedOrigin(healthJSON: Data(#"{"publicUrl":"https://user:pw@evil.example.com"}"#.utf8)) == nil)
        #expect(ServerAddress.reportedOrigin(healthJSON: Data(#"{"publicUrl":42}"#.utf8)) == nil)
    }

    @Test func aMoveIsOnlyToTheAddressTheServerReports() {
        let old = url("https://old.acme.com")
        let new = url("https://new.acme.com")
        #expect(ServerAddress.isMove(from: old, to: url("https://new.acme.com/docs?x=1"), reported: new))
        // Somewhere else than the reported address: not a move (a link out, or a redirect elsewhere).
        #expect(!ServerAddress.isMove(from: old, to: url("https://github.com/x"), reported: new))
        // The server doesn't report one, or reports where it already is.
        #expect(!ServerAddress.isMove(from: old, to: url("https://new.acme.com/"), reported: nil))
        #expect(!ServerAddress.isMove(from: old, to: url("https://old.acme.com/"), reported: old))
        // A server still on the default localhost address never moves a real one there.
        #expect(!ServerAddress.isMove(from: old, to: url("http://localhost:3000/"), reported: url("http://localhost:3000")))
        #expect(ServerAddress.isMove(from: url("http://localhost:3000"), to: url("http://127.0.0.1:3000/"), reported: url("http://127.0.0.1:3000")))
        // Same host over http is a different origin, and not one the app moves to.
        #expect(!ServerAddress.isMove(from: old, to: url("http://new.acme.com/"), reported: new))
    }

    @Test func healthIsOnTheServersOrigin() {
        #expect(ServerAddress.healthURL(server: url("https://office.acme.com")) == url("https://office.acme.com/api/health"))
        #expect(ServerAddress.healthURL(server: url("http://localhost:3000")) == url("http://localhost:3000/api/health"))
    }

    @Test func retriesSoonThenBackOff() {
        #expect(RetryBackoff.delay(afterFailures: 1) == 2)
        #expect(RetryBackoff.delay(afterFailures: 2) == 4)
        #expect(RetryBackoff.delay(afterFailures: 4) == 15)
        #expect(RetryBackoff.delay(afterFailures: 5) == 30)
        #expect(RetryBackoff.delay(afterFailures: 50) == 30)
    }
}
