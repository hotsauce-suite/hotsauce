import Foundation
import Testing
@testable import DictateCore

/// `hearth://setup?server=<origin>` from a workspace's download page (docs/PLAN-mac-onboarding.md R4).
@Suite struct SetupLinkTests {
    func url(_ s: String) -> URL { URL(string: s)! }

    @Test func readsTheWorkspaceFromTheLink() {
        #expect(SetupLink.server(from: url("hearth://setup?server=https%3A%2F%2Fteam.example.com")) == url("https://team.example.com"))
        #expect(SetupLink.server(from: url("hearth://setup?server=https://Team.Example.com/today")) == url("https://team.example.com"))
        #expect(SetupLink.server(from: url("HEARTH://SETUP?server=team.example.com")) == url("https://team.example.com"))
        #expect(SetupLink.server(from: url("hearth:///setup?server=http://localhost:3000")) == url("http://localhost:3000"))
    }

    @Test(arguments: [
        "hearth://setup",
        "hearth://setup?server=",
        "hearth://setup?server=http://team.example.com",
        "hearth://setup?server=javascript:alert(1)",
        "hearth://setup?server=https://user:pw@team.example.com",
        "hearth://meetings?server=https://team.example.com",
        "hearth://setup/x?server=https://team.example.com",
        "hearth-dictate://setup?server=https://team.example.com",
        "https://team.example.com/setup?server=https://team.example.com",
    ])
    func refusesAnythingElse(link: String) {
        #expect(SetupLink.server(from: url(link)) == nil)
    }

    @Test func buildsTheLinkAServerOffers() {
        #expect(SetupLink.url(server: url("https://team.example.com"))?.absoluteString == "hearth://setup?server=https://team.example.com")
        let link = SetupLink.url(server: url("http://localhost:3000"))
        #expect(link.flatMap { SetupLink.server(from: $0) } == url("http://localhost:3000"))
    }
}
