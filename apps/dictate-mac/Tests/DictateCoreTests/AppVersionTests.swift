import DictateCore
import Foundation
import Testing

@Suite struct AppVersionTests {
    @Test func headerOnlyForAPlainVersion() {
        #expect(AppVersion.headerValue(version: "0.26.0") == "mac/0.26.0")
        #expect(AppVersion.headerValue(version: nil) == nil)
        #expect(AppVersion.headerValue(version: "0.26") == nil)
        #expect(AppVersion.headerValue(version: "0.26.0'); alert(1)//") == nil)
    }

    @Test func tagsARequest() {
        var request = URLRequest(url: URL(string: "https://team.example.test/api/dictation/words")!)
        AppVersion.tag(&request, version: "0.26.0", build: nil)
        #expect(request.value(forHTTPHeaderField: "Hotsauce-App") == "mac/0.26.0")
        var untagged = URLRequest(url: URL(string: "https://team.example.test/")!)
        AppVersion.tag(&untagged, version: nil, build: nil)
        #expect(untagged.value(forHTTPHeaderField: "Hotsauce-App") == nil)
    }

    @Test func comparesNumberByNumber() {
        #expect(AppVersion.compare("0.9.0", "0.10.0") == .orderedAscending)
        #expect(AppVersion.compare("0.26.1", "0.26.0") == .orderedDescending)
        #expect(AppVersion.compare("0.26.0", "0.26.0") == .orderedSame)
    }

    @Test func offersAnUpdateOnlyWhenNewer() {
        let json = Data(#"{"version":"0.27.0","build":"1400","reportsVersion":true}"#.utf8)
        let latest = AppVersion.latest(fromJSON: json)
        #expect(latest == AppVersion.Latest(version: "0.27.0", build: "1400"))
        #expect(AppVersion.update(installed: "0.26.0", latest: latest) == "0.27.0")
        #expect(AppVersion.update(installed: "0.27.0", latest: latest) == nil)
        #expect(AppVersion.update(installed: "0.28.0", latest: latest) == nil)
        #expect(AppVersion.update(installed: nil, latest: latest) == nil)
        #expect(AppVersion.latest(fromJSON: Data("<html>".utf8)) == nil)
    }

    @Test func aNewerBuildOfTheSameReleaseIsAnUpdate() {
        let latest = AppVersion.Latest(version: "0.27.0", build: "1400")
        #expect(AppVersion.update(installed: "0.27.0", installedBuild: "1300", latest: latest) == "0.27.0")
        #expect(AppVersion.update(installed: "0.27.0", installedBuild: "1400", latest: latest) == nil)
        #expect(AppVersion.update(installed: "0.27.0", installedBuild: nil, latest: latest) == nil)
        #expect(AppVersion.headerValue(version: "0.27.0", build: "1300") == "mac/0.27.0+1300")
        #expect(AppVersion.headerValue(version: "0.27.0", build: "x") == "mac/0.27.0")
    }

    @Test func pageScriptCarriesOnlyPlainValues() {
        #expect(
            AppVersion.pageScript(version: "0.26.0", build: "1300")
                == "window.hotsauceMacApp = Object.freeze({ version: '0.26.0', build: '1300' });"
        )
        #expect(
            AppVersion.pageScript(version: "0.26.0", build: "x'y")
                == "window.hotsauceMacApp = Object.freeze({ version: '0.26.0' });"
        )
        #expect(AppVersion.pageScript(version: nil, build: "1") == nil)
    }

    @Test func serverAddresses() {
        let server = URL(string: "https://team.example.test")!
        #expect(AppVersion.infoURL(server: server).absoluteString == "https://team.example.test/downloads/mac-app.json")
        #expect(AppVersion.downloadURL(server: server).absoluteString == "https://team.example.test/downloads/Hotsauce.dmg")
    }

    @Test func noUpdateForARebuildOfTheSameApp() {
        // Every Hotsauce release makes a Mac build; most change only the number.
        let json = Data(#"{"version":"0.36.0","build":"130","sameAppSince":"120"}"#.utf8)
        let latest = AppVersion.latest(fromJSON: json)
        #expect(latest?.sameAppSince == "120")
        #expect(AppVersion.update(installed: "0.34.1", installedBuild: "120", latest: latest) == nil)
        #expect(AppVersion.update(installed: "0.34.1", installedBuild: "125", latest: latest) == nil)
        #expect(AppVersion.update(installed: "0.33.0", installedBuild: "119", latest: latest) == "0.36.0")
        #expect(AppVersion.update(installed: "0.33.0", installedBuild: nil, latest: latest) == "0.36.0")
    }
}
