import Foundation
import Testing
@testable import DictateCore

/// The window's own pages when it can't show the suite (docs/PLAN-mac-onboarding.md R1, R6).
@Suite struct SuitePagesTests {
    let address = URL(string: "https://team.acme.com")!

    // R6: the page names the address it tried, and offers another one.
    @Test func cantReachNamesTheAddressAndOffersAnother() {
        let html = SuitePages.cantReach(address: address, reason: "A server with the specified hostname could not be found.",
                                        retry: URL(string: "https://team.acme.com/today")!)
        #expect(html.contains("Can’t reach Hotsauce"))
        #expect(html.contains("team.acme.com"))
        #expect(html.contains("A server with the specified hostname could not be found."))
        #expect(html.contains(#"href="https://team.acme.com/today">Try again</a>"#))
        #expect(html.contains(#"href="\#(SuitePages.changeWorkspaceURL.absoluteString)">Change workspace address</a>"#))
    }

    @Test func escapesWhatTheServerOrSystemSays() {
        let html = SuitePages.cantReach(address: address, reason: #"<script>alert("x")</script>"#, retry: address)
        #expect(!html.contains("<script>"))
        #expect(html.contains("&lt;script&gt;"))
    }

    // R1: with no workspace the window loads nothing from the network, and says where to set one.
    @Test func noWorkspacePageAsksForOne() {
        let html = SuitePages.noWorkspace()
        #expect(html.contains(#"href="\#(SuitePages.changeWorkspaceURL.absoluteString)""#))
        #expect(!html.contains("http"))
    }

    @Test func onlyTheAppsOwnPageLinkChangesTheWorkspace() {
        #expect(SuitePages.isChangeWorkspace(SuitePages.changeWorkspaceURL))
        #expect(!SuitePages.isChangeWorkspace(URL(string: "https://team.acme.com/change-workspace")!))
        #expect(!SuitePages.isChangeWorkspace(URL(string: "hearth://change-workspace")!))
    }
}
