import Foundation

/// A small file only this user can read: 0600, in a 0700 folder, written through a private temp
/// file so it is never half-written or briefly readable by anyone else.
public enum PrivateFile {
    /// Nil for a missing file, and for a symlink: Hearth only ever writes a regular file here.
    public static func read(_ url: URL) -> Data? {
        let type = (try? FileManager.default.attributesOfItem(atPath: url.path))?[.type] as? FileAttributeType
        guard type == .typeRegular else { return nil }
        return try? Data(contentsOf: url)
    }

    @discardableResult
    public static func write(_ data: Data, to url: URL) -> Bool {
        let fm = FileManager.default
        let dir = url.deletingLastPathComponent()
        try? fm.createDirectory(at: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try? fm.setAttributes([.posixPermissions: 0o700], ofItemAtPath: dir.path)
        let temp = dir.appendingPathComponent(".\(url.lastPathComponent)-\(UUID().uuidString)")
        guard fm.createFile(atPath: temp.path, contents: data, attributes: [.posixPermissions: 0o600]) else { return false }
        // rename(2) swaps the new file in atomically, replacing whatever is at the path (a symlink
        // there is replaced, never followed).
        guard rename(temp.path, url.path) == 0 else {
            try? fm.removeItem(at: temp)
            return false
        }
        return true
    }

    public static func delete(_ url: URL) {
        try? FileManager.default.removeItem(at: url)
    }
}
