import Foundation
import Testing
@testable import DictateCore

@Suite struct ConnectLinkTests {
    let token = "hdt_" + String(repeating: "aB3-_", count: 8) + "xyz"

    @Test func parsesTheDictatePagesLink() throws {
        let link = try #require(ConnectLink.parse("hearth-dictate://connect?token=\(token)&server=https%3A%2F%2Foffice.example.com"))
        #expect(link.token == token)
        #expect(link.server == URL(string: "https://office.example.com"))
        #expect(!link.isUnfamiliarServer)
    }

    @Test func acceptsAPastedCodeWithWhitespace() {
        #expect(ConnectLink.parse("  hearth-dictate://connect?token=\(token)&server=https://office.example.com/\n") != nil)
    }

    @Test func defaultsTheServer() {
        #expect(ConnectLink.parse("hearth-dictate://connect?token=\(token)")?.server == ConnectLink.defaultServer)
    }

    @Test func keepsOnlyTheServersOrigin() {
        let link = ConnectLink.parse("hearth-dictate://connect?token=\(token)&server=https://example.com:8443/some/path?q=1")
        #expect(link?.server == URL(string: "https://example.com:8443"))
        #expect(link?.isUnfamiliarServer == true)
    }

    @Test func allowsPlainHttpOnlyForLocalhost() {
        #expect(ConnectLink.parse("hearth-dictate://connect?token=\(token)&server=http://localhost:3000") != nil)
        #expect(ConnectLink.parse("hearth-dictate://connect?token=\(token)&server=http://evil.example") == nil)
    }

    @Test(arguments: [
        "https://your workspace’s /dictate page",
        "hearth-dictate://disconnect?token=hdt_abcdefghijklmnopqrstuvwxyz",
        "hearth-dictate://connect?token=wrongprefix_abcdefghijklmnopqrstuvwxyz",
        "hearth-dictate://connect?token=hdt_short",
        "hearth-dictate://connect?server=https://office.example.com",
        "hearth-dictate://connect?token=hdt_abcdefghijklmnopqrstuvwxyz&server=https://user:pw@office.example.com",
        "hearth-dictate://connect?token=hdt_abcdefghijklmnopqrstuvwxyz&server=javascript:alert(1)",
        "",
    ])
    func refusesAnythingElse(text: String) {
        #expect(ConnectLink.parse(text) == nil)
    }
}
