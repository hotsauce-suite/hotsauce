import DictateCore
import Foundation
import Security
import Testing

/// docs/PLAN-mac-self-update.md U1-U7. The signature and disk image tests use the real `codesign`
/// and `hdiutil` on throwaway bundles.
@Suite(.serialized) struct AppUpdateTests {
    // MARK: U1

    @Test func replacesOnlyAnInstalledWritableCopy() {
        let installed = URL(fileURLWithPath: "/Applications/Hotsauce.app")
        #expect(AppUpdate.destination(bundle: installed, isWritable: { _ in true }) == .success(installed))
        #expect(AppUpdate.destination(bundle: installed, isWritable: { _ in false }) == .failure(.notWritable))
        let mine = URL(fileURLWithPath: "/Users/me/Applications/Hotsauce.app")
        #expect(AppUpdate.destination(bundle: mine, isWritable: { $0.path == "/Users/me/Applications" }) == .success(mine))
        #expect(AppUpdate.destination(bundle: URL(fileURLWithPath: "/Volumes/Hotsauce/Hotsauce.app"), isWritable: { _ in true }) == .failure(.notInstalled))
        let moved = URL(fileURLWithPath: "/private/var/folders/x/AppTranslocation/ABC/d/Hotsauce.app")
        #expect(AppUpdate.destination(bundle: moved, isWritable: { _ in true }) == .failure(.notInstalled))
        #expect(AppUpdate.destination(bundle: URL(fileURLWithPath: "/usr/local/bin/hotsauce"), isWritable: { _ in true }) == .failure(.notInstalled))
    }

    // MARK: U2

    @Test func acceptsOnlyANewerCopyOfTheSameApp() {
        let installed = AppUpdate.BundleInfo(id: "dev.hotsauce.dictate", version: "0.40.0", build: "118")
        #expect(AppUpdate.verdict(installed: installed, candidate: .init(id: "dev.hotsauce.dictate", version: "0.43.1", build: "123")) == nil)
        #expect(AppUpdate.verdict(installed: installed, candidate: .init(id: "dev.hotsauce.dictate", version: "0.40.0", build: "119")) == nil)
        #expect(AppUpdate.verdict(installed: installed, candidate: .init(id: "dev.hotsauce.dictate", version: "0.40.0", build: "118")) == .notNewer)
        #expect(AppUpdate.verdict(installed: installed, candidate: .init(id: "dev.hotsauce.dictate", version: "0.39.9", build: "200")) == .notNewer)
        #expect(AppUpdate.verdict(installed: installed, candidate: .init(id: "dev.someone.else", version: "9.0.0", build: "999")) == .wrongApp)
    }

    // MARK: U3

    @Test func checksTheSignatureAgainstTheRequirement() throws {
        let dir = try Fixture.folder()
        defer { try? FileManager.default.removeItem(at: dir) }
        let a = try Fixture.app(in: dir, name: "A", version: "1.0.0", build: "1")
        let b = try Fixture.app(in: dir, name: "B", version: "1.0.1", build: "2")
        let byID = try #require(Fixture.requirement(#"identifier "dev.test.update""#))
        #expect(AppUpdate.satisfies(b, byID))
        // An ad hoc signature's requirement is its own hash: no other build satisfies it.
        let ofA = try #require(AppUpdate.requirement(ofApp: a))
        #expect(AppUpdate.satisfies(a, ofA))
        #expect(!AppUpdate.satisfies(b, ofA))
        // Changed after signing.
        try Data("tampered".utf8).write(to: b.appendingPathComponent("Contents/Resources/extra.txt"))
        #expect(!AppUpdate.satisfies(b, byID))
    }

    // MARK: U4

    @Test func preparesACheckedCopyFromADiskImage() async throws {
        let dir = try Fixture.folder()
        defer { try? FileManager.default.removeItem(at: dir) }
        let image = try Fixture.diskImage(in: dir, version: "1.2.0", build: "5")
        let staging = dir.appendingPathComponent("staging")
        let installed = AppUpdate.BundleInfo(id: "dev.test.update", version: "1.1.0", build: "4")
        let byID = try #require(Fixture.requirement(#"identifier "dev.test.update""#))

        let result = await AppUpdate.prepare(dmg: image, into: staging, installed: installed, requirement: byID)
        let staged = try result.get()
        #expect(staged.version == "1.2.0" && staged.build == "5")
        #expect(FileManager.default.fileExists(atPath: staged.app.appendingPathComponent("Contents/Info.plist").path))
        #expect(!FileManager.default.fileExists(atPath: staging.appendingPathComponent("update.dmg").path))
        #expect(!FileManager.default.fileExists(atPath: staging.appendingPathComponent("mount").path))
    }

    @Test func refusesACopySignedByAnotherIdentity() async throws {
        let dir = try Fixture.folder()
        defer { try? FileManager.default.removeItem(at: dir) }
        let image = try Fixture.diskImage(in: dir, version: "1.2.0", build: "5")
        let other = try #require(Fixture.requirement(#"identifier "dev.test.update" and certificate leaf[subject.CN] = "Someone Else""#))
        let installed = AppUpdate.BundleInfo(id: "dev.test.update", version: "1.1.0", build: "4")
        let staging = dir.appendingPathComponent("staging")
        #expect(await AppUpdate.prepare(dmg: image, into: staging, installed: installed, requirement: other) == .failure(.signature))
        #expect(!FileManager.default.fileExists(atPath: staging.appendingPathComponent("Updated.app").path))
    }

    @Test func refusesAnOlderCopyAndAMissingImage() async throws {
        let dir = try Fixture.folder()
        defer { try? FileManager.default.removeItem(at: dir) }
        let image = try Fixture.diskImage(in: dir, version: "1.2.0", build: "5")
        let byID = try #require(Fixture.requirement(#"identifier "dev.test.update""#))
        let staging = dir.appendingPathComponent("staging")
        let newer = AppUpdate.BundleInfo(id: "dev.test.update", version: "1.3.0", build: "9")
        #expect(await AppUpdate.prepare(dmg: image, into: staging, installed: newer, requirement: byID) == .failure(.notNewer))
        let missing = dir.appendingPathComponent("nothing.dmg")
        #expect(await AppUpdate.prepare(dmg: missing, into: staging, installed: newer, requirement: byID) == .failure(.download))
        let other = AppUpdate.BundleInfo(id: "dev.other.app", version: "0.1.0", build: "1")
        #expect(await AppUpdate.prepare(dmg: image, into: staging, installed: other, requirement: byID) == .failure(.noApp))
    }

    // MARK: U5

    @Test func swapsTheCopiesOnceTheAppHasQuit() throws {
        let dir = try Fixture.folder()
        defer { try? FileManager.default.removeItem(at: dir) }
        let dest = dir.appendingPathComponent("Applications/Test.app")
        let staged = dir.appendingPathComponent("staging/Test.app")
        try Fixture.marker(dest, "old")
        try Fixture.marker(staged, "new")
        let opened = dir.appendingPathComponent("opened")
        let opener = try Fixture.opener(in: dir, recording: opened)

        let app = Process()
        app.executableURL = URL(fileURLWithPath: "/bin/sleep")
        app.arguments = ["0.3"]
        try app.run()
        try Fixture.sh(AppUpdate.swapArguments(pid: app.processIdentifier, staged: staged, destination: dest, opener: opener.path))

        #expect(try String(contentsOf: dest.appendingPathComponent("marker"), encoding: .utf8) == "new")
        #expect(!FileManager.default.fileExists(atPath: staged.path))
        #expect(!FileManager.default.fileExists(atPath: dir.appendingPathComponent("staging/previous-Test.app").path))
        #expect(try String(contentsOf: opened, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines) == dest.path)
    }

    @Test func putsTheOldCopyBackWhenTheSwapFails() throws {
        let dir = try Fixture.folder()
        defer { try? FileManager.default.removeItem(at: dir) }
        let dest = dir.appendingPathComponent("Applications/Test.app")
        try Fixture.marker(dest, "old")
        let staged = dir.appendingPathComponent("staging/Test.app") // never made
        try FileManager.default.createDirectory(at: staged.deletingLastPathComponent(), withIntermediateDirectories: true)
        let opener = try Fixture.opener(in: dir, recording: dir.appendingPathComponent("opened"))
        try Fixture.sh(AppUpdate.swapArguments(pid: 999_999, staged: staged, destination: dest, opener: opener.path))
        #expect(try String(contentsOf: dest.appendingPathComponent("marker"), encoding: .utf8) == "old")
    }

    @Test func swapArgumentsCarryPathsAsArguments() {
        let args = AppUpdate.swapArguments(
            pid: 42, staged: URL(fileURLWithPath: "/A b/s/Hot\"sauce.app"), destination: URL(fileURLWithPath: "/Applications/Hot\"sauce.app")
        )
        #expect(args[0] == "-c" && args[1] == AppUpdate.swapScript && args[2] == "sh" && args[3] == "42")
        #expect(args[4] == "/A b/s/Hot\"sauce.app")
        #expect(args[5] == "/Applications/Hot\"sauce.app")
        #expect(args[6] == "/A b/s/previous-Hot\"sauce.app")
        #expect(args[7] == "/usr/bin/open")
        #expect(!AppUpdate.swapScript.contains("Hot"))
    }

    // MARK: U6, U7

    @Test func menuAndPageSayWhereTheUpdateStands() {
        #expect(UpdateState.none.menuEntry == nil)
        #expect(UpdateState.available("0.44.0").menuEntry! == ("Update available (0.44.0)…", true))
        #expect(UpdateState.downloading("0.44.0").menuEntry! == ("Downloading update (0.44.0)…", false))
        #expect(UpdateState.ready("0.44.0").menuEntry! == ("Restart to update (0.44.0)", true))
        #expect(UpdateState.none.reply == ["state": "none"])
        #expect(UpdateState.ready("0.44.0").reply == ["state": "ready", "version": "0.44.0"])
        #expect(UpdateBridge.request("state") == .state)
        #expect(UpdateBridge.request("install") == .install)
        #expect(UpdateBridge.request("Install") == nil)
        #expect(UpdateBridge.request(["type": "install"]) == nil)
    }
}

/// Throwaway app bundles, signed ad hoc with the real `codesign`.
private enum Fixture {
    static func folder() throws -> URL {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("appupdate-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    static func app(in dir: URL, name: String, version: String, build: String) throws -> URL {
        let app = dir.appendingPathComponent("\(name).app")
        let macOS = app.appendingPathComponent("Contents/MacOS")
        try FileManager.default.createDirectory(at: macOS, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: app.appendingPathComponent("Contents/Resources"), withIntermediateDirectories: true)
        try FileManager.default.copyItem(atPath: "/usr/bin/true", toPath: macOS.appendingPathComponent("Test").path)
        let plist: [String: String] = [
            "CFBundleIdentifier": "dev.test.update", "CFBundleExecutable": "Test", "CFBundlePackageType": "APPL",
            "CFBundleShortVersionString": version, "CFBundleVersion": build,
        ]
        try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0)
            .write(to: app.appendingPathComponent("Contents/Info.plist"))
        try run("/usr/bin/codesign", ["--force", "--deep", "-s", "-", "-i", "dev.test.update", app.path])
        return app
    }

    static func diskImage(in dir: URL, version: String, build: String) throws -> URL {
        let source = dir.appendingPathComponent("image-src")
        try FileManager.default.createDirectory(at: source, withIntermediateDirectories: true)
        let app = try Fixture.app(in: source, name: "Updated", version: version, build: build)
        try FileManager.default.createSymbolicLink(at: source.appendingPathComponent("Applications"), withDestinationURL: URL(fileURLWithPath: "/Applications"))
        _ = app
        let image = dir.appendingPathComponent("Test.dmg")
        try run("/usr/bin/hdiutil", ["create", "-quiet", "-srcfolder", source.path, "-volname", "Test", "-format", "UDZO", "-ov", image.path])
        return image
    }

    static func requirement(_ text: String) -> SecRequirement? {
        var requirement: SecRequirement?
        return SecRequirementCreateWithString(text as CFString, [], &requirement) == errSecSuccess ? requirement : nil
    }

    static func marker(_ app: URL, _ text: String) throws {
        try FileManager.default.createDirectory(at: app, withIntermediateDirectories: true)
        try Data(text.utf8).write(to: app.appendingPathComponent("marker"))
    }

    /// Stands in for `open`: writes the path it was given.
    static func opener(in dir: URL, recording file: URL) throws -> URL {
        let script = dir.appendingPathComponent("opener.sh")
        try Data("#!/bin/sh\necho \"$1\" > '\(file.path)'\n".utf8).write(to: script)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: script.path)
        return script
    }

    static func sh(_ arguments: [String]) throws {
        try run("/bin/sh", arguments, allowFailure: true)
    }

    static func run(_ tool: String, _ arguments: [String], allowFailure: Bool = false) throws {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: tool)
        task.arguments = arguments
        try task.run()
        task.waitUntilExit()
        if !allowFailure && task.terminationStatus != 0 {
            throw NSError(domain: "Fixture", code: Int(task.terminationStatus), userInfo: [NSLocalizedDescriptionKey: "\(tool) failed"])
        }
    }
}
