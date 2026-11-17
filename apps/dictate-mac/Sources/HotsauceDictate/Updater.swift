import AppKit
import DictateCore

/// Gets a newer build ready quietly and swaps it in on a click (docs/PLAN-mac-self-update.md).
/// When it can't (running from the disk image, a folder it can't write, a failed check), it
/// offers the download instead, as before.
@MainActor
final class Updater {
    private(set) var state: UpdateState = .none {
        didSet { if state != oldValue { onChange(state) } }
    }
    var onChange: (UpdateState) -> Void = { _ in }
    /// The version the server offered for what's downloading or ready (the feed's, which the
    /// disk image's own version may spell differently).
    private var offered: String?
    private var staged: AppUpdate.Staged?
    private var destination: URL?
    private var requirement: SecRequirement?
    private var preparing: Task<Void, Never>?

    private static let failedKey = "update.failedVersion"
    private static let attemptedKey = "update.attempted"

    init() {
        // A restart into an update that reopened on the old version: the swap didn't take
        // (App Management, a folder it couldn't change). Don't offer that one again.
        if let attempted = UserDefaults.standard.string(forKey: Self.attemptedKey) {
            UserDefaults.standard.removeObject(forKey: Self.attemptedKey)
            if let current = AppVersion.current, AppVersion.compare(current, attempted) == .orderedAscending {
                Self.remember(.swap, for: attempted)
            }
        }
        try? FileManager.default.removeItem(at: Self.stagingRoot)
    }

    /// A folder of the app's own that survives restarts (temporary folders get cleaned).
    private static var stagingRoot: URL {
        let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first
            ?? FileManager.default.temporaryDirectory
        return caches.appendingPathComponent("\(Bundle.main.bundleIdentifier ?? "dev.hotsauce.dictate")/Update", isDirectory: true)
    }

    private static func remember(_ failure: AppUpdate.Failure, for version: String) {
        UserDefaults.standard.set("\(failure) for \(version) at \(ISO8601DateFormatter().string(from: Date()))", forKey: "status.updateFailed")
        if failure.isPermanent { UserDefaults.standard.set(version, forKey: failedKey) }
    }

    /// The server offers `version` (nil: nothing newer). Starts getting it ready when it can.
    func offer(_ version: String?, server: URL?) {
        guard let version, let server else { return reset(to: .none) }
        if offered == version {
            switch state {
            case .downloading, .ready: return
            default: break
            }
        }
        // Failed for good last time (wrong signer, a swap that didn't take): just the download.
        if UserDefaults.standard.string(forKey: Self.failedKey) == version { return reset(to: .available(version)) }
        let files = FileManager.default
        let root = Self.stagingRoot
        try? files.createDirectory(at: root, withIntermediateDirectories: true)
        guard case .success(let destination) = AppUpdate.destination(bundle: Bundle.main.bundleURL, isWritable: { files.isWritableFile(atPath: $0.path) }),
              let installed = AppUpdate.BundleInfo(app: Bundle.main.bundleURL),
              let requirement = AppUpdate.runningRequirement(),
              Self.sameVolume(root, destination.deletingLastPathComponent())
        else { return reset(to: .available(version)) }
        reset(to: .downloading(version))
        self.offered = version
        self.destination = destination
        self.requirement = requirement
        let folder = root.appendingPathComponent(UUID().uuidString, isDirectory: true)
        let url = AppVersion.downloadURL(server: server)
        preparing = Task { [weak self] in
            let result = await AppUpdate.prepare(dmg: url, into: folder, installed: installed, requirement: requirement)
            guard let self, !Task.isCancelled, self.offered == version else {
                try? FileManager.default.removeItem(at: folder)
                return
            }
            switch result {
            case .success(let staged):
                self.staged = staged
                self.state = .ready(staged.version)
            case .failure(let failure):
                Self.remember(failure, for: version)
                try? FileManager.default.removeItem(at: folder)
                self.state = .available(version)
            }
        }
    }

    /// Drops whatever was downloading or ready.
    private func reset(to newState: UpdateState) {
        preparing?.cancel()
        preparing = nil
        if let staged { try? FileManager.default.removeItem(at: staged.app.deletingLastPathComponent()) }
        staged = nil
        offered = nil
        state = newState
    }

    private static func sameVolume(_ a: URL, _ b: URL) -> Bool {
        let key = URLResourceKey.volumeIdentifierKey
        guard let x = try? a.resourceValues(forKeys: [key]).volumeIdentifier as? NSObject,
              let y = try? b.resourceValues(forKeys: [key]).volumeIdentifier as? NSObject else { return false }
        return x.isEqual(y)
    }

    /// Checks the ready copy again, then quits, swaps the copies and reopens. False when it can't
    /// (it then offers the download).
    func installAndRelaunch() -> Bool {
        guard case .ready = state, let staged, let destination, let requirement, let version = offered,
              let installed = AppUpdate.BundleInfo(app: Bundle.main.bundleURL)
        else { return false }
        if let failure = AppUpdate.recheck(staged, installed: installed, requirement: requirement) {
            Self.remember(failure, for: version)
            reset(to: .available(version))
            return false
        }
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/bin/sh")
        task.arguments = AppUpdate.swapArguments(pid: ProcessInfo.processInfo.processIdentifier, staged: staged.app, destination: destination)
        do { try task.run() } catch { return false }
        UserDefaults.standard.set(staged.version, forKey: Self.attemptedKey)
        NSApp.terminate(nil)
        return true
    }
}
