import Foundation
import Testing
@testable import DictateCore

@Suite struct ConnectLinkTests {
    let token = "hdt_" + String(repeating: "aB3-_", count: 8) + "xyz"

    @Test func parsesTheDictatePagesLink() throws {
        let link = try #require(ConnectLink.parse("hearth-dictate://connect?token=\(token)&server=https%3A%2F%2Foffice.example.com"))
        #expect(link.token == token)
        #expect(link.server == URL(string: "https://office.example.com"))
        #expect(!link.isUnfamiliar(to: URL(string: "https://office.example.com")))
    }

    @Test func acceptsAPastedCodeWithWhitespace() {
        #expect(ConnectLink.parse("  hearth-dictate://connect?token=\(token)&server=https://office.example.com/\n") != nil)
    }

    // R1: a code without a server is for the workspace this Mac already uses, and only then.
    @Test func aCodeWithoutAServerIsForTheWorkspaceThisMacUses() {
        let workspace = URL(string: "https://team.acme.com")!
        #expect(ConnectLink.parse("hearth-dictate://connect?token=\(token)", workspace: workspace)?.server == workspace)
        #expect(ConnectLink.parse("hearth-dictate://connect?token=\(token)") == nil)
        // The link's own server wins over the workspace.
        #expect(ConnectLink.parse("hearth-dictate://connect?token=\(token)&server=https://other.example.com", workspace: workspace)?.server
            == URL(string: "https://other.example.com"))
    }

    // Any server but the workspace this Mac already uses needs a second look; with none, every one does.
    @Test func unfamiliarIsAnyServerButThisMacsWorkspace() throws {
        let link = try #require(ConnectLink.parse("hearth-dictate://connect?token=\(token)&server=https://team.acme.com"))
        #expect(!link.isUnfamiliar(to: URL(string: "https://team.acme.com")))
        #expect(link.isUnfamiliar(to: URL(string: "https://other.acme.com")))
        #expect(link.isUnfamiliar(to: nil))
    }

    @Test func keepsOnlyTheServersOrigin() {
        let link = ConnectLink.parse("hearth-dictate://connect?token=\(token)&server=https://example.com:8443/some/path?q=1")
        #expect(link?.server == URL(string: "https://example.com:8443"))
        #expect(link?.isUnfamiliar(to: URL(string: "https://example.com")) == true)
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
