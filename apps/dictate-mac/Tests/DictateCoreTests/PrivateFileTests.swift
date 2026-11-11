import Foundation
import Testing
@testable import DictateCore

@Suite struct PrivateFileTests {
    @Test func writesAFileOnlyThisUserCanRead() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("hd-private-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: dir) }
        let url = dir.appendingPathComponent("connection.json")
        #expect(PrivateFile.write(Data("one".utf8), to: url))
        #expect(PrivateFile.write(Data("two".utf8), to: url))
        #expect(PrivateFile.read(url) == Data("two".utf8))
        let attrs = try FileManager.default.attributesOfItem(atPath: url.path)
        #expect((attrs[.posixPermissions] as? NSNumber)?.intValue == 0o600)
        let dirAttrs = try FileManager.default.attributesOfItem(atPath: dir.path)
        #expect((dirAttrs[.posixPermissions] as? NSNumber)?.intValue == 0o700)
        #expect(try FileManager.default.contentsOfDirectory(atPath: dir.path) == ["connection.json"])
        PrivateFile.delete(url)
        #expect(PrivateFile.read(url) == nil)
    }

    @Test func refusesToReadASymlink() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("hd-private-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: dir) }
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let target = dir.appendingPathComponent("elsewhere.json")
        try Data("secret".utf8).write(to: target)
        let url = dir.appendingPathComponent("connection.json")
        try FileManager.default.createSymbolicLink(at: url, withDestinationURL: target)
        #expect(PrivateFile.read(url) == nil)
        // Writing replaces the link with a file; the target is untouched.
        #expect(PrivateFile.write(Data("mine".utf8), to: url))
        #expect(PrivateFile.read(url) == Data("mine".utf8))
        #expect(try Data(contentsOf: target) == Data("secret".utf8))
    }
}
