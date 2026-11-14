import Foundation
import Testing
@testable import DictateCore

/// The setup window's Workspace step (docs/PLAN-mac-onboarding.md R2, R3).
@Suite struct WorkspaceTests {
    func url(_ s: String) -> URL { URL(string: s)! }

    // R2: a bare host or a full URL, https only (http for localhost), the origin only.
    @Test(arguments: [
        ("team.acme.com", "https://team.acme.com"),
        ("  Team.Acme.com  ", "https://team.acme.com"),
        ("https://team.acme.com", "https://team.acme.com"),
        ("https://team.acme.com/today?x=1#y", "https://team.acme.com"),
        ("team.acme.com/docs", "https://team.acme.com"),
        ("https://team.acme.com:8443", "https://team.acme.com:8443"),
        ("team.acme.com:8443", "https://team.acme.com:8443"),
        ("http://localhost:3000", "http://localhost:3000"),
        ("localhost:3000", "https://localhost:3000"),
        ("http://127.0.0.1:3000/", "http://127.0.0.1:3000"),
        ("https://nas:8443", "https://nas:8443"),
    ])
    func acceptsAHostOrAURL(input: String, origin: String) {
        #expect(Workspace.origin(fromInput: input) == url(origin))
    }

    @Test(arguments: ["https://team.acme.com", "https://team.acme.com:8443", "http://localhost:3000"])
    func showsAnAddressThatTypesBackTheSame(origin: String) {
        #expect(Workspace.origin(fromInput: Workspace.displayAddress(url(origin))) == url(origin))
    }

    @Test(arguments: [
        "",
        "   ",
        "http://team.acme.com",
        "ftp://team.acme.com",
        "team",
        "team acme.com",
        "https://user:pw@team.acme.com",
        "javascript:alert(1)",
        "hearth-dictate://connect?token=x",
        "https://",
    ])
    func refusesAnythingElse(input: String) {
        #expect(Workspace.origin(fromInput: input) == nil)
    }

    // R3: only a Hotsauce server's answer counts, and it says who it's for.
    let acme = Data(#"""
    {"ok":true,"version":"0.12.5","publicUrl":"https://team.acme.com","authMode":"clerk","setupRequired":false,
     "productName":"Hotsauce","orgName":"Acme","signInDomain":"acme.com","emailCodeSignIn":false}
    """#.utf8)

    @Test func readsAHotsauceServersHealth() throws {
        let info = try #require(Workspace.info(healthJSON: acme, server: url("https://team.acme.com")))
        #expect(info.server == url("https://team.acme.com"))
        #expect(info.orgName == "Acme")
        #expect(info.signInDomain == "acme.com")
        #expect(info.reported == url("https://team.acme.com"))
        #expect(info.summary == "Acme. Sign in with your acme.com Google account.")
    }

    @Test func summaryWithoutADomainOrName() throws {
        let bare = Data(#"{"ok":true,"authMode":"clerk","productName":"Hotsauce","orgName":"","signInDomain":null}"#.utf8)
        let info = try #require(Workspace.info(healthJSON: bare, server: url("https://team.acme.com")))
        #expect(info.summary == "team.acme.com. Sign in with your Google account.")
        let setup = Data(#"{"ok":true,"authMode":"setup","setupRequired":true,"productName":"Hotsauce","orgName":"Acme"}"#.utf8)
        let unfinished = try #require(Workspace.info(healthJSON: setup, server: url("https://team.acme.com")))
        #expect(unfinished.setupRequired)
        #expect(unfinished.summary == "Acme. This workspace hasn’t finished its setup yet; whoever runs it can finish it at team.acme.com/setup.")
    }

    @Test(arguments: [
        "<html>not json</html>",
        #"{"ok":true}"#,
        #"{"ok":true,"version":"1.0"}"#,
        #"{"status":"ok","productName":"Hotsauce"}"#,
        #"{"ok":false,"productName":"Hotsauce","authMode":"clerk"}"#,
        #"{"ok":true,"productName":42,"authMode":"clerk"}"#,
        "[]",
    ])
    func notAHotsauceServer(body: String) {
        #expect(Workspace.info(healthJSON: Data(body.utf8), server: url("https://team.acme.com")) == nil)
    }

    /// A fetch that answers from a table of recorded responses; anything else is offline.
    func fetcher(_ table: [String: (Int, String)]) -> Workspace.Fetch {
        { url in
            guard let (status, body) = table[url.absoluteString] else { throw URLError(.cannotFindHost) }
            return (Data(body.utf8), status)
        }
    }

    @Test func checkFindsTheWorkspace() async {
        let result = await Workspace.check(url("https://team.acme.com"), fetch: fetcher([
            "https://team.acme.com/api/health": (200, String(decoding: acme, as: UTF8.self)),
        ]))
        guard case let .found(info) = result else { Issue.record("expected found, got \(result)"); return }
        #expect(info.server == url("https://team.acme.com"))
        #expect(info.orgName == "Acme")
    }

    @Test func checkFollowsTheAddressTheServerReports() async {
        let moved = #"{"ok":true,"publicUrl":"https://hotsauce.acme.com","authMode":"clerk","productName":"Hotsauce","orgName":"Acme","signInDomain":"acme.com"}"#
        let result = await Workspace.check(url("https://old.acme.com"), fetch: fetcher([
            "https://old.acme.com/api/health": (200, moved),
            "https://hotsauce.acme.com/api/health": (200, moved),
        ]))
        guard case let .found(info) = result else { Issue.record("expected found, got \(result)"); return }
        #expect(info.server == url("https://hotsauce.acme.com"))
    }

    @Test func checkStaysWhenTheReportedAddressDoesNotAnswer() async {
        let moved = #"{"ok":true,"publicUrl":"https://hotsauce.acme.com","authMode":"clerk","productName":"Hotsauce","orgName":"Acme"}"#
        let result = await Workspace.check(url("https://old.acme.com"), fetch: fetcher([
            "https://old.acme.com/api/health": (200, moved),
        ]))
        guard case let .found(info) = result else { Issue.record("expected found, got \(result)"); return }
        #expect(info.server == url("https://old.acme.com"))
    }

    @Test func checkNeverFollowsARealServerToLocalhost() async {
        let local = #"{"ok":true,"publicUrl":"http://localhost:3000","authMode":"clerk","productName":"Hotsauce","orgName":"Acme"}"#
        let result = await Workspace.check(url("https://team.acme.com"), fetch: fetcher([
            "https://team.acme.com/api/health": (200, local),
            "http://localhost:3000/api/health": (200, local),
        ]))
        guard case let .found(info) = result else { Issue.record("expected found, got \(result)"); return }
        #expect(info.server == url("https://team.acme.com"))
    }

    @Test func checkSaysWhenItIsNotHotsauce() async {
        #expect(await Workspace.check(url("https://www.acme.com"), fetch: fetcher([
            "https://www.acme.com/api/health": (200, #"{"status":"ok"}"#),
        ])) == .notHotsauce)
        #expect(await Workspace.check(url("https://www.acme.com"), fetch: fetcher([
            "https://www.acme.com/api/health": (404, "<html>Not found</html>"),
        ])) == .notHotsauce)
    }

    @Test func checkSaysWhenItCannotReachIt() async {
        let result = await Workspace.check(url("https://nowhere.acme.com"), fetch: fetcher([:]))
        guard case .unreachable = result else { Issue.record("expected unreachable, got \(result)"); return }
    }

    @Test func messagesNameTheAddress() {
        #expect(Workspace.CheckResult.notHotsauce.message(for: url("https://www.acme.com"))
            == "www.acme.com answered, but it isn’t a Hotsauce workspace. Check the address with whoever set it up.")
        #expect(Workspace.CheckResult.unreachable("A server with the specified hostname could not be found.").message(for: url("https://nowhere.acme.com"))
            == "Couldn’t reach nowhere.acme.com. A server with the specified hostname could not be found.")
    }
}
