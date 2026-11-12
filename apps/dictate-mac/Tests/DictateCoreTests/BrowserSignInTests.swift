import Foundation
import Testing
@testable import DictateCore

@Suite struct BrowserSignInTests {
    let server = URL(string: "https://office.example.com")!
    let started = Date(timeIntervalSince1970: 1_800_000_000)

    @Test func statesAreRandomAndURLSafe() {
        let a = BrowserSignIn.randomState(), b = BrowserSignIn.randomState()
        #expect(a != b)
        #expect(a.count == 43)
        #expect(a.range(of: #"^[A-Za-z0-9_-]+$"#, options: .regularExpression) != nil)
    }

    @Test func opensTheConnectPageWithTheState() {
        let signIn = BrowserSignIn(state: "s".repeated(40), started: started)
        #expect(signIn.connectURL(server: server)?.absoluteString == "https://office.example.com/desktop/connect?state=\("s".repeated(40))")
    }

    @Test func acceptsOnlyItsOwnCallbackInTime() {
        let signIn = BrowserSignIn(state: "abc", started: started)
        let good = URL(string: "hearth://auth/callback?state=abc&ticket=tkt_1.x")!
        #expect(signIn.ticket(from: good, now: started.addingTimeInterval(30)) == "tkt_1.x")
        // Another sign-in's state (a link from a web page), too late, or not a callback.
        #expect(signIn.ticket(from: URL(string: "hearth://auth/callback?state=evil&ticket=tkt_1")!, now: started) == nil)
        #expect(signIn.ticket(from: good, now: started.addingTimeInterval(11 * 60)) == nil)
        #expect(signIn.ticket(from: URL(string: "hearth://auth/other?state=abc&ticket=t")!, now: started) == nil)
        #expect(signIn.ticket(from: URL(string: "hearth://auth/callback?state=abc&ticket=a%22b")!, now: started) == nil)
        #expect(signIn.ticket(from: URL(string: "hearth://auth/callback?state=abc")!, now: started) == nil)
    }

    @Test func callbacksAreNotDeepLinksToo() {
        #expect(BrowserSignIn.callback(URL(string: "hearth://auth/callback?state=a&ticket=b")!) != nil)
        #expect(BrowserSignIn.callback(URL(string: "hearth://docs")!) == nil)
    }

    @Test func theFinishPageCarriesNoTicket() {
        #expect(BrowserSignIn.finishURL(server: server)?.absoluteString == "https://office.example.com/desktop/finish")
    }
}

private extension String {
    func repeated(_ n: Int) -> String { String(repeating: self, count: n) }
}
