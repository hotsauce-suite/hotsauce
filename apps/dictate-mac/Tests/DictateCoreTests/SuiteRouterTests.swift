import Foundation
import Testing
@testable import DictateCore

@Suite struct SuiteRouterTests {
    let router = SuiteRouter(server: URL(string: "https://office.example.com")!)

    func url(_ s: String) -> URL { URL(string: s)! }

    @Test func suitePagesStayInTheWindow() {
        #expect(router.decide(url("https://office.example.com/meetings"), isMainFrame: true, userClicked: true, newWindow: false) == .allow)
        #expect(router.decide(url("https://OFFICE.example.com:443/docs"), isMainFrame: true, userClicked: true, newWindow: false) == .allow)
    }

    @Test func otherOriginsOfTheSameHostAreNotTheSuite() {
        #expect(!router.isSuite(url("http://office.example.com/")))
        #expect(!router.isSuite(url("https://office.example.com:8443/")))
        #expect(!router.isSuite(url("https://chat.office.example.com/")))
        #expect(!router.isSuite(url("https://office.example.com.evil.com/")))
    }

    @Test func clickedLinksElsewhereOpenInTheBrowser() {
        #expect(router.decide(url("https://github.com/x"), isMainFrame: true, userClicked: true, newWindow: false) == .openExternally)
        #expect(router.decide(url("https://chat.office.example.com"), isMainFrame: true, userClicked: true, newWindow: false) == .openExternally)
    }

    @Test func newWindowsOpenElsewhereUnlessTheyAreTheSuite() {
        #expect(router.decide(url("https://chat.office.example.com"), isMainFrame: true, userClicked: true, newWindow: true) == .openExternally)
        #expect(router.decide(url("https://office.example.com/clips/abc"), isMainFrame: true, userClicked: true, newWindow: true) == .loadInWindow(url("https://office.example.com/clips/abc")))
    }

    @Test func signInGoesThroughTheBrowser() {
        for page in ["https://accounts.google.com/o/oauth2/v2/auth?x=1", "https://clerk.office.example.com/v1/oauth_callback",
                     "https://accounts.office.example.com/sign-in", "https://smart-fox-1.clerk.accounts.dev/v1/client"] {
            #expect(router.decide(url(page), isMainFrame: true, userClicked: true, newWindow: false) == .signInWithBrowser, Comment(rawValue: page))
            #expect(router.decide(url(page), isMainFrame: true, userClicked: false, newWindow: true) == .signInWithBrowser, Comment(rawValue: page))
        }
        #expect(!router.isSignIn(url("http://accounts.google.com/")))
        #expect(!router.isSignIn(url("https://accounts.google.com.evil.com/")))
        #expect(!router.isSignIn(url("https://evilclerk.com/")))
    }

    @Test func otherSitesNeverLoadInTheWindow() {
        // A script or redirect elsewhere goes to the browser, which shows the address.
        #expect(router.decide(url("https://evil.example/fake-login"), isMainFrame: true, userClicked: false, newWindow: false) == .openExternally)
        #expect(router.decide(url("https://accounts.youtube.com/x"), isMainFrame: true, userClicked: false, newWindow: false) == .openExternally)
        // Iframes load where they are.
        #expect(router.decide(url("https://www.youtube.com/embed/x"), isMainFrame: false, userClicked: false, newWindow: false) == .allow)
    }

    @Test func noPageCanOpenOtherAppsOrFiles() {
        for target in ["file:///Users/me/Downloads/x.command", "file:///System/Applications/Calculator.app", "ssh://host",
                       "x-apple.systempreferences:com.apple.x", "zoommtg://x", "javascript:alert(1)"] {
            for clicked in [true, false] {
                #expect(router.decide(url(target), isMainFrame: true, userClicked: clicked, newWindow: false) == .cancel, Comment(rawValue: target))
                #expect(router.decide(url(target), isMainFrame: false, userClicked: clicked, newWindow: true) == .cancel, Comment(rawValue: target))
            }
        }
    }

    @Test func mailLinksOpenOnAClick() {
        #expect(router.decide(url("mailto:a@b.com"), isMainFrame: true, userClicked: true, newWindow: false) == .openExternally)
        #expect(router.decide(url("mailto:a@b.com"), isMainFrame: true, userClicked: false, newWindow: false) == .cancel)
        #expect(router.decide(url("blob:https://office.example.com/1"), isMainFrame: true, userClicked: true, newWindow: false) == .allow)
        #expect(router.decide(url("about:blank"), isMainFrame: false, userClicked: false, newWindow: false) == .allow)
    }

    @Test func theAppsOwnLinksComeBackToIt() {
        let connect = url("hearth-dictate://connect?token=x")
        #expect(router.decide(connect, isMainFrame: true, userClicked: false, newWindow: false) == .handleInApp(connect))
        let deep = url("hearth://meetings")
        #expect(router.decide(deep, isMainFrame: true, userClicked: true, newWindow: true) == .handleInApp(deep))
    }

    @Test func pathsBecomeSuiteURLs() {
        #expect(router.url(forPath: "/meetings/start?event=a%20b#x")?.absoluteString == "https://office.example.com/meetings/start?event=a%20b#x")
        #expect(SuiteRouter(server: url("http://localhost:3000")).url(forPath: "/docs")?.absoluteString == "http://localhost:3000/docs")
        for bad in ["meetings", "//evil.com/x", "https://evil.com/x", "/\\evil.com", "", "/api/calendar/upcoming", "/API/x", "/api?x", "/mcp", "/ws/dictation", "/desktop/finish#ticket=x", "/Desktop%2Ffinish"] {
            #expect(router.url(forPath: bad) == nil, Comment(rawValue: bad))
        }
    }

    @Test func deepLinks() {
        #expect(SuiteRouter.deepLinkPath(url("hearth://meetings/start?event=1")) == "/meetings/start?event=1")
        #expect(SuiteRouter.deepLinkPath(url("hearth:///docs/team/a.md#L3")) == "/docs/team/a.md#L3")
        #expect(SuiteRouter.deepLinkPath(url("hearth://")) == "/")
        #expect(SuiteRouter.deepLinkPath(url("HEARTH://clips")) == "/clips")
        #expect(SuiteRouter.deepLinkPath(url("hearth-dictate://open?path=/meetings")) == "/meetings")
        #expect(SuiteRouter.deepLinkPath(url("hearth-dictate://open?path=//evil.com")) == nil)
        #expect(SuiteRouter.deepLinkPath(url("hearth-dictate://connect?token=x")) == nil)
        #expect(SuiteRouter.deepLinkPath(url("https://office.example.com/docs")) == nil)
        #expect(SuiteRouter.deepLinkPath(url("hotsauce://docs"), scheme: "hotsauce") == "/docs")
        // Whatever the link says, the result only ever becomes a path on the configured server.
        #expect(router.url(forPath: SuiteRouter.deepLinkPath(url("hearth:////evil.com/x"))!)?.host == "office.example.com")
    }
}

@Suite struct DownloadNameTests {
    let folder = URL(fileURLWithPath: "/Users/me/Downloads")

    @Test func unusedNameIsKept() {
        #expect(DownloadName.unique("clip.mp4", in: folder) { _ in false }.lastPathComponent == "clip.mp4")
    }

    @Test func takenNamesGetANumber() {
        let taken: Set<String> = ["clip.mp4", "clip 2.mp4", "notes"]
        let exists: (URL) -> Bool = { taken.contains($0.lastPathComponent) }
        #expect(DownloadName.unique("clip.mp4", in: folder, exists: exists).lastPathComponent == "clip 3.mp4")
        #expect(DownloadName.unique("notes", in: folder, exists: exists).lastPathComponent == "notes 2")
    }

    @Test func namesCantLeaveTheFolder() {
        let result = DownloadName.unique("../../etc/passwd", in: folder) { _ in false }
        #expect(result.deletingLastPathComponent().path == folder.path)
        #expect(result.lastPathComponent == "passwd")
        #expect(DownloadName.unique("  ", in: folder) { _ in false }.lastPathComponent == "download")
        #expect(DownloadName.unique("..", in: folder) { _ in false }.lastPathComponent == "download")
    }
}

@Suite struct MeetingReminderTests {
    let now = Date(timeIntervalSince1970: 1_800_000_000)

    func meeting(_ id: String, in seconds: TimeInterval, attendees: Int = 2) -> UpcomingMeeting {
        UpcomingMeeting(id: id, title: id, start: now.addingTimeInterval(seconds),
                        attendees: (0 ..< attendees).map { _ in .init(email: "a@b.com") })
    }

    @Test func decodesTheServersList() throws {
        let json = #"[{"id":"e1","title":"Acme sync","start":"2026-11-11T19:00:00.000Z","end":"2026-11-11T19:30:00.000Z","attendees":[{"email":"a@x.com","name":"A"}],"meetLink":"https://meet.google.com/x"},{"id":"e2","title":"Solo","start":"2026-11-11T20:00:00Z","end":"2026-11-11T20:30:00Z","attendees":[]}]"#
        let list = try UpcomingMeeting.decodeList(Data(json.utf8))
        #expect(list.map(\.id) == ["e1", "e2"])
        #expect(list[0].start == ISO8601DateFormatter().date(from: "2026-11-11T19:00:00Z"))
        #expect(list[1].attendees.count == 0)
    }

    @Test func remindsMeetingsWithAttendeesStartingWithinTheLead() {
        var planner = ReminderPlanner()
        let due = planner.due([meeting("soon", in: 60), meeting("solo", in: 60, attendees: 0),
                               meeting("later", in: 200), meeting("started", in: -10)], now: now)
        #expect(due.map(\.id) == ["soon"])
    }

    @Test func remindsOncePerEventAndStart() {
        var planner = ReminderPlanner()
        #expect(planner.due([meeting("m", in: 80)], now: now).count == 1)
        #expect(planner.due([meeting("m", in: 80)], now: now.addingTimeInterval(1)).count == 0)
        // Moved to a new time: reminded again then.
        let moved = meeting("m", in: 600)
        #expect(planner.due([moved], now: now.addingTimeInterval(530)).count == 1)
    }

    @Test func forgetsOldMeetings() {
        var planner = ReminderPlanner()
        _ = planner.due([meeting("m", in: 60)], now: now)
        _ = planner.due([], now: now.addingTimeInterval(2 * 3_600))
        #expect(planner.sent.isEmpty)
    }

    @Test func startPathEncodesTheId() {
        #expect(meeting("abc_123", in: 0).startPath == "/meetings/start?event=abc_123")
        #expect(meeting("a&b=c#d/e", in: 0).startPath == "/meetings/start?event=a%26b%3Dc%23d%2Fe")
    }
}
