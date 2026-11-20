import DictateCore
import Foundation
import Testing

/// docs/PLAN-mac-check-for-updates.md C2-C4.
struct UpdateCheckTests {
    @Test func saysWhichVersionIsUpToDate() {
        let message = UpdateCheck.message(.upToDate(version: "0.62.4", build: "140"), name: "Hotsauce")
        #expect(message.title == "You’re up to date")
        #expect(message.text == "Hotsauce 0.62.4 (build 140) is the newest version.")
        #expect(message.cancel == nil)
        #expect(message.action == .none)
        #expect(UpdateCheck.message(.upToDate(version: "0.62.4", build: nil), name: "Hotsauce").text == "Hotsauce 0.62.4 is the newest version.")
        #expect(UpdateCheck.message(.upToDate(version: nil, build: nil), name: "Hotsauce").text == "This copy of Hotsauce is the newest version.")
        #expect(UpdateCheck.message(.newer(.none), name: "Hotsauce") == UpdateCheck.message(.upToDate(version: nil, build: nil), name: "Hotsauce"))
    }

    @Test func offersTheRestartWhenReady() {
        let message = UpdateCheck.message(.newer(.ready("0.63.0")), name: "Hotsauce")
        #expect(message.title == "Hotsauce 0.63.0 is ready")
        #expect(message.button == "Restart Now")
        #expect(message.cancel == "Later")
        #expect(message.action == .restart)
    }

    @Test func waitsWhileDownloadingAndFallsBackToTheDownload() {
        let downloading = UpdateCheck.message(.newer(.downloading("0.63.0")), name: "Hotsauce")
        #expect(downloading.title == "Downloading Hotsauce 0.63.0…")
        #expect(downloading.action == .none)
        let available = UpdateCheck.message(.newer(.available("0.63.0")), name: "Hotsauce")
        #expect(available.title == "Hotsauce 0.63.0 is out")
        #expect(available.button == "Download")
        #expect(available.action == .download)
    }

    @Test func explainsWhyItCouldNotCheck() {
        #expect(UpdateCheck.message(.noWorkspace, name: "Hotsauce").title == "Connect to a workspace first")
        #expect(UpdateCheck.message(.unreachable, name: "Hotsauce").title == "Couldn’t check for updates")
        #expect(UpdateCheck.message(.unreachable).action == .none)
        #expect(UpdateCheck.message(.notOffered, name: "Hotsauce").title == "No updates offered here")
        #expect(UpdateCheck.message(.unversioned, name: "Hotsauce").title == "Can’t check this build")
    }

    @Test func versionTextIgnoresJunk() {
        #expect(UpdateCheck.versionText("0.62.4", build: "140") == "0.62.4 (build 140)")
        #expect(UpdateCheck.versionText("0.62.4", build: "abc") == "0.62.4")
        #expect(UpdateCheck.versionText("dev", build: "140") == nil)
    }

    @Test func aboutLinksToTheSource() {
        #expect(AboutInfo.sourceURL.absoluteString == "https://github.com/hotsauce-suite/hotsauce")
        #expect(AboutInfo.sourceLabel == "github.com/hotsauce-suite/hotsauce")
    }

    @Test func checksAfterWakingWhenDue() {
        let now = Date(timeIntervalSince1970: 1_000_000)
        #expect(UpdateCheck.dueOnWake(lastCheck: nil, now: now))
        #expect(UpdateCheck.dueOnWake(lastCheck: now.addingTimeInterval(-3_600), now: now))
        #expect(!UpdateCheck.dueOnWake(lastCheck: now.addingTimeInterval(-600), now: now))
    }
}
