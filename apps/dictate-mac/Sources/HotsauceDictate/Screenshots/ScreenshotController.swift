import AppKit
import DictateCore

/// The screenshot tool (docs/PLAN-screenshots.md slice 2): the shortcut grabs every display, the
/// overlay picks what to keep, and the shot goes to the clipboard, the screenshots folder and the
/// preview in the corner. Nothing leaves the Mac.
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
    /// Slice 4 sets this to share a flattened picture; until then Share stays hidden.
    var onShare: ((Data) -> Void)?

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        overlay.shortcut = { [weak self] in self?.shortcut ?? .default }
        overlay.onCancel = { [weak self] in self?.cancel() }
        overlay.onPick = { [weak self] display, selection in self?.keep(selection, of: display) }
        preview.onCopy = { [weak self] shot in self?.copy(shot) }
        preview.onEdit = { [weak self] shot in self?.edit(shot) }
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
        editor.onShare = onShare
        editor.showError = { [weak self] in self?.showMessage($0) }
        editor.folder = { [weak self] in self?.folder ?? FileManager.default.homeDirectoryForCurrentUser }
        editor.onSaved = { [weak self] shot, png in self?.saved(shot, png) }
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

    private func start() {
        guard Permissions.screenRecordingGranted else {
            session.end()
            Permissions.requestScreenRecording()
            prompt.show()
            return
        }
        generation += 1
        let mine = generation
        Task { @MainActor in
            do {
                let frozen = try await ScreenCapture.grab(excluding: preview.windowNumbers.union(overlay.windowNumbers))
                // Esc during the grab (or a newer capture since): never show this one.
                guard mine == generation, session.phase == .capturing else { return }
                session.captured()
                overlay.show(frozen, ownPID: ProcessInfo.processInfo.processIdentifier)
            } catch ScreenCapture.Failure.notAllowed {
                guard mine == generation else { return }
                session.end()
                prompt.show()
            } catch {
                guard mine == generation else { return }
                session.end()
                showMessage("Couldn’t take the screenshot")
            }
        }
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
        let shot = Screenshot(image: image, png: png, fileURL: save(png, takenAt: takenAt), takenAt: takenAt)
        copy(shot)
        recent.add(shot)
        preview.show(shot, on: frozen.screen)
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
