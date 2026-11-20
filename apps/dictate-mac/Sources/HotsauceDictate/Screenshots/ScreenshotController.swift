import AppKit
import DictateCore

/// The screenshot tool (docs/PLAN-screenshots.md slice 2): the shortcut grabs every display, the
/// overlay picks what to keep, and the shot goes to the clipboard, the screenshots folder and the
/// preview in the corner. Nothing leaves the Mac until Share is pressed.
@MainActor
final class ScreenshotController {
    /// A short message in the dictation pill ("Couldn't save the screenshot").
    var showMessage: (String) -> Void = { _ in }

    private var session = ScreenshotSession()
    /// Bumped by each capture and each cancel, so a grab that finishes late can't act on a newer one.
    private var generation = 0
    private let overlay = CaptureOverlay()
    let preview = ScreenshotPreview()
    private let prompt = ScreenRecordingPrompt()
    private(set) var recent = RecentCaptures<Screenshot>()
    private let defaults: UserDefaults
    /// The editor's layers for the recent captures, so reopening one keeps them editable
    /// (in memory only).
    private var documents: [UUID: ShotDocument] = [:]
    private var editors: [UUID: ScreenshotEditor] = [:]
    /// The clipboard's change count right after a capture was copied, so a later save can swap in
    /// the edited picture only if nothing else has been copied since.
    private var copiedCapture: (id: UUID, changeCount: Int)?
    /// Hands a picture to the suite's page to share: (name, base64 PNG) → the page's answer.
    var sharePage: (String, String) async -> Any? = { _, _ in nil }
    /// The suite's host: a link pointing anywhere else is not taken.
    var suiteHost: () -> String? = { nil }
    /// Each share's number, so one that answers after giving up can't act.
    private var shareGeneration = 0
    static let shareTimeout: TimeInterval = 180
    /// One share at a time; a second press while one uploads is ignored.
    private var sharing = false

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        overlay.shortcut = { [weak self] in self?.shortcut ?? .default }
        overlay.onCancel = { [weak self] in self?.cancel() }
        overlay.onPick = { [weak self] display, selection in self?.keep(selection, of: display) }
        preview.onCopy = { [weak self] shot in self?.copy(shot) }
        prompt.relaunch = { [weak self] in self?.relaunch() }
        preview.onEdit = { [weak self] shot in self?.edit(shot) }
        preview.onShare = { [weak self] shot in self?.sharePreview(shot) }
        // Quitting with an editor open saves it as closing it would.
        NotificationCenter.default.addObserver(forName: NSApplication.willTerminateNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated {
                for editor in self?.editors.values.map({ $0 }) ?? [] {
                    _ = editor.saveIfNeeded()
                    editor.window.close()
                }
            }
        }
    }

    /// Opens a capture in the editor (one window each), with its layers from last time.
    func edit(_ shot: Screenshot) {
        preview.dismiss(animated: false)
        if let open = editors[shot.id] {
            open.show()
            return
        }
        let editor = ScreenshotEditor(shot: shot, document: documents[shot.id])
        editor.onShare = { [weak self, weak editor] png in
            guard let self, let editor else { return }
            self.share(png, name: editor.shareName, progress: { editor.setSharing($0) }, done: { editor.showNote($0) })
        }
        editor.showError = { [weak self] in self?.showMessage($0) }
        editor.folder = { [weak self] in self?.folder ?? FileManager.default.homeDirectoryForCurrentUser }
        editor.onSaved = { [weak self] shot, png in self?.saved(shot, png) }
        editor.onFlattened = { [weak self] shot, png in self?.swapClipboard(shot, png) }
        editor.createsFiles = { [weak self] in self.map { ScreenshotAfterCapture.load($0.defaults).save } ?? true }
        editor.onClose = { [weak self] shot, document in
            guard let self else { return }
            self.editors[shot.id] = nil
            self.documents[shot.id] = document
            // Only the recent captures keep their layers.
            let kept = Set(self.recent.items.map(\.id))
            self.documents = self.documents.filter { kept.contains($0.key) }
        }
        editors[shot.id] = editor
        editor.show()
    }

    /// An edit was saved: the recent capture learns its file (Save As), and a clipboard still
    /// holding the unedited capture gets the edited one instead, so redacted pixels don't linger.
    private func saved(_ shot: Screenshot, _ png: Data) {
        recent.update(where: { $0.id == shot.id }) { $0.fileURL = shot.fileURL }
        swapClipboard(shot, png)
    }

    /// A clipboard still holding this shot's unedited capture gets the edited picture instead.
    private func swapClipboard(_ shot: Screenshot, _ png: Data) {
        let pasteboard = NSPasteboard.general
        guard let copied = copiedCapture, copied.id == shot.id, pasteboard.changeCount == copied.changeCount else { return }
        pasteboard.clearContents()
        pasteboard.declareTypes([.png, .tiff], owner: nil)
        pasteboard.setData(png, forType: .png)
        if let tiff = NSBitmapImageRep(data: png)?.tiffRepresentation { pasteboard.setData(tiff, forType: .tiff) }
        copiedCapture = (shot.id, pasteboard.changeCount)
    }

    /// File → Edit Last Screenshot.
    func editLast() {
        if let newest = recent.newest { edit(newest) }
    }

    var shortcut: ScreenshotShortcut { ScreenshotSettings.shortcut(defaults) }
    var folder: URL { ScreenshotSettings.folder(defaults, home: FileManager.default.homeDirectoryForCurrentUser) }

    /// From the key tap. Esc is swallowed only while a capture is under way.
    func handle(_ key: HotkeyMonitor.ScreenshotKey) -> Bool {
        switch key {
        case .shortcut:
            shortcutPressed()
            return true
        case .escape:
            guard session.isActive else { return false }
            cancel()
            return true
        }
    }

    /// The shortcut, or Take Screenshot in a menu: starts a capture, or ends the one on screen.
    func shortcutPressed() {
        switch session.shortcutPressed() {
        case .none: break
        case .dismiss: cancel()
        case .start: start()
        }
    }

    /// This run of the app, for remembering when Screen Recording was last explained.
    private static let launch = UUID().uuidString
    /// macOS's own request is made at most once per run, and only after a capture failed.
    private var requestedScreenRecording = false
    /// Quits and reopens the app, as the self-updater does.
    var relaunch: () -> Void = {}

    /// Tries the capture first: macOS's quick check can be stale or wrong, so only a capture that
    /// really fails for permission brings up the explanation.
    private func start() {
        generation += 1
        let mine = generation
        Task { @MainActor in
            do {
                let frozen = try await ScreenCapture.grab(excluding: preview.windowNumbers.union(overlay.windowNumbers))
                // Esc during the grab (or a newer capture since): never show this one.
                guard mine == generation, session.phase == .capturing else { return }
                session.captured()
                screenRecordingMemory.forget()
                overlay.show(frozen, ownPID: ProcessInfo.processInfo.processIdentifier)
            } catch ScreenCapture.Failure.notAllowed {
                guard mine == generation else { return }
                session.end()
                if !requestedScreenRecording {
                    requestedScreenRecording = true
                    Permissions.requestScreenRecording()
                }
                let advice = screenRecordingMemory.adviceAfterFailure()
                // After a removal from the list, macOS's request must be able to add it again.
                if advice == .removeAndAddAgain { requestedScreenRecording = false }
                prompt.show(advice)
            } catch {
                guard mine == generation else { return }
                session.end()
                showMessage("Couldn’t take the screenshot")
            }
        }
    }

    private var screenRecordingMemory: ScreenRecordingCheck.Memory {
        ScreenRecordingCheck.Memory(defaults: defaults, launch: Self.launch)
    }

    private func cancel() {
        generation += 1
        session.end()
        overlay.close()
    }

    private func keep(_ selection: CaptureSelection, of frozen: FrozenDisplay) {
        session.end()
        overlay.close()
        guard let image = ScreenshotImage.crop(frozen.image, display: frozen.display, to: selection.rect),
              let png = ScreenshotImage.png(image)
        else { return }
        let takenAt = Date()
        // Settings → This Mac → Screenshots chooses what happens next (R15).
        let after = ScreenshotAfterCapture.load(defaults)
        let shot = Screenshot(image: image, png: png, fileURL: after.save ? save(png, takenAt: takenAt) : nil, takenAt: takenAt)
        if after.copy { copy(shot) }
        recent.add(shot)
        if after.preview { preview.show(shot, on: frozen.screen) }
    }

    // MARK: Share (docs/PLAN-screenshots.md R14)

    /// Share on the corner preview: the shot as last edited (layers and redactions flattened), or
    /// as taken.
    private func sharePreview(_ shot: Screenshot) {
        let png = documents[shot.id].flatMap { $0.isEdited ? ShotRenderer.exportPNG($0, source: shot.image) : nil } ?? shot.png
        let name = shot.fileURL?.deletingPathExtension().lastPathComponent ?? ScreenshotFiles.baseName(for: shot.takenAt)
        share(png, name: name, progress: { [weak self] in self?.preview.setSharing($0) }, done: { [weak self] text in
            guard let self, !self.preview.showNote(text) else { return }
            self.showMessage(text)
        })
    }

    /// Uploads through the signed-in page, copies the link, and says what happened. The shot on
    /// this Mac is untouched whatever the answer. Neither the picture nor the link is logged.
    func share(_ png: Data, name: String, progress: @escaping (Bool) -> Void, done: @escaping (String) -> Void) {
        guard !sharing else {
            done("Still sharing the last one. Try again in a moment.")
            return
        }
        let base64: String
        switch ScreenshotShare.payload(png) {
        case let .failure(failure):
            done(ScreenshotShare.message(.failed(failure)))
            return
        case let .success(text):
            base64 = text
        }
        sharing = true
        shareGeneration += 1
        let mine = shareGeneration
        progress(true)
        // A page that never answers mustn't leave Share stuck.
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.shareTimeout) { [weak self] in
            MainActor.assumeIsolated {
                guard let self, self.sharing, self.shareGeneration == mine else { return }
                self.shareGeneration += 1
                self.sharing = false
                progress(false)
                done("Sharing took too long. Check the connection and press Share again.")
            }
        }
        Task { @MainActor in
            let answer = await self.sharePage(name, base64)
            guard self.shareGeneration == mine else { return }
            let outcome = ScreenshotShare.parse(answer, expectedHost: self.suiteHost())
            self.sharing = false
            progress(false)
            if case let .shared(url, _, _) = outcome {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(url.absoluteString, forType: .string)
            }
            done(ScreenshotShare.message(outcome))
        }
    }

    // MARK: Settings → This Mac → Screenshots (R15)

    var settingsSnapshot: MacSettingsBridge.Snapshot.Screenshots {
        .init(
            shortcut: shortcut,
            folder: ScreenshotSettings.displayPath(folder, home: FileManager.default.homeDirectoryForCurrentUser),
            afterCapture: ScreenshotAfterCapture.load(defaults)
        )
    }

    /// A change from the page. A shortcut the Mac refuses changes nothing (the page sees the old one).
    func apply(_ change: MacSettingsBridge.Change) {
        var after = ScreenshotAfterCapture.load(defaults)
        switch change {
        case let .screenshotShortcut(chord):
            if chord.refusal == nil { ScreenshotSettings.setShortcut(chord, in: defaults) }
        case let .screenshotCopy(on): after.copy = on
        case let .screenshotSave(on): after.save = on
        case let .screenshotPreview(on): after.preview = on
        default: return
        }
        after.store(in: defaults)
    }

    func perform(_ action: MacSettingsBridge.Action, done: @escaping () -> Void) {
        switch action {
        case .resetScreenshotShortcut:
            ScreenshotSettings.setShortcut(.default, in: defaults)
            done()
        case .showScreenshotFolder:
            try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            NSWorkspace.shared.open(folder)
            done()
        case .chooseScreenshotFolder:
            let panel = NSOpenPanel()
            panel.canChooseDirectories = true
            panel.canChooseFiles = false
            panel.canCreateDirectories = true
            panel.allowsMultipleSelection = false
            panel.prompt = "Use This Folder"
            panel.message = "Choose where screenshots are saved."
            panel.directoryURL = folder
            NSApp.activate(ignoringOtherApps: true)
            panel.begin { [weak self] response in
                MainActor.assumeIsolated {
                    if response == .OK, let url = panel.url, let self { ScreenshotSettings.setFolder(url, in: self.defaults) }
                    done()
                }
            }
        default:
            done()
        }
    }

    /// The clipboard gets PNG, and TIFF for the apps that only take that.
    private func copy(_ shot: Screenshot) {
        let pasteboard = NSPasteboard.general
        pasteboard.clearContents()
        pasteboard.declareTypes([.png, .tiff], owner: nil)
        pasteboard.setData(shot.png, forType: .png)
        if let tiff = NSBitmapImageRep(cgImage: shot.image).tiffRepresentation {
            pasteboard.setData(tiff, forType: .tiff)
        }
        copiedCapture = (shot.id, pasteboard.changeCount)
    }

    /// Into the screenshots folder (made when first needed), under a name that doesn't clash.
    private func save(_ png: Data, takenAt: Date) -> URL? {
        let folder = folder
        let files = FileManager.default
        do {
            try files.createDirectory(at: folder, withIntermediateDirectories: true)
            let name = ScreenshotFiles.fileName(for: takenAt) { files.fileExists(atPath: folder.appendingPathComponent($0).path) }
            let url = folder.appendingPathComponent(name)
            try png.write(to: url, options: .withoutOverwriting)
            return url
        } catch {
            showMessage("Copied, but couldn’t save it to \(folder.lastPathComponent)")
            return nil
        }
    }
}
