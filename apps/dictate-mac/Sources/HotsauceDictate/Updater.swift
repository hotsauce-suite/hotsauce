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
    private var staged: AppUpdate.Staged?
    private var destination: URL?
    private var preparing: Task<Void, Never>?

    /// The server offers `version` (nil: nothing newer). Starts getting it ready when it can.
    func offer(_ version: String?, server: URL?) {
        guard let version, let server else {
            preparing?.cancel()
            preparing = nil
            staged = nil
            state = .none
            return
        }
        switch state {
        case .downloading(let v) where v == version: return
        case .ready(let v) where v == version: return
        default: break
        }
        guard case .success(let destination) = AppUpdate.destination(bundle: Bundle.main.bundleURL, isWritable: { FileManager.default.isWritableFile(atPath: $0.path) }),
              let installed = AppUpdate.BundleInfo(app: Bundle.main.bundleURL),
              let requirement = AppUpdate.runningRequirement(),
              let folder = try? FileManager.default.url(for: .itemReplacementDirectory, in: .userDomainMask, appropriateFor: destination, create: true)
        else {
            state = .available(version)
            return
        }
        self.destination = destination
        state = .downloading(version)
        let url = AppVersion.downloadURL(server: server)
        preparing?.cancel()
        preparing = Task { [weak self] in
            let result = await AppUpdate.prepare(dmg: url, into: folder, installed: installed, requirement: requirement)
            guard let self, !Task.isCancelled else { return }
            switch result {
            case .success(let staged):
                self.staged = staged
                self.state = .ready(staged.version)
            case .failure(let failure):
                UserDefaults.standard.set("\(failure) for \(version) at \(ISO8601DateFormatter().string(from: Date()))", forKey: "status.updateFailed")
                try? FileManager.default.removeItem(at: folder)
                self.state = .available(version)
            }
        }
    }

    /// Quits, swaps the copies and reopens. False when nothing is ready or the helper won't start.
    func installAndRelaunch() -> Bool {
        guard case .ready = state, let staged, let destination,
              FileManager.default.fileExists(atPath: staged.app.path)
        else { return false }
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/bin/sh")
        task.arguments = AppUpdate.swapArguments(pid: ProcessInfo.processInfo.processIdentifier, staged: staged.app, destination: destination)
        do { try task.run() } catch { return false }
        NSApp.terminate(nil)
        return true
    }
}
