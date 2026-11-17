import Foundation
import Security

/// The app updating itself (docs/PLAN-mac-self-update.md): fetch the newest disk image, copy the
/// app out of it, accept it only when it is newer, the same app and signed so it satisfies this
/// app's own designated requirement, then swap it in after quitting and reopen it.
public enum AppUpdate {
    public enum Failure: Error, Equatable, Sendable {
        /// Running from a disk image or a translocated copy: nothing of ours to replace.
        case notInstalled
        /// The app's folder isn't writable by this user.
        case notWritable
        case download
        case mount
        case noApp
        case wrongApp
        case notNewer
        case signature
        case copy
        /// A previous swap of this version didn't take (the app reopened on the old version).
        case swap

        /// Failures that a new download of the same version would hit again.
        public var isPermanent: Bool { [.wrongApp, .notNewer, .signature, .swap, .noApp].contains(self) }
    }

    // MARK: Where (U1)

    /// The installed app this update replaces: the running bundle itself, when it sits in a
    /// folder this user can write (the bundle too, since moving it aside renames it), not on a
    /// disk image and not translocated by Gatekeeper.
    public static func destination(bundle: URL, isWritable: (URL) -> Bool) -> Result<URL, Failure> {
        let app = bundle.standardizedFileURL
        let path = app.path
        if path.hasPrefix("/Volumes/") || path.contains("/AppTranslocation/") || app.pathExtension != "app" {
            return .failure(.notInstalled)
        }
        return isWritable(app.deletingLastPathComponent()) && isWritable(app) ? .success(app) : .failure(.notWritable)
    }

    // MARK: What (U2)

    public struct BundleInfo: Equatable, Sendable {
        public let id: String
        public let version: String
        public let build: String?
        public init(id: String, version: String, build: String?) {
            self.id = id
            self.version = version
            self.build = build
        }

        /// An app bundle's id, version and build from its Info.plist.
        public init?(app: URL) {
            guard let info = NSDictionary(contentsOf: app.appendingPathComponent("Contents/Info.plist")) as? [String: Any],
                  let id = info["CFBundleIdentifier"] as? String,
                  let version = AppVersion.valid(info["CFBundleShortVersionString"] as? String)
            else { return nil }
            self.init(id: id, version: version, build: AppVersion.validBuild(info["CFBundleVersion"] as? String))
        }
    }

    /// Why `candidate` can't replace `installed`, or nil when it can.
    public static func verdict(installed: BundleInfo, candidate: BundleInfo) -> Failure? {
        guard candidate.id == installed.id else { return .wrongApp }
        let newer = AppVersion.update(
            installed: installed.version, installedBuild: installed.build,
            latest: .init(version: candidate.version, build: candidate.build)
        )
        return newer == nil ? .notNewer : nil
    }

    // MARK: Who signed it (U3)

    /// The running app's designated requirement: who may replace it and keep its permissions.
    public static func runningRequirement() -> SecRequirement? {
        var me: SecCode?
        guard SecCodeCopySelf([], &me) == errSecSuccess, let me else { return nil }
        var onDisk: SecStaticCode?
        guard SecCodeCopyStaticCode(me, [], &onDisk) == errSecSuccess, let onDisk else { return nil }
        var requirement: SecRequirement?
        guard SecCodeCopyDesignatedRequirement(onDisk, [], &requirement) == errSecSuccess else { return nil }
        return requirement
    }

    /// An app bundle's designated requirement, read from its signature.
    public static func requirement(ofApp app: URL) -> SecRequirement? {
        var code: SecStaticCode?
        guard SecStaticCodeCreateWithPath(app as CFURL, [], &code) == errSecSuccess, let code else { return nil }
        var requirement: SecRequirement?
        guard SecCodeCopyDesignatedRequirement(code, [], &requirement) == errSecSuccess else { return nil }
        return requirement
    }

    /// Whether `app` has a valid, unaltered signature (every architecture, nested code included)
    /// that satisfies `requirement`.
    public static func satisfies(_ app: URL, _ requirement: SecRequirement) -> Bool {
        var code: SecStaticCode?
        guard SecStaticCodeCreateWithPath(app as CFURL, [], &code) == errSecSuccess, let code else { return false }
        let flags = SecCSFlags(rawValue: kSecCSCheckAllArchitectures | kSecCSStrictValidate | kSecCSCheckNestedCode)
        return SecStaticCodeCheckValidity(code, flags, requirement) == errSecSuccess
    }

    /// Checks a staged copy again right before it replaces the installed one: it may have sat
    /// for days, and only a copy that still passes U2 and U3 goes in.
    public static func recheck(_ staged: Staged, installed: BundleInfo, requirement: SecRequirement) -> Failure? {
        guard let info = BundleInfo(app: staged.app) else { return .noApp }
        if let failure = verdict(installed: installed, candidate: info) { return failure }
        guard info.version == staged.version, info.build == staged.build else { return .signature }
        return satisfies(staged.app, requirement) ? nil : .signature
    }

    // MARK: Getting it ready (U4)

    /// A new copy, checked and waiting next to the installed one.
    public struct Staged: Equatable, Sendable {
        public let app: URL
        public let version: String
        public let build: String?
        public init(app: URL, version: String, build: String?) {
            self.app = app
            self.version = version
            self.build = build
        }
    }

    /// Downloads the disk image at `url` into `folder` (a private folder on the installed app's
    /// disk), copies the app out and checks it against `installed` and `requirement`.
    public static func prepare(
        dmg url: URL, into folder: URL, installed: BundleInfo, requirement: SecRequirement,
        session: URLSession = .shared
    ) async -> Result<Staged, Failure> {
        let files = FileManager.default
        try? files.createDirectory(at: folder, withIntermediateDirectories: true)
        let image = folder.appendingPathComponent("update.dmg")
        let mount = folder.appendingPathComponent("mount", isDirectory: true)
        defer { try? files.removeItem(at: image) }

        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 60)
        request.setValue("application/x-apple-diskimage", forHTTPHeaderField: "Accept")
        guard let (download, response) = try? await session.download(for: request) else { return .failure(.download) }
        if let http = response as? HTTPURLResponse, http.statusCode != 200 {
            try? files.removeItem(at: download)
            return .failure(.download)
        }
        try? files.removeItem(at: image)
        guard (try? files.moveItem(at: download, to: image)) != nil else { return .failure(.download) }

        try? files.createDirectory(at: mount, withIntermediateDirectories: true)
        guard await run("/usr/bin/hdiutil", ["attach", image.path, "-nobrowse", "-readonly", "-noautoopen", "-mountpoint", mount.path]) == 0 else {
            _ = await run("/usr/bin/hdiutil", ["detach", mount.path, "-force"])
            try? files.removeItem(at: mount)
            return .failure(.mount)
        }
        let copied: Result<URL, Failure>
        if let inImage = (try? files.contentsOfDirectory(at: mount, includingPropertiesForKeys: nil))?
            .first(where: { $0.pathExtension == "app" && BundleInfo(app: $0)?.id == installed.id }) {
            let target = folder.appendingPathComponent(inImage.lastPathComponent)
            try? files.removeItem(at: target)
            copied = await run("/usr/bin/ditto", [inImage.path, target.path]) == 0 ? .success(target) : .failure(.copy)
        } else {
            copied = .failure(.noApp)
        }
        _ = await run("/usr/bin/hdiutil", ["detach", mount.path, "-force"])
        try? files.removeItem(at: mount)

        guard case .success(let app) = copied else {
            if case .failure(let failure) = copied { return .failure(failure) }
            return .failure(.copy)
        }
        _ = await run("/usr/bin/xattr", ["-dr", "com.apple.quarantine", app.path])
        guard let info = BundleInfo(app: app) else {
            try? files.removeItem(at: app)
            return .failure(.noApp)
        }
        if let failure = verdict(installed: installed, candidate: info) {
            try? files.removeItem(at: app)
            return .failure(failure)
        }
        guard satisfies(app, requirement) else {
            try? files.removeItem(at: app)
            return .failure(.signature)
        }
        return .success(Staged(app: app, version: info.version, build: info.build))
    }

    /// Runs a tool and waits for it, without a shell; its exit status, or -1 when it can't start.
    /// One that runs past `timeout` is stopped (and fails).
    static func run(_ tool: String, _ arguments: [String], timeout: TimeInterval = 120) async -> Int32 {
        await withCheckedContinuation { done in
            let task = Process()
            task.executableURL = URL(fileURLWithPath: tool)
            task.arguments = arguments
            task.standardOutput = FileHandle.nullDevice
            task.standardError = FileHandle.nullDevice
            task.terminationHandler = { done.resume(returning: $0.terminationStatus) }
            do { try task.run() } catch { return done.resume(returning: -1) }
            DispatchQueue.global().asyncAfter(deadline: .now() + timeout) { if task.isRunning { task.terminate() } }
        }
    }

    // MARK: Swapping (U5)

    /// The helper that swaps the copies once the app has quit. Run as
    /// `/bin/sh -c <script> sh <pid> <new app> <installed app> <old copy> <opener>`: everything
    /// arrives as arguments, nothing is built into the script. Gives up after 2 minutes if the
    /// app is still running, leaving everything as it was (the app is still open then).
    public static let swapScript = """
    pid="$1"; new="$2"; dest="$3"; old="$4"; opener="$5"
    i=0
    while kill -0 "$pid" 2>/dev/null; do
      i=$((i+1)); [ "$i" -gt 1200 ] && exit 1
      sleep 0.1
    done
    rm -rf "$old"
    if [ -e "$dest" ] && ! mv "$dest" "$old"; then "$opener" "$dest"; exit 1; fi
    if mv "$new" "$dest"; then
      rm -rf "$old"
    else
      [ -e "$old" ] && mv "$old" "$dest"
    fi
    "$opener" "$dest"
    """

    /// The arguments for `/bin/sh` that run `swapScript`.
    public static func swapArguments(pid: Int32, staged: URL, destination: URL, opener: String = "/usr/bin/open") -> [String] {
        let old = staged.deletingLastPathComponent().appendingPathComponent("previous-" + destination.lastPathComponent)
        return ["-c", swapScript, "sh", String(pid), staged.path, destination.path, old.path, opener]
    }
}

// MARK: What the menu and the page show (U6, U7)

/// Where the app's own update stands.
public enum UpdateState: Equatable, Sendable {
    case none
    /// Newer one out, but it can't be installed from here: offer the download.
    case available(String)
    case downloading(String)
    case ready(String)

    /// The menu bar menu's entry: its title and whether it can be clicked; nil for none.
    public var menuEntry: (title: String, enabled: Bool)? {
        switch self {
        case .none: return nil
        case .available(let v): return ("Update available (\(v))…", true)
        case .downloading(let v): return ("Downloading update (\(v))…", false)
        case .ready(let v): return ("Restart to update (\(v))", true)
        }
    }

    /// What the page's `hotsauceMacUpdate.postMessage('state')` gets back.
    public var reply: [String: String] {
        switch self {
        case .none: return ["state": "none"]
        case .available(let v): return ["state": "available", "version": v]
        case .downloading(let v): return ["state": "downloading", "version": v]
        case .ready(let v): return ["state": "ready", "version": v]
        }
    }
}

/// Settings → Apps asking the app about its update.
public enum UpdateBridge {
    public static let handlerName = "hotsauceMacUpdate"

    public enum Request: String, Sendable {
        case state
        case install
    }

    /// Strict: only the exact strings 'state' and 'install'.
    public static func request(_ body: Any) -> Request? {
        (body as? String).flatMap(Request.init(rawValue:))
    }
}
