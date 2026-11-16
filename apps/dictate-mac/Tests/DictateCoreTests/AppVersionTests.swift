import DictateCore
import Foundation
import XCTest

final class AppVersionTests: XCTestCase {
    func testHeaderOnlyForAPlainVersion() {
        XCTAssertEqual(AppVersion.headerValue(version: "0.26.0"), "mac/0.26.0")
        XCTAssertNil(AppVersion.headerValue(version: nil))
        XCTAssertNil(AppVersion.headerValue(version: "0.26"))
        XCTAssertNil(AppVersion.headerValue(version: "0.26.0'); alert(1)//"))
    }

    func testTagsARequest() {
        var request = URLRequest(url: URL(string: "https://team.example.test/api/dictation/words")!)
        AppVersion.tag(&request, version: "0.26.0")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Hotsauce-App"), "mac/0.26.0")
        var untagged = URLRequest(url: URL(string: "https://team.example.test/")!)
        AppVersion.tag(&untagged, version: nil)
        XCTAssertNil(untagged.value(forHTTPHeaderField: "Hotsauce-App"))
    }

    func testComparesNumberByNumber() {
        XCTAssertEqual(AppVersion.compare("0.9.0", "0.10.0"), .orderedAscending)
        XCTAssertEqual(AppVersion.compare("0.26.1", "0.26.0"), .orderedDescending)
        XCTAssertEqual(AppVersion.compare("0.26.0", "0.26.0"), .orderedSame)
    }

    func testOffersAnUpdateOnlyWhenNewer() {
        let json = Data(#"{"version":"0.27.0","build":"1400","reportsVersion":true}"#.utf8)
        let latest = AppVersion.latest(fromJSON: json)
        XCTAssertEqual(latest, "0.27.0")
        XCTAssertEqual(AppVersion.update(installed: "0.26.0", latest: latest), "0.27.0")
        XCTAssertNil(AppVersion.update(installed: "0.27.0", latest: latest))
        XCTAssertNil(AppVersion.update(installed: "0.28.0", latest: latest))
        XCTAssertNil(AppVersion.update(installed: nil, latest: latest))
        XCTAssertNil(AppVersion.latest(fromJSON: Data("<html>".utf8)))
    }

    func testPageScriptCarriesOnlyPlainValues() {
        XCTAssertEqual(
            AppVersion.pageScript(version: "0.26.0", build: "1300"),
            "window.hotsauceMacApp = Object.freeze({ version: '0.26.0', build: '1300' });"
        )
        XCTAssertEqual(
            AppVersion.pageScript(version: "0.26.0", build: "x'y"),
            "window.hotsauceMacApp = Object.freeze({ version: '0.26.0' });"
        )
        XCTAssertNil(AppVersion.pageScript(version: nil, build: "1"))
    }

    func testServerAddresses() {
        let server = URL(string: "https://team.example.test")!
        XCTAssertEqual(AppVersion.infoURL(server: server).absoluteString, "https://team.example.test/downloads/mac-app.json")
        XCTAssertEqual(AppVersion.downloadURL(server: server).absoluteString, "https://team.example.test/downloads/Hotsauce.dmg")
    }
}
